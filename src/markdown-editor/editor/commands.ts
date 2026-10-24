/**
 * 编辑命令层：`EditState` → `EditState` 的纯函数。
 *
 * 为什么单独抽出来：工具栏、快捷键、命令式 API 都走同一套命令，
 * 而它们都不该关心光标在 contenteditable 编辑区还是预览区里。
 * 纯函数也方便直接写回归测试。
 *
 * 约定：
 * - `start` / `end` 是选区字符偏移，折叠光标时两者相等；
 * - 返回 `null` 表示该命令不属于文本改写（撤销、切换模式、复制等由组件处理）；
 * - 行级命令（标题、列表、缩进）会保持光标相对位置，而不是把整段重新选中。
 */
import type { ToolbarItemName } from "../types";
import { countLines, lineAtOffset } from "./lines";

export interface EditState {
  text: string;
  start: number;
  end: number;
}

export interface CommandOptions {
  tabSize: number;
  labels: Record<string, string>;
}

/** 片段里的光标占位符（不可能出现在正常文本里） */
const CARET = "\u0000";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 行首位置（pos 所在行的起始偏移） */
const lineStartOf = (text: string, pos: number): number => {
  const index = text.lastIndexOf("\n", Math.max(0, pos - 1));
  return index < 0 ? 0 : index + 1;
};

/** 行尾位置（pos 所在行的结束偏移，不含换行） */
const lineEndOf = (text: string, pos: number): number => {
  const index = text.indexOf("\n", pos);
  return index < 0 ? text.length : index;
};

/** 选区覆盖的完整行区间 */
const lineRange = (state: EditState): { from: number; to: number; lines: string[] } => {
  const from = lineStartOf(state.text, state.start);
  // 选区正好落在行首时，不要把下一行也算进来
  const endPos = state.end > state.start && state.text[state.end - 1] === "\n" ? state.end - 1 : state.end;
  const to = lineEndOf(state.text, endPos);
  return { from, to, lines: state.text.slice(from, to).split("\n") };
};

/** 逐行改写，并按行增量映射光标/选区 */
const rewriteLines = (state: EditState, transform: (lines: string[]) => string[]): EditState => {
  const { from, to, lines } = lineRange(state);
  const nextLines = transform(lines);
  const nextSegment = nextLines.join("\n");
  const nextText = state.text.slice(0, from) + nextSegment + state.text.slice(to);

  /** 计算某个绝对位置所在行的增量 */
  const deltaFor = (pos: number): number => {
    const lineIndex = clamp(state.text.slice(from, pos).split("\n").length - 1, 0, lines.length - 1);
    const before = lines[lineIndex] ?? "";
    const after = nextLines[lineIndex] ?? "";
    return after.length - before.length;
  };

  return {
    text: nextText,
    start: state.start + deltaFor(state.start),
    end: state.end === state.start ? state.start + deltaFor(state.start) : state.end + deltaFor(state.end),
  };
};

/** 选中文本时包裹，未选中时插入占位并选中占位 */
const wrapInline = (state: EditState, before: string, after: string, placeholder: string): EditState => {
  const { text, start, end } = state;
  if (start !== end) {
    const selected = text.slice(start, end);
    const nextText = text.slice(0, start) + before + selected + after + text.slice(end);
    return { text: nextText, start: start + before.length, end: end + before.length };
  }
  const nextText = text.slice(0, start) + before + placeholder + after + text.slice(end);
  return {
    text: nextText,
    start: start + before.length,
    end: start + before.length + placeholder.length,
  };
};

/** 插入片段：自动补换行（块级语法需要独立成行），并用 CARET 标记光标 */
const insertSnippet = (state: EditState, snippet: string, options?: { block?: boolean }): EditState => {
  const marker = snippet.indexOf(CARET);
  const clean = snippet.split(CARET).join("");

  let prefix = "";
  let suffix = "";
  const before = state.text.slice(0, state.start);
  if (options?.block) {
    // 只补最少的换行：前面不在行首就换一行，后面不在行首也只补一个换行。
    // 围栏/表格/公式按 CommonMark 都可以打断段落，不需要空行分隔。
    if (before && !before.endsWith("\n")) prefix = "\n";
    const after = state.text.slice(state.end);
    if (after && !after.startsWith("\n")) suffix = "\n";
  }

  const nextText = before + prefix + clean + suffix + state.text.slice(state.end);
  const caret =
    marker >= 0 ? state.start + prefix.length + marker : state.start + prefix.length + clean.length;
  return { text: nextText, start: caret, end: caret };
};

/** 行级前缀开关：全部已带则去掉，否则补上 */
const toggleLinePrefix = (
  state: EditState,
  prefixFor: (line: string, index: number) => string,
  pattern: RegExp,
): EditState =>
  rewriteLines(state, (lines) => {
    const contentLines = lines.filter((line) => line.trim() !== "");
    // 光标落在空行（或空文档）时也要有反应：直接在当前行插入前缀，
    // 否则「点引用/列表按钮毫无变化」，这是报障过的真实场景
    if (!contentLines.length) {
      return lines.map((line, index) => (index === 0 ? prefixFor(line, 0) : line));
    }
    const allHave = contentLines.every((line) => pattern.test(line));
    return lines.map((line, index) => {
      if (!line.trim()) return line;
      if (allHave) return line.replace(pattern, "");
      return prefixFor(line, index) + line.replace(pattern, "");
    });
  });

