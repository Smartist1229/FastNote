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
  /** 编辑区内容区可用宽度（px） */
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
  /** 单行行高（px）：来自容器的 computed line-height，用于把测量层的像素高度折算成行数 */
  unit = 0;
  /**
   * 真实的行推进（px）：一行走多高。
   *
   * 大多数情况下等于 `unit`，但**不能直接拿 computed line-height 当它用**：
   * 那个值只是显示用的四舍五入结果，而排版用的行盒是 LayoutUnit（1/64 px）——
   * 像 14px × 1.9 = 26.6px 这种值并不能整除，真实推进是 26.59375，
   * 每行差 0.006px；一行看不出来，两千行就是十几像素，折行多的话还会被放大。
   * 所以这里用一个探针实测一次「几行占多高」，把差值抹掉。
   */
  advance = 0;
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
      /*
       * 行推进只跟字体/字号/行高/宽度有关，排版条件一变就重新实测一次。
       * 量不出来（极端情况下探针被裁剪）就退回 computed 值，退化到老行为。
       */
      const measured = this.measureAdvance(element);
      this.advance = measured && measured > box.unit * 0.6 && measured < box.unit * 1.6 ? measured : box.unit;
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

  /**
   * 保证 [0, upto) 全部实测过：直接跳到远处时这里一次补齐，之后就不用再测。
   *
   * 补齐会改偏移表（未测行原本按 1 行算），所以要主动通知一次：查找高亮层的上下垫高
   * 就是按这张表算的，不通知的话「滚动到远处再改字号」时那条路径上没人重算 → 高亮整层偏移。
   * 一帧最多通知一次（`measure` 每次滚动只调一遍，且 `target <= frontier` 时直接返回）。
   */
  ensureVisible(element: HTMLElement, upto: number): void {
    const target = Math.min(upto, this.lines.length);
    if (target <= this.frontier) return;
    this.measureRange(element, this.frontier, target);
    this.frontier = target;
    this.offsetsStale = true;
    this.notify();
  }

  /**
   * 光标在**内容坐标系**里的位置（px）：x 从内容左边缘算，y 从内容顶边算。
   *
   * 复用行号槽的测量层：它已经和编辑区同字体、同宽度、同折行规则（连字也一起），
   * 只把光标所在的那一行拆成「前缀 + 标记 + 后缀」排一次，标记的 offsetLeft/offsetTop
   * 就是光标的位置——折行、Tab、代理对、CJK 全宽都由浏览器算，不用另养一套宽度模型。
   *
   * 一次调用 = 一次排版 + 两次读取，所以只在光标真的动过时调（滚动只是平移，别走这里）。
   */
  caretPoint(element: HTMLElement, line: number, column: number): { x: number; y: number } | null {
    if (!this.lines.length) return null;
    const box = this.mirrorOf(element);
    if (!box) return null;
    if (this.styleStale) {
      this.stylize(box, element);
      this.styleStale = false;
    }

    const index = Math.max(0, Math.min(line, this.lines.length - 1));
    const text = this.lines[index] ?? "";
    const at = Math.max(0, Math.min(column, text.length));
    const doc = element.ownerDocument;
    const row = doc.createElement("div");
    row.className = "mde-measure-line";
    // offsetParent 收窄到这一行：量出来的就是行内坐标，折出来的第几行体现在 top 里
    row.style.position = "relative";
    /*
     * 首尾各放一个零宽标记，尾部那个就是光标。
     *
     * 为什么不直接用尾部标记的 offsetTop：行内盒的 offsetTop 不是行盒顶，
     * 而是「内容区顶」——等于 (line-height − 字体内容高) / 2 的那点内缩（实测 4px）。
     * 拿一个同样在行首的标记做基准相减，剩下的就恰好是「折过几个视觉行」。
     */
    const base = doc.createElement("span");
    base.textContent = FILLER;
    const marker = doc.createElement("span");
    marker.textContent = FILLER;
    row.appendChild(base);
    row.appendChild(doc.createTextNode(text.slice(0, at)));
    row.appendChild(marker);
    row.appendChild(doc.createTextNode(text.slice(at)));
    box.appendChild(row);
    // 先写完再读：整个过程只触发一次重排
    const x = marker.offsetLeft;
    /*
     * 行内的折行偏移（marker.offsetTop - base.offsetTop）是测量层量出来的，单位是
     * 测量层的行高 `unit`；真实排版用的是 `advance`，两者可能差零点几像素。
     * 折过几行先折算成行数，再乘以 advance，光标才不会在一行的第 2、3 段上慢慢偏。
     */
    const rowsIntoLine = this.unit > 0 ? (marker.offsetTop - base.offsetTop) / this.unit : 0;
    const y = this.offsetOf(index) + Math.round(rowsIntoLine) * (this.advance || this.unit);
    box.textContent = "";
    return { x, y };
  }

  /**
   * 实测「一行占多高」。
   *
   * 探针就是测量层里的一行：同样的字体 / 字号 / 行高 / 宽度，塞 6 行进去，
   * 量出来的高度除以 6。编辑区现在是 contenteditable 的块级容器，
   * 行盒与测量层同源，所以探针也用同一个 div——不必再为一个表单控件单开一套。
   */
  private measureAdvance(element: HTMLElement): number | null {
    const box = this.mirrorOf(element);
    if (!box) return null;
    if (this.styleStale) {
      this.stylize(box, element);
      this.styleStale = false;
    }
    const doc = element.ownerDocument;
    const probe = doc.createElement("div");
    probe.className = "mde-measure-line";
    // 6 行要真的排成 6 行：测量层整体跟着编辑区走 pre-wrap，这里强制不折
    probe.style.whiteSpace = "pre";
    probe.textContent = "x\nx\nx\nx\nx\nx";
    box.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height > 0 ? height / 6 : null;
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

    this.notify();
    return this.pending > 0;
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
    // 用实测的行推进，不是 computed line-height：两者在小数行高下会差零点几像素
    const advance = this.advance || this.unit;
    let at = 0;
    for (let i = 0; i < n; i += 1) {
      this.offsets[i] = at;
      at += this.rows[i] * advance;
    }
    this.offsets[n] = at;
    this.total = at;
    this.offsetsStale = false;
  }

  /** 取到与编辑区同字体同宽度的隐藏测量层 */
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
   * 把测量层的排版条件对齐到编辑区容器。
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
      /*
       * 折行方式要照抄：关掉自动换行时编辑区是 `pre`，
       * 测量层若还留着 CSS 里的 `pre-wrap`，超宽的长行会被折成几段，
       * 光标横向坐标就变成「折行后的列」而不是真实列——nowrap 下会整体偏左。
       */
      box.style.whiteSpace = source.whiteSpace;
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
