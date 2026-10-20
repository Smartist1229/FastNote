/**
 * 编辑输入区：contenteditable + 按逻辑行虚拟化。
 *
 * 为什么不是 textarea：
 * - textarea 里整篇文本都在 DOM 上，几万行的文档光是文本节点就是几万个，
 *   每次重排/重绘都要带上它们；
 * - 查找高亮只能靠「底下再铺一层镜像文本」来画，两层必须像素级对齐，
 *   改字号、改命中、浏览器的滚动锚定都会让它错位。
 *
 * 换过来之后：
 * - DOM 里只有可视区间那几十个 `.mde-line`，文档多长都不影响节点数；
 * - 查找高亮走 `::highlight()`（见 editor/highlights.ts），底色铺的就是命中那一段文字，
 *   没有第二层文本，也就没有「两层对不齐」这回事；
 * - 行号、当前行高亮、折行测量、光标定位都只是「给那一行加个类 / 查一次偏移表」
 *   ——行号槽与正文天然对齐，因为它们共用同一份 `LineRuler`。
 *
 * 代价是要自己接管「DOM ↔ 文档偏移」这件事，这里把它收在三处：
 * - 所有编辑意图都在 `beforeinput` 里拦下来自己算（输入法组合除外），
 *   于是文档始终是唯一事实，不用去猜浏览器改了什么；
 * - 组合期间放浏览器改 DOM，结束（`compositionend`）时把渲染窗口的整段文本读回来，
 *   与上一次渲染的内容做前后缀差分，换算出新的全文；
 * - 光标移动（方向键 / Home / End / 翻页）交回浏览器：行是真的 DOM 行，
 *   折行之后「下一行在哪」它比我们清楚。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ClipboardEvent as ReactClipboardEvent,
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { MarkdownChangeSource, MarkdownEditorConfig } from "../types";
import { autoPairOnInput, continueMarkdownOnEnter, runCommand, type EditState } from "../editor/commands";
import { lineAtOffset, lineOffsets, splitLines } from "../editor/lines";
import { useVisualLineRows } from "../editor/hooks/useVisualLineRows";
import { useVisibleRange } from "../editor/hooks/useVisibleRange";
import type { SearchMatch } from "../editor/search";
import { clearHighlights, setFlashRanges, setHighlightRanges, setTokenRanges } from "../editor/highlights";
import {
  collectFenceRows,
  highlightFenceRows,
  scanFences,
  syntaxHighlightName,
  type TokenSpan,
} from "../editor/syntax";
import { Gutter, type GutterHandle } from "../components/Gutter";

/** 可视区间上下各多渲染几行：滚到边界时新内容已经在 DOM 里，不会闪一下空白 */
const VIEW_PAD = 12;

/** ruler 还没给出可视区间时的兜底渲染行数（首帧） */
const FALLBACK_LINES = 60;

/**
 * 为了落选区，渲染区间最多向上下各补多少行。
 *
 * 待落的选区两端必须真的在 DOM 里，否则只能退到窗口边缘（光标就停在上一行）。
 * 打字、回车这种「只在附近动一两行」的情况全靠这个补齐：
 * 文档末尾新加一行时，区间要等下一次 `sync()` 才变，那一帧里新行还不存在。
 *
 * 上限是必要的：全选时光标在文档末尾，没有上限就会把整篇几万行都渲染出来。
 */
const SELECT_PAD = 64;

/** 一个容器最多铺多少个命中区间 */
const MAX_RANGES = 400;

/**
 * 一次最多铺多少个代码 token 区间。
 *
 * token 比查找命中密得多（一行十几个很常见），但只覆盖可视区间，
 * 给到 1500 足够铺满一屏；再多的部分滚出去之后会重新算。
 */
const MAX_TOKEN_RANGES = 1500;

export interface SourceEditorHandle {
  focus: () => void;
  blur: () => void;
  getElement: () => HTMLElement | null;
  getState: () => EditState;
  /** 写入新值并指定选区（历史由上层记录） */
  apply: (next: EditState, source?: MarkdownChangeSource) => void;
  /**
   * 设置选区。`focus` 为 false 时只落选区、不抢焦点：
   * 查找跳转（连按 Enter 找下一个）必须用 false，否则焦点回到输入框之前，
   * 第二次 Enter 就变成在编辑器里换行。
   */
  /**
   * @param focus  是否顺带抢焦点（查找跳转要传 false，否则第二次 Enter 会变成换行）
   * @param reveal 是否顺带把目标滚进视野（调用方已经滚好了就传 false，免得两套滚动打架）
   */
  setSelection: (start: number, end?: number, focus?: boolean, reveal?: boolean) => void;
  /** 只排队选区：等下一次 value 更新后再落选区，用于撤销这类"先改值再定位"的场景 */
  queueSelection: (start: number, end?: number) => void;
  scrollToLine: (line: number) => void;
  /** 让某个文本偏移可见（查找跳转）：与那一行当前是否被渲染无关 */
  scrollToOffset: (offset: number) => void;
  /**
   * 某一行在编辑区内容坐标系里的纵向偏移（px）。
   *
   * 分栏滚动同步要的就是这个：虚拟化之后 DOM 里没有整篇，只能问 `LineRuler`，
   * 而 `LineRuler` 也正是编辑区自己滚动时所依据的那张表——两边用同一张表才对得上。
   */
  lineOffset: (line: number) => number;
  /** 编辑区一个视觉行的真实行高（px）：computed line-height 在小数行高下会差零点几像素 */
  lineUnit: () => number;
}

/**
 * 当前焦点能不能被编辑器拿走。
 *
 * 焦点在查找框里时不能拿：抢回来之后用户再按 Enter 就变成在编辑器里换行，
 * 而不是「找下一个」——查找框的 Enter 得一直归查找框。
 */
const canTakeFocus = (element: HTMLElement): boolean => {
  const active = element.ownerDocument.activeElement as HTMLElement | null;
  return !active?.closest?.(".mde-search");
};

/** 夹在 [min, max] 之间；max 可能小于 min（例如内容没有溢出），此时取 min */
const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(min, max), Math.max(min, value));

/* ---------- 字符/词/行的步进：删除类编辑要用 ---------- */

/** 词内字符（含下划线），用来算「一个词」的边界 */
const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** 往左退一个字符；代理对一次退两个码元，避免删出半个字 */
const stepBack = (text: string, at: number): number => {
  if (at <= 0) return 0;
  const code = text.charCodeAt(at - 1);
  if (code >= 0xdc00 && code <= 0xdfff && at >= 2) {
    const leading = text.charCodeAt(at - 2);
    if (leading >= 0xd800 && leading <= 0xdbff) return at - 2;
  }
  return at - 1;
};

/** 往右进一个字符；同样一次跨过整个代理对 */
const stepForward = (text: string, at: number): number => {
  if (at >= text.length) return text.length;
  const code = text.charCodeAt(at);
  if (code >= 0xd800 && code <= 0xdbff && at + 1 < text.length) {
    const trailing = text.charCodeAt(at + 1);
    if (trailing >= 0xdc00 && trailing <= 0xdfff) return at + 2;
  }
  return at + 1;
};

/** 前一个词的起点：先吃掉空白，再吃掉词本身 */
const wordStartOf = (text: string, at: number): number => {
  let index = at;
  while (index > 0 && !WORD_CHAR.test(text[index - 1])) index -= 1;
  while (index > 0 && WORD_CHAR.test(text[index - 1])) index -= 1;
  return index;
};

/** 后一个词的终点 */
const wordEndOf = (text: string, at: number): number => {
  let index = at;
  const total = text.length;
  while (index < total && !WORD_CHAR.test(text[index])) index += 1;
  while (index < total && WORD_CHAR.test(text[index])) index += 1;
  return index;
};

