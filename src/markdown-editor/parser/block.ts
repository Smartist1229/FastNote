/**
 * 块级解析：源文本 → 块级 AST。
 *
 * 流程：
 * 1) 归一化换行、切行并记录每行的绝对偏移（就地编辑/任务勾选靠它定位源码）；
 * 2) 抽出 YAML front matter、引用式链接定义、脚注定义（把已消费的行置空，保持行号与偏移不变）；
 * 3) 递归下降解析块：围栏代码 / 公式 / 标题 / 分割线 / 引用（含 GFM Alert）/ 列表（含嵌套与任务）
 *    / 表格 / HTML 块 / 缩进代码 / 段落（含 Setext 标题）；
 * 4) 解析结束后把脚注定义转成块，按首次引用顺序编号。
 *
 * 之所以不用现成解析器：实时预览需要「每个顶层块的源码区间」，市面解析器普遍丢弃位置信息。
 */
import { inlineToText, normalizeLabel, parseInline } from "./inline";
import type {
  AlertKind,
  BlockNode,
  InlineContext,
  InlineNode,
  ListItemNode,
  OutlineItem,
  ParsedDocument,
  TableAlign,
  TaskState,
} from "./types";

/** 带绝对偏移的一行 */
interface SourceLine {
  text: string;
  /** text[0] 在原始字符串中的偏移 */
  offset: number;
  /** 1 起算的行号 */
  line: number;
}

interface ParseState {
  links: Map<string, { href: string; title?: string }>;
  footnoteDefs: Map<string, SourceLine[]>;
  footnoteIndex: Map<string, number>;
  footnoteOrder: string[];
  slugs: Map<string, number>;
  outline: OutlineItem[];
  allowHtml: boolean;
  /** 单个换行（GFM breaks）：\n 直接算硬换行 */
  breaks: boolean;
}

const indentOf = (text: string): number => {
  let n = 0;
  for (const ch of text) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
};

const stripIndent = (text: string, width: number): string => {
  let n = 0;
  let i = 0;
  while (i < text.length && n < width) {
    if (text[i] === " ") {
      n++;
      i++;
    } else if (text[i] === "\t") {
      n += 4 - (n % 4);
      i++;
    } else break;
  }
  return text.slice(i);
};

const blank = (text: string) => !text.trim();

/** 围栏代码块开头 */
const matchFence = (text: string): { char: string; length: number; info: string } | null => {
  const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(text);
  if (!m) return null;
  const char = m[1][0];
  // 反引号围栏的 info 里不能再出现反引号（避免和行内代码混淆）
  if (char === "`" && m[2].includes("`")) return null;
  return { char, length: m[1].length, info: m[2].trim() };
};

const isFenceClose = (text: string, char: string, length: number): boolean => {
  const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(text);
  return !!m && m[1][0] === char && m[1].length >= length;
};

const matchAtxHeading = (text: string): { level: 1 | 2 | 3 | 4 | 5 | 6; content: string } | null => {
  const m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(text);
  if (!m) return null;
  return {
    level: m[1].length as 1 | 2 | 3 | 4 | 5 | 6,
    content: (m[2] ?? "").replace(/[ \t]+#+$/, ""),
  };
};

const isHr = (text: string): boolean => /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(text);

const matchQuote = (text: string): string | null => {
  const m = /^ {0,3}>[ \t]?(.*)$/.exec(text);
  return m ? m[1] : null;
};

interface ListMarker {
  ordered: boolean;
  start: number;
  /** 内容起始列（预算好的缩进宽度） */
  contentOffset: number;
  /** 0 起的行内缩进 */
  indent: number;
}

const matchListMarker = (text: string): ListMarker | null => {
  const m = /^( {0,3})([*+-]|\d{1,9}[.)])([ \t]+|$)/.exec(text);
  if (!m) return null;
  const ordered = /\d/.test(m[2]);
  const spaces = m[3] ? Math.min(m[3].length, 4) : 1;
  return {
    ordered,
    start: ordered ? parseInt(m[2], 10) : 1,
    contentOffset: m[1].length + m[2].length + spaces,
    indent: m[1].length,
  };
};

