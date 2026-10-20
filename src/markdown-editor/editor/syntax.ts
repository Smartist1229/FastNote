/**
 * 编辑区的代码块识别与语法着色。
 *
 * 编辑区是 contenteditable：往行里塞 `<span class="hljs-*">` 会把一行拆成多个文本节点，
 * 输入法组合、浏览器选区、React 的重新渲染三者会互相踩，表现为「高亮忽有忽无、光标乱跳」。
 * 所以这里和查找高亮走同一条路——只算「第几行、第几个字符到第几个字符、属于哪类 token」，
 * 由上层换成 `Range` 交给 `::highlight()` 画颜色，DOM 一个节点都不动（颜色也不影响字宽）。
 *
 * 另一件事是「哪些行属于代码块」：`scanFences` 扫全文的围栏（``` / ~~~），
 * 得到每块的起止行与语言，编辑区据此给整块铺那层很浅的底色。
 */
import { highlightCode } from "../render/highlight";

/** token 类别：与 `CodeThemeColors` 的键一一对应，也是 `--mde-tok-*` 的后缀 */
export type SyntaxToken =
  | "keyword"
  | "string"
  | "number"
  | "comment"
  | "function"
  | "variable"
  | "type"
  | "tag"
  | "attr"
  | "builtin"
  | "literal"
  | "meta"
  | "punctuation"
  | "addition"
  | "deletion";

/** 全部类别（注入 `::highlight()` 规则时按这张表遍历） */
export const SYNTAX_TOKENS: SyntaxToken[] = [
  "keyword",
  "string",
  "number",
  "comment",
  "function",
  "variable",
  "type",
  "tag",
  "attr",
  "builtin",
  "literal",
  "meta",
  "punctuation",
  "addition",
  "deletion",
];

/** highlight.js 的类名后缀 → 上面的类别（未列出的类名不单独着色，沿用外层） */
const HLJS_TOKENS: Record<string, SyntaxToken> = {
  keyword: "keyword",
  "selector-tag": "keyword",
  doctag: "keyword",
  string: "string",
  regexp: "string",
  char: "string",
  "template-string": "string",
  number: "number",
  comment: "comment",
  quote: "comment",
  title: "function",
  section: "function",
  "selector-id": "function",
  variable: "variable",
  "template-variable": "variable",
  params: "variable",
  type: "type",
  tag: "tag",
  name: "tag",
  "selector-class": "tag",
  attr: "attr",
  attribute: "attr",
  built_in: "builtin",
  "builtin-name": "builtin",
  literal: "literal",
  meta: "meta",
  punctuation: "punctuation",
  operator: "punctuation",
  addition: "addition",
  deletion: "deletion",
};

/** 一个围栏代码块；`close` 未闭合时等于最后一行的下标 */
export interface CodeFence {
  /** 起始围栏行（含），0 基 */
  open: number;
  /** 结束围栏行（含），0 基 */
  close: number;
  /** info string 里的语言，可能是别名或空 */
  lang: string;
  /** 有没有遇到收尾围栏 */
  closed: boolean;
}

/** 行内一段 token：[from, to) 是这一行的列号 */
export interface TokenSpan {
  from: number;
  to: number;
  token: SyntaxToken;
}

/** 围栏行：0~3 个前导空格 + 至少三个反引号/波浪号 + 其余内容 */
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * 扫出全文的围栏代码块（和预览区同一套规则）：
 * - 收尾围栏必须是同一种字符、长度不短于开头、后面不再有内容；
 * - 反引号围栏的 info string 里不能再出现反引号（否则那是行内代码）；
 * - 没闭合的块一路延伸到文末，照样算代码块。
 */
export const scanFences = (lines: string[]): CodeFence[] => {
  const fences: CodeFence[] = [];
  let open: { line: number; marker: string; lang: string } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const match = FENCE_RE.exec(lines[index] ?? "");
    if (!open) {
      if (!match) continue;
      const marker = match[1];
      const info = match[2].trim();
      if (marker[0] === "`" && info.includes("`")) continue;
      open = { line: index, marker, lang: info.split(/\s+/)[0] ?? "" };
      continue;
    }
    if (
      match &&
      match[1][0] === open.marker[0] &&
      match[1].length >= open.marker.length &&
      match[2].trim() === ""
    ) {
      fences.push({ open: open.line, close: index, lang: open.lang, closed: true });
      open = null;
    }
  }

  if (open) fences.push({ open: open.line, close: Math.max(0, lines.length - 1), lang: open.lang, closed: false });
  return fences;
};

