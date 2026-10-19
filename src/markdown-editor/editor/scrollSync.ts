/**
 * 分栏滚动同步。
 *
 * 不用「百分比对百分比」的原因：源码行数与渲染高度不成正比（一个代码块可能占 20 行源码
 * 但只有 3 屏高），按比例同步会在长文档里越滚越偏。
 *
 * 这里用「单调锚点表 + 强制端点」：
 * - 预览里每个顶层块带 `data-line`，收集成锚点：源码侧 = 该行贴在源码视口顶部所需的
 *   scrollTop，预览侧 = 对应块贴在预览视口顶部所需的 scrollTop；
 * - 表从 `(0, 0)` 起步，以「两端各自的最大滚动值」收尾，并且**双向严格递增**。
 *   收尾这一步是「源码比预览长 / 预览比源码长 / 纯文本没有任何块锚点」都能对上的关键：
 *   尾部块锚点的源码侧通常已经超过源码最大滚动值（最后几行永远顶不到视口顶部），
 *   直接追加会破坏单调性，所以先把压在端点之后的锚点弹掉再追加；
 * - 滚动时查表做分段线性插值，两个方向都驱动。
 *
 * 回声处理：写进对方的值记下来，对方随后触发的 scroll 事件如果正好是这个值就认作回声丢掉。
 * 比「加锁 N 毫秒」更跟手——用户连续滚动时不会有事件被吞，也不会两边互相推动抖动。
 */

interface Point {
  /** 源码侧：让某一行贴在源码视口顶部所需的 scrollTop */
  source: number;
  /** 预览侧：对应块贴在预览视口顶部所需的 scrollTop */
  preview: number;
}

/** 取源码区一个视觉行的真实像素行高（行高是倍数，要落成 px 才能换算偏移） */
const readUnit = (editor: HTMLElement, fallback: number): number => {
  const view = editor.ownerDocument.defaultView;
  if (!view) return fallback;
  const value = parseFloat(view.getComputedStyle(editor).lineHeight);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * 估算每个逻辑行在源码里的纵向偏移。
 *
 * textarea 的 scrollHeight 是**视觉行**总高：开了自动换行时一个逻辑行可能占好几行，
 * 直接按 `(行号-1)×行高` 算会系统性偏小，长文里能差出一整屏，表现为「源码还能滚，
 * 映射已经到头了」。这里先反推视觉行总数，再按行长把它分回各行：
 * 解 `Σ max(1, 行长/cap) = 视觉行总数` 得到「一个视觉行大约放多少字」，
 * 行长除 cap 就是该行的视觉行数。没折行时解出的 cap 会大于最长行，
 * 于是每行都是 1 行，与不折行的结果完全一致。
 */
const estimateLineOffsets = (editor: HTMLElement, text: string, unit: number): number[] => {
  const lines = text.split("\n");
  const offsets = new Array<number>(lines.length);
  const rows = new Array<number>(lines.length).fill(1);
  const view = editor.ownerDocument.defaultView;
  const style = view ? view.getComputedStyle(editor) : null;
  const padTop = style ? parseFloat(style.paddingTop) || 0 : 0;
  const padBottom = style ? parseFloat(style.paddingBottom) || 0 : 0;
  const content = Math.max(0, editor.scrollHeight - padTop - padBottom);
  const rowsTotal = unit > 0 ? Math.max(lines.length, content / unit) : lines.length;

  let longest = 0;
  for (const line of lines) if (line.length > longest) longest = line.length;
  if (rowsTotal > lines.length + 0.5 && longest > 0) {
    let low = 1;
    let high = longest;
    // 二分 20 次足够：cap 的精度对最终插值影响远小于 1px
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      let sum = 0;
      for (const line of lines) sum += Math.max(1, line.length / mid);
      if (sum > rowsTotal) low = mid;
      else high = mid;
    }
    const cap = Math.max(1, (low + high) / 2);
    for (let i = 0; i < lines.length; i++) rows[i] = Math.max(1, lines[i].length / cap);
  }

  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    offsets[i] = offset;
    offset += rows[i] * unit;
  }
  return offsets;
};

/** 收集锚点表：双向严格递增，首尾必为 (0,0) 与 (最大滚动, 最大滚动) */
const collectPoints = (preview: HTMLElement, editor: HTMLElement, text: string, unit: number): Point[] => {
  const points: Point[] = [];
  /** 双向都要严格递增，否则插值会来回跳 */
  const push = (source: number, previewTop: number) => {
    const last = points[points.length - 1];
    if (last && (source <= last.source || previewTop <= last.preview)) return;
    points.push({ source, preview: previewTop });
  };

  push(0, 0);
  const offsets = estimateLineOffsets(editor, text, unit);
  const origin = preview.getBoundingClientRect().top - preview.scrollTop;
  let lastLine = -1;
  preview.querySelectorAll<HTMLElement>("[data-line]").forEach((node) => {
    const line = Number(node.dataset.line);
    // 同一行可能有多个块（块内嵌套），只取第一个
    if (!Number.isFinite(line) || line < 1 || line === lastLine) return;
    lastLine = line;
    const source = offsets[Math.min(line - 1, offsets.length - 1)] ?? 0;
    push(source, node.getBoundingClientRect().top - origin);
  });

  const maxSource = Math.max(0, editor.scrollHeight - editor.clientHeight);
  const maxPreview = Math.max(0, preview.scrollHeight - preview.clientHeight);
  while (points.length > 1) {
    const last = points[points.length - 1];
    if (maxSource > last.source && maxPreview > last.preview) break;
    points.pop();
  }
  push(maxSource, maxPreview);
  return points;
};

