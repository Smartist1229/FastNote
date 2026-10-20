/**
 * 分栏滚动同步。
 *
 * 不用「百分比对百分比」的原因：编辑行数与渲染高度不成正比（一个代码块可能占 20 行编辑内容
 * 但只有 3 屏高），按比例同步会在长文档里越滚越偏。
 *
 * 这里用「单调锚点表 + 强制端点」：
 * - 预览里每个顶层块带 `data-line`，收集成锚点：编辑侧 = 该行贴在编辑视口顶部所需的
 *   scrollTop，预览侧 = 对应块贴在预览视口顶部所需的 scrollTop；
 * - 表从 `(0, 0)` 起步，以「两端各自的最大滚动值」收尾，并且**双向严格递增**。
 *   收尾这一步是「编辑比预览长 / 预览比编辑长 / 纯文本没有任何块锚点」都能对上的关键：
 *   尾部块锚点的编辑侧通常已经超过编辑区最大滚动值（最后几行永远顶不到视口顶部），
 *   直接追加会破坏单调性，所以先把压在端点之后的锚点弹掉再追加；
 * - 滚动时查表做分段线性插值，两个方向都驱动。
 *
 * 回声处理：写进对方的值记下来，对方随后触发的 scroll 事件如果正好是这个值就认作回声丢掉。
 * 比「加锁 N 毫秒」更跟手——用户连续滚动时不会有事件被吞，也不会两边互相推动抖动。
 */

interface Point {
  /** 编辑侧：让某一行贴在编辑视口顶部所需的 scrollTop */
  source: number;
  /** 预览侧：对应块贴在预览视口顶部所需的 scrollTop */
  preview: number;
}

export interface SourceGeometry {
  /**
   * 某一行（1 起算）在编辑区内容坐标系里的纵向偏移（px）。
   *
   * 虚拟化的编辑区 DOM 里没有整篇，纵向位置只能问 `LineRuler`——
   * 而它也正是编辑区自己滚动时所依据的那张表，两边用同一张表才对得上。
   */
  lineOffset: (line: number) => number;
  /** 编辑区一个视觉行的真实行高（px） */
  unit: () => number;
}

/** 收集锚点表：双向严格递增，首尾必为 (0,0) 与 (最大滚动, 最大滚动) */
const collectPoints = (
  preview: HTMLElement,
  editor: HTMLElement,
  geometry: SourceGeometry,
  lineCount: number,
): Point[] => {
  const points: Point[] = [];
  /** 双向都要严格递增，否则插值会来回跳 */
  const push = (source: number, previewTop: number) => {
    const last = points[points.length - 1];
    if (last && (source <= last.source || previewTop <= last.preview)) return;
    points.push({ source, preview: previewTop });
  };

  push(0, 0);
  const origin = preview.getBoundingClientRect().top - preview.scrollTop;
  let lastLine = -1;
  preview.querySelectorAll<HTMLElement>("[data-line]").forEach((node) => {
    const line = Number(node.dataset.line);
    // 同一行可能有多个块（块内嵌套），只取第一个
    if (!Number.isFinite(line) || line < 1 || line === lastLine) return;
    lastLine = line;
    const source = geometry.lineOffset(Math.min(line, Math.max(1, lineCount)));
    push(source, node.getBoundingClientRect().top - origin);
  });

  const maxPreview = Math.max(0, preview.scrollHeight - preview.clientHeight);
  // 编辑侧的最大滚动：虚拟化之后容器的 scrollHeight 就是 LineRuler 算出来的总高（上下垫高撑出来的）
  const maxSource = Math.max(0, editor.scrollHeight - editor.clientHeight);
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
  /** 编辑区的几何：行偏移与视觉行高（虚拟化下由 LineRuler 提供） */
  geometry: SourceGeometry;
  /** 编辑总行数：锚点行号超出时按它夹取（取函数，避免每次敲字都重新绑定） */
  lineCount: () => number;
  mode: "anchor" | "ratio";
}

/**
 * 幂等写回：目标已经在位置上（差值 < 1px）就不写。
 * 没有这一步，「编辑 → 预览 → 编辑」的回声会永动；有了它，回声算出相同值时
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
export const bindScrollSync = ({
  editor,
  preview,
  geometry,
  lineCount,
  mode,
}: ScrollSyncOptions): (() => void) => {
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
    const total = lineCount();
    const next = `${preview.scrollHeight}/${preview.clientHeight}/${editor.scrollHeight}/${editor.clientHeight}/${total}`;
    if (dirty || next !== stamp) {
      dirty = false;
      stamp = next;
      points = collectPoints(preview, editor, geometry, total);
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