interface SourceEditorProps {
  value: string;
  onChange: (next: EditState, source: MarkdownChangeSource) => void;
  onSelectionChange?: (start: number, end: number) => void;
  config: MarkdownEditorConfig;
  readOnly: boolean;
  placeholder: string;
  autoFocus?: boolean;
  className?: string;
  /** 返回 true 表示快捷键已处理（上层负责 preventDefault） */
  onKeyDown?: (event: ReactKeyboardEvent<HTMLElement>) => boolean;
  /** 粘贴/拖入图片 */
  onImageFile?: (file: File) => void;
  /** 拿到真实 DOM，供滚动同步绑定 */
  onElement?: (element: HTMLElement | null) => void;
  /** 查找命中：由组件铺成文字范围的高亮，不需要时传空数组 */
  matches?: SearchMatch[];
  /** 当前命中的下标 */
  matchIndex?: number;
  /** 只高亮当前命中（关闭时高亮全部） */
  highlightOnlyCurrent?: boolean;
  /** 光标所在的逻辑行（0 基）：`editor.highlightActiveLine` 打开时整行高亮 */
  activeLine?: number;
  /** 大纲跳转后要临时高亮的逻辑行（0 基）；-1 / undefined 表示没有 */
  flashLine?: number;
}

export const SourceEditor = forwardRef<SourceEditorHandle, SourceEditorProps>(
  (
    {
      value,
      onChange,
      onSelectionChange,
      config,
      readOnly,
      placeholder,
      autoFocus,
      className,
      onKeyDown,
      onImageFile,
      onElement,
      matches,
      matchIndex = -1,
      highlightOnlyCurrent = false,
      activeLine = -1,
      flashLine = -1,
    },
    ref,
  ) => {
    const contentRef = useRef<HTMLDivElement | null>(null);
    const gutterRef = useRef<GutterHandle | null>(null);
    const caretRef = useRef<HTMLDivElement | null>(null);
    /** 光标的内容坐标（px）：滚动手势只平移它，不用重新测量 */
    const caretPoint = useRef<{ x: number; y: number } | null>(null);
    const caretFrame = useRef(0);
    /** 已经提交进 DOM 的文本：DOM 里的行永远与它对应，偏移换算都读它 */
    const valueRef = useRef(value);
    /**
     * 已经 emit 出去、但父层还没把新 value 送回来的文本。
     *
     * 百万字级的文档一次提交要几十毫秒，这期间再敲一个字，`valueRef` 还是旧文本，
     * 而 `selRef` 已经跟着上一笔编辑往前挪了——拿旧文本配新光标算出来的结果
     * 会把刚敲的那个字吞掉，光标也跟着错位。所以输入路径优先读这里。
     */
    const pendingTextRef = useRef<string | null>(null);
    /*
     * 只在提交之后更新 valueRef，不在渲染期间写。
     * 并发渲染下渲染函数可能被丢弃，渲染里改过的 ref 会指向一棵从没上屏的树，
     * 之后 DOM 偏移换算就整体错位。
     * 一次提交意味着父层已经把 emit 出去的文本送回来了，待定值可以清掉。
     */
    useLayoutEffect(() => {
      valueRef.current = value;
      pendingTextRef.current = null;
    }, [value]);
    /** 当前选区（文档偏移）；渲染与命令都读它，DOM 选区是它的镜像 */
    const selRef = useRef({ start: 0, end: 0 });
    /** 待落回 DOM 的选区 */
    const pendingSelection = useRef<[number, number] | null>(null);
    /** 上一次渲染出来的行文本：组合结束后做前后缀差分要用 */
    const renderedRef = useRef<{ first: number; texts: string[] } | null>(null);
    /**
     * 上一次我们自己写进 DOM 的选区（节点 + 偏移）。
     *
     * `selectionchange` 分不清「用户挪的」和「我们刚写的」，
     * 只能靠这个把回声认出来——否则 select-all 这类「逻辑选区比 DOM 选区长」的场景
     * 会被下一次事件立刻改回 DOM 那一小段。
     */
    const appliedRef = useRef<{
      anchorNode: Node | null;
      anchorOffset: number;
      focusNode: Node | null;
      focusOffset: number;
    } | null>(null);
    /**
     * 刚落下去的选区，要在接下来几趟渲染里看住它。
     *
     * 跳到远处时行是「先滚过去、下一趟渲染才出现」的：这一趟里选区落好了，
     * 紧接着 React 换掉整批 `.mde-line`（旧节点被卸载），DOM 选区就掉回容器上，
     * 表现为「跳转之后没有光标」。所以记住它，每次渲染后确认一次，掉了就补回去。
     */
    const guardSelection = useRef<[number, number] | null>(null);
    const composing = useRef(false);
    /** 浏览器会自己改 DOM 的那几次输入（组合以外的漏网之鱼），到 `input` 事件里读回来 */
    const nativeMutation = useRef(false);
    const [element, setElementState] = useState<HTMLDivElement | null>(null);
    /** 有没有焦点：当前行高亮只在聚焦时画（两个编辑器并排时不该各亮一行） */
    const [focused, setFocused] = useState(false);
    /**
     * 行容器的版本号：组合输入结束后自增，让 React 整块换掉 `.mde-lines`。
     *
     * 输入法组合期间浏览器会自由增删编辑区 DOM（空行占位的 `<br>`、组合文本节点），
     * React 记着的旧节点可能已经不在树上了。等它按旧引用去 removeChild 就会抛
     * NotFoundError；换掉行容器则只删 `.mde-lines` 自己（父节点没被动过），连带清掉整批脏节点。
     */
    const [domEpoch, setDomEpoch] = useState(0);

    const setElement = useCallback(
      (next: HTMLDivElement | null) => {
        contentRef.current = next;
        setElementState(next);
        onElement?.(next);
      },
      [onElement],
    );

    const emit = useCallback(
      (next: EditState, source: MarkdownChangeSource = "toolbar") => {
        // 父层的提交要等一会儿：先把这次的结果记成「最新文本」，中间再敲的字才不会丢
        pendingTextRef.current = next.text;
        pendingSelection.current = [next.start, next.end];
        selRef.current = { start: next.start, end: next.end };
        onChange(next, source);
      },
      [onChange],
    );

    const showGutter = config.editor.lineNumbers;
    const ruler = useVisualLineRows({
      element,
      text: value,
      /*
       * 行号槽关掉时也照常测量：虚拟化的总高度、光标定位都要它的偏移表。
       * 测量本身是增量的（只在文本/宽度变化时重测脏行），稳态下不花什么时间。
       */
      enabled: true,
      wrap: config.editor.wrap,
      fontFamily: config.editor.fontFamily,
      fontSize: config.editor.fontSize,
      lineHeight: config.editor.lineHeight,
      letterSpacing: config.editor.letterSpacing,
      tabSize: config.editor.tabSize,
      fontLigatures: config.editor.fontLigatures,
    });
    const { range, scroll, schedule, sync } = useVisibleRange(element, ruler, VIEW_PAD);
    /** 订阅测量进度：渐进扫描每帧只动行号槽，不带整棵编辑器 */
    useSyncExternalStore(ruler.subscribe, ruler.getVersion);

    const lines = splitLines(value);
    const totalLines = lines.length;
    /** 渲染区间：[first, last)。待落的选区在附近时把它一起渲染出来，否则光标落不上去 */
    const window = ((): { first: number; last: number } => {
      const start = range.first;
      const end = range.last > range.first ? range.last : Math.min(totalLines, FALLBACK_LINES);
      const pending = pendingSelection.current;
      if (!pending || !totalLines) return { first: start, last: end };
      const low = lineAtOffset(value, Math.min(pending[0], pending[1])).line;
      const high = lineAtOffset(value, Math.max(pending[0], pending[1])).line;
      return {
        // 只补近处的：远处的（全选到文末那种）不值得为它渲染整篇
        first: low >= start - SELECT_PAD ? Math.max(0, Math.min(start, low)) : start,
        last: high <= end + SELECT_PAD ? Math.min(totalLines, Math.max(end, high + 1)) : end,
      };
    })();
    const first = window.first;
    const last = window.last;

    /**
     * 行号最大位数 → 行号槽宽度。
     * ruler 还没同步过时按当前文本直接切行数算，避免槽宽先窄后宽地跳一下。
     */
    const gutterDigits = String(Math.max(1, ruler.lines.length || totalLines)).length;

    /* ---------- 围栏代码块 ---------- */

    /*
     * 围栏是「全文状态」：这一行在不在代码块里，取决于它前面有没有开着的围栏，
     * 所以得从头扫。只在文本变化时扫一次（`value` 变了，`lines` 才是新的）。
     */
    const fences = useMemo(
      () => scanFences(lines),
      // eslint-disable-next-line react-hooks/exhaustive-deps -- lines 每次都新建，按 value 记忆即可
      [value],
    );
    /** 当前渲染区间内每一行的围栏归属（围栏行 / 代码行） */
    const fenceRows = useMemo(() => collectFenceRows(fences, first, last), [fences, first, last]);

    /* ---------- 代码块 token 着色 ---------- */
    /*
     * 着色走 `::highlight()`（见 editor/syntax.ts 的说明），所以这里只算区间。
     * highlight.js 是异步懒加载的，区间表先放 ref、算完了再抬一个 tick 让铺区间的那趟
     * effect 跑：文字本身一直由 React 渲染，不会出现「着色没到就看不见」。
     */
    const [tokenTick, setTokenTick] = useState(0);
    const tokenRows = useRef(new Map<number, TokenSpan[]>());

    useEffect(() => {
      const content = contentRef.current;
      const cleared = new Map<number, TokenSpan[]>();
      tokenRows.current = cleared;
      if (!content) return;
      if (config.editor.codeHighlight !== true || !fenceRows.size) {
        setTokenRanges(content, []);
        return;
      }
      let cancelled = false;
      const jobs = fences
        .filter((fence) => fence.close >= first && fence.open < last)
        .map((fence) =>
          highlightFenceRows(fence, lines, first, last, true).then((spans) => {
            for (const [line, list] of spans) if (!cancelled) cleared.set(line, list);
          }),
        );
      void Promise.all(jobs).then(() => {
        if (!cancelled && cleared.size) setTokenTick((tick) => tick + 1);
      });
      return () => {
        cancelled = true;
      };
    }, [config.editor.codeHighlight, fenceRows, fences, first, last, lines]);

    /** 把算好的 token 段换成 Range 交给 `::highlight()`；行节点被换掉就要重铺 */
    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content) return;
      const groups = new Map<string, Range[]>();
      let total = 0;
      for (const [line, spans] of tokenRows.current) {
        if (total >= MAX_TOKEN_RANGES) break;
        const row = content.querySelector<HTMLElement>(`.mde-line[data-line="${line}"]`);
        if (!row) continue;
        for (const span of spans) {
          if (total >= MAX_TOKEN_RANGES) break;
          const from = columnPoint(row, span.from);
          const to = columnPoint(row, span.to);
          if (!from || !to) continue;
          const range = content.ownerDocument.createRange();
          range.setStart(from.node, from.offset);
          range.setEnd(to.node, to.offset);
          const name = syntaxHighlightName(span.token);
          const list = groups.get(name);
          if (list) list.push(range);
          else groups.set(name, [range]);
          total += 1;
        }
      }
      setTokenRanges(
        content,
        Array.from(groups, ([name, ranges]) => ({ name, ranges })),
      );
      return () => setTokenRanges(content, []);
    }, [tokenTick, first, last, value]);

    /* ---------- DOM ↔ 文档偏移 ---------- */

    /** 渲染出来的行：逻辑行号取自 `data-line`（渲染那一刻写死的，不受浏览器改动影响） */
    const rowOf = useCallback((node: Node | null): HTMLElement | null => {
      if (!node) return null;
      const element = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
      return element?.closest?.(".mde-line") ?? null;
    }, []);

    /** DOM 位置 → 文档偏移；位置不在任何行里时返回 null */
    const pointToOffset = useCallback(
      (node: Node, offset: number): number | null => {
        const content = contentRef.current;
        const text = valueRef.current;
        if (!content || !content.contains(node)) return null;
        const row = rowOf(node);
        const offsets = lineOffsets(text);
        if (row) {
          const line = Number(row.dataset.line);
          if (!Number.isFinite(line)) return null;
          const start = offsets[line] ?? text.length;
          const doc = content.ownerDocument;
          const probe = doc.createRange();
          probe.setStart(row, 0);
          try {
            probe.setEnd(node, offset);
          } catch {
            return null;
          }
          // 行内只有文本节点与（空行的）<br>，串起来就是这一行的列号
          const column = probe.toString().length;
          return start + Math.min(column, (splitLines(text)[line] ?? "").length);
        }
        // 落在行的外面（理论上只有上下留白）：按文档顺序贴到区间两端
        const head = content.querySelector(".mde-line");
        if (!head) return 0;
        return node.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING ? 0 : text.length;
      },
      [rowOf],
    );

    /** 文档偏移 → DOM 位置；目标行没被渲染出来时返回 null */
    const offsetToPoint = useCallback((offset: number): { node: Node; offset: number } | null => {
      const content = contentRef.current;
      const text = valueRef.current;
      if (!content) return null;
      const at = lineAtOffset(text, Math.max(0, Math.min(offset, text.length)));
      const row = content.querySelector<HTMLElement>(`.mde-line[data-line="${at.line}"]`);
      if (!row) return null;
      const doc = content.ownerDocument;
      const walker = doc.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let remaining = offset - at.start;
      let node = walker.nextNode();
      while (node) {
        const length = node.nodeValue?.length ?? 0;
        if (remaining <= length) return { node, offset: Math.max(0, remaining) };
        remaining -= length;
        node = walker.nextNode();
      }
      // 空行（只有一个 <br>）或列在末尾：落回行节点的开头
      return { node: row, offset: 0 };
    }, []);

    /**
     * 把偏移夹到「当前渲染出来的这一段」之内。
     *
     * 虚拟化之后窗口外的行根本不在 DOM 里，落选区时只能退到窗口边缘。
     * 逻辑选区本身不跟着缩——缩的只是画在屏上的那一截。
     */
    const clampToWindow = useCallback((offset: number): number => {
      const content = contentRef.current;
      const text = valueRef.current;
      if (!content) return offset;
      const rows = content.querySelectorAll<HTMLElement>(".mde-line");
      if (!rows.length) return offset;
      const offsets = lineOffsets(text);
      const docLines = splitLines(text);
      const from = Number(rows[0].dataset.line);
      const to = Number(rows[rows.length - 1].dataset.line);
      const min = offsets[from] ?? 0;
      const max = (offsets[to] ?? 0) + (docLines[to]?.length ?? 0);
      return clamp(offset, min, max);
    }, []);

    const readDomSelection = useCallback((): { start: number; end: number } | null => {
      const content = contentRef.current;
      if (!content) return null;
      const selection = content.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0) return null;
      const anchor = selection.anchorNode;
      const focus = selection.focusNode;
      if (!anchor || !focus) return null;
      const from = pointToOffset(anchor, selection.anchorOffset);
      const to = pointToOffset(focus, selection.focusOffset);
      if (from === null || to === null) return null;
      return { start: Math.min(from, to), end: Math.max(from, to) };
    }, [pointToOffset]);

    /**
     * 写回 DOM 选区。
     *
     * `exact` 为 true 时只接受精确落点（两端都在渲染窗口里）；
     * false 时允许把落在窗口之外的那一端退到窗口边缘——「全选」这种
     * 逻辑选区比 DOM 长得多的情况，至少能画出窗口内那一截，而不是一个像素都不选中。
     */
    const writeDomSelection = useCallback(
      (start: number, end: number, exact: boolean): boolean => {
        const content = contentRef.current;
        if (!content) return false;
        const from = offsetToPoint(start) ?? (exact ? null : offsetToPoint(clampToWindow(start)));
        const to = offsetToPoint(end) ?? (exact ? null : offsetToPoint(clampToWindow(end)));
        if (!from || !to) return false;
        const doc = content.ownerDocument;
        const selection = doc.getSelection();
        if (!selection) return false;
        const next = doc.createRange();
        next.setStart(from.node, from.offset);
        next.setEnd(to.node, to.offset);
        selection.removeAllRanges();
        selection.addRange(next);
        appliedRef.current = {
          anchorNode: selection.anchorNode,
          anchorOffset: selection.anchorOffset,
          focusNode: selection.focusNode,
          focusOffset: selection.focusOffset,
        };
        return true;
      },
      [clampToWindow, offsetToPoint],
    );

    /**
     * 当前 DOM 选区的两端是不是都落在某一行里。
     *
     * 「在容器里」不算——落在 `.mde-content` 自己身上时方向键一步都走不动，
     * 与「没有光标」是同一件事。
     */
    const selectionInRows = useCallback((): boolean => {
      const content = contentRef.current;
      if (!content) return false;
      const selection = content.ownerDocument.getSelection();
      if (!selection || selection.rangeCount === 0) return false;
      return Boolean(rowOf(selection.anchorNode) && rowOf(selection.focusNode));
    }, [rowOf]);

    /* ---------- 自绘光标 ---------- */

    const paintCaret = useCallback(() => {
      const caret = caretRef.current;
      const content = contentRef.current;
      if (!caret || !content) return;
      const point = caretPoint.current;
      if (!point) {
        /*
         * 必须把 is-blinking 摘掉再置透明：闪烁是 CSS animation，动画里的 opacity
         * 优先级高于内联样式——只写 style.opacity = 0 的话，失焦后那根光标会继续
         * 一闪一闪地钉在原地（既不跟随滚动，也不消失）。
         */
        caret.classList.remove("is-blinking");
        caret.style.opacity = "0";
        // 量不出位置时把原生光标放回来：宁可细一点，也不能没有光标
        content.classList.remove("is-caret-hidden");
        return;
      }
      /*
       * 光标高度 = 字号 × caretHeight（默认 1.25）：比字略高一点，上下各出头一点，
       * 像原生光标那样把字符"括"住；不占满整个行盒——顶到行盒高低边的话，
       * 在一行里看着像一条竖杠压在字上，很别扭。
       * 高度小于行盒时在行盒内垂直居中。
       */
      const unit = ruler.advance || ruler.unit || config.editor.fontSize * config.editor.lineHeight;
      const caretHeight = config.editor.fontSize * (config.editor.caretHeight > 0 ? config.editor.caretHeight : 1.25);
      caret.style.height = `${caretHeight}px`;
      const top = point.y - content.scrollTop + Math.max(0, (unit - caretHeight) / 2);
      caret.style.transform = `translate(${point.x - content.scrollLeft}px, ${top}px)`;
      caret.style.opacity = "1";
      content.classList.add("is-caret-hidden");
    }, [config.editor.caretHeight, config.editor.fontSize, config.editor.lineHeight, ruler]);

    /**
     * 重新测量光标位置。
     *
     * 只在光标真的动过时调（选区变化、文本变化、焦点进出）；滚动不走这里。
     * 有选区、失焦、输入法组合中都交回浏览器：那时该画的是选区/候选框，不是光标。
     */
    const syncCaret = useCallback(() => {
      const content = contentRef.current;
      const caret = caretRef.current;
      if (!content || !caret) return;
      const focused = content.ownerDocument.activeElement === content;
      const { start, end } = selRef.current;
      if (!focused || start !== end || composing.current) {
        caretPoint.current = null;
        paintCaret();
        return;
      }
      const at = lineAtOffset(valueRef.current, start);
      const point = ruler.caretPoint(content, at.line, start - at.start);
      if (!point) {
        caretPoint.current = null;
        paintCaret();
        return;
      }
      const view = content.ownerDocument.defaultView;
      const style = view ? view.getComputedStyle(content) : null;
      /*
       * 光标要落在「前一个字」与「后一个字」之间的正中间。
       * 量出来的 x 是后一个字的左边缘（前一个字连同它的字间距一起结束的地方），
       * 直接画在那里，光标的后半截就压在后面的字身上，看着像贴过去了。
       * 所以左移「半个字间距 + 半个光标宽度」：字间距为 0 时正好以边界为中心，
       * 有字间距时落在空隙正中。宽度从元素上读，改 --mde-caret-width 也跟着走。
       */
      const caretWidth = caret.offsetWidth || 2;
      const tracking = style ? parseFloat(style.letterSpacing) || 0 : 0;
      caretPoint.current = {
        x: (style ? parseFloat(style.paddingLeft) || 0 : 0) + point.x - tracking / 2 - caretWidth / 2,
        y: (style ? parseFloat(style.paddingTop) || 0 : 0) + point.y,
      };
      paintCaret();
      // 重新起一次闪烁：正在动的时候是实心的，停手之后才开始闪（和原生光标一致）
      caret.classList.remove("is-blinking");
      void caret.offsetWidth;
      caret.classList.add("is-blinking");
    }, [paintCaret, ruler]);

    /** 敲一个字往往同时触发 input 与 selectionchange，合并到下一帧只量一次 */
    const scheduleCaret = useCallback(() => {
      if (caretFrame.current) return;
      caretFrame.current = requestAnimationFrame(() => {
        caretFrame.current = 0;
        syncCaret();
      });
    }, [syncCaret]);

    /* ---------- 选区落地 ---------- */

    /**
     * 下一次渲染之后，某一行会不会在渲染窗口里。
     *
     * 用的是「下一次」而不是当前这一次：滚动刚改过 scrollTop 时，可视区间的 state
     * 要等 `sync()` 之后那一趟渲染才更新，而这一趟里行还不存在。
     */
    const lineWillRender = useCallback(
      (offset: number): boolean => {
        const content = contentRef.current;
        const text = valueRef.current;
        if (!content || !ruler.lines.length) return false;
        const line = lineAtOffset(text, offset).line;
        const view = Math.max(1, content.clientHeight);
        const top = content.scrollTop;
        const first = Math.max(0, ruler.lineAt(top) - VIEW_PAD);
        const last = Math.min(ruler.lines.length, ruler.lineAt(top + view) + VIEW_PAD + 1);
        return line >= first && line < last;
      },
      [ruler],
    );

    /**
     * 把待落的选区写进 DOM。
     *
     * 每次渲染都试一次：文本改完、区间重算完、rAF 兜底都会走到这里。
     *
     * 精确落点还不存在时**不能直接退到窗口边缘**：那是「行还没渲染出来」，
     * 下一趟渲染就有了；现在凑合着写上去，紧接着行一换（旧行被卸载）选区就掉回容器上，
     * 表现为「跳转之后没有光标」。所以先看清它下一趟会不会出现，会就留着再试。
     */
    const applyPending = useCallback(
      (retry = 0) => {
        const pending = pendingSelection.current;
        if (!pending) return;
        const [start, end] = pending;
        if (writeDomSelection(start, end, true)) {
          pendingSelection.current = null;
          selRef.current = { start, end };
          guardSelection.current = [start, end];
          scheduleCaret();
          return;
        }
        if (!lineWillRender(start) || !lineWillRender(end)) {
          if (!writeDomSelection(start, end, false)) return;
          pendingSelection.current = null;
          selRef.current = { start, end };
          guardSelection.current = [start, end];
          scheduleCaret();
          return;
        }
        /*
         * 目标行按理说在窗口里，DOM 里却没有它：这一趟的区间状态落后了。
         * 以前这里直接 return 等下一趟渲染，但没人保证一定还有下一趟——
         * 选区就长期落不下去，表现为「刚敲过的那一行，方向键怎么都回不去」。
         * 主动重算一次区间，并补试几帧，补不回来再交给后续渲染。
         */
        if (retry >= 3) return;
        sync();
        requestAnimationFrame(() => applyPending(retry + 1));
      },
      [lineWillRender, scheduleCaret, sync, writeDomSelection],
    );

    /** 下一帧再试一次：区间刚变、这一帧还没有对应行时的兜底 */
    const queueApply = useCallback(() => {
      requestAnimationFrame(() => applyPending());
    }, [applyPending]);

    /**
     * 每次渲染都做两件事：试落一次选区，再看住上一次落好的选区。
     *
     * 后一件是跳远之后补光标的唯一时机：滚动换掉了整批 `.mde-line`，
     * 浏览器把选区丢回容器，而此刻新的行已经在 DOM 里了，补一次就落稳了。
     */
    useLayoutEffect(() => {
      applyPending();
      const guard = guardSelection.current;
      const content = contentRef.current;
      if (!guard || !content || pendingSelection.current) return;
      if (content.ownerDocument.activeElement !== content || selectionInRows()) return;
      writeDomSelection(guard[0], guard[1], false);
    });

    /**
     * 选区变化：只在这里把 DOM 选区翻译成文档偏移。
     *
     * `selectionchange` 挂在 document 上：contenteditable 的光标就是选区的一种，
     * 方向键、鼠标点击、程序化 `addRange` 都会触发它。
     */
    useEffect(() => {
      const content = element;
      if (!content) return;
      const doc = content.ownerDocument;
      const handleSelectionChange = () => {
        const selection = doc.getSelection();
        const applied = appliedRef.current;
        if (selection && applied) {
          if (
            selection.anchorNode === applied.anchorNode &&
            selection.anchorOffset === applied.anchorOffset &&
            selection.focusNode === applied.focusNode &&
            selection.focusOffset === applied.focusOffset
          ) {
            return;
          }
        }
        /*
         * 选区掉在容器上（换掉整批行节点时浏览器常这么干）：这不是用户挪的光标。
         * 当成第 0 个字符的话，自绘光标会跳到文首，方向键也再也回不到刚才那一行。
         * 逻辑选区保持不动，下一帧把它重新落回行里。
         */
        if (selection && !rowOf(selection.anchorNode) && !rowOf(selection.focusNode)) {
          requestAnimationFrame(() => {
            const target = contentRef.current;
            if (!target || target.ownerDocument.activeElement !== target) return;
            if (pendingSelection.current) {
              applyPending();
              return;
            }
            if (selectionInRows()) return;
            const guard = guardSelection.current ?? [selRef.current.start, selRef.current.end];
            writeDomSelection(guard[0], guard[1], false);
          });
          return;
        }
        const next = readDomSelection();
        if (!next) return;
        if (next.start === selRef.current.start && next.end === selRef.current.end) return;
        selRef.current = next;
        // 光标真的被用户挪走了：不再需要看住上一次跳转落下的那个点
        guardSelection.current = null;
        onSelectionChange?.(next.start, next.end);
        scheduleCaret();
      };
      doc.addEventListener("selectionchange", handleSelectionChange);
      return () => doc.removeEventListener("selectionchange", handleSelectionChange);
    }, [
      applyPending,
      element,
      onSelectionChange,
      readDomSelection,
      rowOf,
      scheduleCaret,
      selectionInRows,
      writeDomSelection,
    ]);

    /* ---------- 查找命中 ---------- */

    /**
     * 把可视区间内的命中交给 `::highlight()` 去铺（见 editor/highlights.ts）。
     *
     * 底色铺的就是 Range 覆盖的那一段**文字**：高度随字形盒，折行时每一段各自铺，
     * 与预览区同一套名字、同一套观感。
     * 试过改成按行盒高度画矩形（相邻命中会连成一条整行色带），看着像选中了整行、
     * 又和预览区的高亮对不上，所以回到这里——只标命中本身，不标整行。
     *
     * Range 指向的是真实的行节点，虚拟化换掉节点之后旧的就失效了，
     * 所以渲染区间一变就要重铺一次。
     */
    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content) return;
      const list = matches ?? [];
      const current = list[matchIndex] ?? null;
      if (!list.length || !current) {
        clearHighlights(content);
        return;
      }
      const text = valueRef.current;
      const offsets = lineOffsets(text);
      const from = offsets[first] ?? 0;
      const to = last > first ? (offsets[last - 1] ?? 0) + (lines[last - 1]?.length ?? 0) : from;
      const doc = content.ownerDocument;
      const hit: Range[] = [];
      const currentRanges: Range[] = [];
      // 二分找到第一个可能落在窗口里的命中，其余不必扫
      let index = firstMatchAtOrAfter(list, from);
      for (; index < list.length; index += 1) {
        const match = list[index];
        if (match.start >= to) break;
        if (hit.length + currentRanges.length >= MAX_RANGES) break;
        const startPoint = offsetToPoint(match.start);
        const endPoint = offsetToPoint(match.end);
        if (!startPoint || !endPoint) continue;
        const range = doc.createRange();
        range.setStart(startPoint.node, startPoint.offset);
        range.setEnd(endPoint.node, endPoint.offset);
        if (match.start === current.start) currentRanges.push(range);
        else if (!highlightOnlyCurrent) hit.push(range);
      }
      setHighlightRanges(content, hit, currentRanges);
      return () => clearHighlights(content);
    }, [first, highlightOnlyCurrent, last, lines, matchIndex, matches, offsetToPoint, value]);

    /* ---------- 大纲跳转目标的高亮 ---------- */

    /**
     * 与查找命中同一套机制（`::highlight(mde-flash)`），区间是「目标行的文字范围」——
     * 含 `###` 这些标记，但不铺整行的宽度。
     * 目标行不在渲染窗口里就先不铺，滚过去之后下一次渲染自然补上。
     */
    useLayoutEffect(() => {
      const content = contentRef.current;
      if (!content) return;
      const row =
        flashLine >= 0
          ? content.querySelector<HTMLElement>(`.mde-line[data-line="${flashLine}"]`)
          : null;
      if (!row) {
        setFlashRanges(content, []);
        return;
      }
      const range = content.ownerDocument.createRange();
      range.selectNodeContents(row);
      setFlashRanges(content, [range]);
      return () => setFlashRanges(content, []);
    }, [first, flashLine, last]);

    /* ---------- 滚动：行号槽跟随 + 光标平移 ---------- */

    useEffect(() => {
      const content = element;
      if (!content) return;
      const onScroll = () => {
        const top = content.scrollTop;
        scroll.current = top;
        gutterRef.current?.follow(top);
        paintCaret();
        schedule();
      };
      content.addEventListener("scroll", onScroll, { passive: true });
      return () => content.removeEventListener("scroll", onScroll);
    }, [element, paintCaret, schedule, scroll]);

    /**
     * 指针停在行号槽上也要能滚。
     *
     * 行号槽是滚动容器的兄弟节点：滚轮落在槽上时浏览器往上找不到可滚动的祖先，
     * 整个编辑区一动不动，得先把指针挪回正文才滚得动。这里自己把增量转给容器。
     *
     * 三个约束：
     * - 只能挂原生非 passive 监听：React 根节点上的 onWheel 是 passive 的，
     *   里面 preventDefault 既不生效（宿主页面照样跟着滚），也拦不住浏览器自己的那次滚动，
     *   转发会和原生滚动叠成双倍速度；
     * - 只挂在槽上，不挂滚动容器本身——正文区的滚轮一旦要等 JS 处理完才走，
     *   滚动就不在合成器线程上了，长文档会明显发涩；
     * - 已经转到边界（这个方向没得滚了）就放行，让外层页面接着滚。
     */
    useEffect(() => {
      const root = gutterRef.current?.getElement() ?? null;
      const content = element;
      if (!root || !content) return;
      const onWheel = (event: WheelEvent) => {
        // Ctrl/⌘ + 滚轮是「改字号」（由上层接管），别再顺手滚一下正文
        if (event.ctrlKey || event.metaKey) return;
        // deltaMode 非像素时先换算：按行就换成整行高，按页就换成整屏
        const scale =
          event.deltaMode === 1
            ? ruler.advance || ruler.unit || config.editor.fontSize * config.editor.lineHeight
            : event.deltaMode === 2
              ? content.clientHeight
              : 1;
        const top = clamp(content.scrollTop + event.deltaY * scale, 0, content.scrollHeight - content.clientHeight);
        const left = clamp(content.scrollLeft + event.deltaX * scale, 0, content.scrollWidth - content.clientWidth);
        if (top === content.scrollTop && left === content.scrollLeft) return;
        event.preventDefault();
        content.scrollTop = top;
        content.scrollLeft = left;
      };
      root.addEventListener("wheel", onWheel, { passive: false });
      return () => root.removeEventListener("wheel", onWheel);
    }, [config.editor.fontSize, config.editor.lineHeight, element, ruler, showGutter]);

    /** contenteditable 没有原生 autofocus，挂载后自己聚焦一次 */
    useEffect(() => {
      if (!autoFocus || !element || readOnly) return;
      if (canTakeFocus(element)) element.focus({ preventScroll: true });
    }, [autoFocus, element, readOnly]);

    /** 每次渲染都立刻重算可视区间：文本变了、高度测出来了，都不能让行号慢一帧 */
    useLayoutEffect(() => {
      if (!element) return;
      sync();
      // 文本、字号、折行宽度变了都可能挪动光标：本帧内重新量一次
      scheduleCaret();
    });

    /** 记下这一帧渲染出来的行文本：组合结束后要靠它做差分 */
    useLayoutEffect(() => {
      renderedRef.current = { first, texts: lines.slice(first, last) };
    });

    /* ---------- 编辑 ---------- */

    /**
     * 跳转前的补测：把 [0, line] 这一段补齐。
     *
     * 偏移表里的行数对没测过的行是「占位 1 行」，按它算出来的纵向位置会偏上，
     * 偏多少取决于折行多不多——跳得越远错得越狠。宁可多花一次排版，
     * 也不能让「跳到第 1800 行」落在第 1500 行。
     */
    const measureUpTo = useCallback(
      (line: number) => {
        const content = contentRef.current;
        const count = ruler.lines.length;
        if (!content || !count || ruler.frontier > line) return;
        ruler.ensureVisible(content, Math.min(count, line + 1));
      },
      [ruler],
    );

    /**
     * 让某个偏移进入视口（换行后重新落选区之前调用，保证目标行会被渲染）。
     *
     * 不去量「命中节点的位置」：虚拟化之后视口外根本没有那个节点，量不到就等于不跳。
     * 这里改用 ruler 的偏移表算内容坐标，与当前渲染了哪些行无关。
     */
    const revealOffset = useCallback(
      (offset: number) => {
        const content = contentRef.current;
        if (!content) return;
        const text = valueRef.current;
        const at = lineAtOffset(text, Math.max(0, Math.min(offset, text.length)));
        const unit = ruler.advance || ruler.unit || config.editor.fontSize * config.editor.lineHeight;
        measureUpTo(at.line);
        const point = ruler.lines.length ? ruler.caretPoint(content, at.line, Math.max(0, offset - at.start)) : null;
        const y = point ? point.y : ruler.lines.length ? ruler.offsetOf(at.line) : at.line * unit;
        const viewTop = content.scrollTop;
        // 已经完整可见就不动：连按「下一个」时视图不该每跳一次都重新居中
        const margin = Math.max(unit, 28);
        if (y >= viewTop + margin && y + unit <= viewTop + content.clientHeight - margin) return;
        const max = Math.max(0, content.scrollHeight - content.clientHeight);
        content.scrollTop = clamp(y - content.clientHeight / 2 + unit / 2, 0, max);
      },
      [config.editor.fontSize, config.editor.lineHeight, measureUpTo, ruler],
    );

    /** 把渲染窗口读回来，与上一次渲染的内容做前后缀差分，换算出新的全文 */
    const readback = useCallback(() => {
      const content = contentRef.current;
      const rendered = renderedRef.current;
      if (!content || !rendered) return;
      const rows = content.querySelectorAll<HTMLElement>(".mde-line");
      if (!rows.length || !rendered.texts.length) return;
      const text = valueRef.current;
      const nextTexts: string[] = [];
      rows.forEach((row) => nextTexts.push(row.textContent ?? ""));
      const prevText = rendered.texts.join("\n");
      const nextText = nextTexts.join("\n");
      if (prevText === nextText) return;

      const shared = Math.min(prevText.length, nextText.length);
      let lo = 0;
      while (lo < shared && prevText[lo] === nextText[lo]) lo += 1;
      let suffix = 0;
      while (
        suffix < shared - lo &&
        prevText[prevText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
      ) {
        suffix += 1;
      }
      const prevEnd = prevText.length - suffix;
      const nextEnd = nextText.length - suffix;

      // 渲染窗口里的字符下标 → 文档偏移（窗口是从 rendered.first 行开始的一段连续文本）
      const offsets = lineOffsets(text);
      const docLines = splitLines(text);
      const toDoc = (blockOffset: number): number => {
        const head = prevText.slice(0, blockOffset);
        let breaks = 0;
        let lastBreak = -1;
        for (let i = 0; i < head.length; i += 1) {
          if (head.charCodeAt(i) === 10) {
            breaks += 1;
            lastBreak = i;
          }
        }
        const line = rendered.first + breaks;
        const start = offsets[line] ?? text.length;
        const column = blockOffset - (lastBreak + 1);
        return start + Math.max(0, Math.min(column, (docLines[line] ?? "").length));
      };

      const from = toDoc(lo);
      const to = toDoc(prevEnd);
      const insert = nextText.slice(lo, nextEnd);
      const next = text.slice(0, from) + insert + text.slice(to);
      const caret = from + insert.length;
      emit({ text: next, start: caret, end: caret }, "input");
    }, [emit]);

    /** 图片文件统一交给上层（返回 URL 由上层插入） */
    const pickImage = (files: FileList | null): boolean => {
      if (!files || !onImageFile) return false;
      for (const file of Array.from(files)) {
        if (file.type.startsWith("image/")) {
          onImageFile(file);
          return true;
        }
      }
      return false;
    };

    const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
      if (pickImage(event.clipboardData?.files ?? null)) event.preventDefault();
    };

    const handleDrop = (event: ReactDragEvent<HTMLDivElement>) => {
      if (pickImage(event.dataTransfer?.files ?? null)) event.preventDefault();
    };

    /**
     * 复制/剪切一律按**逻辑选区**取文本。
     *
     * 虚拟化之后 DOM 里只有可视的那几十行，选区一旦超出窗口（select-all 就是），
     * 浏览器复制到的只是窗口里那一小段。这里直接按文档偏移切片写进剪贴板。
     */
    const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
      const text = pendingTextRef.current ?? valueRef.current;
      const { start, end } = selRef.current;
      if (end <= start) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text.slice(start, end));
    };

    const handleCut = (event: ReactClipboardEvent<HTMLDivElement>) => {
      const text = pendingTextRef.current ?? valueRef.current;
      const { start, end } = selRef.current;
      if (readOnly || end <= start) return;
      event.preventDefault();
      event.clipboardData.setData("text/plain", text.slice(start, end));
      emit({ text: text.slice(0, start) + text.slice(end), start, end: start }, "input");
    };

    /**
     * 所有编辑意图都在这里拦下来自己算。
     *
     * 用原生监听而不是 React 的 `onBeforeInput`：后者传进来的 `nativeEvent`
     * 并不是 `beforeinput` 那个 `InputEvent`（`inputType` 是 null，只有 `data`），
     * 拿它去判编辑类型会一律落到「认不出来」，于是每一次输入都被吞掉。
     *
     * 返回 `EditState` = 已处理（preventDefault 后走 `emit`）；
     * 返回 null = 交给浏览器改 DOM，随后在 `input` 里读回来（组合期外的漏网之鱼）。
     */
    const handleBeforeInput = useCallback(
      (event: InputEvent) => {
        // 组合期间完全放行：浏览器要在真实 DOM 上画候选框，任何干涉都会打断它
        if (composing.current || event.isComposing || readOnly) {
          if (readOnly) event.preventDefault();
          return;
        }
        const state: EditState = {
          text: pendingTextRef.current ?? valueRef.current,
          start: selRef.current.start,
          end: selRef.current.end,
        };
        const next = editForInput(state, event.inputType, event, config.editor);
        if (!next) {
          nativeMutation.current = true;
          return;
        }
        event.preventDefault();
        emit(next, "input");
      },
      [config.editor, emit, readOnly],
    );

    const handleInputEvent = useCallback(() => {
      if (!nativeMutation.current) return;
      nativeMutation.current = false;
      // 浏览器直接改过 DOM：旧的 `.mde-line` / 文本节点可能已被它合并或删掉，
      // 读回全文后整块换掉行容器，避免 React 接着拿失效引用去 removeChild。
      readback();
      setDomEpoch((epoch) => epoch + 1);
    }, [readback]);

    const handleCompositionStart = useCallback(() => {
      composing.current = true;
      // 组合期间交回浏览器画（候选框旁边那根原生光标），自绘的收起来
      scheduleCaret();
    }, [scheduleCaret]);

    const handleCompositionEnd = useCallback(() => {
      composing.current = false;
      // 先把浏览器改过的 DOM 读回全文，再整块换掉行容器：
      // 顺序反了会先用旧值渲染，组合进去的字要等下一帧才出现。
      readback();
      setDomEpoch((epoch) => epoch + 1);
      scheduleCaret();
    }, [readback, scheduleCaret]);

    /*
     * beforeinput / input / composition 都挂原生监听。
     *
     * 编辑事件必须拿到真正的 `InputEvent`：`inputType` 决定这一次是插入、换行还是删除，
     * `dataTransfer` 里才是粘贴进来的文本。React 合成事件给不了这两个。
     */
    useEffect(() => {
      const content = element;
      if (!content) return;
      const onBeforeInput = (event: Event) => handleBeforeInput(event as InputEvent);
      content.addEventListener("beforeinput", onBeforeInput);
      content.addEventListener("input", handleInputEvent);
      content.addEventListener("compositionstart", handleCompositionStart);
      content.addEventListener("compositionend", handleCompositionEnd);
      return () => {
        content.removeEventListener("beforeinput", onBeforeInput);
        content.removeEventListener("input", handleInputEvent);
        content.removeEventListener("compositionstart", handleCompositionStart);
        content.removeEventListener("compositionend", handleCompositionEnd);
      };
    }, [element, handleBeforeInput, handleCompositionEnd, handleCompositionStart, handleInputEvent]);

    const handleFocus = () => {
      const content = contentRef.current;
      if (!content) return;
      setFocused(true);
      const selection = content.ownerDocument.getSelection();
      const anchor = selection?.anchorNode ?? null;
      /*
       * 聚焦时浏览器不一定把光标放回行里——它可能停在容器上（`content` 自己，offset 0），
       * 那时方向键一步都走不动。所以判据是「有没有落进某一行」，而不是「在不在容器里」。
       */
      const inRow = anchor && content.contains(anchor) && rowOf(anchor);
      if (!inRow) {
        pendingSelection.current = [selRef.current.start, selRef.current.end];
        applyPending();
      }
      scheduleCaret();
    };

    const handleBlur = () => {
      setFocused(false);
      // 失焦之后不再替用户看住上一次跳转的落点，也不再画当前行
      guardSelection.current = null;
      scheduleCaret();
    };

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (onKeyDown?.(event)) return;
      if (composing.current || event.nativeEvent.isComposing) return;

      const text = pendingTextRef.current ?? valueRef.current;
      const { start, end } = selRef.current;

      if (event.key === "Escape") {
        contentRef.current?.blur();
        return;
      }

      /*
       * 回车一律在 keydown 里处理，不走 beforeinput。
       *
       * `contenteditable="plaintext-only"` 里普通回车发的是 `insertLineBreak` 而不是
       * `insertParagraph`，光看 inputType 分不出「回车」和「Shift+回车」，
       * 于是续写列表这类行为没法只在编辑事件里决定；而 keydown 上修饰键是明确的。
       */
      if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        // 有选区时先把选区清掉：续写只看光标所在的那一行
        const cleared = start !== end ? text.slice(0, start) + text.slice(end) : text;
        const at = Math.min(start, end);
        const plain: EditState = {
          text: cleared.slice(0, at) + "\n" + cleared.slice(at),
          start: at + 1,
          end: at + 1,
        };
        if (event.shiftKey || !config.editor.continueMarkdownOnEnter) {
          emit(plain, "input");
          return;
        }
        // 注意传的是**换行之前**的文本与光标：续写判断的是「当前这一行」
        const result = continueMarkdownOnEnter(cleared, at, config.editor.tabSize);
        emit(result ? { text: result.text, start: result.caret, end: result.caret } : plain, "input");
        return;
      }

      // select-all：DOM 里没有整篇，只能按逻辑选区走（复制/剪切也读的是它）
      if ((event.ctrlKey || event.metaKey) && !event.altKey && (event.key === "a" || event.key === "A")) {
        event.preventDefault();
        pendingSelection.current = [0, text.length];
        selRef.current = { start: 0, end: text.length };
        applyPending();
        queueApply();
        onSelectionChange?.(0, text.length);
        return;
      }

      if (event.key === "Tab" && config.editor.tabKey !== "none") {
        event.preventDefault();
        const state: EditState = { text, start, end };
        if (event.shiftKey) {
          const next = runCommand(state, "outdent", { tabSize: config.editor.tabSize, labels: {} });
          if (next) emit(next, "format");
          return;
        }
        // 有选区时缩进整行；折叠光标时插入空格
        if (start !== end) {
          const next = runCommand(state, "indent", { tabSize: config.editor.tabSize, labels: {} });
          if (next) emit(next, "format");
          return;
        }
        const spaces = " ".repeat(config.editor.tabSize);
        emit(
          {
            text: state.text.slice(0, start) + spaces + state.text.slice(end),
            start: start + spaces.length,
            end: start + spaces.length,
          },
          "input",
        );
      }
    };

    /** 点击行号：选中整行文本，方便整行删除/替换 */
    const selectLineAt = useCallback(
      (lineIndex: number) => {
        if (!config.editor.gutterClickSelectsLine) return;
        const text = valueRef.current;
        const offsets = lineOffsets(text);
        const docLines = splitLines(text);
        const index = Math.max(0, Math.min(offsets.length - 1, lineIndex));
        const start = offsets[index] ?? 0;
        const end = start + (docLines[index]?.length ?? 0);
        const content = contentRef.current;
        if (content && canTakeFocus(content)) content.focus({ preventScroll: true });
        pendingSelection.current = [start, end];
        selRef.current = { start, end };
        applyPending();
        queueApply();
        onSelectionChange?.(start, end);
      },
      [applyPending, config.editor.gutterClickSelectsLine, onSelectionChange, queueApply],
    );

    /* ---------- 命令式句柄 ---------- */

    useImperativeHandle(
      ref,
      () => ({
        focus: () => contentRef.current?.focus(),
        blur: () => contentRef.current?.blur(),
        getElement: () => contentRef.current,
        /*
         * 取的是逻辑选区，不是 DOM 选区：后者受虚拟化限制（全选时只有窗口里那一截），
         * 而命令、撤销、统计都该按用户真正的选区来算。
         */
        getState: () => ({
          text: pendingTextRef.current ?? valueRef.current,
          start: selRef.current.start,
          end: selRef.current.end,
        }),
        apply: (next, source = "toolbar") => emit(next, source),
        setSelection: (start, end = start, focus = true, reveal = true) => {
          const content = contentRef.current;
          if (!content) return;
          if (focus && canTakeFocus(content)) content.focus({ preventScroll: true });
          pendingSelection.current = [start, end];
          selRef.current = { start, end };
          // 目标行可能在渲染窗口之外：先滚过去，再重算区间，最后落选区
          if (reveal) revealOffset(start);
          sync();
          applyPending();
          queueApply();
          onSelectionChange?.(start, end);
        },
        queueSelection: (start, end = start) => {
          pendingSelection.current = [start, end];
          selRef.current = { start, end };
        },
        scrollToLine: (line) => {
          const content = contentRef.current;
          if (!content) return;
          const unit = ruler.advance || ruler.unit || config.editor.fontSize * config.editor.lineHeight;
          const index = Math.max(0, line - 1);
          measureUpTo(index);
          const offset = ruler.lines.length ? ruler.offsetOf(index) : index * unit;
          content.scrollTop = Math.max(0, offset - 2 * unit);
        },
        scrollToOffset: revealOffset,
        lineOffset: (line) => ruler.offsetOf(Math.max(0, line - 1)),
        lineUnit: () => ruler.advance || ruler.unit || config.editor.fontSize * config.editor.lineHeight,
      }),
      [
        applyPending,
        config.editor.fontSize,
        config.editor.lineHeight,
        emit,
        measureUpTo,
        onSelectionChange,
        queueApply,
        readDomSelection,
        revealOffset,
        ruler,
        sync,
      ],
    );

    /* ---------- 渲染 ---------- */

    /** 字体相关的排版条件：容器与行号测量层必须完全一致，否则折出来的行数不同 */
    const textStyle: CSSProperties = {
      fontFamily: config.editor.fontFamily,
      fontSize: `${config.editor.fontSize}px`,
      lineHeight: config.editor.lineHeight,
      letterSpacing: config.editor.letterSpacing,
      tabSize: config.editor.tabSize,
      // 底部留白：滚到最后一行时还能再往上抬一点（和原来 textarea 的行为一致）
      paddingBottom: config.editor.scrollPaddingBottom,
    };

    /**
     * 渲染窗口里的行。
     *
     * 「当前行」在这里只是一个类名：行本来就是一个个真实的 div，不需要额外的定位层。
     * 大纲跳转的高亮不在这里——它只铺那一行的文字范围（`::highlight(mde-flash)`），
     * 整行加底色会连折行之后的空档一起染上色，看着是一块色带而不是「选中了这段字」。
     *
     * 围栏代码块整块铺一层很浅的底色（含围栏行本身），颜色由主题给的
     * `--mde-source-code-bg` 决定；token 的文字颜色不在这里——那是 `::highlight()` 干的活。
     */
    const showActive = focused && config.editor.highlightActiveLine;
    /* 代码块增强整体开关：关掉后连浅底也不铺，编辑区回到纯文本的样子 */
    const showCode = config.editor.codeHighlight === true;
    const rows = useMemo(() => {
      const nodes: ReactNode[] = [];
      for (let index = first; index < last; index += 1) {
        const line = lines[index] ?? "";
        const inCode = showCode && fenceRows.has(index);
        const className = [
          "mde-line",
          showActive && index === activeLine ? "is-current" : "",
          inCode ? "is-code" : "",
        ]
          .filter(Boolean)
          .join(" ");
        nodes.push(
          <div className={className} key={index} data-line={index}>
            {line ? line : <br />}
          </div>,
        );
      }
      return nodes;
    }, [activeLine, fenceRows, first, last, lines, showActive, showCode]);

    /** 上下留白：可视区间之外的部分，用 padding 撑（光标落不进 padding） */
    const padTop = ruler.lines.length ? ruler.offsetOf(first) : 0;
    const padBottom = ruler.lines.length ? Math.max(0, ruler.total - ruler.offsetOf(last)) : 0;

    return (
      <div className={`mde-source${className ? ` ${className}` : ""}${showGutter ? " has-gutter" : ""}`}>
        {showGutter && (
          <Gutter
            ref={gutterRef}
            ruler={ruler}
            range={range}
            scroll={scroll}
            lineHeight={config.editor.lineHeight}
            fontSize={config.editor.fontSize}
            digits={gutterDigits}
            activeLine={showActive ? activeLine : -1}
            flashLine={flashLine}
            gutterClickSelectsLine={config.editor.gutterClickSelectsLine}
            onSelectLine={selectLineAt}
          />
        )}
        <div className="mde-source-main">
          {/*
            自绘光标：原生光标只有 1px，在 125%/150% 缩放下细得几乎看不见。
            这一层只管画，位置由 JS 写 transform，不参与布局、不吃鼠标事件。
          */}
          <div className="mde-caret-layer" aria-hidden="true">
            <div className="mde-caret" ref={caretRef} />
          </div>
          <div
            ref={setElement}
            className={`mde-content${config.editor.wrap ? "" : " is-nowrap"}`}
            contentEditable={readOnly ? false : "plaintext-only"}
            suppressContentEditableWarning
            role="textbox"
            aria-multiline="true"
            aria-readonly={readOnly || undefined}
            aria-label={placeholder}
            spellCheck={config.editor.spellCheck}
            style={textStyle}
            onKeyDown={handleKeyDown}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onCopy={handleCopy}
            onCut={handleCut}
            onPaste={handlePaste}
            onDrop={handleDrop}
          >
            <div
              className="mde-lines"
              key={domEpoch}
              style={{ paddingTop: padTop, paddingBottom: padBottom }}
            >
              {rows}
            </div>
          </div>
          {value === "" && <div className="mde-placeholder">{placeholder}</div>}
        </div>
      </div>
    );
  },
);

