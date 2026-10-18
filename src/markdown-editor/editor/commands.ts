/**
 * 编辑命令层：`EditState` → `EditState` 的纯函数。
 *
 * 为什么单独抽出来：工具栏、快捷键、命令式 API 都走同一套命令，
 * 而它们都不该关心光标在 textarea 还是实时预览的块编辑框里。
 * 纯函数也方便写回归测试（见 scripts/markdown-editor.test.mjs 的命令部分）。
 *
 * 约定：
 * - `start` / `end` 是选区字符偏移，折叠光标时两者相等；
 * - 返回 `null` 表示该命令不属于文本改写（撤销、切换模式、复制等由组件处理）；
 * - 行级命令（标题、列表、缩进）会保持光标相对位置，而不是把整段重新选中。
 */
import type { ToolbarItemName } from "../types";

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

/** 计算统计信息 */
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
} => {
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
  const latin = (text.match(/[A-Za-z0-9_]+(?:['’-][A-Za-z0-9_]+)*/g) || []).length;
  const lines = text ? text.split("\n").length : 0;
  const paragraphs = text ? text.split(/\n\s*\n/).filter((block) => block.trim()).length : 0;
  const words = cjk + latin;
  const line = text.slice(0, caret).split("\n").length;
  const column = caret - lineStartOf(text, caret) + 1;
  return {
    words,
    chars: text.length,
    charsNoSpace: text.replace(/\s/g, "").length,
    lines,
    paragraphs,
    readingMinutes: words === 0 ? 0 : Math.max(0.1, Math.round((words / Math.max(1, readingSpeed)) * 10) / 10),
    cursor: { line, column, selection },
  };
};

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
  };
};
