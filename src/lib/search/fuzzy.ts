/**
 * 轻量模糊匹配：命令面板与快速跳转共用。
 *
 * 只要两件事：**打分**（决定排序）与**命中区间**（决定高亮）。刻意不引第三方库——
 * 笔记标题动辄上千条，每敲一个键就要跑一遍，实现越简单越可控。
 *
 * 打分阶梯（单条查询词）：
 *   完全相同 1000 > 前缀 860 > 词首 700 > 任意位置包含 520 > 散落子序列 2/字（+ 连续与词首奖励）
 * 位置越靠后扣分越多，让「React 入门」在搜 react 时排到「深入 React 原理」前面。
 *
 * 多条查询词（空格分隔）按 **AND** 处理：每条都必须命中，分数相加。中文用户很少打空格，
 * 但搜 `react hook` 这种英文关键词时，AND 比整串匹配实用得多。
 */

/** 命中区间：左闭右开 */
export interface MatchRange {
  start: number;
  end: number;
}

export interface FuzzyMatch {
  score: number;
  ranges: MatchRange[];
}

/** 词首判定用的分隔符：空白、标点、常见中英文分隔符 */
const BOUNDARY_CHARS = new Set([
  " ",
  "\t",
  "\n",
  "-",
  "_",
  "/",
  "\\",
  ".",
  ",",
  ":",
  ";",
  "!",
  "?",
  "(",
  ")",
  "[",
  "]",
  "{",
  "}",
  "\"",
  "'",
  "`",
  "·",
  "、",
  "，",
  "。",
  "：",
  "；",
  "！",
  "？",
  "（",
  "）",
  "【",
  "】",
  "《",
  "》",
  "—",
]);

const isBoundary = (text: string, index: number): boolean =>
  index === 0 || BOUNDARY_CHARS.has(text[index - 1]);

/**
 * 子序列匹配：按顺序吃到查询词的每个字符。
 * 英文缩写场景用得上（`md` → `markdown`、`td` → `TODO 列表`），代价是容易误命中，
 * 所以只给很低的底分，正常包含命中永远排在它前面。
 */
const matchSubsequence = (text: string, term: string): FuzzyMatch | null => {
  let ti = 0;
  let prev = -2;
  let score = 0;
  const ranges: MatchRange[] = [];
  for (let i = 0; i < text.length && ti < term.length; i += 1) {
    if (text[i] !== term[ti]) continue;
    if (i === prev + 1) score += 8;
    else score += 2;
    if (isBoundary(text, i)) score += 6;
    prev = i;
    ti += 1;
    const last = ranges[ranges.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else ranges.push({ start: i, end: i + 1 });
  }
  return ti === term.length ? { score, ranges } : null;
};

/** 单条查询词的匹配（text 必须已是小写） */
const matchTerm = (text: string, term: string): FuzzyMatch | null => {
  const index = text.indexOf(term);
  if (index >= 0) {
    const exact = text.length === term.length;
    const atStart = index === 0;
    let score = exact ? 1000 : atStart ? 860 : isBoundary(text, index) ? 700 : 520;
    score -= Math.min(index, 80);
    score += Math.min(term.length, 12) * 4;
    return { score, ranges: [{ start: index, end: index + term.length }] };
  }
  return matchSubsequence(text, term);
};

/** 合并重叠 / 相邻区间，避免高亮被切成碎段 */
const mergeRanges = (ranges: MatchRange[]): MatchRange[] => {
  if (ranges.length <= 1) return ranges;
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i += 1) {
    const last = out[out.length - 1];
    const next = sorted[i];
    if (next.start <= last.end) last.end = Math.max(last.end, next.end);
    else out.push(next);
  }
  return out;
};

/**
 * 把文本与查询词比对。
 *
 * 小写化只在长度不变时才采用：`İ`、`ß` 这类字符小写后会变长，
 * 此时区间坐标会与原文错位（高亮画到别的字上），宁可退回区分大小写。
 */
export const fuzzyMatch = (text: string, query: string): FuzzyMatch | null => {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return { score: 0, ranges: [] };
  if (!text) return null;
  const lowered = text.toLowerCase();
  const haystack = lowered.length === text.length ? lowered : text;
  let score = 0;
  const ranges: MatchRange[] = [];
  for (const term of terms) {
    const hit = matchTerm(haystack, term);
    if (!hit) return null;
    score += hit.score;
    ranges.push(...hit.ranges);
  }
  return { score, ranges: mergeRanges(ranges) };
};

/** 只判断是否命中，不需要分数与高亮时用它省掉区间合并 */
export const fuzzyTest = (text: string, query: string): boolean => fuzzyMatch(text, query) !== null;

/** 按命中区间把文本切成片段，渲染层据此决定哪段加粗 */
export const splitByRanges = (
  text: string,
  ranges: MatchRange[],
): Array<{ text: string; hit: boolean }> => {
  if (!ranges.length) return [{ text, hit: false }];
  const out: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, text.length));
    const end = Math.max(start, Math.min(range.end, text.length));
    if (start > cursor) out.push({ text: text.slice(cursor, start), hit: false });
    if (end > start) out.push({ text: text.slice(start, end), hit: true });
    cursor = Math.max(cursor, end);
  }
  if (cursor < text.length) out.push({ text: text.slice(cursor), hit: false });
  return out;
};