SourceEditor.displayName = "SourceEditor";

/**
 * 行内列号 → DOM 位置。
 *
 * 一行的 DOM 里只有文本节点（外加空行那个 `<br>`），串起来就是这一行的列号。
 * 与 `offsetToPoint` 同一套走法，区别只在起点是行内的相对列号。
 */
const columnPoint = (row: HTMLElement, column: number): { node: Node; offset: number } | null => {
  const walker = row.ownerDocument.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let remaining = column;
  let node = walker.nextNode();
  while (node) {
    const length = node.nodeValue?.length ?? 0;
    if (remaining <= length) return { node, offset: Math.max(0, remaining) };
    remaining -= length;
    node = walker.nextNode();
  }
  return null;
};

/** 第一个 `end > at` 的命中下标：窗口之前就结束的命中整体跳过 */
function firstMatchAtOrAfter(matches: SearchMatch[], at: number): number {
  let low = 0;
  let high = matches.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (matches[mid].end > at) high = mid;
    else low = mid + 1;
  }
  return low;
}

/**
 * 把一个编辑意图换算成新的文档状态。
 *
 * 返回 null 表示「这个类型我们不接管」——调用方会让浏览器自己改 DOM，
 * 再在 `input` 事件里把渲染窗口读回来。
 */
function editForInput(
  state: EditState,
  type: string,
  native: InputEvent,
  cfg: MarkdownEditorConfig["editor"],
): EditState | null {
  const { text, start, end } = state;
  /** 用 insert 替换选区（选区为空就是纯插入） */
  const splice = (insert: string): EditState => ({
    text: text.slice(0, start) + insert + text.slice(end),
    start: start + insert.length,
    end: start + insert.length,
  });

  switch (type) {
    case "insertText": {
      const data = native.data ?? "";
      if (!data) return null;
      if (data.length === 1 && start === end) {
        const paired = autoPairOnInput(text, start, data, cfg.autoPair);
        if (paired) return { text: paired.text, start: paired.caret, end: paired.caret };
      }
      return splice(data);
    }
    case "insertParagraph": {
      const base = start !== end ? splice("\n") : state;
      if (!cfg.continueMarkdownOnEnter) return base;
      const result = continueMarkdownOnEnter(base.text, base.start, cfg.tabSize);
      return result ? { text: result.text, start: result.caret, end: result.caret } : base;
    }
    case "insertLineBreak":
      return splice("\n");
    case "insertFromPaste":
    case "insertFromDrop":
    case "insertFromYank": {
      const data = native.dataTransfer?.getData("text/plain") ?? "";
      // 拿不到文本就别拦：让浏览器自己贴，随后按渲染窗口读回来
      return data ? splice(data) : null;
    }
    case "deleteContentBackward": {
      if (start !== end) return splice("");
      const from = stepBack(text, start);
      return { text: text.slice(0, from) + text.slice(end), start: from, end: from };
    }
    case "deleteContentForward": {
      if (start !== end) return splice("");
      const to = stepForward(text, end);
      return { text: text.slice(0, start) + text.slice(to), start, end: start };
    }
    case "deleteWordBackward": {
      if (start !== end) return splice("");
      const from = wordStartOf(text, start);
      return { text: text.slice(0, from) + text.slice(end), start: from, end: from };
    }
    case "deleteWordForward": {
      if (start !== end) return splice("");
      const to = wordEndOf(text, end);
      return { text: text.slice(0, start) + text.slice(to), start, end: start };
    }
    case "deleteSoftLineBackward":
    case "deleteHardLineBackward": {
      if (start !== end) return splice("");
      const lineStart = lineAtOffset(text, start).start;
      // 已经在行首：把换行符也删掉，与上一行合并
      const from = start > lineStart ? lineStart : Math.max(0, lineStart - 1);
      return { text: text.slice(0, from) + text.slice(end), start: from, end: from };
    }
    case "deleteSoftLineForward":
    case "deleteHardLineForward": {
      if (start !== end) return splice("");
      const at = lineAtOffset(text, start);
      const lineEnd = at.start + (splitLines(text)[at.line] ?? "").length;
      // 已经在行尾：连换行符一起删，与下一行合并
      const to = start < lineEnd ? lineEnd : Math.min(text.length, lineEnd + 1);
      return { text: text.slice(0, start) + text.slice(to), start, end: start };
    }
    case "deleteEntireSoftLine": {
      const at = lineAtOffset(text, start);
      const lineEnd = at.start + (splitLines(text)[at.line] ?? "").length;
      return { text: text.slice(0, at.start) + text.slice(lineEnd), start: at.start, end: at.start };
    }
    case "insertCompositionText":
    case "deleteCompositionText":
    case "insertReplacementText":
      // 组合 / 拼写替换：浏览器要在真实 DOM 上做，交给读回
      return null;
    case "historyUndo":
    case "historyRedo":
      // 撤销归上层（Ctrl/⌘+Z 在快捷键里就拦掉了），这里只拦住浏览器自己那套
      return state;
    default:
      // 认不出来的类型一律吞掉：让它改 DOM 而我们不知情，比什么都不做更糟
      return state;
  }
}