/* ---------------- 具体命令 ---------------- */

/** 标题：level=0 表示还原为正文；再点一次同级标题则取消 */
export const applyHeading = (state: EditState, level: 0 | 1 | 2 | 3 | 4 | 5 | 6): EditState =>
  rewriteLines(state, (lines) => {
    const headingPattern = /^(#{1,6})[ \t]+/;
    const sameLevel = level > 0 && lines.every((line) => new RegExp(`^#{${level}}[ \\t]+`).test(line));
    const target = sameLevel ? 0 : level;
    return lines.map((line) => {
      const stripped = line.replace(headingPattern, "");
      if (target === 0) return stripped;
      return `${"#".repeat(target)} ${stripped}`;
    });
  });

/** 有序/无序/任务列表 */
const applyList = (state: EditState, kind: "bullet" | "ordered" | "task"): EditState => {
  const pattern = kind === "task" ? /^[-*+][ \t]+\[[ xX]\][ \t]+/ : kind === "bullet" ? /^[-*+][ \t]+/ : /^\d{1,9}[.)][ \t]+/;
  let counter = 1;
  return toggleLinePrefix(
    state,
    () => {
      if (kind === "ordered") return `${counter++}. `;
      if (kind === "task") return "- [ ] ";
      return "- ";
    },
    pattern,
  );
};

/** 引用块范围：从当前行向上/向下扩展，允许块内空行（`>` 空行也算块内） */
const quoteBlockRange = (text: string, pos: number) => {
  let from = lineStartOf(text, pos);
  let to = lineEndOf(text, pos);
  const isQuote = (line: string) => /^[ \t]{0,3}>/.test(line);

  while (from > 0) {
    const prevEnd = from - 1;
    const prevStart = lineStartOf(text, prevEnd);
    if (!isQuote(text.slice(prevStart, prevEnd))) break;
    from = prevStart;
  }

  let cursor = to;
  while (cursor < text.length) {
    const nextStart = cursor + 1;
    const nextEnd = lineEndOf(text, nextStart);
    const nextLine = text.slice(nextStart, nextEnd);
    if (isQuote(nextLine)) {
      cursor = nextEnd;
      continue;
    }
    if (!nextLine.trim()) {
      const afterStart = nextEnd + 1;
      if (afterStart <= text.length) {
        const afterEnd = lineEndOf(text, afterStart);
        if (isQuote(text.slice(afterStart, afterEnd))) {
          cursor = afterEnd;
          continue;
        }
      }
    }
    break;
  }

  return { from, to: cursor, lines: text.slice(from, cursor).split("\n") };
};

/** 提示块：把当前段落转成 GFM Alert；同类型再点一次则取消 */
export const applyCallout = (state: EditState, kind: string): EditState => {
  const { text } = state;
  const label = `[!${kind.toUpperCase()}]`;
  const { from, to, lines } = quoteBlockRange(text, state.start);
  const strip = (line: string) => line.replace(/^[ \t]{0,3}>[ \t]?/, "");

  if (strip(lines[0]).trim() === label) {
    const rest = lines.slice(1);
    while (rest.length && !rest[0].trim()) rest.shift();
    const segment = rest.map(strip).join("\n");
    return { text: text.slice(0, from) + segment + text.slice(to), start: from, end: from + segment.length };
  }

  const segment = [`> ${label}`, "", ...lines.map((line) => `> ${strip(line)}`)].join("\n");
  return { text: text.slice(0, from) + segment + text.slice(to), start: from, end: from + segment.length };
};

/** `!!!` 提示块：有选区时把选区包进块内，无选区时插入占位并选中 */
export const applyAdmonition = (state: EditState, kind: string, title = ""): EditState => {
  const { text, start, end } = state;
  const header = `!!! ${kind}${title ? ` "${title}"` : ""}`;
  const selected = text.slice(start, end);
  const body = selected || "内容";
  const snippet = `${header}\n${body}\n!!!`;

  const before = text.slice(0, start);
  const after = text.slice(end);
  const prefix = before && !before.endsWith("\n") ? "\n" : "";
  const suffix = after && !after.startsWith("\n") ? "\n" : "";

  const bodyStart = start + prefix.length + header.length + 1;
  return {
    text: before + prefix + snippet + suffix + after,
    start: bodyStart,
    end: bodyStart + body.length,
  };
};

/** 缩进：整行加 tabSize 个空格 */
const applyIndent = (state: EditState, tabSize: number, outdent: boolean): EditState =>
  rewriteLines(state, (lines) =>
    lines.map((line) => {
      if (!line.trim()) return line;
      if (outdent) {
        const match = new RegExp(`^ {1,${tabSize}}`).exec(line);
        return match ? line.slice(match[0].length) : line.replace(/^\t/, "");
      }
      return " ".repeat(tabSize) + line;
    }),
  );

