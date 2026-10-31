/**
 * 全文按 `\n` 切行的共享缓存。
 *
 * 为什么需要它：一次按键里 `value.split("\n")` 会被行号槽、折行测量、滚动同步、
 * 查找高亮层各调用一遍。长文档上一次就是几万元素的数组，四遍就是几十万——
 * 而它们切的是同一份文本。这里用缓存把四遍并成一遍：
 * 同一份文本只切一次，各处拿到的是同一个数组引用，遍历与缓存比对也照常工作。
 *
 * 按键路径上更进一步：`noteTextChange` 会拿着「哪一段被换掉了」的提示做**增量切行**——
 * 公共前缀、公共后缀的行字符串直接复用，只对中间那几行 `split`。
 * 于是 2.5 万行文档上每键的切行从「切 2.5 万次 + 造 2.5 万个字符串」降到「切一两行」，
 * 行号槽的前后缀差分也因为引用相同而退化成指针比较。
 *
 * 缓存保留两条：输入法/命令可能在同一帧里连续改两次文本，前后两份都要能命中。
 *
 * 行首偏移表按需构建：只有光标定位（状态栏行列号、查找跳转、增量解析）需要它，
 * 打字路径上不会额外付出 O(n) 的代价。
 */

interface LineCache {
  text: string;
  lines: string[];
  /** 每行首字符在原文里的偏移（长度 = lines.length + 1）；首次查询时才构建 */
  offsets: Float64Array | null;
}

let current: LineCache | null = null;
let previous: LineCache | null = null;

const build = (text: string): LineCache => {
  const entry: LineCache = { text, lines: text.split("\n"), offsets: null };
  previous = current;
  current = entry;
  return entry;
};

const ensure = (text: string): LineCache => {
  if (current && current.text === text) return current;
  if (previous && previous.text === text) {
    const hit = previous;
    previous = current;
    current = hit;
    return hit;
  }
  return build(text);
};

/** 切行；结果与传入文本一一对应，内容未变时复用上一次的数组 */
export const splitLines = (text: string): string[] => ensure(text).lines;

/** 行数（空文本算 0 行） */
export const countLines = (text: string): number => (text ? ensure(text).lines.length : 0);

const offsetsOf = (entry: LineCache): Float64Array => {
  if (!entry.offsets) {
    const lines = entry.lines;
    const offsets = new Float64Array(lines.length + 1);
    let at = 0;
    for (let i = 0; i < lines.length; i += 1) {
      offsets[i] = at;
      at += lines[i].length + 1;
    }
    offsets[lines.length] = at;
    entry.offsets = offsets;
  }
  return entry.offsets;
};

/** 每行首字符的绝对偏移，供二分定位用 */
export const lineOffsets = (text: string): Float64Array => offsetsOf(ensure(text));

/**
 * 偏移落在第几行（0 基）以及那一行的起始偏移。
 *
 * 原来是按字符数 `\n` 逐个累加（状态栏每挪一次光标就全文扫一遍），
 * 这里改成在行首偏移表上二分，光标移动变成 O(log n)。
 */
export const lineAtOffset = (text: string, offset: number): { line: number; start: number } => {
  const entry = ensure(text);
  const offsets = offsetsOf(entry);
  if (entry.lines.length === 0) return { line: 0, start: 0 };
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = entry.lines.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= target) low = mid;
    else high = mid - 1;
  }
  return { line: low, start: offsets[low] };
};

/** 一次替换：旧文本 `[from, oldTo)` → 新文本 `[from, newTo)` */
export interface TextEdit {
  from: number;
  oldTo: number;
  newTo: number;
}

/**
 * 收口成一个「能自洽还原」的编辑。
 *
 * 公共前缀与公共后缀可能**重叠**（重复字符让前后缀共同吃掉同一段文本，典型是
 * 删掉紧挨着空行的那 3 个字符）：此时 `newTo < from`，区间退化，前后缀等式
 * `prev.slice(0,from) === next.slice(0,from)` 与 `prev.slice(oldTo) === next.slice(newTo)`
 * 不再同时成立——而这两条正是增量切行敢复用前后缀行的唯一依据（压小 `from` 只会让
 * 改动区间变成真实改动的超集，两条等式随之都成立）。
 *
 * `minFrom` 是调用方真正逐字符验证过的左界：压到它以下就说明改动根本不在提示附近，
 * 返回 null 让调用方退回完整差分。
 */
const settleEdit = (edit: TextEdit, minFrom: number): TextEdit | null => {
  const from = Math.min(edit.from, edit.oldTo, edit.newTo);
  if (from === edit.from) return edit;
  if (from < minFrom) return null;
  return { from, oldTo: edit.oldTo, newTo: edit.newTo };
};

/**
 * 有界差分：只在两端各扫 `limit` 个字符，扫不出边界就返回 null。
 *
 * 按键热路径上不能全文找公共前后缀（百万字就是百万次比较）；
 * 真实输入的变化总在光标附近，几十个字符内就能定位。整篇粘贴这类大改动
 * 直接放弃提示，退回一次完整切行，正确性不受影响。
 */
