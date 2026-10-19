/**
 * 全文按 `\n` 切行的共享缓存。
 *
 * 为什么需要它：一次按键里 `value.split("\n")` 会被行号槽、折行测量、滚动同步、
 * 查找高亮层各调用一遍。长文档上一次就是几万元素的数组，四遍就是几十万——
 * 而它们切的是同一份文本。这里用「单条缓存」把四遍并成一遍：
 * 同一份文本只切一次，各处拿到的是同一个数组引用，遍历与缓存比对也照常工作。
 *
 * 缓存只保留一条：编辑器同一时刻反复切的就是当前这一份文本，命中率是压倒性的。
 * 两个编辑器交替渲染时命中不了，退化成直接切，比原来不会更差。
 *
 * 行首偏移表按需构建：只有光标定位（状态栏行列号、F3 跳转）需要它，
 * 打字路径上不会额外付出 O(n) 的代价。
 */

interface LineCache {
  text: string;
  lines: string[];
  /** 每行首字符在原文里的偏移；首次查询时才构建 */
  offsets: number[] | null;
}

let current: LineCache | null = null;

const ensure = (text: string): LineCache => {
  if (current && current.text === text) return current;
  current = { text, lines: text.split("\n"), offsets: null };
  return current;
};

/** 切行；结果与传入文本一一对应，内容未变时复用上一次的数组 */
export const splitLines = (text: string): string[] => ensure(text).lines;

/** 行数（空文本算 0 行） */
export const countLines = (text: string): number => (text ? ensure(text).lines.length : 0);

/** 每行首字符的绝对偏移，供二分定位用 */
export const lineOffsets = (text: string): number[] => {
  const entry = ensure(text);
  if (!entry.offsets) {
    const offsets = new Array<number>(entry.lines.length);
    let at = 0;
    for (let i = 0; i < entry.lines.length; i += 1) {
      offsets[i] = at;
      at += entry.lines[i].length + 1;
    }
    entry.offsets = offsets;
  }
  return entry.offsets;
};

/**
 * 偏移落在第几行（0 基）以及那一行的起始偏移。
 *
 * 原来是按字符数 `\n` 逐个累加（状态栏每挪一次光标就全文扫一遍），
 * 这里改成在行首偏移表上二分，光标移动变成 O(log n)。
 */
export const lineAtOffset = (text: string, offset: number): { line: number; start: number } => {
  const offsets = lineOffsets(text);
  if (!offsets.length) return { line: 0, start: 0 };
  const target = Math.max(0, Math.min(offset, text.length));
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= target) low = mid;
    else high = mid - 1;
  }
  return { line: low, start: offsets[low] };
};