/** 链接：有选中 → 包住并选中地址；无选中 → 插入占位文本 */
const applyLink = (state: EditState, labels: Record<string, string>, image: boolean): EditState => {
  const { text, start, end } = state;
  const placeholder = labels.placeholderLink || "https://";
  const selected = text.slice(start, end);

  if (image) {
    const alt = selected || labels.placeholderText || "alt";
    const snippet = `![${alt}](${placeholder})`;
    const nextText = text.slice(0, start) + snippet + text.slice(end);
    const urlStart = start + 2 + alt.length + 2;
    return { text: nextText, start: urlStart, end: urlStart + placeholder.length };
  }

  if (selected) {
    const nextText = text.slice(0, start) + `[${selected}](${placeholder})` + text.slice(end);
    const urlStart = start + selected.length + 3;
    return { text: nextText, start: urlStart, end: urlStart + placeholder.length };
  }

  const labelText = labels.placeholderText || "text";
  const snippet = `[${labelText}](${placeholder})`;
  const nextText = text.slice(0, start) + snippet + text.slice(end);
  return { text: nextText, start: start + 1, end: start + 1 + labelText.length };
};

/** 表格模板 */
const tableSnippet = (rows: number, cols: number): string => {
  const header = `| ${Array.from({ length: cols }, (_, i) => `列 ${i + 1}`).join(" | ")} |`;
  const align = `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`;
  const body = Array.from({ length: rows }, () => `| ${Array.from({ length: cols }, () => "  ").join(" | ")} |`);
  return [header, align, ...body].join("\n");
};

/** 脚注：插入引用并在文末补定义 */
const applyFootnote = (state: EditState): EditState => {
  const used = new Set([...state.text.matchAll(/\[\^([^\]]+)\]/g)].map((m) => m[1]));
  let index = 1;
  while (used.has(String(index))) index++;
  const id = String(index);
  const ref = `[^${id}]`;
  const insertion = state.text.slice(0, state.start) + ref + state.text.slice(state.end);
  const definition = `\n\n[^${id}]: 脚注内容`;
  const hasTrailingNewline = insertion.endsWith("\n");
  const nextText = insertion + (hasTrailingNewline ? "" : "\n") + definition;
  const caret = state.start + ref.length;
  return { text: nextText, start: caret, end: caret };
};

/* ---------------- 文字颜色 / 底色 ---------------- */
/*
 * 颜色没有 Markdown 语法，只能落到行内 HTML。这里固定在一种写法：
 * `<font style="color:#e03131">文字</font>` / `<font style="background-color:#ffe066">文字</font>`。
 *
 * 用 `<font>` 而不是 `<span>` 的理由：行首出现标签时块解析器原本会整行当成 HTML 块
 * （和 `<div>` 同一路），于是 `<span…># 标题</span>` 既丢了标题样式也丢了行内解析——
 * 看起来就是「上了色标题没了」。这类短语级标签现在统一放行（见 parser/block.ts 的
 * INLINE_HTML_TAGS），标记留在标签**外面**，标题仍是标题。
 *
 * 依赖 `preview.allowHtml`（关掉时标签会原文显示）。后续的「改色 / 清色」全靠这条固定写法识别；
 * 读的时候顺带兼容早期写进笔记里的 `<span style="…">`（改色时就换成 `<font>`）。
 */
export type InlineColorProp = "color" | "background-color";

const COLOR_WRAP = "font";
/** 读取时兼容的标签名（写入永远只用 `<font>`） */
const COLOR_TAGS = "(?:font|span)";
const COLOR_OPEN_G = new RegExp(`<${COLOR_TAGS}\\s+style="([^"]*)">`, "g");
const COLOR_CLOSE_G = new RegExp(`</${COLOR_TAGS}\\s*>`, "g");

type ColorTagName = "font" | "span";

interface ColorFrame {
  name: ColorTagName;
  style: string;
  raw: string;
}

interface LocatedColorFrame extends ColorFrame {
  openStart: number;
  openEnd: number;
}

/** 从标签属性串里取 style（双引号、单引号都认）；没有 style 返回 null */
const styleAttrOf = (attrs: string): string | null => {
  const found = /\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  return found ? found[1] ?? found[2] ?? "" : null;
};

/** 把当前颜色标签栈摊平成一条 style，并覆写 / 删除目标属性 */
const mergedFrameStyle = (stack: ColorFrame[], prop: InlineColorProp, value: string | null): string => {
  const props = new Map<string, string>();
  for (const frame of stack) {
    for (const entry of frame.style.split(";")) {
      const colon = entry.indexOf(":");
      if (colon < 0) continue;
      const key = entry.slice(0, colon).trim().toLowerCase();
      const val = entry.slice(colon + 1).trim();
      if (key && val) props.set(key, val);
    }
  }
  if (value) props.set(prop, value);
  else props.delete(prop);
  return [...props].map(([key, val]) => `${key}:${val}`).join(";");
};

/** 从 style 串里读出某个属性的值 */
const readStyleProp = (style: string, prop: InlineColorProp): string | null => {
  const found = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+?)\\s*(?:;|$)`).exec(style);
  return found ? found[1] : null;
};

/**
 * 往 style 串里写属性（已有同名则替换），`value` 为 null 表示删掉这一条。
 * 返回改写后的结果；整串为空说明这个标签已经没有存在的意义，可以整块摘掉。
 */
const writeStyleProp = (style: string, prop: InlineColorProp, value: string | null): string => {
  const kept = style
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "" && !new RegExp(`^${prop}\\s*:`).test(entry));
  if (value) kept.push(`${prop}:${value}`);
  return kept.join(";");
};

/**
 * 行首的块标记：`# `、`> `、`- [ ] `、`1. ` 以及它们的叠加（`> - `、`> # `）。
 * 给整行上色时必须把它留在颜色标签**外面**，否则标记进了标签，它就不再是标记了。
 */
