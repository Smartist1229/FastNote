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
  const sourceOf = (line: number) =>
    geometry.lineOffset(Math.min(Math.max(1, line), Math.max(1, lineCount)));

  push(0, 0);
  const origin = preview.getBoundingClientRect().top - preview.scrollTop;
  /*
   * 长文档的预览是分片 `content-visibility` 的，看单个块的矩形没问题，
   * 但遍历全部块会逼浏览器把每个屏外分片都排一遍——一次收集能卡上十几秒。
   * 屏外分片只拿「分片顶 + 分片首块行号」当锚点；视口附近的分片才展开到块。
   * 滚动时的局部映射因此仍是逐块的，远距离跳转先按分片近似、进入视野后再校正。
   */
  const chunks = preview.querySelectorAll<HTMLElement>(".mde-chunk");
  if (chunks.length) {
    /*
     * 只展开当前视口里的分片：同步的目标位置就在视口附近，逐块锚点取这一小段就够。
     * 上下各多看一屏会把每帧要读的块矩形翻三倍，而分片锚点已经能覆盖视口外的那一段。
     */
    const viewTop = preview.scrollTop;
    const viewBottom = preview.scrollTop + preview.clientHeight;
    const addRows = (chunk: HTMLElement) => {
      chunk.querySelectorAll<HTMLElement>("[data-line]").forEach((node) => {
        const line = Number(node.dataset.line);
        if (!Number.isFinite(line) || line < 1) return;
        push(sourceOf(line), node.getBoundingClientRect().top - origin);
      });
    };
    chunks.forEach((chunk) => {
      const rect = chunk.getBoundingClientRect();
      const top = rect.top - origin;
      const line = Number(chunk.dataset.line);
      if (Number.isFinite(line) && line >= 1) push(sourceOf(line), top);
      if (top + rect.height >= viewTop && top <= viewBottom) addRows(chunk);
    });
  } else {
    let lastLine = -1;
    preview.querySelectorAll<HTMLElement>("[data-line]").forEach((node) => {
      const line = Number(node.dataset.line);
      // 同一行可能有多个块（块内嵌套），只取第一个
      if (!Number.isFinite(line) || line < 1 || line === lastLine) return;
      lastLine = line;
      push(sourceOf(line), node.getBoundingClientRect().top - origin);
    });
  }

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

/** 一次写回的结果：落点和它跨过的距离（后者用来判断是不是大跳转） */
interface ScrollWrite {
  value: number;
  delta: number;
}

/**
 * 幂等写回：目标已经在位置上（差值 < 1px）就不写。
 * 没有这一步，「编辑 → 预览 → 编辑」的回声会永动；有了它，回声算出相同值时
 * 不产生新的 scroll 事件，链条自然终止。
 *
 * 返回实际写入的位置（没写则为 null）。调用方直接拿它记回声，别再读一次
 * `scrollTop`：写完立刻读会强制浏览器当场把新滚出来的那一屏排版一遍，
 * 分栏里每帧要多付好几毫秒。
 */
const writeScroll = (target: HTMLElement, value: number): ScrollWrite | null => {
  const max = Math.max(0, target.scrollHeight - target.clientHeight);
  const next = Math.round(Math.min(Math.max(0, value), max));
  const current = target.scrollTop;
  if (Math.abs(current - next) < 1) return null;
  target.scrollTop = next;
  return { value: next, delta: Math.abs(next - current) };
};

/**
 * 大跳转后的补算。
 *
 * 跳到远处时，目标区里 `content-visibility: auto` 的分片还是按占位高度摆着的；
 * 写进 scrollTop 的那一帧浏览器才把分片排成真实高度，整段内容随之平移——
 * 此时源侧的 scrollTop 没变、目标侧也没再发 scroll 事件，一次映射就停在了
 * 偏出去的位置（实测能差一整节，要再滚一像素才对齐）。
 *
 * 先把紧挨着的两帧补算掉（布局可能在一两帧内就变了），再按时间补算几次：
 * 分片真正换高有时要几十到几百毫秒，只在 rAF 里补会错过这段「迟到的布局」。
 * 只给大跳转补算，连续滚动时每帧仍然只映射一次。
 */
const SETTLE_PASSES = 2;
/** 大跳转后额外按时间补算的延迟（ms）：覆盖分片迟到的高度更新 */
const SETTLE_DELAYS = [100, 300, 700];
/** 超过这个距离才算大跳转：小步滚动时没有分片换高的问题，不必多算 */
const SETTLE_DELTA = 24;