export const quickTextEdit = (prev: string, next: string, limit = 4096): TextEdit | null => {
  if (prev === next) return null;
  const shared = Math.min(prev.length, next.length);
  const maxPrefix = Math.min(shared, limit);
  let from = 0;
  while (from < maxPrefix && prev.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  if (from >= limit && shared > limit) return null;
  const maxSuffix = Math.min(prev.length - from, next.length - from, limit);
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  if (suffix >= limit && maxSuffix >= limit) return null;
  // 前缀是从 0 逐字符扫出来的，左界可信到 0
  return settleEdit({ from, oldTo: prev.length - suffix, newTo: next.length - suffix }, 0);
};

/**
 * 带位置提示的有界差分。
 *
 * `quickTextEdit` 从文首找公共前缀：在第 4 万行打字时前缀扫描会撞上 limit 而放弃，
 * 按键于是退化成一次全文切行。这里假定改动就在 `around`（光标）附近：
 * 先在锚点两侧的有界窗口里找第一处不一致，再按长度差找后缀的对齐点。
 * 窗口里找不到（多处置改 / 换笔记）返回 null，调用方退回完整差分。
 */
export const quickTextEditNear = (
  prev: string,
  next: string,
  around: number,
  limit = 4096,
): TextEdit | null => {
  if (prev === next) return null;
  const delta = next.length - prev.length;
  if (Math.abs(delta) > limit) return null;
  const minLength = Math.min(prev.length, next.length);
  const anchor = Math.max(0, Math.min(around, minLength));
  const windowStart = Math.max(0, anchor - limit);
  const windowEnd = Math.min(minLength, anchor + limit);
  let from = windowStart;
  while (from < windowEnd && prev.charCodeAt(from) === next.charCodeAt(from)) from += 1;
  if (from >= windowEnd) from = windowEnd;
  // 起点之前再确认一小段相同：提示若落在别的改动上，这里就会现形
  const left = Math.min(from, 32);
  for (let i = 1; i <= left; i += 1) {
    if (prev.charCodeAt(from - i) !== next.charCodeAt(from - i)) return null;
  }
  /*
   * 对齐后缀：把 `from` 之后的旧文本整体平移 delta 去和新文本比，
   * 第一段 32 字符（或直到文末）完全一致的位置就是改动的终点。
   * 纯插入在 moved=0 就对齐；替换在旧片段走完后对齐。
   */
  const span = Math.min(limit, Math.max(prev.length - from, next.length - from) + Math.abs(delta));
  for (let moved = 0; moved <= span; moved += 1) {
    const oldAt = from + moved;
    const newAt = oldAt + delta;
    if (oldAt > prev.length || newAt > next.length) break;
    const run = Math.min(32, prev.length - oldAt, next.length - newAt);
    let aligned = true;
    for (let i = 0; i < run; i += 1) {
      if (prev.charCodeAt(oldAt + i) !== next.charCodeAt(newAt + i)) {
        aligned = false;
        break;
      }
    }
    if (!aligned) continue;
    if (run === 32 || (oldAt + run === prev.length && newAt + run === next.length)) {
      // 窗口左界之外只抽检了 32 个字符，压过它就是「改动不在光标附近」
      return settleEdit({ from, oldTo: oldAt, newTo: newAt }, Math.max(0, windowStart - 32));
    }
  }
  return null;
};

/**
 * 用调用方缓存的切行结果求整行差分（字符偏移）。
 *
 * `diffTextLines` 每次都要重新切行；解析快照里本来就存着上一版的行表和偏移表，
 * 直接拿来用，按键时就不必再切一遍百万字。
 */
export const diffLinesEdit = (
  prevLines: readonly string[],
  prevOffsets: Float64Array,
  nextLines: readonly string[],
  nextOffsets: Float64Array,
): TextEdit | null => {
  const shared = Math.min(prevLines.length, nextLines.length);
  let prefix = 0;
  while (prefix < shared && prevLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    prevLines[prevLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  if (prefix >= prevLines.length && prefix >= nextLines.length) return null;
  const prevLength = Math.max(0, (prevOffsets[prevLines.length] ?? 1) - 1);
  const nextLength = Math.max(0, (nextOffsets[nextLines.length] ?? 1) - 1);
  const oldEnd = prevLines.length - suffix;
  const newEnd = nextLines.length - suffix;
  return {
    from: prevOffsets[prefix] ?? prevLength,
    oldTo: oldEnd >= prevLines.length ? prevLength : (prevOffsets[oldEnd] ?? prevLength),
    newTo: newEnd >= nextLines.length ? nextLength : (nextOffsets[newEnd] ?? nextLength),
  };
};

/** 在缓存的偏移表上二分定位（偏移表末项是 text.length + 1） */
export const lineIndexAt = (offsets: Float64Array, count: number, offset: number): number => {
  if (count <= 0) return 0;
  const length = Math.max(0, (offsets[count] ?? 1) - 1);
  const target = Math.max(0, Math.min(offset, length));
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= target) low = mid;
    else high = mid - 1;
  }
  return low;
};

/** 改动落在哪两个逻辑行之间（0 基，`last` 是受影响的最后一行） */
const linesAround = (
  entry: LineCache,
  from: number,
  to: number,
): { first: number; last: number } => {
  const offsets = offsetsOf(entry);
  const count = entry.lines.length;
  const locate = (offset: number): number => {
    const target = Math.max(0, Math.min(offset, entry.text.length));
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (offsets[mid] <= target) low = mid;
      else high = mid - 1;
    }
    return low;
  };
  return { first: locate(from), last: locate(to) };
};