const BLOCK_MARKER =
  /^(?:(?:[ \t]{0,3}>[ \t]*)*(?:(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)(?:\[[ xX]\][ \t]+)?|#{1,6}[ \t]+)?)/;

/**
 * 行内标签处理完后，去掉「刚闭合又原样重开」留下的空壳标签。
 * 被删掉的标签会改变后面的字符偏移，所以传入的标记点要跟着左移；
 * 标记点若落在被删标签内部，就收到这个标签的起始位置（标签本身不属于选中文字）。
 */
const stripEmptyColorPairs = (text: string, marks: number[]): { text: string; marks: number[] } => {
  const emptyPair = /<(font|span)\b[^>]*><\/\1>/gi;
  let current = text;
  let points = marks;

  for (let pass = 0; pass < 4; pass += 1) {
    const removed: { start: number; end: number }[] = [];
    let next = "";
    let cursor = 0;
    for (const match of current.matchAll(emptyPair)) {
      if (!/style\s*=/i.test(match[0])) continue;
      const start = match.index ?? 0;
      const end = start + match[0].length;
      next += current.slice(cursor, start);
      cursor = end;
      removed.push({ start, end });
    }
    if (!removed.length) break;
    next += current.slice(cursor);
    points = points.map((point) => {
      let shift = 0;
      for (const range of removed) {
        if (point >= range.end) shift += range.end - range.start;
        else if (point > range.start) shift += point - range.start;
      }
      return point - shift;
    });
    current = next;
  }

  return { text: current, marks: points };
};

/**
 * 只改一行里 [from, to) 这一段的颜色。
 *
 * 核心不是「再给选区套一层」，而是**让位再接管**：
 * 进入选区时把还开着的颜色标签临时闭合，选区内按目标颜色重新发标签，
 * 离开选区时再把此刻仍然有效的原标签按原样打开。
 * 于是选区落在已有标签中间、跨过标签边界、连续改色，都不会出现同属性标签嵌套；
 * 选区内原有的颜色标签被吸收（非颜色样式保留），选区外一个字符都不动。
 *
 * 返回的 start / end 是选区在新行里的落点：只圈住原来的文字，
 * 新插入的开、闭标签留在选区外面——否则下一次改色会把闭合标签当成选中内容。
 */
const restyleLineColors = (
  line: string,
  from: number,
  to: number,
  prop: InlineColorProp,
  value: string | null,
): { text: string; start: number; end: number } => {
  if (from >= to || !line) return { text: line, start: from, end: to };

  const stack: ColorFrame[] = [];
  const out: string[] = [];
  let length = 0;
  let overlay: string | null = null;
  let detached = false;
  let mappedStart: number | null = null;
  let mappedEnd: number | null = null;

  const push = (chunk: string) => {
    out.push(chunk);
    length += chunk.length;
  };

  const closeOverlay = () => {
    if (overlay === null) return;
    push(`</${COLOR_WRAP}>`);
    overlay = null;
  };

  const ensureOverlay = () => {
    const style = mergedFrameStyle(stack, prop, value);
    if (style === (overlay ?? "")) return;
    closeOverlay();
    if (style) {
      push(`<${COLOR_WRAP} style="${style}">`);
      overlay = style;
    }
  };

  /** 进入选区：外层颜色标签先让位 */
  const enter = () => {
    if (detached) return;
    for (let i = stack.length - 1; i >= 0; i -= 1) push(`</${stack[i].name}>`);
    detached = true;
  };

  /** 离开选区：把此刻仍有效的标签重新打开 */
  const leave = () => {
    if (!detached) return;
    // 选区终点在收尾标签之前：先记下位置，再把临时标签关掉、原标签重开
    if (mappedEnd === null) mappedEnd = length;
    closeOverlay();
    for (const frame of stack) push(frame.raw);
    detached = false;
  };

  const pushRaw = (raw: string) => {
    if (!raw) return;
    // 原始行内标签可能和临时颜色标签交叉：先收临时标签，标签之后再按需重开
    if (detached) closeOverlay();
    push(raw);
  };

  const emitChunk = (chunk: string, chunkStart: number) => {
    if (!chunk) return;
    const cuts = [from, to]
      .filter((point) => point > chunkStart && point < chunkStart + chunk.length)
      .sort((a, b) => a - b);

    const emitPiece = (piece: string, pieceStart: number) => {
      if (!piece) return;
      if (pieceStart < from) {
        pushRaw(piece);
        return;
      }
      if (pieceStart >= to) {
        leave();
        pushRaw(piece);
        return;
      }
      enter();
      ensureOverlay();
      // 第一个被选中的字符：记在新建的开标签之后
      if (mappedStart === null) mappedStart = length;
      push(piece);
    };

    let offset = 0;
    for (const cut of cuts) {
      emitPiece(chunk.slice(offset, cut - chunkStart), chunkStart + offset);
      offset = cut - chunkStart;
    }
    emitPiece(chunk.slice(offset), chunkStart + offset);
  };

  const tagRe = /<(\/?)(font|span)\b([^>]*)>/gi;
  let cursor = 0;
  for (const match of line.matchAll(tagRe)) {
    const index = match.index ?? 0;
    emitChunk(line.slice(cursor, index), cursor);
    cursor = index + match[0].length;

    const name = match[2].toLowerCase() as ColorTagName;
    const inside = index >= from && index < to;

    if (match[1]) {
      const open = stack.map((frame) => frame.name).lastIndexOf(name);
      if (inside) {
        enter();
        if (open >= 0) stack.splice(open, 1);
      } else {
        leave();
        pushRaw(match[0]);
        if (open >= 0) stack.splice(open, 1);
      }
      continue;
    }

    const style = styleAttrOf(match[3]);
    if (style === null) {
      // 不带 style 的 font / span 与颜色无关，原样保留
      pushRaw(match[0]);
      continue;
    }

    if (inside) {
      enter();
      stack.push({ name, style, raw: match[0] });
    } else {
      leave();
      pushRaw(match[0]);
      stack.push({ name, style, raw: match[0] });
    }
  }
  emitChunk(line.slice(cursor), cursor);
  leave();

  // 选区结束在标签边界时，重开又立刻闭合会留下空壳，顺手收掉；
  // 清理会挪动偏移，选区落点一起跟着修
  const cleaned = stripEmptyColorPairs(out.join(""), [mappedStart ?? 0, mappedEnd ?? 0]);
  return { text: cleaned.text, start: cleaned.marks[0], end: cleaned.marks[1] };
};

/** 光标所在的、带某个颜色属性的最内层标签 */
const enclosingColorFrame = (
  text: string,
  pos: number,
  prop: InlineColorProp,
): LocatedColorFrame | null => {
  const from = lineStartOf(text, pos);
  const segment = text.slice(from, pos);
  const stack: LocatedColorFrame[] = [];

  for (const match of segment.matchAll(/<(\/?)(font|span)\b([^>]*)>/gi)) {
    if (match[1]) {
      const name = match[2].toLowerCase();
      const open = stack.map((frame) => frame.name).lastIndexOf(name as ColorTagName);
      if (open >= 0) stack.splice(open, 1);
      continue;
    }
    const style = styleAttrOf(match[3]);
    if (style === null) continue;
    const index = match.index ?? 0;
    stack.push({
      name: match[2].toLowerCase() as ColorTagName,
      style,
      raw: match[0],
      openStart: from + index,
      openEnd: from + index + match[0].length,
    });
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    if (readStyleProp(stack[i].style, prop)) return stack[i];
  }
  return null;
};

/** 从 pos 往后找该标签的闭合标签 */
const closingTagAfter = (
  text: string,
  pos: number,
  name: ColorTagName,
): { start: number; end: number } | null => {
  const re = new RegExp(`</${name}\\s*>`, "gi");
  re.lastIndex = pos;
  const match = re.exec(text);
  return match ? { start: match.index, end: match.index + match[0].length } : null;
};

/** 折叠光标：在已有颜色里改属性就改整个标签，否则插入一段带色占位文本 */
const applyCollapsedColor = (
  state: EditState,
  prop: InlineColorProp,
  value: string | null,
  placeholder: string,
): EditState => {
  const { text, start } = state;
  const frame = enclosingColorFrame(text, start, prop);

  if (!frame) {
    if (value === null) return state;
    return wrapInline(state, `<${COLOR_WRAP} style="${prop}:${value}">`, `</${COLOR_WRAP}>`, placeholder);
  }

  const close = closingTagAfter(text, start, frame.name);
  const nextStyle = writeStyleProp(frame.style, prop, value);

  if (!nextStyle) {
    // 属性删空：摘掉标签但保留中间的文字
    const openLength = frame.openEnd - frame.openStart;
    let nextText = text.slice(0, frame.openStart) + text.slice(frame.openEnd);
    let caret = start - openLength;
    if (close) {
      const closeStart = close.start - openLength;
      const closeEnd = close.end - openLength;
      nextText = nextText.slice(0, closeStart) + nextText.slice(closeEnd);
      if (caret >= closeStart) caret -= close.end - close.start;
    }
    const safe = Math.max(0, caret);
    return { text: nextText, start: safe, end: safe };
  }

  const open = `<${COLOR_WRAP} style="${nextStyle}">`;
  const delta = open.length - (frame.openEnd - frame.openStart);
  let nextText = text.slice(0, frame.openStart) + open + text.slice(frame.openEnd);
  let caret = start + delta;
  if (close) {
    const closeStart = close.start + delta;
    const closeEnd = close.end + delta;
    const replaced = `</${COLOR_WRAP}>`;
    nextText = nextText.slice(0, closeStart) + replaced + nextText.slice(closeEnd);
    if (caret > closeStart) caret += replaced.length - (close.end - close.start);
  }
  return { text: nextText, start: caret, end: caret };
};

/**
 * 给选区改 / 清颜色。
 *
 * 选区按行切开：行首块标记（`# `、`> `、`- [ ] `、`1. `）留在颜色标签外面，
 * 每行只改与选区相交的那一段，标签永远不会跨行。`value === null` 表示清除：
 * 无论颜色是这一次刚上的还是文档里本来就有的，都会从选区覆盖到的标签里摘掉。
 */
export const applyInlineColor = (
  state: EditState,
  prop: InlineColorProp,
  value: string | null,
  placeholder: string,
): EditState => {
  const { text, start, end } = state;
  if (start === end) return applyCollapsedColor(state, prop, value, placeholder);

  /** 拖选常常多带一个换行符，先摘掉再判断（不能把行尾 `\n` 包进标签） */
  const stop = text[end - 1] === "\n" ? end - 1 : end;
  if (start >= stop) return state;

  const from = lineStartOf(text, start);
  let lineStart = from;
  let replacement = "";
  /** 新文本里的选区落点：只圈住原来的文字，不含这次插入的标签 */
  let nextStart: number | null = null;
  let nextEnd: number | null = null;

  while (lineStart <= stop) {
    const lineEnd = lineEndOf(text, lineStart);
    const line = text.slice(lineStart, lineEnd);
    const visibleFrom = Math.max(start, lineStart);
    const visibleTo = Math.min(stop, lineEnd);

    if (visibleFrom < visibleTo) {
      const marker = BLOCK_MARKER.exec(line)?.[0] ?? "";
      const contentStart = lineStart + marker.length;
      const relFrom = Math.max(visibleFrom, contentStart) - contentStart;
      const relTo = Math.max(0, visibleTo - contentStart);
      const restyled = restyleLineColors(line.slice(marker.length), relFrom, relTo, prop, value);
      const base = from + replacement.length + marker.length;
      if (nextStart === null) nextStart = base + restyled.start;
      nextEnd = base + restyled.end;
      replacement += marker + restyled.text;
    } else {
      replacement += line;
    }

    if (lineEnd >= stop || lineEnd === text.length) break;
    replacement += "\n";
    lineStart = lineEnd + 1;
  }

  const replaceEnd = lineEndOf(text, stop);
  const nextText = text.slice(0, from) + replacement + text.slice(replaceEnd);
  return {
    text: nextText,
    start: clamp(nextStart ?? start, 0, nextText.length),
    end: clamp(nextEnd ?? end, 0, nextText.length),
  };
};

/**
 * 光标（或选区起点）连带处在哪些颜色标签里：返回那个属性的值，没有则 null。
 *
 * 只做一次前行内的标签配对——从行首扫到光标，开标签入栈、闭标签出栈；
 * 然后**自内向外**找第一个写了该属性的标签：底色在外层、字色在内层时两个都要能识别出来。
 * 这里刻意**不看后面有没有闭合**：半句话刚打完开标签的原始状态也该算「正带着这个颜色」。
 */
const detectInlineColor = (text: string, pos: number, prop: InlineColorProp): string | null => {
  const before = text.slice(lineStartOf(text, pos), pos);
  const stack: string[] = [];
  let cursor = 0;

  COLOR_OPEN_G.lastIndex = 0;
  COLOR_CLOSE_G.lastIndex = 0;
  while (cursor < before.length) {
    COLOR_OPEN_G.lastIndex = cursor;
    COLOR_CLOSE_G.lastIndex = cursor;
    const open = COLOR_OPEN_G.exec(before);
    const close = COLOR_CLOSE_G.exec(before);
    if (!open && !close) break;
    if (close && (!open || close.index < open.index)) {
      stack.pop();
      cursor = close.index + close[0].length;
    } else if (open) {
      stack.push(open[1]);
      cursor = open.index + open[0].length;
    } else {
      break;
    }
  }

  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const value = readStyleProp(stack[i], prop);
    if (value) return value;
  }
  return null;
};

/** 命令入口：返回 null 表示交给组件处理 */
export const runCommand = (
  state: EditState,
  name: ToolbarItemName,
  options: CommandOptions,
): EditState | null => {
  const { tabSize, labels } = options;
  switch (name) {
    case "bold":
      return wrapInline(state, "**", "**", "粗体文本");
    case "italic":
      return wrapInline(state, "_", "_", "斜体文本");
    case "strike":
      return wrapInline(state, "~~", "~~", "删除文本");
    case "underline":
      return wrapInline(state, "<u>", "</u>", "下划线");
    case "mark":
      return wrapInline(state, "==", "==", "高亮文本");
    case "sup":
      return wrapInline(state, "^", "^", "上标");
    case "sub":
      return wrapInline(state, "~", "~", "下标");
    case "inlineCode":
      return wrapInline(state, "`", "`", "代码");
    case "codeBlock": {
      const selected = state.text.slice(state.start, state.end);
      if (selected) {
        // 有选中：整段包进围栏，并把光标放到围栏起始处，方便补语言
        const snippet = "```\n" + selected + "\n```";
        const nextText = state.text.slice(0, state.start) + snippet + state.text.slice(state.end);
        const caret = state.start + 3;
        return { text: nextText, start: caret, end: caret };
      }
      return insertSnippet(state, "```\n" + CARET + "\n```", { block: true });
    }
    case "quote":
      return toggleLinePrefix(state, () => "> ", /^>[ \t]?/);
    case "alert": {
      const snippet = `> [!NOTE]\n> ${CARET}`;
      return insertSnippet(state, snippet, { block: true });
    }
    case "callout":
      return applyAdmonition(state, "warning");
    case "bulletList":
      return applyList(state, "bullet");
    case "orderedList":
      return applyList(state, "ordered");
    case "taskList":
      return applyList(state, "task");
    case "indent":
      return applyIndent(state, tabSize, false);
    case "outdent":
      return applyIndent(state, tabSize, true);
    case "link":
      return applyLink(state, labels, false);
    case "image":
      return applyLink(state, labels, true);
    case "table":
      return insertSnippet(state, tableSnippet(2, 3), { block: true });
    case "hr":
      // 只插入「--- + 换行」，多余空行让用户自己控制
      return insertSnippet(state, "---\n" + CARET, { block: true });
    case "math":
      return wrapInline(state, "$", "$", "公式");
    case "mathBlock":
      return insertSnippet(state, "$$\n" + CARET + "\n$$", { block: true });
    case "mermaid":
      return insertSnippet(
        state,
        "```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[结束]\n  B -->|否| A\n```",
        { block: true },
      );
    case "footnote":
      return applyFootnote(state);
    case "toc":
      return insertSnippet(state, "[TOC]", { block: true });
    case "heading": {
      // 无 level 信息时默认一级标题，实际由工具栏下拉调用 applyHeading
      return applyHeading(state, 1);
    }
    default:
      return null;
  }
};

/* ---------------- 回车续写 / 自动配对 ---------------- */

/** 回车时续写列表、任务、引用；返回 null 表示不拦截 */
export const continueMarkdownOnEnter = (
  text: string,
  caret: number,
  tabSize: number,
): { text: string; caret: number } | null => {
  const from = lineStartOf(text, caret);
  const to = lineEndOf(text, caret);
  const line = text.slice(from, to);
  // 只有光标在行尾才续写，行中间回车保持普通换行
  if (caret !== to) return null;

  const list = /^(\s*)([-*+]|\d{1,9}[.)])([ \t]+)(\[[ xX]\][ \t]+)?(.*)$/.exec(line);
  if (list) {
    const [, indent, marker, spaces, task, content] = list;
    if (!content.trim()) {
      // 空列表项回车 → 结束列表，去掉标记
      const nextText = text.slice(0, from) + indent + text.slice(to);
      const nextCaret = from + indent.length;
      return { text: nextText, caret: nextCaret };
    }
    const nextMarker = /\d/.test(marker)
      ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}`
      : marker;
    const nextTask = task !== undefined ? "[ ] " : "";
    const insertion = `\n${indent}${nextMarker}${spaces}${nextTask}`;
    return { text: text.slice(0, caret) + insertion + text.slice(caret), caret: caret + insertion.length };
  }

  const quote = /^(\s*>[ \t]?)(.*)$/.exec(line);
  if (quote && quote[2].trim() === "") {
    const nextText = text.slice(0, from) + quote[1].trimEnd() + text.slice(to);
    return { text: nextText, caret: from + Math.max(0, quote[1].length - 1) };
  }
  if (quote) {
    const insertion = `\n${quote[1]}`;
    return { text: text.slice(0, caret) + insertion + text.slice(caret), caret: caret + insertion.length };
  }

  // 其余情况不做处理（tabSize 预留给未来的多级缩进策略）
  void tabSize;
  return null;
};

const PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  '"': '"',
  "'": "'",
  "`": "`",
};

const CLOSERS = new Set(Object.values(PAIRS));

export interface AutoPairOptions {
  brackets: boolean;
  quotes: boolean;
  backticks: boolean;
}

/** 自动配对：返回 null 表示不拦截 */
export const autoPairOnInput = (
  text: string,
  caret: number,
  input: string,
  options: AutoPairOptions,
): { text: string; caret: number } | null => {
  const closer = PAIRS[input];
  if (!closer) {
    // 输入的是右半边：右侧已经是同一个符号 → 跳过，避免出现 )) 或 ]]
    if (CLOSERS.has(input) && text[caret] === input) return { text, caret: caret + 1 };
    return null;
  }
  if (input === "`" && !options.backticks) return null;
  if ((input === '"' || input === "'") && !options.quotes) return null;
  if (input !== "`" && input !== '"' && input !== "'" && !options.brackets) return null;
  // 引号既是开也是闭：右侧已有同符号时直接跳过
  if (text[caret] === input) return { text, caret: caret + 1 };

  return {
    text: text.slice(0, caret) + input + closer + text.slice(caret),
    caret: caret + input.length,
  };
};