/** 某一行的围栏归属：`open` / `close` 是围栏行本身，`body` 是代码行 */
export type FenceRole = "open" | "body" | "close";

/** 取 [from, to) 行范围内的围栏归属表；一次只算可视区间，长文档不会被整篇扫两遍 */
export const collectFenceRows = (
  fences: CodeFence[],
  from: number,
  to: number,
): Map<number, FenceRole> => {
  const map = new Map<number, FenceRole>();
  for (const fence of fences) {
    if (fence.close < from || fence.open >= to) continue;
    const start = Math.max(from, fence.open);
    const end = Math.min(to - 1, fence.close);
    for (let line = start; line <= end; line += 1) {
      if (line === fence.open) map.set(line, "open");
      else if (line === fence.close && fence.closed) map.set(line, "close");
      else map.set(line, "body");
    }
  }
  return map;
};

/**
 * 把 highlight.js 的输出按行拆成 token 段。
 *
 * 解析的是它自己生成的 HTML（`<span class="hljs-keyword">`），不另写一套语法分析。
 * 输出里除了 `<span>` 只有转义后的文本，`DOMParser` 足够；解析在独立的 document 里做，
 * 不会碰真实 DOM。
 */
const parseTokens = (html: string, firstLine: number): Map<number, TokenSpan[]> => {
  const result = new Map<number, TokenSpan[]>();
  if (!html || !html.includes("<span")) return result;

  const parsed = new DOMParser().parseFromString(`<div id="mde-syntax">${html}</div>`, "text/html");
  const root = parsed.getElementById("mde-syntax");
  if (!root) return result;

  let line = firstLine;
  let column = 0;

  const visit = (node: Node, token: SyntaxToken | null): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? "";
      if (!text) return;
      for (let index = 0; index < text.length; index += 1) {
        if (text[index] === "\n") {
          line += 1;
          column = 0;
          continue;
        }
        if (token) {
          const spans = result.get(line);
          const last = spans?.[spans.length - 1];
          // 相邻同类 token 合成一段，少建几百个 Range
          if (last && last.to === column && last.token === token) last.to = column + 1;
          else if (spans) spans.push({ from: column, to: column + 1, token });
          else result.set(line, [{ from: column, to: column + 1, token }]);
        }
        column += 1;
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const cls = Array.from(element.classList).find((name) => name.startsWith("hljs-"));
    const next = (cls && HLJS_TOKENS[cls.slice(5)]) || token;
    element.childNodes.forEach((child) => visit(child, next));
  };

  root.childNodes.forEach((child) => visit(child, null));
  return result;
};

/**
 * 高亮一个围栏块里 [from, to) 这些行，返回每行的 token 段。
 *
 * 着色以整块为单位算（单行算会丢上下文，块注释、多行字符串都会错位），
 * 但只把可视行的结果交出去。没有语言标记或 highlight.js 不可用时返回空表。
 */
export const highlightFenceRows = async (
  fence: CodeFence,
  lines: string[],
  from: number,
  to: number,
  enabled: boolean,
): Promise<Map<number, TokenSpan[]>> => {
  const bodyStart = fence.open + 1;
  const bodyEnd = Math.max(bodyStart, fence.close);
  if (bodyEnd <= bodyStart || !fence.lang) return new Map();
  if (to <= bodyStart || from > bodyEnd) return new Map();

  const code = lines.slice(bodyStart, bodyEnd).join("\n");
  if (!code) return new Map();

  const html = await highlightCode(code, fence.lang, enabled);
  const parsed = parseTokens(html, bodyStart);
  if (!parsed.size) return parsed;

  // 只留可视区间，其余段本来也画不到
  const visible = new Map<number, TokenSpan[]>();
  for (let line = Math.max(from, bodyStart); line < Math.min(to, bodyEnd); line += 1) {
    const spans = parsed.get(line);
    if (spans?.length) visible.set(line, spans);
  }
  return visible;
};

/** `::highlight()` 的名字前缀：MarkdownEditor 按主题注入对应颜色（见 theme.ts） */
export const syntaxHighlightName = (token: SyntaxToken): string => `mde-syn-${token}`;
