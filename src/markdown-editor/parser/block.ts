/**
 * 块级解析：源文本 → 块级 AST。
 *
 * 流程：
 * 1) 归一化换行、切行并记录每行的绝对偏移（就地编辑/任务勾选靠它定位编辑区）；
 * 2) 抽出 YAML front matter、引用式链接定义、脚注定义（把已消费的行置空，保持行号与偏移不变）；
 * 3) 递归下降解析块：围栏代码 / 公式 / 标题 / 分割线 / 引用（含 GFM Alert）/ 列表（含嵌套与任务）
 *    / 表格 / HTML 块 / 缩进代码 / 段落（含 Setext 标题）；
 * 4) 解析结束后把脚注定义转成块，按首次引用顺序编号。
 *
 * 之所以不用现成解析器：实时预览需要「每个顶层块的 Markdown 区间」，市面解析器普遍丢弃位置信息。
 */
import { inlineToText, normalizeLabel, parseInline } from "./inline";
import { lineIndexAt, lineOffsets, splitLines } from "../editor/lines";
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

/**
 * 短语级（inline）标签：它们出现在**行首**时不该把整行吞成 HTML 块。
 *
 * 典型的翻车现场是给标题上色：`<font style="color:red"># 标题</font>`。
 * 按 HTML_BLOCK 的老规则这整行算 HTML 块——所以标题既没了字号也没了行内解析，
 * 看起来就是「套了颜色之后标题失效」。`<u>`、`<span>` 同理。
 * 真正的 HTML 块（`<div>`、`<table>`、注释、doctype）不受影响。
 */
const INLINE_HTML_TAGS = new Set([
  "a",
  "abbr",
  "b",
  "bdi",
  "bdo",
  "cite",
  "code",
  "data",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "label",
  "mark",
  "q",
  "rp",
  "rt",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strong",
  "sub",
  "sup",
  "time",
  "u",
  "var",
]);
const HTML_LEAD_TAG = /^ {0,3}<\/?([a-zA-Z][a-zA-Z0-9-]*)/;
const isHtmlBlockStart = (text: string): boolean => {
  const lead = HTML_LEAD_TAG.exec(text);
  if (lead && INLINE_HTML_TAGS.has(lead[1].toLowerCase())) return false;
  return HTML_BLOCK.test(text);
};

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
  const source = splitLines(src);
  const lines: SourceLine[] = new Array(source.length);
  let offset = 0;
  for (let index = 0; index < source.length; index += 1) {
    const text = source[index];
    lines[index] = { text, offset, line: index + 1 };
    offset += text.length + 1;
  }
  return lines;
};