/* ---------------- 统计 ---------------- */

/** 单词内部允许的连接符：`don't` / `state-of-art` 在词频统计里算一个词 */
const isWordJoin = (code: number): boolean => code === 39 || code === 45 || code === 8217;

/** 构成单词的字符：`[A-Za-z0-9_]` */
const isWordChar = (code: number): boolean =>
  (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;

/** CJK 汉字 / 假名 / 谚文：每个字算一个词 */
const isCjk = (code: number): boolean =>
  (code >= 0x3400 && code <= 0x4dbf) ||
  (code >= 0x4e00 && code <= 0x9fff) ||
  (code >= 0x3040 && code <= 0x30ff) ||
  (code >= 0xac00 && code <= 0xd7af);

/** 与正则 `\s` 对齐的空白判定（换行单独由 code === 10 处理） */
const isSpace = (code: number): boolean =>
  code === 32 ||
  code === 9 ||
  code === 11 ||
  code === 12 ||
  code === 13 ||
  code === 0xa0 ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200a) ||
  code === 0x2028 ||
  code === 0x2029 ||
  code === 0x202f ||
  code === 0x205f ||
  code === 0x3000 ||
  code === 0xfeff;

/**
 * 文档级统计（字数 / 字符 / 行数 / 段数 / 阅读时长）。
 *
 * 原来这一块是六条独立的全文扫描：两次 `match` 各产出一个几万项的数组，
 * 两次 `split` 各产出一份全文切分，外加一次 `replace` 复制整篇——
 * 每敲一个字都要付一遍，长文档上是稳稳的几十毫秒级抖动。
 *
 * 改成一遍扫描、零中间数组：词数、段数、去空格字数在同一个循环里累加出来。
 * 行数直接取共享切行缓存的结果，连这一次遍历都省掉。
 *
 * 段数的判定与 `split(/\n\s*\n/).filter(非空)` 等价：段是「连续非空行」的极大区间。
 */
