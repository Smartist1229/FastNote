/**
 * 软换行下「每个逻辑行占几个视觉行」的测量器。
 *
 * 行号槽要靠它才能把折行的续行留空（数字钉在首行），所以它必须给出**每一行的真实行数**；
 * 而真实行数只能靠真的排版量出来——按字数估算在长文档里会累积误差，滚到后面越偏越多。
 * 于是这里的问题不是「怎么算」，而是「几千行什么时候量」。
 *
 * 核心不变量：**已测量的区间永远是文档的一个前缀 `[0, frontier)`**。
 * 由此得到三条性质：
 * - 可视窗口被强制包进这个前缀（`ensureVisible`），所以屏上出现的行一定是实测值，
 *   而它前面的所有行也都实测过 → 纵向偏移不会漂，行号和正文始终对齐；
 * - 没测量到的行一律按 1 行参与排版，它们必然在可视窗口之外，看不见也就无所谓；
 * - 排版摊到多帧里（`step`，每帧有预算），打开几万字的文档不再一次性卡住。
 *
 * 代价只有一个：直接跳到很靠后的位置（Ctrl+End）时要把中间没测过的部分一次补齐。
 * 这是一次性的，补完之后整段都不用再测。
 *
 * 测量结果的消费方通过 `subscribe` 订阅（版本号变化即重取），
 * 这样渐进扫描的每帧只重渲染行号槽，不会带动整棵编辑器。
 */
import { splitLines } from "./lines";

/** 一帧最多实测多少行：把打开超长文档的排版摊开，避免单帧几百毫秒 */
const FRAME_BUDGET = 512;

/** 空行没有行盒，量不出高度，塞个零宽字符让它撑出一行 */
const FILLER = "\u200b";

export interface RulerBox {
  /** textarea 内容区可用宽度（px） */
  width: number;
  /** 单行行高（px） */
  unit: number;
  /** 字体指纹：变了才需要重新同步测量层的字体 */
  font: string;
  /** 关闭自动换行时每行必然占一行，不必排版 */
  wrap: boolean;
}

/** 找出 next 相对 prev 变化的区间 [lo, hi)：公共前缀 + 公共后缀之外的部分 */
const dirtyRange = (prev: string[], next: string[]): [number, number] => {
  const n = next.length;
  const m = prev.length;
  const shared = Math.min(n, m);
  let lo = 0;
  while (lo < shared && prev[lo] === next[lo]) lo += 1;
  let hi = 0;
  while (hi < shared - lo && prev[m - 1 - hi] === next[n - 1 - hi]) hi += 1;
  return [lo, n - hi];
};

export class LineRuler {
  /** 当前文本的切行结果（与共享切行缓存同一引用） */
  lines: string[] = [];
  /** 每个逻辑行占的视觉行数；[0, frontier) 是实测值，其余是占位 1 */
  rows = new Float64Array(0);
  /** 已实测的前缀长度（行数） */
  frontier = 0;
  /** 单行行高（px） */
  unit = 0;
  /** 内容总高（px） */
  total = 0;
  /** 可视窗口的末行下标 + 1，由行号槽每帧写入 */
  visibleEnd = 0;

  private boxKey = "";
  private cached: string[] | null = null;
  private width = 0;
  /** 改动后需要重测、且落在已测前缀内的区间（跟着打字走的那一两行） */
  private redoFrom = 0;
  private redoTo = 0;
  private offsets = new Float64Array(1);
  private offsetsStale = true;
  /** 字体/尺寸变过，测量层的排版条件需要重新对齐 */
  private styleStale = true;
  private mirror: HTMLDivElement | null = null;
  private host: HTMLElement | null = null;
  private listeners = new Set<() => void>();
  private version = 0;

  /** 订阅进度变化（供 useSyncExternalStore 使用），返回解绑函数 */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  /** 通知消费方：行数变了，偏移量要重算 */
  readonly notify = (): void => {
    this.version += 1;
    for (const listener of this.listeners) listener();
  };

  /** 还有多少行没测到 */
  get pending(): number {
    return Math.max(0, this.lines.length - this.frontier) + Math.max(0, this.redoTo - this.redoFrom);
  }

