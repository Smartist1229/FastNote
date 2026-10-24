/**
 * 查找 / 替换的纯逻辑层（不碰 DOM、不依赖 React，便于单测与外部复用）。
 *
 * 语义对齐 VSCode：
 * - `findMatches` 按「区分大小写 / 正则」两种开关产出全部命中区间；
 * - 「下一个 / 上一个」以光标偏移为锚点在命中列表里跳转，到底后按 loop 回到另一端；
 * - 正则模式下替换串支持 `$1`~`$99`、`$&`、`$<name>`、`$$`，以及 `\n` `\t` `\r` `\\` 转义；
 * - `regexReplace` 再进一步：替换串里原样写下的查找正则会被当成「整个命中」的占位符，
 *   于是「查找 `[a-z]+`、替换 `-[a-z]+`」得到的是 `-原词`，而不是字面量 `-[a-z]+`。
 */
import { lineAtOffset } from "./lines";
export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
  /**
   * 替换串按正则展开（只在 `regex` 打开时生效）。
   *
   * 关掉时替换串是**字面量**：写什么就贴什么。
   * 打开时，替换串里凡是与查找正则**源码相同**的片段，都替换成当前命中文本——
   * 这样「在命中的前后加东西」可以照抄正则写法，不必绕着写 `$&`。
   */
  regexReplace: boolean;
}

export interface SearchMatch {
  start: number;
  end: number;
}

/** 转义正则元字符：非正则模式把查询词当纯文本 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 构造查询正则；查询为空或正则非法时返回 null（调用方视为「无命中」）。
 *
 * 两个固定的标志位：
 * - `g`：`findMatches` 要一次扫完全文；
 * - `m`：`^` / `$` 按**行首行尾**匹配。全文搜索时用户写 `^## `（VSCode 的习惯）就是要
 *   逐行命中，不给 `m` 的话整篇只会命中第一行，这是最容易踩的坑。
 */
export const buildSearchRegExp = (query: string, options: SearchOptions): RegExp | null => {
  if (!query) return null;
  const flags = `gm${options.caseSensitive ? "" : "i"}`;
  try {
    return new RegExp(options.regex ? query : escapeRegExp(query), flags);
  } catch {
    return null;
  }
};

/**
 * 列出全部命中。
 *
 * 两个保护：零宽匹配（例如正则 `a*`）会让 lastIndex 原地不动，这里手动后移；
 * `limit` 到量即停，避免几万次命中把大文档拖死（计数器只用于展示上限）。
 */
export const findMatches = (
  text: string,
  query: string,
  options: SearchOptions,
  limit = Infinity,
): SearchMatch[] => {
  const regex = buildSearchRegExp(query, options);
  if (!regex) return [];
  const matches: SearchMatch[] = [];
  let guard = 0;
  let found: RegExpExecArray | null;
  while ((found = regex.exec(text)) !== null) {
    const value = found[0];
    if (value.length === 0) {
      regex.lastIndex += 1;
      continue;
    }
    matches.push({ start: found.index, end: found.index + value.length });
    if (matches.length >= limit) break;
    if (found.index === regex.lastIndex) regex.lastIndex += 1;
    if (++guard > 200000) break;
  }
  return matches;
};

/** 从光标往后找第一个命中；loop 为真时回绕到开头 */
export const nextMatchIndex = (matches: SearchMatch[], from: number, loop = true): number => {
  if (!matches.length) return -1;
  for (let index = 0; index < matches.length; index += 1) {
    if (matches[index].start >= from) return index;
  }
  return loop ? 0 : -1;
};

/** 从光标往前找第一个命中；loop 为真时回绕到末尾 */
export const prevMatchIndex = (matches: SearchMatch[], from: number, loop = true): number => {
  if (!matches.length) return -1;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    if (matches[index].start < from) return index;
  }
  return loop ? matches.length - 1 : -1;
};

/**
 * 在命中起点上重新执行一次正则，拿到捕获组。
 *
 * 为什么不用「把命中串再喂给 `^(?:pattern)$` 跑一遍」：那样每次都要重新锚定，
 * 遇到 `^` / `$` / 单词边界这类零宽断言时经常匹配不上，`$1` 就变成了字面量。
 * 这里用 sticky（`y`）标志从 `match.start` 原地匹配一次，既精确又只做一次扫描。
 * 标志位必须与 `buildSearchRegExp` 一致（`i` / `m`），否则同一段文本两次执行的结果不同。
 */
const execAt = (
  text: string,
  match: SearchMatch,
  pattern: string,
  options: SearchOptions,
): RegExpExecArray | null => {
  try {
    const regex = new RegExp(pattern, `ym${options.caseSensitive ? "" : "i"}`);
    regex.lastIndex = match.start;
    const found = regex.exec(text);
    return found && found.index === match.start ? found : null;
  } catch {
    return null;
  }
};