/** 分段线性插值：position 在 `side` 这一侧落在哪一段，就按比例取另一侧的值 */
const mapPoint = (points: Point[], position: number, side: "source" | "preview"): number => {
  if (!points.length) return 0;
  const from = side === "source" ? (point: Point) => point.source : (point: Point) => point.preview;
  const to = side === "source" ? (point: Point) => point.preview : (point: Point) => point.source;
  const first = points[0];
  if (position <= from(first)) return to(first);
  for (let i = 0; i < points.length - 1; i++) {
    const current = points[i];
    const next = points[i + 1];
    const start = from(current);
    const end = from(next);
    if (position > end) continue;
    const span = Math.max(1e-6, end - start);
    return to(current) + (to(next) - to(current)) * ((position - start) / span);
  }
  return to(points[points.length - 1]);
};

export interface ScrollSyncOptions {
  editor: HTMLElement;
  preview: HTMLElement;
  /** 编辑区一个逻辑行的高度（px）；取不到计算样式时的兜底值 */
  lineHeight: number;
  mode: "anchor" | "ratio";
}

/**
 * 幂等写回：目标已经在位置上（差值 < 1px）就不写。
 * 没有这一步，「源码 → 预览 → 源码」的回声会永动；有了它，回声算出相同值时
 * 不产生新的 scroll 事件，链条自然终止。
 */
const writeScroll = (target: HTMLElement, value: number): boolean => {
  const max = Math.max(0, target.scrollHeight - target.clientHeight);
  const next = Math.round(Math.min(Math.max(0, value), max));
  if (Math.abs(target.scrollTop - next) < 1) return false;
  target.scrollTop = next;
  return true;
};

/** 建立双向同步，返回解绑函数 */
export const bindScrollSync = ({ editor, preview, lineHeight, mode }: ScrollSyncOptions): (() => void) => {
  const source = editor as HTMLTextAreaElement;
  let points: Point[] = [];
  /** 尺寸指纹：内容或视口变了才重算锚点，比逐帧收集便宜得多 */
  let stamp = "";
  let dirty = true;
  /** 自己写进去的值：用它把回声事件认出来 */
  let echoEditor = -1;
  let echoPreview = -1;
  let frameEditor = 0;
  let framePreview = 0;

  const sync = (from: "editor" | "preview") => {
    const maxEditor = Math.max(0, editor.scrollHeight - editor.clientHeight);
    const maxPreview = Math.max(0, preview.scrollHeight - preview.clientHeight);
    if (mode === "ratio") {
      const fromMax = from === "editor" ? maxEditor : maxPreview;
      const toMax = from === "editor" ? maxPreview : maxEditor;
      const fromEl = from === "editor" ? editor : preview;
      const toEl = from === "editor" ? preview : editor;
      if (writeScroll(toEl, fromMax > 0 ? (fromEl.scrollTop / fromMax) * toMax : 0)) {
        if (toEl === editor) echoEditor = editor.scrollTop;
        else echoPreview = preview.scrollTop;
      }
      return;
    }
    const next = `${preview.scrollHeight}/${preview.clientHeight}/${editor.scrollHeight}/${editor.clientHeight}`;
    if (dirty || next !== stamp) {
      dirty = false;
      stamp = next;
      points = collectPoints(
        preview,
        editor,
        typeof source.value === "string" ? source.value : "",
        readUnit(editor, lineHeight),
      );
    }
    if (from === "editor") {
      if (writeScroll(preview, mapPoint(points, editor.scrollTop, "source"))) echoPreview = preview.scrollTop;
    } else if (writeScroll(editor, mapPoint(points, preview.scrollTop, "preview"))) {
      echoEditor = editor.scrollTop;
    }
  };

  const onEditorScroll = () => {
    const echo = echoEditor >= 0 && Math.abs(editor.scrollTop - echoEditor) < 1;
    echoEditor = -1;
    if (echo) return;
    cancelAnimationFrame(frameEditor);
    frameEditor = requestAnimationFrame(() => sync("editor"));
  };
  const onPreviewScroll = () => {
    const echo = echoPreview >= 0 && Math.abs(preview.scrollTop - echoPreview) < 1;
    echoPreview = -1;
    if (echo) return;
    cancelAnimationFrame(framePreview);
    framePreview = requestAnimationFrame(() => sync("preview"));
  };
  // 预览重渲染（打字、切文档）后锚点失效
  const markDirty = () => {
    dirty = true;
  };

  editor.addEventListener("scroll", onEditorScroll, { passive: true });
  preview.addEventListener("scroll", onPreviewScroll, { passive: true });
  const observer = new MutationObserver(markDirty);
  observer.observe(preview, { childList: true, subtree: true, characterData: true });

  return () => {
    cancelAnimationFrame(frameEditor);
    cancelAnimationFrame(framePreview);
    editor.removeEventListener("scroll", onEditorScroll);
    preview.removeEventListener("scroll", onPreviewScroll);
    observer.disconnect();
  };
};