  /** 每行的起始纵向偏移（px） */
  offsetOf(line: number): number {
    if (this.offsetsStale) this.rebuildOffsets();
    return this.offsets[Math.max(0, Math.min(line, this.lines.length))];
  }

  /** 某个纵向位置落在第几行（0 基）：在偏移表上二分，不必逐行累加 */
  lineAt(px: number): number {
    if (this.offsetsStale) this.rebuildOffsets();
    const count = this.lines.length;
    if (count === 0) return 0;
    let low = 0;
    let high = count - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.offsets[mid] <= px) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  /**
   * 同步文本与排版条件。
   *
   * 只保证「可视窗口之前全部实测」，其余交给 `step` 逐帧扫。
   * 文本与排版条件都没变、且可视窗口仍在前缀内时直接返回，打字路径上因此几乎不做事。
   */
  sync(element: HTMLElement, text: string, box: RulerBox): void {
    if (!box.wrap ? box.unit <= 0 : box.width <= 0 || box.unit <= 0) return;
    const lines = splitLines(text);
    const key = `${box.font}|${Math.round(box.width)}|${box.unit}|${box.wrap ? 1 : 0}`;
    const boxChanged = key !== this.boxKey;
    const textChanged = this.cached !== lines;
    if (!boxChanged && !textChanged && this.visibleEnd <= this.frontier) return;

    this.boxKey = key;
    this.unit = box.unit;

    if (boxChanged) {
      if (box.wrap) {
        /*
         * 宽度或字体变了，之前的实测作废。这里先把行数按宽度比例缩放一次，
         * 再让扫描慢慢校准：否则重排瞬间所有行都塌回 1 行，
         * 行号槽会先缩成一小截再慢慢长回来，缩放过程中看得见抽动。
         */
        const ratio = this.width > 0 ? box.width / this.width : 0;
        if (ratio > 0) {
          for (let i = 0; i < this.rows.length; i += 1) {
            this.rows[i] = Math.max(1, Math.round(this.rows[i] / ratio));
          }
        }
      }
      this.width = box.width;
      this.frontier = 0;
      this.redoFrom = 0;
      this.redoTo = 0;
      this.styleStale = true;
    }

    if (textChanged || boxChanged) {
      const n = lines.length;
      this.ensureCapacity(n);
      if (textChanged && !boxChanged && this.cached) {
        const [lo, hi] = dirtyRange(this.cached, lines);
        // 只重测「已经测过」的那部分；还没测到的行留给扫描去量
        this.redoFrom = Math.max(0, lo);
        this.redoTo = Math.min(hi, this.frontier, n);
        if (!box.wrap) {
          for (let i = lo; i < hi; i += 1) this.rows[i] = 1;
        }
      }
      this.lines = lines;
      this.cached = lines;
    }

    if (!box.wrap) {
      // 不折行：每行必然占一行，直接标记全部已测，省掉整趟排版
      for (let i = 0; i < this.lines.length; i += 1) this.rows[i] = 1;
      this.frontier = this.lines.length;
      this.redoFrom = 0;
      this.redoTo = 0;
    } else {
      this.ensureVisible(element, this.visibleEnd);
    }

    this.rebuildOffsets();
    this.notify();
  }

  /** 保证 [0, upto) 全部实测过：直接跳到远处时这里一次补齐，之后就不用再测 */
  ensureVisible(element: HTMLElement, upto: number): void {
    const target = Math.min(upto, this.lines.length);
    if (target <= this.frontier) return;
    this.measureRange(element, this.frontier, target);
    this.frontier = target;
    this.offsetsStale = true;
  }

  /** 推进一帧的渐进测量；返回是否还有剩余 */
  step(element: HTMLElement): boolean {
    let budget = FRAME_BUDGET;

    if (this.redoTo > this.redoFrom) {
      const end = Math.min(this.redoTo, this.redoFrom + budget);
      this.measureRange(element, this.redoFrom, end);
      budget -= end - this.redoFrom;
      this.redoFrom = end;
      this.offsetsStale = true;
    }

    if (budget > 0 && this.frontier < this.lines.length) {
      const end = Math.min(this.lines.length, this.frontier + budget);
      this.measureRange(element, this.frontier, end);
      this.frontier = end;
      this.offsetsStale = true;
    }

    const more = this.pending > 0;
    if (more) this.notify();
    return more;
  }