export const computeDocStats = (
  text: string,
  readingSpeed = 400,
): {
  words: number;
  chars: number;
  charsNoSpace: number;
  lines: number;
  paragraphs: number;
  readingMinutes: number;
} => {
  let cjk = 0;
  let latin = 0;
  let paragraphs = 0;
  let charsNoSpace = 0;
  /** 当前行已经出现过实心字符 */
  let lineHasContent = false;
  /** 上一行是实心行 → 当前行与它同属一段 */
  let inParagraph = false;
  let inWord = false;
  /** 刚吃进连接符，后面紧跟的字母不算新词 */
  let joined = false;

  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 10) {
      inParagraph = lineHasContent;
      lineHasContent = false;
      inWord = false;
      joined = false;
      continue;
    }
    if (isSpace(code)) {
      inWord = false;
      joined = false;
      continue;
    }
    charsNoSpace += 1;
    if (!lineHasContent && !inParagraph) paragraphs += 1;
    lineHasContent = true;

    if (isCjk(code)) {
      cjk += 1;
      inWord = false;
      joined = false;
      continue;
    }
    if (isWordChar(code)) {
      if (!inWord && !joined) latin += 1;
      inWord = true;
      joined = false;
      continue;
    }
    if (isWordJoin(code)) {
      joined = inWord;
      inWord = false;
      continue;
    }
    inWord = false;
    joined = false;
  }

  const words = cjk + latin;
  return {
    words,
    chars: text.length,
    charsNoSpace,
    lines: countLines(text),
    paragraphs,
    readingMinutes: words === 0 ? 0 : Math.max(0.1, Math.round((words / Math.max(1, readingSpeed)) * 10) / 10),
  };
};

