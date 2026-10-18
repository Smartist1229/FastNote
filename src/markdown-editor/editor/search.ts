/**
 * 查找 / 替换的纯逻辑层（不碰 DOM、不依赖 React，便于单测与外部复用）。
 *
 * 语义对齐 VSCode：
 * - `findMatches` 按「区分大小写 / 正则」两种开关产出全部命中区间；
 * - 「下一个 / 上一个」以光标偏移为锚点在命中列表里跳转，到底后按 loop 回到另一端；
 * - 正则模式下替换串支持 `$1`、`$&`、`$$`（交给 String.replace 处理）。
 */
export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

export interface SearchMatch {
  start: number;
  end: number;
}

/** 转义正则元字符：非正则模式把查询词当纯文本 */
const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 构造查询正则；查询为空或正则非法时返回 null（调用方视为「无命中」） */
export const buildSearchRegExp = (query: string, options: SearchOptions): RegExp | null => {
  if (!query) return null;
  const flags = `g${options.caseSensitive ? "" : "i"}`;
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

/** 正则模式下展开替换串里的 $1 / $& / $$；非正则模式原样返回 */
export const expandReplacement = (
  matched: string,
  pattern: string,
  replacement: string,
  options: SearchOptions,
): string => {
  if (!options.regex) return replacement;
  try {
    return matched.replace(new RegExp(`^(?:${pattern})$`, options.caseSensitive ? "" : "i"), replacement);
  } catch {
    return replacement;
  }
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
  replacementFor: (matched: string) => string,
): { text: string; caret: number } => {
  if (!matches.length) return { text, caret: 0 };
  let out = "";
  let cursor = 0;
  let caret = matches[0].start;
  for (const match of matches) {
    const replacement = replacementFor(text.slice(match.start, match.end));
    out += text.slice(cursor, match.start) + replacement;
    cursor = match.end;
    caret = match.start + replacement.length;
  }
  out += text.slice(cursor);
  return { text: out, caret };
};

/** 偏移 → 行号（0 基）：比 split('\n') 省一次全量数组 */
export const offsetToLine = (text: string, offset: number): number => {
  let line = 0;
  const limit = Math.min(offset, text.length);
  for (let index = 0; index < limit; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
};