/** 只构造窗口内的行（行号、偏移仍是全文的绝对坐标），避免每次按键切全文 */
const toWindowLines = (src: string, from: number, to: number): SourceLine[] => {
  const source = splitLines(src);
  const offsets = lineOffsets(src);
  const count = Math.max(0, to - from);
  const lines: SourceLine[] = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const line = from + index;
    lines[index] = { text: source[line] ?? "", offset: offsets[line] ?? src.length, line: line + 1 };
  }
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
  if (isHtmlBlockStart(text)) return true;
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
    if (st.allowHtml && isHtmlBlockStart(text)) {
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

/* ---------- 增量解析 ---------- */

interface LineDiff {
  first: number;
  oldEnd: number;
  newEnd: number;
}

/**
 * 两次切行结果的公共前后缀。
 *
 * 增量切行（editor/lines.ts）复用了没变过的行字符串，所以这里比较的是引用，
 * 五万行也只是五万次指针比较。
 */
const diffLineRange = (prev: readonly string[], next: readonly string[]): LineDiff => {
  const shared = Math.min(prev.length, next.length);
  let first = 0;
  while (first < shared && prev[first] === next[first]) first += 1;
  let suffix = 0;
  while (suffix < shared - first && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1;
  }
  return { first, oldEnd: prev.length - suffix, newEnd: next.length - suffix };
};

/** 标题行 / Setext 下划线：会改变全文的锚点去重序列 */
const HEADING_LINE = /^ {0,3}(?:#{1,6}(?:[ \t]|$)|(?:=+|-+)[ \t]*$)/;
/** 引用式链接 / 脚注定义 */
const DEFINITION_LINE = /^ {0,3}\[[^\]]+\]:/;
/** 围栏与 front matter 边界：会改变「定义是否还在正文里」 */
const BOUNDARY_LINE = /^ {0,3}(?:`{3,}|~{3,})|^(?:---|\.\.\.)[ \t]*$/;

/**
 * 变化的行里有没有会牵动全文状态的语法。
 *
 * 增量解析只重排「受改动影响的那几块」，前提是标题锚点、链接/脚注定义、围栏
 * 这些跨块状态没有变。命中任意一条就退回整篇解析——正确优先。
 * 脚注引用也在这里拦下：引用增删会改变全篇脚注编号。
 */
const touchesGlobalState = (lines: readonly string[], from: number, to: number): boolean => {
  for (let index = from; index < to; index += 1) {
    const text = lines[index] ?? "";
    if (HEADING_LINE.test(text)) return true;
    if (DEFINITION_LINE.test(text)) return true;
    if (BOUNDARY_LINE.test(text)) return true;
    if (text.includes("[^")) return true;
  }
  return false;
};

/** 按文档顺序收集标题的 slug（重复计数以出现顺序累计） */
const collectHeadingBases = (blocks: BlockNode[], out: string[] = []): string[] => {
  for (const block of blocks) {
    if (block.type === "heading") out.push(slugify(inlineToText(block.children)));
    else if (block.type === "blockquote" || block.type === "callout") collectHeadingBases(block.children, out);
    else if (block.type === "list") {
      for (const item of block.items) collectHeadingBases(item.children, out);
    }
  }
  return out;
};

/**
 * 按文档顺序收集脚注引用。
 *
 * 引用编号是全文状态：窗口里删掉/改动一个引用会重排后面所有编号。
 * 改行的首字符检查挡不住跨行的 `[^…]`（`[^` 可能在上一行），
 * 所以还要拿窗口前后的引用序列做一次比对，序列不一致就退回整篇解析。
 */
const collectFootnoteRefs = (blocks: BlockNode[], out: string[] = []): string[] => {
  const walkInline = (nodes: InlineNode[]): void => {
    for (const node of nodes) {
      if (node.type === "footnoteRef") out.push(node.id);
      else if ("children" in node) walkInline(node.children);
    }
  };
  for (const block of blocks) {
    switch (block.type) {
      case "heading":
      case "paragraph":
        walkInline(block.children);
        break;
      case "blockquote":
      case "callout":
        collectFootnoteRefs(block.children, out);
        break;
      case "list":
        for (const item of block.items) collectFootnoteRefs(item.children, out);
        break;
      case "table":
        for (const cell of block.header) walkInline(cell);
        for (const row of block.rows) for (const cell of row) walkInline(cell);
        break;
      default:
        break;
    }
  }
  return out;
};

const sameStrings = (a: string[], b: string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

/**
 * 全文标题序列缓存：`bases[i]` 是第 i 个标题的 slug，`blockIndexes[i]` 是它所在的顶层块。
 *
 * 增量解析每次都要知道「窗口之前已经出现过哪些标题」，否则窗口里的重复锚点会编错号。
 * 原实现每次按键都把窗口前的块递归走一遍、对每个标题跑 slugify（正则），
 * 几千个标题就是 2ms 以上；标题内容只随窗口变化，缓存下来后按键路径只剩数组切片。
 */
interface HeadingIndex {
  bases: string[];
  blockIndexes: number[];
}

const headingIndexes = new WeakMap<ParsedDocument, HeadingIndex>();

const buildHeadingIndex = (blocks: BlockNode[]): HeadingIndex => {
  const bases: string[] = [];
  const blockIndexes: number[] = [];
  const visit = (nodes: BlockNode[], top: number): void => {
    for (const node of nodes) {
      if (node.type === "heading") {
        bases.push(slugify(inlineToText(node.children)));
        blockIndexes.push(top);
      } else if (node.type === "blockquote" || node.type === "callout") {
        visit(node.children, top);
      } else if (node.type === "list") {
        for (const item of node.items) visit(item.children, top);
      }
    }
  };
  for (let index = 0; index < blocks.length; index += 1) visit([blocks[index]], index);
  return { bases, blockIndexes };
};

/** 取文档标题索引；整篇解析的文档第一次用到时才构建 */
const headingIndexOf = (doc: ParsedDocument): HeadingIndex => {
  const cached = headingIndexes.get(doc);
  if (cached) return cached;
  const built = buildHeadingIndex(doc.blocks);
  headingIndexes.set(doc, built);
  return built;
};

/** 前 `blockCount` 个顶层块里有多少个标题 */
const headingCountBefore = (index: HeadingIndex, blockCount: number): number => {
  let low = 0;
  let high = index.blockIndexes.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (index.blockIndexes[mid] < blockCount) low = mid + 1;
    else high = mid;
  }
  return low;
};

const sameLinks = (
  next: Map<string, { href: string; title?: string }>,
  prev: Map<string, { href: string; title?: string }>,
): boolean => {
  if (next.size !== prev.size) return false;
  for (const [label, link] of next) {
    const old = prev.get(label);
    if (!old || old.href !== link.href || old.title !== link.title) return false;
  }
  return true;
};

/** 脚注定义原文的指纹：定义不变才敢复用尾部块里的脚注编号 */
const footnoteSignature = (defs: Map<string, SourceLine[]>): string => {
  if (!defs.size) return "";
  const parts: string[] = [];
  for (const [id, lines] of defs) parts.push(`${id}\u0001${lines.map((line) => line.text).join("\n")}`);
  return parts.join("\u0002");
};

/**
 * 尾部块随改动整体平移。
 *
 * 平移必须落到对象上（而不是沿用旧对象）：下一次增量解析要靠这些 `line` / `start`
 * 判断哪一段是安全的公共后缀。容器里的嵌套块（列表项、引用、callout）同样带绝对
 * 偏移与任务勾选偏移，必须一起平移，否则 AST 会和新文本对不上。
 * 子节点内容共享引用，渲染层的块级 memo 只在内容和行号真的变了时才重画
 * （`data-offset` 允许滞后，见 MarkdownPreview 的说明）。
 */
const shiftBlockTree = (block: BlockNode, delta: number, lineDelta: number): BlockNode => {
  const base = {
    start: block.start + delta,
    end: block.end + delta,
    line: block.line + lineDelta,
  };
  if (block.type === "list") {
    return {
      ...block,
      ...base,
      items: block.items.map((item) => ({
        ...item,
        line: item.line + lineDelta,
        taskOffset: item.taskOffset >= 0 ? item.taskOffset + delta : item.taskOffset,
        children: item.children.map((child) => shiftBlockTree(child, delta, lineDelta)),
      })),
    };
  }
  if (block.type === "blockquote" || block.type === "callout") {
    return {
      ...block,
      ...base,
      children: block.children.map((child) => shiftBlockTree(child, delta, lineDelta)),
    };
  }
  return { ...block, ...base };
};

const shiftTailBlocks = (blocks: BlockNode[], delta: number, lineDelta: number): BlockNode[] => {
  if (delta === 0 && lineDelta === 0) return blocks.slice();
  return blocks.map((block) => shiftBlockTree(block, delta, lineDelta));
};

/**
 * 窗口里最后一个 callout 是否真的闭合了。
 *
 * `!!!` / `???` 没有结尾记号时会一路吞到文末。窗口解析把行截断在窗口边界，
 * 于是「未闭合」和「刚好在窗口末尾闭合」在 AST 上长得一样；若此时复用尾部块，
 * 就会和整篇解析（尾部全被吞进 callout）分叉。这里按解析器同一套规则，
 * 只在窗口范围内找结尾记号，找不到就不敢复用尾部。
 */
const calloutClosedInWindow = (
  lines: SourceLine[],
  block: BlockNode & { type: "callout" },
  windowStart: number,
  limit: number,
): boolean => {
  const headerIndex = block.line - 1 - windowStart;
  const header = CALLOUT_OPEN.exec(lines[headerIndex]?.text ?? "");
  if (!header) return true;
  const marker = header[1];
  for (let index = headerIndex + 1; index < limit; index += 1) {
    if ((lines[index]?.text ?? "").replace(/^ {0,3}/, "").trim() === marker) return true;
  }
  return false;
};

/**
 * 窗口里最后一个围栏 / 数学块是否在窗口内闭合。
 *
 * 与 callout 同理：未闭合的围栏在窗口边界会被截断，AST 上看起来像正常结束；
 * 若仍接回尾部，整篇解析里本来吞掉尾部的围栏就被漏掉了。缩进代码不在此列，
 * 它由「尾部首行是否缩进」的边界检查负责。
 */
const fenceClosedInWindow = (
  lines: SourceLine[],
  block: BlockNode,
  windowStart: number,
  limit: number,
): boolean => {
  const headerIndex = block.line - 1 - windowStart;
  if (headerIndex < 0 || headerIndex >= limit) return true;
  if (block.type === "math") {
    const header = /^ {0,3}\$\$(.*)$/.exec(lines[headerIndex]?.text ?? "");
    if (!header || /\$\$\s*$/.test(header[1])) return true;
    for (let index = headerIndex + 1; index < limit; index += 1) {
      if (/^ {0,3}\$\$\s*$/.test(lines[index]?.text ?? "")) return true;
    }
    return false;
  }
  if (block.type !== "code" || !block.fence) return true;
  for (let index = headerIndex + 1; index < limit; index += 1) {
    if (isFenceClose(lines[index]?.text ?? "", block.fence[0], block.fence.length)) return true;
  }
  return false;
};

/**
 * 增量解析：只重排改动窗口里的顶层块，其余块复用上一份 AST。
 *
 * 返回 null 表示这次改动不适合增量（换了全文、改到了跨块状态、窗口边界无法确认），
 * 调用方退回 `parseMarkdown` 即可，正确性不受影响。
 *
 * 窗口的取法（行号 0 基）：
 * - 起点 S 是一块的起始行，且 S-1 是未被改动的空行（或 S 是首块）——
 *   空行保证前一块的段落/列表/引用已经结束，改动不会反向吞并它；
 * - 终点 R 同样落在「空行之后的新块起点」，R 之后的行原样复用；
 * - 窗口内用完整解析器重排（行号、偏移都是绝对的），因此嵌套列表、表格、
 *   围栏代码这些跨行结构的判断与整篇解析完全一致。
 */
export function parseMarkdownIncremental(
  previous: {
    text: string;
    doc: ParsedDocument;
    /** 与 `doc` 配套的切行结果：调用方缓存好了就省掉一次全文切行 */
    lines?: readonly string[];
    offsets?: Float64Array;
  },
  nextText: string,
  options: { allowHtml?: boolean; breaks?: boolean } = {},
  nextCache?: { lines: readonly string[]; offsets: Float64Array },
): ParsedDocument | null {
  const prevText = previous.text;
  const prevDoc = previous.doc;
  if (prevText === nextText) return prevDoc;
  if (!prevText || !nextText) return null;
  // 整篇解析会先归一化 CRLF；增量路径直接按 \n 切行，遇到 CR 就不掺和
  if (prevText.includes("\r") || nextText.includes("\r")) return null;

  const prevLines = previous.lines ?? splitLines(prevText);
  const nextLines = nextCache?.lines ?? splitLines(nextText);
  const { first, oldEnd, newEnd } = diffLineRange(prevLines, nextLines);
  if (first >= prevLines.length && first >= nextLines.length) return prevDoc;
  const lineDelta = nextLines.length - prevLines.length;
  const delta = nextText.length - prevText.length;
  const prevOffsets = previous.offsets ?? lineOffsets(prevText);
  const nextOffsets = nextCache?.offsets ?? lineOffsets(nextText);

  // front matter 在文首，改到它（或改出新的开头分割线）就整篇重来
  if (first === 0) {
    if (prevDoc.frontmatter || /^ {0,3}---[ \t]*$/.test(nextLines[0] ?? "")) return null;
  } else if (prevDoc.frontmatter) {
    const frontLines = prevDoc.frontmatter.raw ? prevDoc.frontmatter.raw.split("\n").length + 2 : 2;
    if (first < frontLines) return null;
  }

  if (touchesGlobalState(prevLines, first, oldEnd)) return null;
  if (touchesGlobalState(nextLines, first, newEnd)) return null;

  const prevBlocks = prevDoc.blocks;
  const firstLineStart = prevOffsets[first] ?? prevText.length;

  /* ---- 窗口起点：向前退到「前面是空行」的块边界 ---- */
  let head = 0;
  while (head < prevBlocks.length && prevBlocks[head].end <= firstLineStart) head += 1;

  let startLine: number;
  let headCount: number;
  if (head >= prevBlocks.length) {
    // 改动落在全篇最后一块之后（文末输入 / 尾部空白）
    const last = prevBlocks.length - 1;
    if (last < 0) {
      startLine = 0;
      headCount = 0;
    } else {
      const endLine = lineIndexAt(prevOffsets, prevLines.length, prevBlocks[last].end);
      if (endLine + 1 < first && blank(prevLines[endLine + 1] ?? "")) {
        startLine = first;
        headCount = prevBlocks.length;
      } else {
        startLine = prevBlocks[last].line - 1;
        headCount = last;
      }
    }
  } else {
    let q = head;
    while (q > 0) {
      const line = prevBlocks[q].line - 1;
      if (line <= first && line > 0 && blank(prevLines[line - 1] ?? "")) break;
      q -= 1;
    }
    if (q === 0) {
      const line = prevBlocks[0].line - 1;
      // 改动可能发生在首块之前的空白里：窗口从文首开始
      startLine = line <= first ? line : 0;
    } else {
      startLine = prevBlocks[q].line - 1;
    }
    headCount = q;
  }

  /* ---- 窗口终点：第一个「前一行是未改动空行」的尾块 ---- */
  let resume = prevBlocks.length;
  let resumeOldLine = prevLines.length;
  for (let i = 0; i < prevBlocks.length; i += 1) {
    const line = prevBlocks[i].line - 1;
    if (line <= oldEnd) continue;
    if (blank(prevLines[line - 1] ?? "")) {
      resume = i;
      resumeOldLine = line;
      break;
    }
  }
  const endLine = resume < prevBlocks.length ? resumeOldLine + lineDelta : nextLines.length;

  /* ---- 定义扫描：与整篇解析同一套规则 ---- */
  /*
   * 有定义时才切全文逐行扫描；没有 front matter / 引用定义 / 脚注的文档，
   * 改动行又已经被 touchesGlobalState 挡过一遍，不可能凭空长出定义，
   * 窗口直接按行号构造即可（省掉每键一次全文切行 + 全行正则）。
   */
  const hasDefinitions =
    prevDoc.links.size > 0 || prevDoc.footnotes.length > 0 || prevDoc.frontmatter !== null;
  let windowSource: SourceLine[];
  let definitionState: ParseState;
  let frontmatter: ParsedDocument["frontmatter"] = null;
  if (hasDefinitions) {
    const scanned = toLines(nextText);
    definitionState = {
      links: new Map(),
      footnoteDefs: new Map(),
      footnoteIndex: new Map(),
      footnoteOrder: [],
      slugs: new Map(),
      outline: [],
      allowHtml: options.allowHtml ?? true,
      breaks: options.breaks ?? false,
    } satisfies ParseState;
    frontmatter = extractDefinitions(scanned, definitionState).frontmatter;
    windowSource = scanned.slice(startLine, endLine);

    if (!sameLinks(definitionState.links, prevDoc.links)) return null;
    if (definitionState.footnoteDefs.size || prevDoc.footnotes.length) {
      const previousDefinitions = {
        links: new Map(),
        footnoteDefs: new Map(),
        footnoteIndex: new Map(),
        footnoteOrder: [],
        slugs: new Map(),
        outline: [],
        allowHtml: true,
        breaks: false,
      } satisfies ParseState;
      extractDefinitions(toLines(prevText), previousDefinitions);
      if (
        footnoteSignature(definitionState.footnoteDefs) !==
        footnoteSignature(previousDefinitions.footnoteDefs)
      ) {
        return null;
      }
    }
  } else {
    definitionState = {
      links: new Map(),
      footnoteDefs: new Map(),
      footnoteIndex: new Map(),
      footnoteOrder: [],
      slugs: new Map(),
      outline: [],
      allowHtml: options.allowHtml ?? true,
      breaks: options.breaks ?? false,
    } satisfies ParseState;
    windowSource = toWindowLines(nextText, startLine, endLine);
  }

  /* ---- 重排窗口 ---- */
  const st: ParseState = {
    links: definitionState.links,
    footnoteDefs: definitionState.footnoteDefs,
    footnoteIndex: new Map(prevDoc.footnotes.map((item) => [item.id, item.index])),
    footnoteOrder: prevDoc.footnotes.map((item) => item.id),
    slugs: new Map(),
    outline: [],
    allowHtml: options.allowHtml ?? true,
    breaks: options.breaks ?? false,
  };
  const prevHeadings = headingIndexOf(prevDoc);
  const headingStart = headingCountBefore(prevHeadings, headCount);
  const headingEnd = headingCountBefore(prevHeadings, resume);
  /*
   * 只给「窗口里本来就有标题」的情况播种。窗口没有标题时，空 slug 表就能用；
   * 如果新窗口凭空长出标题，后面的标题序列校验会直接退回整篇解析。
   */
  if (headingEnd > headingStart) {
    const needed = new Set(prevHeadings.bases.slice(headingStart, headingEnd));
    const counts = new Map<string, number>();
    for (let index = 0; index < headingStart; index += 1) {
      const base = prevHeadings.bases[index];
      if (needed.has(base)) counts.set(base, (counts.get(base) ?? 0) + 1);
    }
    for (const [base, count] of counts) st.slugs.set(base, count);
  }

  const windowBlocks = parseBlocks(windowSource, st, 0);

  /*
   * 窗口起点同样是「可吞并」边界：复用的头部若以列表/缩进代码结尾，
   * 窗口里新起的列表或缩进行会被它跨空行收走。整篇解析会合并，
   * 增量却分成两个块，所以这种边界直接放弃增量。
   */
  if (headCount > 0) {
    const headLast = prevBlocks[headCount - 1];
    let firstLine = startLine;
    while (firstLine < endLine && blank(nextLines[firstLine] ?? "")) firstLine += 1;
    const firstIndented = /^[ \t]/.test(nextLines[firstLine] ?? "");
    if (headLast?.type === "list" && (windowBlocks[0]?.type === "list" || firstIndented)) return null;
    if (headLast?.type === "code" && firstIndented) return null;
  }

  // 窗口末尾若被某个未闭合结构（围栏 / callout）吞掉，尾部块就不能接回来
  if (resume < prevBlocks.length) {
    const blankLine = endLine - 1;
    const blankStart = nextOffsets[blankLine] ?? nextText.length;
    const lastBlock = windowBlocks[windowBlocks.length - 1];
    if (lastBlock && lastBlock.end > blankStart) return null;
    if (lastBlock && lastBlock.type === "callout" && !calloutClosedInWindow(windowSource, lastBlock, startLine, endLine - startLine)) {
      return null;
    }
    if (
      lastBlock &&
      (lastBlock.type === "code" || lastBlock.type === "math") &&
      !fenceClosedInWindow(windowSource, lastBlock, startLine, endLine - startLine)
    ) {
      return null;
    }
    /*
     * 列表与缩进代码可以跨空行继续吞内容：窗口里刚起的列表，会把尾部开头的
     * 缩进行收成自己的子块，也会和尾部另一个列表合并（整篇解析确实如此），
     * 尾部块就不能当作独立块复用。
     */
    const tailFirst = prevBlocks[resume];
    if (
      lastBlock &&
      (lastBlock.type === "list" || lastBlock.type === "code") &&
      (tailFirst?.type === "list" || /^[ \t]/.test(nextLines[endLine] ?? ""))
    ) {
      return null;
    }
  }

  // 标题序列是锚点去重的输入：窗口里的标题集合变了，尾部块的 id 就不再可信
  const windowHeadings = collectHeadingBases(windowBlocks);
  if (!sameStrings(prevHeadings.bases.slice(headingStart, headingEnd), windowHeadings)) {
    return null;
  }

  // 同理，脚注引用序列变了，全篇编号都会重排，尾部块里的序号与脚注表必须作废
  const nextWindowRefs = collectFootnoteRefs(windowBlocks);
  if (
    (prevDoc.footnotes.length > 0 || nextWindowRefs.length > 0) &&
    !sameStrings(collectFootnoteRefs(prevBlocks.slice(headCount, resume)), nextWindowRefs)
  ) {
    return null;
  }


  const shiftedTail = shiftTailBlocks(prevBlocks.slice(resume), delta, lineDelta);
  const blocks = [
    ...prevBlocks.slice(0, headCount),
    ...windowBlocks,
    ...shiftedTail,
  ];

  // 大纲按行号有序：用二分切出「窗口前 / 窗口后」，避免每次按键过滤整个大纲
  const outlineCut = (target: number): number => {
    let low = 0;
    let high = prevDoc.outline.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (prevDoc.outline[mid].line - 1 < target) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  const outline = [
    ...prevDoc.outline.slice(0, outlineCut(startLine)),
    ...st.outline,
    ...prevDoc.outline.slice(outlineCut(resumeOldLine)).map((item) => ({
      ...item,
      line: item.line + lineDelta,
    })),
  ];

  // 脚注定义可能整段落在窗口外：仍然按新文本重新解析（定义本身已确认没变）
  const order = [...st.footnoteOrder];
  for (const id of st.footnoteDefs.keys()) if (!order.includes(id)) order.push(id);
  const footnotes = order.map((id, index) => ({
    id,
    label: String(index + 1),
    index: index + 1,
    children: st.footnoteDefs.has(id) ? parseBlocks(st.footnoteDefs.get(id)!, st, 1) : [],
  }));

  const result: ParsedDocument = {
    blocks,
    frontmatter,
    outline,
    footnotes,
    links: definitionState.links,
  };
  const blockShift = windowBlocks.length - (resume - headCount);
  headingIndexes.set(result, {
    bases: [
      ...prevHeadings.bases.slice(0, headingStart),
      ...windowHeadings,
      ...prevHeadings.bases.slice(headingEnd),
    ],
    blockIndexes: [
      ...prevHeadings.blockIndexes.slice(0, headingStart),
      ...buildHeadingIndex(windowBlocks).blockIndexes.map((index) => index + headCount),
      ...prevHeadings.blockIndexes.slice(headingEnd).map((index) => index + blockShift),
    ],
  });
  return result;
}
