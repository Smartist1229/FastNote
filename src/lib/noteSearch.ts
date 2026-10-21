/**
 * 笔记搜索的匹配与高亮：把「是否正则」「上下文片段」「片段内的命中区间」收在一处。
 *
 * 之所以独立成模块：Sidebar 的三个虚拟分组（全部 / 标题 / 正文）要用同一套判定，
 * 若各处自己拼正则，"同一次搜索里标题组和正文组判定不一致"迟早会发生。
 *
 * 两条硬规则：
 * - 正则**不合法时返回 null 而不是抛错**：输入框逐字符变化，`(`、`a{` 这类半成品会一路出现，
 *   用户敲字的过程不该被报错打断；此时上层按"零个命中"处理。
 * - **片段里的命中区间必须与片段同一份文本**：先在原文上算出绝对值，再按窗口偏移换算成片段内坐标。
 *   少了这一步，高亮就会整体错位（`{" "}` 导致 NaN 的情况就是这么来的）。
 */
import type { Note } from "@/interface/note";

/** 命中区间：左闭右开的下标 */
export interface MatchRange {
  start: number;
  end: number;
}

/** 一段文本最多统计多少处命中：够高亮用即可，不必把长文扫干净 */
const MAX_RANGES = 40;

const escapeRegExp = (input: string): string => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 折叠空白：正文里的换行会造成只此项命中（查询词跨行、上下文片段里出现裸换行）。
 * 搜索统一在折叠后的文本上做，命中效果与"读的时候看起来的样子"一致。
 */
export const collapseWhitespace = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * 按当前模式构造匹配器。
 *
 * @param query 已经处理过大小写的查询词（正则模式下必须是原始大小写）
 * @param useRegex 是否按正则解释
 * @returns 匹配器；query 为空或正则不合法时返回 null
 */
export const buildNoteMatcher = (query: string, useRegex: boolean): { pattern: RegExp } | null => {
  if (!query) return null;
  try {
    // 两种模式都不区分大小写：普通搜索若区分大小写，`TODO` 就搜不到 `todo`
    const source = useRegex ? query : escapeRegExp(query);
    return { pattern: new RegExp(source, "gi") };
  } catch {
    return null;
  }
};

/** 某个文本里的命中区间（按出现顺序，最多 MAX_RANGES 段） */
export const findMatchRanges = (matcher: ReturnType<typeof buildNoteMatcher>, text: string): MatchRange[] => {
  if (!matcher) return [];
  const { pattern } = matcher;
  pattern.lastIndex = 0;
  const out: MatchRange[] = [];
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    // 零宽命中（`/x*/` 之类）会让 exec 停在同一位置 → 手动推进一位，否则死循环
    if (hit[0].length === 0) {
      pattern.lastIndex += 1;
      continue;
    }
    out.push({ start: hit.index, end: hit.index + hit[0].length });
    if (out.length >= MAX_RANGES) break;
  }
  return out;
};

/** 片段radix长度：太短看不出上下文，太长会挤掉标题行 */
const SNIPPET_MIN = 60;
const SNIPPET_MAX = 92;

/**
 * 围绕第一处命中截一段上下文，并把命中区间换算成**片段内坐标**。
 *
 * 只看正文开头是不够的：命中常常落在中间，用户想知道的是"关键词周围写了什么"。
 * 两侧各留 40 个字符，命中太靠左则从 0 起。
 */
export const buildMatchSnippet = (
  content: string,
  ranges: MatchRange[],
): { text: string; ranges: MatchRange[] } => {
  const text = collapseWhitespace(content);
  if (!text) return { text: "", ranges: [] };
  if (ranges.length === 0) {
    return {
      text: text.length > SNIPPET_MIN ? `${text.slice(0, SNIPPET_MIN)}…` : text,
      ranges: [],
    };
  }
  const first = ranges[0];
  let start = Math.max(0, first.start - 40);
  let end = Math.min(text.length, Math.max(first.end + 40, start + SNIPPET_MIN));
  // 窗口比上限还长：把右端收回来，保证左右留白均衡
  if (end - start > SNIPPET_MAX) end = start + SNIPPET_MAX;
  const slice = `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
  // 前面的省略号占 1 个字符，所有区间整体偏移 (−start + 1)；区间截出窗口的部分丢弃
  const shift = 1 - start;
  const mapped = ranges
    .filter((r) => r.end > start && r.start < end)
    .map((r) => ({ start: Math.max(0, r.start + (start > 0 ? shift : 0)), end: r.end + (start > 0 ? shift : 0) }))
    .filter((r) => r.start < r.end);
  return { text: slice, ranges: mapped };
};

/**
 * 一次搜索的单条命中。
 * 标题与正文分开统计，是为了上层能直接按这两种情况建虚拟分组，不必再各算一遍。
 */
export interface NoteSearchHit {
  note: Note;
  /** 标题内的命中，坐标相对于 note.title */
  titleRanges: MatchRange[];
  /** 上下文片段内的命中，坐标相对于 snippet（可直接用于高亮） */
  snippetRanges: MatchRange[];
  /** 围绕第一处正文命中的上下文，过长会被截断成省略号 */
  snippet: string;
  /** 只有标题命中（此时没有必要展示正文片段） */
  titleOnly: boolean;
}

/**
 * 对全量笔记做一次搜索。
 *
 * 主列表本来就带正文（AI 读取未打开笔记依赖它），所以这里不额外发请求。
 * 返回的数组沿用传入顺序（后端排序：置顶优先 + 当前排序字段）。
 *
 * `invalid` 表示"开了正则但查询词不是合法正则"——用来在界面上给一句提示，
 * 而不是让用户在只会得到零结果的输入框前干瞪眼。
 */
export const searchNotes = (
  notes: Note[],
  query: string,
  useRegex: boolean,
): { hits: NoteSearchHit[]; invalid: boolean } => {
  const raw = query.trim();
  if (!raw) return { hits: [], invalid: false };
  const matcher = buildNoteMatcher(useRegex ? raw : raw.toLowerCase(), useRegex);
  if (!matcher) return { hits: [], invalid: true };

  const hits: NoteSearchHit[] = [];
  for (const note of notes) {
    const hayTitle = useRegex ? note.title : note.title.toLowerCase();
    // 正文在折叠空白后的版本上匹配：坐标与随后截取的片段同源
    const hayContent = useRegex ? collapseWhitespace(note.content) : collapseWhitespace(note.content).toLowerCase();
    const titleRanges = findMatchRanges(matcher, hayTitle);
    const contentRanges = findMatchRanges(matcher, hayContent);
    if (titleRanges.length === 0 && contentRanges.length === 0) continue;
    const { text: snippet, ranges: snippetRanges } = buildMatchSnippet(note.content, contentRanges);
    hits.push({ note, titleRanges, snippetRanges, snippet, titleOnly: contentRanges.length === 0 });
  }
  return { hits, invalid: false };
};