/** 建立双向同步，返回解绑函数 */
export const bindScrollSync = ({
  editor,
  preview,
  geometry,
  lineCount,
  mode,
}: ScrollSyncOptions): (() => void) => {
  let points: Point[] = [];
  /** 自己写进去的值：用它把回声事件认出来 */
  let echoEditor = -1;
  let echoPreview = -1;
  let frameEditor = 0;
  let framePreview = 0;
  /** 延迟补算的定时器；用户真正滚动 / 解绑时取消 */
  let settleTimers: number[] = [];

  const clearSettle = () => {
    for (const id of settleTimers) window.clearTimeout(id);
    settleTimers = [];
  };

  /** 按当前布局再映射几次（只写不排下一轮，避免定时器互相续命） */
  const scheduleSettle = (from: "editor" | "preview") => {
    clearSettle();
    settleTimers = SETTLE_DELAYS.map((delay) => window.setTimeout(() => sync(from), delay));
  };

  const sync = (from: "editor" | "preview"): ScrollWrite | null => {
    const maxEditor = Math.max(0, editor.scrollHeight - editor.clientHeight);
    const maxPreview = Math.max(0, preview.scrollHeight - preview.clientHeight);
    if (mode === "ratio") {
      const fromMax = from === "editor" ? maxEditor : maxPreview;
      const toMax = from === "editor" ? maxPreview : maxEditor;
      const fromEl = from === "editor" ? editor : preview;
      const toEl = from === "editor" ? preview : editor;
      const written = writeScroll(toEl, fromMax > 0 ? (fromEl.scrollTop / fromMax) * toMax : 0);
      if (written) {
        if (toEl === editor) echoEditor = written.value;
        else echoPreview = written.value;
      }
      return written;
    }
    const total = lineCount();
    /*
     * 每帧重收集，不再缓存整张锚点表。
     *
     * 分片 `content-visibility` 的占位高度会在滚动中逐步换成实测值，缓存的远距离
     * 锚点过一帧就偏了；而按分片收集之后一次只有几百个锚点，重算比读一遍缓存贵不了多少。
     * 反过来缓存「尺寸指纹」还会把整篇块矩形读一遍，在长文档上正是十几秒的卡顿来源。
     */
    points = collectPoints(preview, editor, geometry, total);
    if (from === "editor") {
      const written = writeScroll(preview, mapPoint(points, editor.scrollTop, "source"));
      if (written) echoPreview = written.value;
      return written;
    }
    const written = writeScroll(editor, mapPoint(points, preview.scrollTop, "preview"));
    if (written) echoEditor = written.value;
    return written;
  };

  /** 跑一次映射；大跳转后补算几帧，并按时间再补几次等分片落定 */
  const run = (from: "editor" | "preview", pass = 0) => {
    const written = sync(from);
    if (!written || written.delta < SETTLE_DELTA) return;
    scheduleSettle(from);
    if (pass >= SETTLE_PASSES) return;
    if (from === "editor") {
      cancelAnimationFrame(frameEditor);
      frameEditor = requestAnimationFrame(() => run("editor", pass + 1));
    } else {
      cancelAnimationFrame(framePreview);
      framePreview = requestAnimationFrame(() => run("preview", pass + 1));
    }
  };

  const onEditorScroll = () => {
    const echo = echoEditor >= 0 && Math.abs(editor.scrollTop - echoEditor) < 1;
    echoEditor = -1;
    if (echo) return;
    clearSettle();
    cancelAnimationFrame(frameEditor);
    frameEditor = requestAnimationFrame(() => run("editor"));
  };
  const onPreviewScroll = () => {
    const echo = echoPreview >= 0 && Math.abs(preview.scrollTop - echoPreview) < 1;
    echoPreview = -1;
    if (echo) return;
    clearSettle();
    cancelAnimationFrame(framePreview);
    framePreview = requestAnimationFrame(() => run("preview"));
  };

  editor.addEventListener("scroll", onEditorScroll, { passive: true });
  preview.addEventListener("scroll", onPreviewScroll, { passive: true });

  return () => {
    clearSettle();
    cancelAnimationFrame(frameEditor);
    cancelAnimationFrame(framePreview);
    editor.removeEventListener("scroll", onEditorScroll);
    preview.removeEventListener("scroll", onPreviewScroll);
  };
};