/**
 * 按「整行」求两段文本的变化区间（字符偏移）。
 *
 * 与 `quickTextEdit` 的分工：这里追求准，用于「这次是不是整篇换掉」的判定与预览块复用。
 * 行字符串相同（引用相同）时是一次指针比较，所以两万行文档也只是两万次比较；
 * 而逐字符找公共前后缀是百万次比较，不能在每次按键的渲染路径上跑。
 *
 * 返回 `null` 表示两段文本完全一致。
 */
export const diffTextLines = (prevText: string, nextText: string): TextEdit | null => {
  if (prevText === nextText) return null;
  const prevLines = splitLines(prevText);
  const nextLines = splitLines(nextText);
  const shared = Math.min(prevLines.length, nextLines.length);
  let prefix = 0;
  while (prefix < shared && prevLines[prefix] === nextLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < shared - prefix &&
    prevLines[prevLines.length - 1 - suffix] === nextLines[nextLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const prevOffsets = lineOffsets(prevText);
  const nextOffsets = lineOffsets(nextText);
  const oldEndLine = prevLines.length - suffix;
  const newEndLine = nextLines.length - suffix;
  return {
    from: prevOffsets[prefix] ?? 0,
    oldTo: oldEndLine >= prevLines.length ? prevText.length : prevOffsets[oldEndLine],
    newTo: newEndLine >= nextLines.length ? nextText.length : nextOffsets[newEndLine],
  };
};

/**
 * 告诉缓存「prev 到 next 只改了 [from, oldTo) → [from, newTo)」。
 *
 * 只做增量切行与偏移平移；前置条件不满足（缓存里没有 prev、编辑描述不自洽）
 * 时安静返回 false，下次 `splitLines` 会做一次完整切行。
 *
 * 偏移表的增量更新与行数组同步：前缀原样、中间按新行重算、后缀整体平移 delta。
 * 这样紧随其后的 `lineAtOffset`（状态栏行列号）不必再全文重建偏移表。
 */
export const noteTextChange = (prev: string, next: string, edit: TextEdit | null): boolean => {
  if (!edit || prev === next) return false;
  const entry = current;
  if (!entry || entry.text !== prev) return false;
  const { from, oldTo, newTo } = edit;
  if (from < 0 || oldTo < from || oldTo > prev.length || newTo < from || newTo > next.length) return false;
  const delta = next.length - prev.length;
  if (newTo - oldTo !== delta) return false;
  /*
   * 边界抽检：调用方偶尔会把「改了哪一段」算错（例如选区被宿主回写）。
   * 真拿错误的提示去增量切行，行会悄悄错位；这里比几十个字符，错了就退回完整切行。
   */
  const left = Math.min(from, 32);
  for (let i = 1; i <= left; i += 1) {
    if (prev.charCodeAt(from - i) !== next.charCodeAt(from - i)) return false;
  }
  const right = Math.min(prev.length - oldTo, next.length - newTo, 32);
  for (let i = 0; i < right; i += 1) {
    if (prev.charCodeAt(oldTo + i) !== next.charCodeAt(newTo + i)) return false;
  }

  const oldLines = entry.lines;
  const oldCount = oldLines.length;
  const offsets = offsetsOf(entry);
  const { first, last } = linesAround(entry, from, oldTo);
  const lineStart = offsets[first];
  // 中间段在旧文本里的结束位置：受影响最后一行的行尾（不含换行）
  const lineEnd = offsets[last] + oldLines[last].length;

  const middleStart = lineStart;
  const middleEnd = lineEnd + delta;
  const middleLines = next.slice(middleStart, middleEnd).split("\n");
  const middleLength = middleLines.length;

  const nextCount = first + middleLength + (oldCount - last - 1);
  const lines = new Array<string>(nextCount);
  for (let i = 0; i < first; i += 1) lines[i] = oldLines[i];
  for (let i = 0; i < middleLength; i += 1) lines[first + i] = middleLines[i];
  const suffix = oldCount - last - 1;
  for (let i = 0; i < suffix; i += 1) lines[first + middleLength + i] = oldLines[last + 1 + i];

  const nextOffsets = new Float64Array(nextCount + 1);
  for (let i = 0; i <= first; i += 1) nextOffsets[i] = offsets[i];
  let at = middleStart;
  for (let i = 0; i < middleLength; i += 1) {
    nextOffsets[first + i] = at;
    at += middleLines[i].length + 1;
  }
  const suffixStart = first + middleLength;
  for (let i = 0; i <= suffix; i += 1) nextOffsets[suffixStart + i] = offsets[last + 1 + i] + delta;

  const nextEntry: LineCache = { text: next, lines, offsets: nextOffsets };
  previous = entry;
  current = nextEntry;
  return true;
};
