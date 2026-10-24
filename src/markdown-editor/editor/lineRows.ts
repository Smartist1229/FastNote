/**
 * 软换行下「每个逻辑行占几个视觉行」的测量器。
 *
 * 行号槽要靠它才能把折行的续行留空（数字钉在首行），所以它必须给出**屏上每一行的真实行数**；
 * 而真实行数只能靠真的排版量出来——按字数估算在长文档里会累积误差，滚到后面越偏越多。
 *
 * 这里的办法是**按需量当前可视窗口**，而不是把全文逐个量一遍：
 * - 视口里的行（含上下补渲染的行）在渲染前同步实测，屏上的行号、光标、高亮永远用真实行数；
 * - 没量过的行按 1 视觉行参与偏移计算。它们只在视口之外，看不见就不影响对齐；
 * - 滚动、搜索跳转只量目标附近的一小段（`measureBand`），代价与文档长度无关。
 *   百万字的文档打开即可用，不会因为后台逐行排版把主线程占住几十秒。
 *
 * 代价是：滚动条总高在没量到的地方是估算值，随滚动逐步校正。偏移表、行号槽和
 * 滚动同步都读同一张表，所以校正不会让屏上的行号与正文错开；向上滚进未测区时
 * `useVisibleRange` 会把锚点行的偏移变化补回 scrollTop，避免视图跳动。
 *
 * 文本增删会平移未改动的尾部行数（`rows.copyWithin`）：只重测真正改到的行，
 * 折行行数不会从改动点开始整体错位。
 *
 * 测量结果的消费方通过 `subscribe` 订阅（版本号变化即重取）。
 */
import { splitLines } from "./lines";

/** 空行没有行盒，量不出高度，塞个零宽字符让它撑出一行 */
const FILLER = "\u200b";

/** 没实测过的行在偏移表里按 1 视觉行估算（与旧行为一致，保证滚动映射单调） */
const ESTIMATED_ROWS = 1;

/**
 * 滚动路径上允许多少行暂时没量到：渲染窗口上下各留了十几行余量，
 * 这几行等进入窗口后下一帧自然会被量到，不值得为它们再开一次隐藏层排版。
 */
const RENDERED_SLACK = 12;

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

/** 两次切行的变化区间：公共前后缀之外的部分（`oldEnd` / `newEnd` 不含） */
interface LineDiff {
  first: number;
  oldEnd: number;
  newEnd: number;
}

const diffLines = (prev: string[], next: string[]): LineDiff => {
  const shared = Math.min(prev.length, next.length);
  let first = 0;
  while (first < shared && prev[first] === next[first]) first += 1;
  let suffix = 0;
  while (suffix < shared - first && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) {
    suffix += 1;
  }
  return { first, oldEnd: prev.length - suffix, newEnd: next.length - suffix };
};

export class LineRuler {
  /** 当前文本的切行结果（与共享切行缓存同一引用） */
  lines: string[] = [];
  /** 每个逻辑行占的视觉行数；NaN = 还没实测，按 ESTIMATED_ROWS 参与偏移计算 */
  rows = new Float64Array(0);
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
  /** 内容总高（px）：未测部分是估算值，随实测逐步校正 */
  total = 0;

  private boxKey = "";
  private cached: string[] | null = null;
  private width = 0;
  private offsets = new Float64Array(1);
  private offsetsStale = true;
  /** 字体/尺寸变过，测量层的排版条件需要重新对齐 */
  private styleStale = true;
  /** 排版条件变过时记下锚点行，等这轮重渲染把 padding 换成新表后再落 scrollTop */
  private anchorRequest: { line: number; intra: number } | null = null;
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

  /** 取走待落的锚点（排版条件刚变过）：消费方在重渲染后把这一行钉回原位置 */
  takeAnchor(): { line: number; intra: number } | null {
    const request = this.anchorRequest;
    this.anchorRequest = null;
    return request;
  }