/**
 * 光标行列号（1 基）。
 *
 * 单独拆出来是为了让「挪光标」和「改文本」分别计价：光标移动时文本没变，
 * 共享切行缓存直接命中，二分定位是 O(log n)，不用再扫一遍全文。
 */
export const computeCursor = (text: string, caret: number): { line: number; column: number } => {
  if (!text) return { line: 1, column: 1 };
  const at = Math.max(0, Math.min(caret, text.length));
  const { line, start } = lineAtOffset(text, at);
  return { line: line + 1, column: at - start + 1 };
};

/** 完整统计：文档级部分 + 光标位置（对外 API 保持原签名） */
export const computeStats = (
  text: string,
  caret: number,
  readingSpeed = 400,
  selection = 0,
): {
  words: number;
  chars: number;
  charsNoSpace: number;
  lines: number;
  paragraphs: number;
  readingMinutes: number;
  cursor: { line: number; column: number; selection: number };
} => ({
  ...computeDocStats(text, readingSpeed),
  cursor: { ...computeCursor(text, caret), selection },
});

/** 光标所在行的格式状态：工具栏按钮高亮用 */
export interface ActiveFormats {
  heading: number | null;
  bold: boolean;
  italic: boolean;
  strike: boolean;
  mark: boolean;
  inlineCode: boolean;
  quote: boolean;
  bulletList: boolean;
  orderedList: boolean;
  taskList: boolean;
  /** 光标处生效的文字颜色；null = 当前没有上色 */
  textColor: string | null;
  /** 光标处生效的文字底色 */
  bgColor: string | null;
}