/**
 * 替换串里的转义：`\n` `\t` `\r` `\\`（与 VSCode 的正则替换一致）。
 * 其它 `\x` 原样保留——用户可能真的要写反斜杠。
 */
const ESCAPES: Record<string, string> = { n: "\n", t: "\t", r: "\r", "\\": "\\" };

/**
 * 展开替换串里的占位符（只在正则模式下调用）。
 *
 * 支持的范围刻意与 VSCode 保持一致：`$$` 字面 `$`、`$&` 整个命中、`$1`~`$99` 捕获组、
 * `$<name>` 命名组，以及 `\n` `\t` `\r` `\\`；`$'` / `` $` `` 不展开——它们会插入
 * 「命中之后 / 之前的全文」，在替换全部里几乎是灾难。
 *
 * `placeholder` 非空时（`regexReplace` 打开），替换串里与它相同的片段先按「整个命中」展开，
 * 优先级高于 `$` 占位符——用户既然照抄了正则源码，就不该再被当成字面量。
 */
const expandTokens = (found: RegExpExecArray, replacement: string, placeholder = ""): string => {
  let out = "";
  for (let index = 0; index < replacement.length; index += 1) {
    if (placeholder && replacement.startsWith(placeholder, index)) {
      out += found[0];
      index += placeholder.length - 1;
      continue;
    }
    const char = replacement[index];
    if (char === "\\" && index + 1 < replacement.length) {
      const next = replacement[index + 1];
      const escape = ESCAPES[next];
      if (escape !== undefined) {
        out += escape;
        index += 1;
        continue;
      }
      out += char;
      continue;
    }
    if (char !== "$" || index + 1 >= replacement.length) {
      out += char;
      continue;
    }
    const next = replacement[index + 1];
    if (next === "$") {
      out += "$";
      index += 1;
      continue;
    }
    if (next === "&") {
      out += found[0];
      index += 1;
      continue;
    }
    if (next === "<") {
      const end = replacement.indexOf(">", index + 2);
      if (end > index) {
        out += found.groups?.[replacement.slice(index + 2, end)] ?? "";
        index = end;
        continue;
      }
      out += char;
      continue;
    }
    if (next >= "1" && next <= "9") {
      // 两位组号优先（`$12` 先当第 12 组），那一组不存在时退回一位（`$1` + "2"）
      const two = replacement.slice(index + 1, index + 3);
      if (/^\d{2}$/.test(two) && Number(two) < found.length) {
        out += found[Number(two)] ?? "";
        index += 2;
        continue;
      }
      out += found[Number(next)] ?? "";
      index += 1;
      continue;
    }
    out += char;
  }
  return out;
};

/**
 * 展开一次替换：正则模式下按捕获组展开占位符，非正则模式原样返回。
 *
 * 传全文 + 命中区间而不是「命中串 + pattern」：占位符要按真实捕获组展开，
 * 而捕获组只能从原文上重新执行正则拿到（`execAt`）。
 */
export const expandReplacement = (
  text: string,
  match: SearchMatch,
  pattern: string,
  replacement: string,
  options: SearchOptions,
): string => {
  if (!options.regex) return replacement;
  const found = execAt(text, match, pattern, options);
  if (!found) return replacement;
  return expandTokens(found, replacement, options.regexReplace ? pattern : "");
};

/** 替换单个命中，返回新文本与替换后的光标位置 */
export const replaceMatch = (
  text: string,
  match: SearchMatch,
  replacement: string,
): { text: string; caret: number } => ({
  text: text.slice(0, match.start) + replacement + text.slice(match.end),
  caret: match.start + replacement.length,
});

/** 批量替换：索引较大的先算好再拼，避免长度变化导致后续错位 */
export const replaceAllMatches = (
  text: string,
  matches: SearchMatch[],
  replacementFor: (match: SearchMatch, matched: string) => string,
): { text: string; caret: number } => {
  if (!matches.length) return { text, caret: 0 };
  let out = "";
  let cursor = 0;
  let caret = matches[0].start;
  for (const match of matches) {
    const matched = text.slice(match.start, match.end);
    const replacement = replacementFor(match, matched);
    out += text.slice(cursor, match.start) + replacement;
    cursor = match.end;
    caret = match.start + replacement.length;
  }
  out += text.slice(cursor);
  return { text: out, caret };
};

/** 偏移 → 行号（0 基）：走共享切行缓存的二分，不必逐字符数换行 */
export const offsetToLine = (text: string, offset: number): number => lineAtOffset(text, offset).line;