  dispose(): void {
    this.listeners.clear();
    this.mirror?.remove();
    this.mirror = null;
    this.host = null;
  }

  private ensureCapacity(n: number): void {
    if (this.rows.length >= n) return;
    const grown = new Float64Array(Math.max(n, 64, this.rows.length * 2));
    grown.set(this.rows);
    for (let i = this.rows.length; i < grown.length; i += 1) grown[i] = 1;
    this.rows = grown;
  }

  private rebuildOffsets(): void {
    const n = this.lines.length;
    if (this.offsets.length < n + 1) this.offsets = new Float64Array(n + 1);
    const unit = this.unit;
    let at = 0;
    for (let i = 0; i < n; i += 1) {
      this.offsets[i] = at;
      at += this.rows[i] * unit;
    }
    this.offsets[n] = at;
    this.total = at;
    this.offsetsStale = false;
  }

  /** 取到与 textarea 同字体同宽度的隐藏测量层 */
  private mirrorOf(element: HTMLElement): HTMLDivElement | null {
    const host = element.parentElement ?? element.ownerDocument.body;
    if (this.mirror && this.host === host) return this.mirror;
    this.mirror?.remove();
    const node = element.ownerDocument.createElement("div");
    node.className = "mde-measure";
    node.setAttribute("aria-hidden", "true");
    host.appendChild(node);
    this.mirror = node;
    this.host = host;
    this.styleStale = true;
    return node;
  }

  /**
   * 把测量层的排版条件对齐到 textarea。
   *
   * 可用宽度要按 clientWidth 减左右 padding 算：纵向滚动条出现时 clientWidth 会自己变小。
   * 连字也要跟着：它改变字符宽度，两边不一致时同一行折出来的行数不同。
   * 逐帧调用太浪费（一次 getComputedStyle + 十几次样式写入），所以只在字体/尺寸变化时做。
   */
  private stylize(box: HTMLDivElement, element: HTMLElement): void {
    const view = element.ownerDocument.defaultView;
    const source = view ? view.getComputedStyle(element) : null;
    if (source) {
      box.style.fontFamily = source.fontFamily;
      box.style.fontSize = source.fontSize;
      box.style.lineHeight = source.lineHeight;
      box.style.fontWeight = source.fontWeight;
      box.style.fontStyle = source.fontStyle;
      box.style.fontVariant = source.fontVariant;
      box.style.letterSpacing = source.letterSpacing;
      box.style.wordSpacing = source.wordSpacing;
      box.style.textIndent = source.textIndent;
      box.style.textTransform = source.textTransform;
      box.style.tabSize = source.tabSize;
      box.style.wordBreak = source.wordBreak;
      box.style.overflowWrap = source.overflowWrap;
      box.style.fontVariantLigatures = source.fontVariantLigatures;
      box.style.fontFeatureSettings = source.fontFeatureSettings;
    }
    box.style.width = `${this.width}px`;
  }

  /** 实测 [from, to) 的行高并写回 rows；写入与读取分离，只触发一次重排 */
  private measureRange(element: HTMLElement, from: number, to: number): void {
    if (to <= from) return;
    const box = this.mirrorOf(element);
    if (!box) return;
    if (this.styleStale) {
      this.stylize(box, element);
      this.styleStale = false;
    }

    const doc = element.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const nodes: HTMLDivElement[] = [];
    for (let i = from; i < to; i += 1) {
      const line = doc.createElement("div");
      line.className = "mde-measure-line";
      line.textContent = this.lines[i] || FILLER;
      fragment.appendChild(line);
      nodes.push(line);
    }
    box.appendChild(fragment);
    // 先写完再统一读，避免读写交替触发多次重排
    const heights = nodes.map((node) => node.getBoundingClientRect().height);
    box.textContent = "";

    const unit = this.unit;
    for (let i = 0; i < nodes.length; i += 1) {
      this.rows[from + i] = Math.max(1, Math.round(heights[i] / unit));
    }
  }
}