export const detectFormats = (text: string, start: number, end: number): ActiveFormats => {
  const from = lineStartOf(text, start);
  const line = text.slice(from, lineEndOf(text, start));
  const heading = /^(#{1,6})[ \t]+/.exec(line);

  /** 选区两侧（或选区内侧）是否被同一对定界符包住 */
  const wrapped = (token: string): boolean => {
    const before = text.slice(Math.max(0, start - token.length), start);
    const after = text.slice(end, end + token.length);
    if (before === token && after === token) return true;
    const innerBefore = text.slice(start, start + token.length);
    const innerAfter = text.slice(Math.max(0, end - token.length), end);
    return start !== end && innerBefore === token && innerAfter === token;
  };

  return {
    heading: heading ? heading[1].length : null,
    bold: wrapped("**"),
    italic: wrapped("_"),
    strike: wrapped("~~"),
    mark: wrapped("=="),
    inlineCode: wrapped("`"),
    quote: /^>[ \t]?/.test(line),
    bulletList: /^[-*+][ \t]+/.test(line),
    orderedList: /^\d{1,9}[.)][ \t]+/.test(line),
    taskList: /^[-*+][ \t]+\[[ xX]\][ \t]+/.test(line),
    // 颜色不在 `wrapped()` 那套定界符里：它们是带属性的标签，得单独做标签配对。
    // 有选区时看最后一个字符所在的位置：选中整段带色文字时，选区终点往往已经越过闭标签。
    textColor: detectInlineColor(text, start !== end ? end - 1 : end, "color"),
    bgColor: detectInlineColor(text, start !== end ? end - 1 : end, "background-color"),
  };
};