const splitTableRow = (raw: string): string[] => {
  let text = raw.trim();
  if (text.startsWith("|")) text = text.slice(1);
  const cells: string[] = [];
  let cur = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      cur += ch + (text[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (ch === "`") {
      let run = 0;
      while (text[i + run] === "`") run++;
      let j = i + run;
      let close = -1;
      while (j < text.length) {
        if (text[j] === "`") {
          let r = 0;
          while (text[j + r] === "`") r++;
          if (r === run) {
            close = j;
            break;
          }
          j += r;
          continue;
        }
        j++;
      }
      if (close >= 0) {
        cur += text.slice(i, close + run);
        i = close + run;
        continue;
      }
    }
    if (ch === "|") {
      cells.push(cur);
      cur = "";
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  cells.push(cur);
  // 尾部 `|` 会多出一个空单元格
  if (cells.length > 1 && cells[cells.length - 1].trim() === "" && /[|]\s*$/.test(raw)) cells.pop();
  return cells.map((cell) => cell.trim());
};

const parseAlign = (row: string): TableAlign[] =>
  splitTableRow(row).map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

/** 表格：当前行是表头，下一行是对齐分隔行 */
const isTableStart = (lines: SourceLine[], i: number): boolean => {
  if (i + 1 >= lines.length) return false;
  const head = lines[i].text;
  if (!head.includes("|")) return false;
  const delim = lines[i + 1].text;
  if (!delim.includes("|")) return false;
  const cells = splitTableRow(delim).filter((c) => c !== "");
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell));
};

const HTML_BLOCK = /^ {0,3}(?:<!--|<\?|<!\[CDATA\[|<![A-Z]|<\/?[a-zA-Z][a-zA-Z0-9-]*(?:[\s/>]|$))/;

const ALERTS: AlertKind[] = ["note", "tip", "important", "warning", "caution"];

/**
 * Admonition 提示块（MkDocs 风格围栏）：
 * - `!!! [type] ["标题"]`        常驻提示块；
 * - `??? [type] ["标题"]`        可折叠提示块（默认收起，渲染成 <details>）；
 * - `???+ [type] ["标题"]`       可折叠提示块（默认展开）。
 * 结尾行是同样的围栏记号；不写结尾行则吞到文末。
 */
const CALLOUT_OPEN = /^ {0,3}(!!!|\?\?\?)(\+)?(?:[ \t]+(.*))?$/;

/** 类型别名：对齐 MkDocs Material 的全部类型名，映射到组件的 5 种观感 */
const CALLOUT_ALIAS: Record<string, AlertKind> = {
  note: "note",
  abstract: "note",
  summary: "note",
  tldr: "note",
  info: "note",
  example: "note",
  snippet: "note",
  quote: "note",
  cite: "note",
  tip: "tip",
  hint: "tip",
  important: "important",
  success: "tip",
  check: "tip",
  done: "tip",
  question: "tip",
  help: "tip",
  faq: "tip",
  warning: "warning",
  warn: "warning",
  attention: "warning",
  caution: "caution",
  danger: "caution",
  error: "caution",
  bug: "caution",
  failure: "caution",
  fail: "caution",
  missing: "caution",
};

/** 解析开头行：`!!!` / `!!! warning` / `!!! note "标题"` / `!!! 自定义标题` */
const parseCalloutHeader = (rest: string): { kind: AlertKind; title: string } => {
  const trimmed = rest.trim().replace(/^["“]|["”]$/g, "");
  if (!trimmed) return { kind: "warning", title: "" };
  const [first, ...others] = trimmed.split(/\s+/);
  const kind = CALLOUT_ALIAS[first.toLowerCase()];
  if (kind) {
    return { kind, title: others.join(" ").replace(/^["“]|["”]$/g, "") };
  }
  // 首词不是已知类型：整行当标题，类型默认 warning
  return { kind: "warning", title: trimmed };
};

/** 标题锚点：保留中英文与数字，其余转连字符 */
const slugify = (text: string): string => {
  const base = text
    .toLowerCase()
    .trim()
    .replace(/[`*_~^=$[\]()<>#!]/g, "")
    .replace(/[^\w\u4e00-\u9fa5\s-]/g, "")
    .replace(/\s+/g, "-");
  return base || "section";
};

/** 标题注册：生成去重锚点并返回纯文本（大纲与 TOC 都用它） */
const registerHeading = (children: InlineNode[], st: ParseState): { id: string; label: string } => {
  const label = inlineToText(children);
  const slug = slugify(label);
  const seen = st.slugs.get(slug) ?? 0;
  st.slugs.set(slug, seen + 1);
  return { id: seen ? `${slug}-${seen}` : slug, label };
};

/** 统一生成行数组（保留行号与偏移，不丢空行） */
const toLines = (src: string): SourceLine[] => {
  const lines: SourceLine[] = [];
  let offset = 0;
  src.split("\n").forEach((text, index) => {
    lines.push({ text, offset, line: index + 1 });
    offset += text.length + 1;
  });
  return lines;
};

/** 预扫描：front matter / 链接定义 / 脚注定义 */
const extractDefinitions = (lines: SourceLine[], st: ParseState): { frontmatter: ParsedDocument["frontmatter"] } => {
  let frontmatter: ParsedDocument["frontmatter"] = null;
  if (lines.length && /^---\s*$/.test(lines[0].text)) {
    for (let i = 1; i < lines.length; i++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[i].text)) {
        const raw = lines
          .slice(1, i)
          .map((l) => l.text)
          .join("\n");
        const data: Record<string, string> = {};
        for (const row of raw.split("\n")) {
          const m = /^([\w.-]+)\s*:\s*(.*)$/.exec(row);
          if (m) data[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
        frontmatter = { raw, data };
        for (let k = 0; k <= i; k++) lines[k].text = "";
        break;
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].text;
    if (!text.trim()) continue;

    const fn = /^ {0,3}\[\^([^\]]+)\]:[ \t]?(.*)$/.exec(text);
    if (fn) {
      const body: SourceLine[] = [
        { text: fn[2], offset: lines[i].offset + text.length - fn[2].length, line: lines[i].line },
      ];
      lines[i].text = "";
      let j = i + 1;
      let pending: number[] = [];
      while (j < lines.length) {
        const next = lines[j].text;
        if (!next.trim()) {
          pending.push(j);
          j++;
          continue;
        }
        if (indentOf(next) >= 4) {
          for (const b of pending) {
            body.push({ text: "", offset: lines[b].offset, line: lines[b].line });
            lines[b].text = "";
          }
          pending = [];
          body.push({ text: stripIndent(next, 4), offset: lines[j].offset + 4, line: lines[j].line });
          lines[j].text = "";
          j++;
          continue;
        }
        break;
      }
      st.footnoteDefs.set(fn[1], body);
      i = j - 1;
      continue;
    }

    const ref = /^ {0,3}\[([^\]]+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?[ \t]*$/.exec(text);
    if (ref && !ref[1].startsWith("^")) {
      st.links.set(normalizeLabel(ref[1]), {
        href: ref[2].replace(/^<|>$/g, ""),
        title: ref[3] ?? ref[4] ?? ref[5],
      });
      lines[i].text = "";
    }
  }

  return { frontmatter };
};

/** 段落的终止条件：遇到这些行就不该再并入段落 */
const startsNewBlock = (lines: SourceLine[], i: number): boolean => {
  const text = lines[i].text;
  if (blank(text)) return true;
  if (
    matchFence(text) ||
    isHr(text) ||
    matchAtxHeading(text) ||
    matchQuote(text) ||
    matchListMarker(text) ||
    CALLOUT_OPEN.test(text)
  )
    return true;
  if (/^ {0,3}\$\$/.test(text)) return true;
  if (HTML_BLOCK.test(text)) return true;
  if (isTableStart(lines, i)) return true;
  if (/^ {0,3}\[\[?toc\]?\]\s*$/i.test(text)) return true;
  return false;
};

/** 递归解析块序列 */
const parseBlocks = (lines: SourceLine[], st: ParseState, depth: number): BlockNode[] => {
  const blocks: BlockNode[] = [];
  let i = 0;
  const inlineCtx: InlineContext = {
    links: st.links,
    footnoteIndex: st.footnoteIndex,
    footnoteOrder: st.footnoteOrder,
    allowHtml: st.allowHtml,
    breaks: st.breaks,
  };

  while (i < lines.length) {
    const cur = lines[i];
    const text = cur.text;
    if (blank(text)) {
      i++;
      continue;
    }

    // 围栏代码块
    const fence = matchFence(text);
    if (fence) {
      const startLine = cur.line;
      const startOffset = cur.offset;
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (isFenceClose(lines[j].text, fence.char, fence.length)) {
          closed = true;
          break;
        }
        body.push(lines[j].text);
        j++;
      }
      const endIndex = closed ? j : lines.length - 1;
      const info = fence.info;
      const [lang, ...rest] = info.split(/\s+/);
      blocks.push({
        type: "code",
        lang: (lang || "").toLowerCase(),
        meta: rest.join(" "),
        code: body.join("\n"),
        fence: fence.char.repeat(fence.length),
        start: startOffset,
        end: lines[endIndex].offset + lines[endIndex].text.length,
        line: startLine,
      });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // 数学块 $$ ... $$
    const mathOpen = /^ {0,3}\$\$(.*)$/.exec(text);
    if (mathOpen) {
      const startLine = cur.line;
      const startOffset = cur.offset;
      const inlinePart = mathOpen[1];
      if (/\$\$\s*$/.test(inlinePart)) {
        const code = inlinePart.replace(/\$\$\s*$/, "").trim();
        blocks.push({
          type: "math",
          code,
          start: startOffset,
          end: cur.offset + text.length,
          line: startLine,
        });
        i++;
        continue;
      }
      const body: string[] = inlinePart.trim() ? [inlinePart] : [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (/^ {0,3}\$\$\s*$/.test(lines[j].text)) {
          closed = true;
          break;
        }
        body.push(lines[j].text);
        j++;
      }
      const endIndex = closed ? j : lines.length - 1;
      blocks.push({
        type: "math",
        code: body.join("\n").trim(),
        start: startOffset,
        end: lines[endIndex].offset + lines[endIndex].text.length,
        line: startLine,
      });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // 标题
    const heading = matchAtxHeading(text);
    if (heading) {
      const children = parseInline(heading.content, inlineCtx);
      const { id, label } = registerHeading(children, st);
      blocks.push({
        type: "heading",
        level: heading.level,
        id,
        children,
        start: cur.offset,
        end: cur.offset + text.length,
        line: cur.line,
      });
      if (depth === 0) st.outline.push({ id, text: label, level: heading.level, line: cur.line });
      i++;
      continue;
    }

    // 分割线
    if (isHr(text)) {
      blocks.push({ type: "hr", start: cur.offset, end: cur.offset + text.length, line: cur.line });
      i++;
      continue;
    }

    // TOC 占位
    if (/^ {0,3}\[\[?toc\]?\]\s*$/i.test(text)) {
      blocks.push({ type: "toc", start: cur.offset, end: cur.offset + text.length, line: cur.line });
      i++;
      continue;
    }

    // Admonition 提示块（!!! / ??? / ???+）：收集到下一个同记号的结尾行
    const calloutOpen = CALLOUT_OPEN.exec(text);
    if (calloutOpen) {
      const marker = calloutOpen[1];
      const header = parseCalloutHeader(calloutOpen[3] ?? "");
      const body: SourceLine[] = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        if (lines[j].text.replace(/^ {0,3}/, "").trim() === marker) {
          closed = true;
          break;
        }
        body.push(lines[j]);
        j++;
      }
      // MkDocs 风格常把内容缩进 4 空格：统一去掉公共缩进，同时保持偏移正确
      const minIndent = body.reduce((min, line) => (line.text.trim() ? Math.min(min, indentOf(line.text)) : min), Number.POSITIVE_INFINITY);
      const strip = Number.isFinite(minIndent) && minIndent >= 4 ? minIndent : 0;
      const content = body.map((line) => ({
        text: strip ? stripIndent(line.text, strip) : line.text,
        offset: line.offset + (strip ? Math.min(strip, indentOf(line.text)) : 0),
        line: line.line,
      }));
      const endLine = closed ? lines[j] : lines[lines.length - 1];
      blocks.push({
        type: "callout",
        kind: header.kind,
        title: header.title,
        // `???` 折叠（默认收起），`???+` 折叠且默认展开，`!!!` 常驻
        fold: marker === "???",
        open: Boolean(calloutOpen[2]),
        children: parseBlocks(content, st, depth + 1),
        start: cur.offset,
        end: endLine.offset + endLine.text.length,
        line: cur.line,
      });
      i = closed ? j + 1 : lines.length;
      continue;
    }

    // 引用 / Alert
    const quoteFirst = matchQuote(text);
    if (quoteFirst !== null) {
      const startOffset = cur.offset;
      const startLine = cur.line;
      const inner: SourceLine[] = [{ text: quoteFirst, offset: cur.offset + text.length - quoteFirst.length, line: cur.line }];
      let j = i + 1;
      let endOffset = cur.offset + text.length;
      while (j < lines.length) {
        const q = matchQuote(lines[j].text);
        if (q !== null) {
          inner.push({
            text: q,
            offset: lines[j].offset + lines[j].text.length - q.length,
            line: lines[j].line,
          });
          endOffset = lines[j].offset + lines[j].text.length;
          j++;
          continue;
        }
        if (blank(lines[j].text)) break;
        // 懒惰续行：不以引用符开头但属于同一段落
        if (!startsNewBlock(lines, j)) {
          inner.push({ text: lines[j].text, offset: lines[j].offset, line: lines[j].line });
          endOffset = lines[j].offset + lines[j].text.length;
          j++;
          continue;
        }
        break;
      }
      let alert: AlertKind | null = null;
      const firstText = inner[0]?.text ?? "";
      const alertMatch = /^\[!(\w+)\][ \t]*$/i.exec(firstText.trim());
      if (alertMatch && ALERTS.includes(alertMatch[1].toLowerCase() as AlertKind)) {
        alert = alertMatch[1].toLowerCase() as AlertKind;
        inner.shift();
      }
      blocks.push({
        type: "blockquote",
        children: parseBlocks(inner, st, depth + 1),
        alert,
        start: startOffset,
        end: endOffset,
        line: startLine,
      });
      i = j;
      continue;
    }

    // 列表
    const marker = matchListMarker(text);
    if (marker) {
      const startOffset = cur.offset;
      const startLine = cur.line;
      const items: ListItemNode[] = [];
      let loose = false;
      let k = i;
      let listEnd = cur.offset + text.length;

      while (k < lines.length) {
        const m = matchListMarker(lines[k].text);
        if (!m || m.ordered !== marker.ordered) break;

        const itemLine = lines[k];
        const contentOffset = itemLine.offset + m.contentOffset;
        let firstText = itemLine.text.slice(m.contentOffset);
        let task: TaskState = null;
        let taskOffset = -1;
        const taskMatch = /^\[([ xX])\][ \t]+/.exec(firstText);
        if (taskMatch) {
          task = taskMatch[1].toLowerCase() === "x";
          taskOffset = itemLine.offset + m.contentOffset + 1;
          firstText = firstText.slice(taskMatch[0].length);
        }
        const body: SourceLine[] = [
          {
            text: firstText,
            offset: contentOffset + (taskMatch ? taskMatch[0].length : 0),
            line: itemLine.line,
          },
        ];
        let endOffset = itemLine.offset + itemLine.text.length;
        k++;

        while (k < lines.length) {
          const next = lines[k].text;
          if (blank(next)) {
            // 空行后仍缩进 → 属于本项（列表变松散）
            let look = k + 1;
            while (look < lines.length && blank(lines[look].text)) look++;
            if (look < lines.length && indentOf(lines[look].text) >= m.contentOffset) {
              loose = true;
              for (; k < look; k++) body.push({ text: "", offset: lines[k].offset, line: lines[k].line });
              continue;
            }
            break;
          }
          if (indentOf(next) >= m.contentOffset) {
            body.push({
              text: stripIndent(next, m.contentOffset),
              offset: lines[k].offset + m.contentOffset,
              line: lines[k].line,
            });
            endOffset = lines[k].offset + next.length;
            k++;
            continue;
          }
          // 懒惰续行：紧跟在文本行后、且不是新块
          if (!startsNewBlock(lines, k) && body.length) {
            body.push({ text: next.trimStart(), offset: lines[k].offset + (next.length - next.trimStart().length), line: lines[k].line });
            endOffset = lines[k].offset + next.length;
            k++;
            continue;
          }
          break;
        }

        items.push({
          children: parseBlocks(body, st, depth + 1),
          task,
          taskOffset,
          line: itemLine.line,
        });
        listEnd = endOffset;

        // 列表是否继续：跳过空行后仍是同类标记
        let look = k;
        while (look < lines.length && blank(lines[look].text)) look++;
        if (look < lines.length) {
          const nextMarker = matchListMarker(lines[look].text);
          if (nextMarker && nextMarker.ordered === marker.ordered) {
            if (look > k) loose = true;
            k = look;
            continue;
          }
        }
        break;
      }

      if (items.length) {
        blocks.push({
          type: "list",
          ordered: marker.ordered,
          startNumber: marker.start,
          tight: !loose,
          items,
          start: startOffset,
          end: listEnd,
          line: startLine,
        });
        i = k;
        continue;
      }
    }

    // 表格
    if (isTableStart(lines, i)) {
      const header = splitTableRow(text).map((cell) => parseInline(cell, inlineCtx));
      const align = parseAlign(lines[i + 1].text);
      const rows: ReturnType<typeof parseInline>[][] = [];
      let j = i + 2;
      let endOffset = lines[i + 1].offset + lines[i + 1].text.length;
      while (j < lines.length) {
        const rowText = lines[j].text;
        if (blank(rowText) || !rowText.includes("|")) break;
        const cells = splitTableRow(rowText);
        rows.push(
          Array.from({ length: header.length }, (_, c) => parseInline(cells[c] ?? "", inlineCtx)),
        );
        endOffset = lines[j].offset + rowText.length;
        j++;
      }
      blocks.push({
        type: "table",
        align,
        header,
        rows,
        start: cur.offset,
        end: endOffset,
        line: cur.line,
      });
      i = j;
      continue;
    }

    // HTML 块
    if (st.allowHtml && HTML_BLOCK.test(text)) {
      const startOffset = cur.offset;
      let j = i;
      let endOffset = cur.offset + text.length;
      while (j < lines.length && !blank(lines[j].text)) {
        endOffset = lines[j].offset + lines[j].text.length;
        j++;
      }
      blocks.push({
        type: "html",
        raw: lines
          .slice(i, j)
          .map((l) => l.text)
          .join("\n"),
        start: startOffset,
        end: endOffset,
        line: cur.line,
      });
      i = j;
      continue;
    }

    // 缩进代码块（4 空格）
    if (indentOf(text) >= 4) {
      const startOffset = cur.offset;
      const body: string[] = [];
      let j = i;
      let endOffset = cur.offset + text.length;
      while (j < lines.length) {
        const t = lines[j].text;
        if (blank(t)) {
          body.push("");
          j++;
          continue;
        }
        if (indentOf(t) < 4) break;
        body.push(stripIndent(t, 4));
        endOffset = lines[j].offset + t.length;
        j++;
      }
      while (body.length && body[body.length - 1] === "") body.pop();
      blocks.push({
        type: "code",
        lang: "",
        meta: "",
        code: body.join("\n"),
        fence: "",
        start: startOffset,
        end: endOffset,
        line: cur.line,
      });
      i = j;
      continue;
    }

    // 段落（含 Setext 标题）
    {
      const startOffset = cur.offset;
      const startLine = cur.line;
      const texts: string[] = [text];
      let j = i + 1;
      let setext: 1 | 2 | null = null;
      let setextLineEnd = cur.offset + text.length;
      while (j < lines.length) {
        const next = lines[j].text;
        if (blank(next)) break;
        const underline = /^ {0,3}(=+|-+)[ \t]*$/.exec(next);
        if (underline) {
          setext = underline[1][0] === "=" ? 1 : 2;
          setextLineEnd = lines[j].offset + next.length;
          j++;
          break;
        }
        if (startsNewBlock(lines, j)) break;
        texts.push(next);
        j++;
      }
      const content = texts.join("\n");
      const children = parseInline(content, inlineCtx);
      if (setext && texts.length) {
        const { id, label } = registerHeading(children, st);
        blocks.push({
          type: "heading",
          level: setext,
          id,
          children,
          start: startOffset,
          end: setextLineEnd,
          line: startLine,
        });
        if (depth === 0) st.outline.push({ id, text: label, level: setext, line: startLine });
      } else {
        blocks.push({
          type: "paragraph",
          children,
          start: startOffset,
          end: lines[j - 1].offset + lines[j - 1].text.length,
          line: startLine,
        });
      }
      i = j;
    }
  }

  return blocks;
};

/** 入口：解析整篇 Markdown */
export function parseMarkdown(
  src: string,
  options: { allowHtml?: boolean; breaks?: boolean } = {},
): ParsedDocument {
  const text = src.replace(/\r\n?/g, "\n");
  const st: ParseState = {
    links: new Map(),
    footnoteDefs: new Map(),
    footnoteIndex: new Map(),
    footnoteOrder: [],
    slugs: new Map(),
    outline: [],
    allowHtml: options.allowHtml ?? true,
    breaks: options.breaks ?? false,
  };

  const lines = toLines(text);
  const { frontmatter } = extractDefinitions(lines, st);
  const blocks = parseBlocks(lines, st, 0);

  // 脚注：先按引用顺序，再把没被引用的定义补在后面
  const order = [...st.footnoteOrder];
  for (const id of st.footnoteDefs.keys()) if (!order.includes(id)) order.push(id);
  const footnotes = order.map((id, index) => ({
    id,
    label: String(index + 1),
    index: index + 1,
    children: st.footnoteDefs.has(id) ? parseBlocks(st.footnoteDefs.get(id)!, st, 1) : [],
  }));

  return { blocks, frontmatter, outline: st.outline, footnotes, links: st.links };
}