  /** 实测改变了锚点行的偏移：等这一轮重渲染完成后再落 scrollTop */
  requestAnchor(line: number, intra: number): void {
    this.anchorRequest = { line, intra: Math.max(0, intra) };
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
   * 只实测「眼下要用的那一段」：文本变化时量改到的那几行，排版条件变化时量视口附近。
   * 其余行保持估算（1 视觉行），滚动/跳转时由 `measureBand` 逐段校正。
   * 这样文档长度不再决定每次编辑的代价。
   */
  sync(element: HTMLElement, text: string, box: RulerBox): void {
    if (!box.wrap ? box.unit <= 0 : box.width <= 0 || box.unit <= 0) return;
    const lines = splitLines(text);
    const key = `${box.font}|${Math.round(box.width)}|${box.unit}|${box.wrap ? 1 : 0}`;
    const boxChanged = key !== this.boxKey;
    const textChanged = this.cached !== lines;
    if (!boxChanged && !textChanged) return;

    this.boxKey = key;
    this.unit = box.unit;

    let anchorLine = 0;
    let intra = 0;
    if (boxChanged) {
      // 锚点要在改表之前取：宽度/字号变了以后，行号会整体换一套位置
      if (this.lines.length) {
        const top = element.scrollTop;
        anchorLine = this.lineAt(top);
        intra = Math.max(0, top - this.offsetOf(anchorLine));
      }
      const oldWidth = this.width;
      this.width = box.width;
      this.styleStale = true;
      /*
       * 行推进只跟字体/字号/行高/宽度有关，排版条件一变就重新实测一次。
       * 量不出来（极端情况下探针被裁剪）就退回 computed 值，退化到老行为。
       */
      const measured = this.measureAdvance(element);
      this.advance = measured && measured > box.unit * 0.6 && measured < box.unit * 1.6 ? measured : box.unit;

      /*
       * 已经量过的行按宽度比例缩放一次再继续用：换宽度时一行能放的字数大致与宽度成反比，
       * 缩放后的偏移足够接近真值，滚动位置不会先塌回文首再慢慢长回来。
       * 视口附近随后会被实测覆盖，远处的近似值等滚到了再校正。
       */
      if (box.wrap && oldWidth > 0) {
        const ratio = oldWidth / box.width;
        if (Math.abs(ratio - 1) > 0.001) {
          const count = this.lines.length;
          for (let i = 0; i < count; i += 1) {
            const value = this.rows[i];
            if (!Number.isNaN(value)) this.rows[i] = Math.max(1, Math.round(value * ratio));
          }
        }
      }
    }

    let diff: LineDiff | null = null;
    /*
     * 这一趟到底有没有「看得见的变化」：行数、折行行数、总高、偏移表任何一个动了，
     * 消费方才需要重渲染。普通打字把一行写得再长、只要没折出新的一行，
     * 屏上的数字、光标位置、滚动高度全都不变——此时通知订阅者只会白白重渲染一趟。
     */
    let changed = boxChanged || !this.cached || lines.length !== this.cached.length;
    let diffFirst = 0;
    let diffEnd = 0;
    let beforeRows = 0;
    if (textChanged) {
      const prev = this.cached;
      this.ensureCapacity(lines.length);
      if (prev && !boxChanged) {
        diff = diffLines(prev, lines);
        /*
         * 尾部行整体平移：只作废真正改到的区间，后面的折行行数继续有效。
         * 不这么做的话，插入/删除一行会让改动点之后的实测值全部与行错位。
         */
        if (diff.oldEnd !== diff.newEnd) {
          this.rows.copyWithin(diff.newEnd, diff.oldEnd, prev.length);
        } else {
          // 行数没变：记下改动区间的旧视觉行数，量完再比一次，决定要不要通知
          diffFirst = Math.max(0, diff.first);
          diffEnd = Math.min(prev.length, diff.oldEnd);
          for (let i = diffFirst; i < diffEnd; i += 1) {
            beforeRows += Number.isNaN(this.rows[i]) ? ESTIMATED_ROWS : this.rows[i];
          }
        }
      } else if (prev) {
        this.rows.fill(Number.NaN, 0, lines.length);
      }
      this.lines = lines;
      this.cached = lines;
      if (diff) {
        this.rows.fill(Number.NaN, Math.max(0, diff.first), Math.max(0, Math.min(diff.newEnd, lines.length)));
      }
    }

    this.ensureCapacity(lines.length);
    const count = lines.length;
    const visibleRows = Math.ceil(Math.max(1, element.clientHeight) / Math.max(1, this.advance || this.unit));

    if (!box.wrap) {
      // 不折行：每行必然占一行，直接标记全部已测，省掉整趟排版
      this.rows.fill(1, 0, count);
    } else if (boxChanged) {
      const anchor = Math.max(0, Math.min(anchorLine, Math.max(0, count - 1)));
      // 缩放值只是近似：视口上下这一段重新实测
      this.rows.fill(Number.NaN, anchor, Math.min(count, anchor + visibleRows + 4));
      this.measureBand(element, Math.max(0, anchor - 2), Math.min(count, anchor + visibleRows + 8), false);
    } else if (diff) {
      /*
       * 打字通常只改一行；粘贴/回车可能是几十行。
       * 少量改动直接量改动段，大量改动只保证屏上那一段是实测的（其余滚到时再补）。
       */
      const changedLines = Math.min(count, diff.newEnd) - Math.max(0, diff.first);
      if (changedLines <= 8) {
        this.measureBand(element, Math.max(0, diff.first), Math.min(count, diff.newEnd), false);
      } else {
        const anchor = this.lineAt(element.scrollTop);
        this.measureBand(element, anchor, Math.min(count, anchor + visibleRows + 2), false);
      }
    }

    if (!boxChanged && diff && diff.oldEnd === diff.newEnd) {
      let afterRows = 0;
      const end = Math.min(count, diff.newEnd);
      for (let i = diffFirst; i < end; i += 1) {
        afterRows += Number.isNaN(this.rows[i]) ? ESTIMATED_ROWS : this.rows[i];
      }
      changed = afterRows !== beforeRows;
    }

    if (changed) {
      this.offsetsStale = true;
      this.rebuildOffsets();
    }
    if (boxChanged && count) {
      const line = Math.min(anchorLine, count - 1);
      const height = (Number.isNaN(this.rows[line]) ? ESTIMATED_ROWS : this.rows[line]) * (this.advance || this.unit);
      this.requestAnchor(line, Math.min(intra, Math.max(0, height - 1)));
    }
    if (changed) this.notify();
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
    const index = Math.max(0, Math.min(line, this.lines.length - 1));
    // 光标所在行可能还没量过（例如刚打开文档）：先补测这一行，y 才是真实折行位置
    if (Number.isNaN(this.rows[index])) this.measureBand(element, index, index + 1);
    const box = this.mirrorOf(element);
    if (!box) return null;
    if (this.styleStale) {
      this.stylize(box, element);
      this.styleStale = false;
    }

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

  /**
   * 实测 `[from, to)` 里还没量过的行，返回行数是否真的变了。
   *
   * 只把 NaN 的行塞进测量层：已经量过的行不必重排，滚动时每次只付一小段的代价。
   * 返回值用于调用方决定要不要校正 scrollTop——行数没变，偏移就没变，不用动。
   *
   * `preferRendered` 是滚动路径用的：那时文本没变，编辑区里已经渲染出来的
   * `.mde-line` 就是最终排版结果，直接读它们的高度即可。隐藏测量层虽然也能量，
   * 但它每次 append 都会把刚被浏览器排好的文档再弄脏一遍——分栏时这一下会把
   * 预览区一起冲掉重排，每帧白白多付十几毫秒。渲染窗口本身就带上下各十几行余量，
   * 剩下几行没渲染到的先按估算参与排版，下一帧进入窗口时自然会被量到。
   */
  measureBand(element: HTMLElement, from: number, to: number, notify = true, preferRendered = false): boolean {
    const limit = this.lines.length;
    if (!limit) return false;
    const start = Math.max(0, Math.min(from, limit));
    const end = Math.max(start, Math.min(to, limit));
    if (end <= start) return false;
    this.ensureCapacity(limit);

    let missing = 0;
    for (let i = start; i < end; i += 1) if (Number.isNaN(this.rows[i])) missing += 1;
    if (!missing) return false;

    let changed = false;
    if (preferRendered) {
      const rendered = element.querySelectorAll<HTMLElement>(".mde-line[data-line]");
      const indexes: number[] = [];
      const nodes: HTMLElement[] = [];
      for (const node of rendered) {
        const index = Number(node.dataset.line);
        if (!Number.isInteger(index) || index < start || index >= end) continue;
        if (!Number.isNaN(this.rows[index])) continue;
        // 组合输入期间 DOM 里的文字可能领先于 ruler 的行文本，对不上就不信
        if ((node.textContent ?? "") !== (this.lines[index] ?? "")) continue;
        indexes.push(index);
        nodes.push(node);
      }
      if (indexes.length) {
        const heights = nodes.map((node) => node.getBoundingClientRect().height);
        changed = this.commitRows(indexes, heights);
        missing -= indexes.length;
        if (missing <= RENDERED_SLACK) {
          if (changed && notify) this.notify();
          return changed;
        }
      }
    }

    const box = this.mirrorOf(element);
    if (!box) return false;
    if (this.styleStale) {
      this.stylize(box, element);
      this.styleStale = false;
    }

    const doc = element.ownerDocument;
    const fragment = doc.createDocumentFragment();
    const indexes: number[] = [];
    const nodes: HTMLDivElement[] = [];
    for (let i = start; i < end; i += 1) {
      if (!Number.isNaN(this.rows[i])) continue;
      const line = doc.createElement("div");
      line.className = "mde-measure-line";
      line.textContent = this.lines[i] || FILLER;
      fragment.appendChild(line);
      indexes.push(i);
      nodes.push(line);
    }
    box.appendChild(fragment);
    // 先写完再统一读，避免读写交替触发多次重排
    const heights = nodes.map((node) => node.getBoundingClientRect().height);
    box.textContent = "";

    changed = this.commitRows(indexes, heights) || changed;
    if (changed && notify) this.notify();
    return changed;
  }

  private commitRows(indexes: number[], heights: number[]): boolean {
    const unit = this.unit;
    let changed = false;
    for (let i = 0; i < indexes.length; i += 1) {
      const index = indexes[i];
      const rows = Math.max(1, Math.round(heights[i] / unit));
      const previous = Number.isNaN(this.rows[index]) ? ESTIMATED_ROWS : this.rows[index];
      this.rows[index] = rows;
      if (rows !== previous) changed = true;
    }
    this.offsetsStale = true;
    return changed;
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
    grown.fill(Number.NaN);
    grown.set(this.rows);
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
      const rows = this.rows[i];
      at += (Number.isNaN(rows) ? ESTIMATED_ROWS : rows) * advance;
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
}
