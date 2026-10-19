/**
 * MarkdownEditor 主组件。
 *
 * 职责边界：
 * - 持有文档、模式、选择区、历史、全屏/大纲等界面状态；
 * - 把「工具栏 / 快捷键 / 命令式 API / 任务勾选」统一收敛成 `applyEdit()` 一条写入口，
 *   保证任何来源的改动都会走同一套历史记录与受控回调；
 * - 几种模式只是不同的视图组合：源码（textarea）、分栏（源码 + 预览）、阅读（预览）、
 *   纯渲染（render，无外壳），它们共用同一份文档与同一套渲染。
 *
 * 受控/非受控：传了 `value` 就是受控（内部不再存值，只回调 onChange）；
 * 模式同理，传了 `mode` 就完全由外部掌控。
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import "../styles.css";
import { ALL_MODES, resolveConfig, resolveLabels } from "../defaults";
import { buildThemeVars } from "../theme";
import { parseMarkdown } from "../parser/block";
import {
  applyAdmonition,
  applyCallout,
  applyHeading,
  computeCursor,
  computeDocStats,
  detectFormats,
  runCommand,
  type ActiveFormats,
  type EditState,
} from "../editor/commands";
import { useHistory } from "../editor/useHistory";
import { bindScrollSync } from "../editor/scrollSync";
import {
  expandReplacement,
  findMatches,
  nextMatchIndex,
  offsetToLine,
  prevMatchIndex,
  replaceAllMatches,
  replaceMatch,
  type SearchMatch,
  type SearchOptions,
} from "../editor/search";
import type {
  DeepPartial,
  MarkdownChangeSource,
  MarkdownCustomTool,
  MarkdownEditorConfig,
  MarkdownEditorInstance,
  MarkdownEditorMode,
  MarkdownEditorProps,
  MarkdownStats,
  ParsedDocument,
  ToolbarItemName,
} from "../types";
import { SourceEditor, type SourceEditorHandle } from "../components/SourceEditor";
import { Toolbar } from "../components/Toolbar";
import { StatusBar } from "../components/StatusBar";
import { Outline } from "../components/Outline";
import { SearchBox } from "../components/SearchBox";
import { MarkdownPreview } from "../render/MarkdownPreview";

/** 文本编辑目标：源码 textarea 与实时预览块编辑框都满足这个形状 */
interface EditorTarget {
  getState: () => EditState;
  apply: (next: EditState) => void;
}

/** 默认快捷键（键名用 KeyboardEvent.code 归一化后的结果） */
const DEFAULT_SHORTCUTS: Record<string, string> = {
  "mod+b": "bold",
  "mod+i": "italic",
  "mod+shift+x": "strike",
  "mod+e": "inlineCode",
  "mod+shift+e": "codeBlock",
  "mod+k": "link",
  "mod+shift+k": "image",
  "mod+shift+.": "quote",
  "mod+shift+7": "orderedList",
  "mod+shift+8": "bulletList",
  "mod+shift+9": "taskList",
  "mod+shift+m": "math",
  "mod+shift+f": "footnote",
  "mod+alt+1": "heading1",
  "mod+alt+2": "heading2",
  "mod+alt+3": "heading3",
  "mod+alt+4": "heading4",
  "mod+alt+5": "heading5",
  "mod+alt+6": "heading6",
  "mod+alt+0": "heading0",
};

/** 跟随系统的明暗解析 */
const useResolvedTheme = (mode: "light" | "dark" | "auto"): "light" | "dark" => {
  const [system, setSystem] = useState<"light" | "dark">(() => {
    if (typeof window === "undefined" || !window.matchMedia) return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });

  useEffect(() => {
    if (mode !== "auto" || typeof window === "undefined" || !window.matchMedia) return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setSystem(media.matches ? "dark" : "light");
    handler();
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, [mode]);

  return mode === "auto" ? system : mode;
};

/** 归一化快捷键只需要这几个字段，原生事件与 React 合成事件都能传进来 */
type KeyLike = Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "key">;

/** 从事件生成归一化快捷键字符串 */
const acceleratorOf = (event: KeyLike): string => {
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("mod");
  if (event.altKey) parts.push("alt");
  if (event.shiftKey) parts.push("shift");
  const code = event.code;
  if (code.startsWith("Digit")) parts.push(code.slice(5));
  else if (code.startsWith("Key")) parts.push(code.slice(3).toLowerCase());
  else if (code === "Backquote") parts.push("`");
  else if (code === "Period") parts.push(".");
  else if (code === "Slash") parts.push("/");
  else parts.push(event.key.toLowerCase());
  return parts.join("+");
};

const resolveHeight = (value: number | string | undefined, fallback: string): string => {
  if (value === undefined) return fallback;
  return typeof value === "number" ? `${value}px` : value;
};

/** 分栏的栅格列：拖拽时直接写进容器样式，与下面的 render 共用同一套算法 */
const splitColumns = (
  ratio: number,
  split: { resizable: boolean; dividerWidth: number },
): string =>
  split.resizable ? `${ratio}fr ${split.dividerWidth}px ${1 - ratio}fr` : `${ratio}fr ${1 - ratio}fr`;

/** a → b 的文本变化区间 [lo, hi)：公共前缀 + 公共后缀之外就是真正动过的部分 */
const changedRange = (a: string, b: string): [number, number] => {
  const shared = Math.min(a.length, b.length);
  let lo = 0;
  while (lo < shared && a.charCodeAt(lo) === b.charCodeAt(lo)) lo += 1;
  let hi = 0;
  while (hi < shared - lo && a.charCodeAt(a.length - 1 - hi) === b.charCodeAt(b.length - 1 - hi)) hi += 1;
  return [lo, a.length - hi];
};

/** 一份「源文本 + 解析选项 + 解析结果」的快照：三者必须成对流转 */
interface ParsedSnapshot {
  text: string;
  allowHtml: boolean;
  breaks: boolean;
  doc: ParsedDocument;
}

/** 变化跨度超过这个字符数就不再当成「敲字」：多半是换笔记或整篇粘贴 */
const WHOLESALE_SPAN = 4096;

/**
 * 这次改的是不是「整篇换掉」。
 *
 * 换笔记时两份文本几乎没有公共前后缀，变化跨度≈全文；这种改动要立刻解析、
 * 也不该拿去和上一篇复用块——否则预览会先停在上一篇，甚至把上一篇的块搬过来。
 */
const isWholesaleChange = (previous: string, next: string): boolean => {
  if (!previous.length || !next.length) return true;
  const [lo, hi] = changedRange(previous, next);
  const span = hi - lo;
  if (span > WHOLESALE_SPAN) return true;
  // 跨度同时占了原文与新文的大半：不是在原有内容上改，而是换了内容
  return span * 2 > previous.length && span * 2 > next.length;
};

/** 块里是否带任务项：任务勾选取的是 `taskOffset` 这个绝对偏移 */
const hasTaskItem = (node: ParsedDocument["blocks"][number]): boolean => {
  if (node.type === "list") {
    return node.items.some(
      (item) => item.task !== null || item.children.some((child) => hasTaskItem(child)),
    );
  }
  if (node.type === "blockquote" || node.type === "callout") {
    return node.children.some((child) => hasTaskItem(child));
  }
  return false;
};

/**
 * 复用未受本次改动影响的块节点。
 *
 * 前提是 `previous.text` 与 `previous.doc` 真的对得上（防抖期间 doc 会落后于 value，
 * 拿 value 去配旧 doc 会让下面的区间判断全部算错，预览于是卡在上一篇）。
 * 换笔记 / 整篇粘贴根本不具备「内容没被碰到」的前提，直接放弃复用。
 *
 * 头部：变化点之前的块偏移完全一致，按位置复用。
 * 尾部：两边各自的「变化点之后」文本相同，但只要中间增删过字符，块的绝对偏移就整体平移了——
 *   带任务项的块不能复用（勾选会按平移前的 taskOffset 改到别的字符上），
 *   行号变了的也不能复用（data-line 是滚动同步与「跳到源码」的锚点）。
 */
const shareBlocks = (
  next: { text: string; doc: ParsedDocument },
  previous: { text: string; doc: ParsedDocument } | null,
): ParsedDocument => {
  if (!previous) return next.doc;
  if (previous.text === next.text) return previous.doc;
  if (isWholesaleChange(previous.text, next.text)) return next.doc;

  const [lo, hi] = changedRange(previous.text, next.text);
  const prevBlocks = previous.doc.blocks;
  const blocks = next.doc.blocks;
  const out = blocks.slice();

  let head = 0;
  while (head < blocks.length && blocks[head].end <= lo) head += 1;
  let prevHead = 0;
  while (prevHead < prevBlocks.length && prevBlocks[prevHead].end <= lo) prevHead += 1;
  // 块数对不上说明中段增删了块，位置对应关系不确定，头部一律不复用
  if (head === prevHead) {
    for (let i = 0; i < head; i += 1) out[i] = prevBlocks[i];
  }

  const prevTail = previous.text.length - hi;
  let i = blocks.length - 1;
  let j = prevBlocks.length - 1;
  while (i >= head && j >= prevHead) {
    const block = blocks[i];
    const old = prevBlocks[j];
    // 两边都得整块落在公共后缀里，跨在变化点上的块不能复用
    if (block.start < hi || old.start < prevTail) break;
    // 相对位置 / 长度 / 行号必须逐项对上：任一项不符说明后缀里的块已经配对错行，后面更早的也不可信
    if (old.start - prevTail !== block.start - hi) break;
    if (old.end - old.start !== block.end - block.start) break;
    if (old.line !== block.line) break;
    // 任务项带着平移前的 taskOffset，复用会让勾选改到别的字符上
    if (!hasTaskItem(block)) out[i] = old;
    i -= 1;
    j -= 1;
  }

  return { ...next.doc, blocks: out };
};

export const MarkdownEditor = forwardRef<MarkdownEditorInstance, MarkdownEditorProps>((props, ref) => {
  const {
    value: valueProp,
    defaultValue = "",
    onChange,
    mode: modeProp,
    defaultMode,
    onModeChange,
    config: configPatch,
    readOnly = false,
    placeholder,
    height,
    minHeight,
    maxHeight,
    className,
    style,
    autoFocus,
    onReady,
    onSave,
    onImagePaste,
    onLinkClick,
    onTaskToggle,
    onOutlineChange,
    onStatsChange,
    onFullscreenChange,
  } = props;

  const config = useMemo(() => resolveConfig(configPatch as DeepPartial<MarkdownEditorConfig>), [configPatch]);
  const labels = useMemo(() => resolveLabels(config), [config]);
  const resolvedTheme = useResolvedTheme(config.theme.mode);
  const themeVars = useMemo(() => buildThemeVars(config, resolvedTheme).vars, [config, resolvedTheme]);

  /* ---------- 值 / 模式 ---------- */
  const isControlled = valueProp !== undefined;
  const [innerValue, setInnerValue] = useState(defaultValue);
  const value = isControlled ? (valueProp as string) : innerValue;
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const available = config.mode.available.length ? config.mode.available : ALL_MODES;
  /** render 是「无外壳纯渲染」，不出现在模式切换里，因此不受 available 限制 */
  const isRenderMode = (value: MarkdownEditorMode) => value === "render";
  const [innerMode, setInnerMode] = useState<MarkdownEditorMode>(() => {
    const initial = modeProp ?? defaultMode ?? config.mode.defaultMode;
    return isRenderMode(initial) || available.includes(initial) ? initial : available[0];
  });
  const mode =
    modeProp && (isRenderMode(modeProp) || available.includes(modeProp)) ? modeProp : innerMode;
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const selectionRef = useRef(selection);
  const updateSelection = useCallback((start: number, end: number) => {
    selectionRef.current = { start, end };
    setSelection({ start, end });
  }, []);

  /* ---------- 解析 ---------- */
  const parseOptions = useMemo(
    () => ({ allowHtml: config.preview.allowHtml, breaks: config.preview.breaks }),
    [config.preview.allowHtml, config.preview.breaks],
  );

  /**
   * 解析结果必须和「它是从哪段文本、哪套选项解析出来的」成对流转。
   *
   * 防抖期间 doc 天然落后于 value，若把 value 当成 doc 的文本记进复用缓存，
   * 之后每次都会命中这条错账（`previous.text === text` 直接返回旧 doc），
   * 表现就是换笔记后预览永远停在上一篇。
   */
  const makeSnapshot = useCallback(
    (text: string, options: { allowHtml: boolean; breaks: boolean }): ParsedSnapshot => ({
      text,
      allowHtml: options.allowHtml,
      breaks: options.breaks,
      doc: parseMarkdown(text, options),
    }),
    [],
  );

  const [debounced, setDebounced] = useState<ParsedSnapshot>(() =>
    makeSnapshot(value, parseOptions),
  );

  /**
   * 本次渲染要显示的解析结果。
   *
   * 防抖为 0（实时预览）时直接在渲染期解析：走 effect 的话一次按键是
   * 「渲染 → effect 解析 → setState → 再渲染」两趟提交，长文档上等于把整棵树 diff 两遍。
   * 换笔记 / 整篇粘贴同样不等防抖——那是单击操作，不在按键热路径上，
   * 等 120ms 只会让人先看见上一篇的残留内容。
   */
  const parsed = useMemo<ParsedSnapshot>(() => {
    const upToDate =
      debounced.text === value &&
      debounced.allowHtml === parseOptions.allowHtml &&
      debounced.breaks === parseOptions.breaks;
    if (upToDate) return debounced;
    if (!config.preview.debounce || isWholesaleChange(debounced.text, value)) {
      return makeSnapshot(value, parseOptions);
    }
    return debounced;
  }, [value, parseOptions, debounced, config.preview.debounce, makeSnapshot]);

  /** 防抖落地：到点把「这一帧显示的解析结果」写进防抖状态，与渲染期解析保持同一份 */
  useEffect(() => {
    const delay = config.preview.debounce;
    if (!delay) return;
    const committed =
      debounced.text === value &&
      debounced.allowHtml === parseOptions.allowHtml &&
      debounced.breaks === parseOptions.breaks;
    if (committed) return;
    // 这一帧已经同步解析过（换笔记 / 整篇替换）：到点直接落库，别再白解析一遍
    const alreadyParsed =
      parsed.text === value &&
      parsed.allowHtml === parseOptions.allowHtml &&
      parsed.breaks === parseOptions.breaks;
    const timer = window.setTimeout(
      () => setDebounced(alreadyParsed ? parsed : makeSnapshot(value, parseOptions)),
      delay,
    );
    return () => window.clearTimeout(timer);
  }, [value, parseOptions, config.preview.debounce, debounced, parsed, makeSnapshot]);

  /**
   * 把「内容没被这次改动碰到」的块换回上一次的节点对象。
   *
   * 打字只改到一个块，但整篇解析会给每一个块造新对象——两千多个块于是全部重渲染一遍，
   * 光这一项就是每键一百多毫秒。复用旧对象后，块级 memo 能把没变的块整个跳过，
   * 预览的渲染量塌回到真正动过的那一两块。
   *
   * 缓存里存的是「快照」而不是 value：只有和 doc 配套的那段文本才能当复用基准。
   */
  const lastDoc = useRef<{ text: string; doc: ParsedDocument } | null>(null);
  const doc = useMemo(() => {
    const next = shareBlocks(parsed, lastDoc.current);
    lastDoc.current = { text: parsed.text, doc: next };
    return next;
  }, [parsed]);

  /* ---------- 历史 ---------- */
  const history = useHistory(config.editor.historyLimit);

  /* ---------- 查找 / 替换 ---------- */
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchReplace, setSearchReplace] = useState("");
  const [searchShowReplace, setSearchShowReplace] = useState(config.search.showReplace);
  const [searchOptions, setSearchOptions] = useState<SearchOptions>({
    caseSensitive: config.search.caseSensitive,
    regex: config.search.regex,
  });
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [matchIndex, setMatchIndex] = useState(0);
  /** 下一次命中重算后是否要替用户选中该命中（按钮 / 快捷键触发时才选） */
  const selectOnRevealRef = useRef(false);
  /** 快捷键定义在查找逻辑之前，用 ref 转发，避免声明顺序问题 */
  const goNextRef = useRef<() => void>(() => {});
  const goPrevRef = useRef<() => void>(() => {});
  const openSearchRef = useRef<(query?: string, withReplace?: boolean) => void>(() => {});
  const closeSearchRef = useRef<() => void>(() => {});

  useEffect(() => {
    setSearchShowReplace(config.search.showReplace);
  }, [config.search.showReplace]);

  const matches = useMemo(
    () =>
      config.search.enabled && searchOpen && searchQuery
        ? findMatches(value, searchQuery, searchOptions, config.search.maxMatches)
        : [],
    [config.search.enabled, config.search.maxMatches, searchOpen, searchQuery, searchOptions, value],
  );
  const matchesRef = useRef(matches);
  matchesRef.current = matches;
  const matchIndexRef = useRef(matchIndex);
  matchIndexRef.current = matchIndex;

  /* ---------- 布局状态 ---------- */
  const [fullscreen, setFullscreen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(config.outline.show);
  const [splitRatio, setSplitRatio] = useState(config.split.ratio);
  useEffect(() => {
    setSplitRatio(config.split.ratio);
  }, [config.split.ratio]);

  /* ---------- 引用 ---------- */
  const sourceRef = useRef<SourceEditorHandle | null>(null);
  const sourceElRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  /* ---------- 写入口：所有改动都经过这里 ---------- */
  const commitValue = useCallback(
    (next: string, caret: number, source: MarkdownChangeSource) => {
      const previous = valueRef.current;
      if (next === previous) {
        updateSelection(caret, caret);
        return;
      }
      history.record({ text: previous, caret: selectionRef.current.start }, source === "input");
      valueRef.current = next;
      if (!isControlled) setInnerValue(next);
      onChange?.(next, { source, mode: modeRef.current });
      updateSelection(caret, caret);
    },
    [history, isControlled, onChange, updateSelection],
  );

  const handleSourceElement = useCallback((element: HTMLTextAreaElement | null) => {
    sourceElRef.current = element;
  }, []);

  const handleSourceChange = useCallback(
    (next: EditState, source: MarkdownChangeSource) => {
      commitValue(next.text, next.end, source);
      updateSelection(next.start, next.end);
    },
    [commitValue, updateSelection],
  );

  /** 当前可用的编辑目标 + 它的编辑态 */
  const resolveTarget = useCallback((): { target: EditorTarget; state: EditState } | null => {
    const source = sourceRef.current;
    return source ? { target: source, state: source.getState() } : null;
  }, []);

  /** 只取句柄：用于只读查询（如取当前选区） */
  const getTargetHandle = useCallback((): EditorTarget | null => sourceRef.current, []);

  const applyToTarget = useCallback(
    (target: EditorTarget, next: EditState) => {
      target.apply(next);
      updateSelection(next.start, next.end);
    },
    [updateSelection],
  );

  /* ---------- 命令 ---------- */
  // undo/redo 的实现在下方（依赖 restoreSnapshot），工具栏通过 ref 调用，避免循环依赖
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});

  const runToolbar = useCallback(
    (name: ToolbarItemName) => {
      if (name === "mode" || name === "outline" || name === "fullscreen") return;
      if (name === "undo") {
        undoRef.current();
        return;
      }
      if (name === "redo") {
        redoRef.current();
        return;
      }
      const resolved = resolveTarget();
      if (!resolved) return;
      const next = runCommand(resolved.state, name, { tabSize: config.editor.tabSize, labels });
      if (!next) return;
      applyToTarget(resolved.target, next);
    },
    [applyToTarget, config.editor.tabSize, resolveTarget, labels],
  );

  const applyHeadingLevel = useCallback(
    (level: 0 | 1 | 2 | 3 | 4 | 5 | 6) => {
      const resolved = resolveTarget();
      if (!resolved) return;
      applyToTarget(resolved.target, applyHeading(resolved.state, level));
    },
    [applyToTarget, resolveTarget],
  );

  const applyAlert = useCallback(
    (kind: string) => {
      const resolved = resolveTarget();
      if (!resolved) return;
      applyToTarget(resolved.target, applyCallout(resolved.state, kind));
    },
    [applyToTarget, resolveTarget],
  );

  const applyCalloutBlock = useCallback(
    (kind: string) => {
      const resolved = resolveTarget();
      if (!resolved) return;
      applyToTarget(resolved.target, applyAdmonition(resolved.state, kind));
    },
    [applyToTarget, resolveTarget],
  );

  /* ---------- 撤销 / 重做（整篇快照） ---------- */
  const restoreSnapshot = useCallback(
    (snapshot: { text: string; caret: number }, source: MarkdownChangeSource) => {
      valueRef.current = snapshot.text;
      if (!isControlled) setInnerValue(snapshot.text);
      onChange?.(snapshot.text, { source, mode: modeRef.current });
      updateSelection(snapshot.caret, snapshot.caret);
      // 值更新是异步的，这里只排队选区，等 textarea 拿到新值后再落光标
      sourceRef.current?.queueSelection(snapshot.caret, snapshot.caret);
    },
    [isControlled, onChange, updateSelection],
  );

  const undo = useCallback(() => {
    const snapshot = history.undo({ text: valueRef.current, caret: selectionRef.current.start });
    if (snapshot) restoreSnapshot(snapshot, "undo");
  }, [history, restoreSnapshot]);

  const redo = useCallback(() => {
    const snapshot = history.redo({ text: valueRef.current, caret: selectionRef.current.start });
    if (snapshot) restoreSnapshot(snapshot, "redo");
  }, [history, restoreSnapshot]);

  undoRef.current = undo;
  redoRef.current = redo;

  /* ---------- 模式 / 全屏 / 大纲 ---------- */
  const changeMode = useCallback(
    (next: MarkdownEditorMode) => {
      if (next === modeRef.current || !available.includes(next)) return;
      modeRef.current = next;
      setInnerMode(next);
      onModeChange?.(next);
    },
    [available, onModeChange],
  );

  const toggleFullscreen = useCallback(
    (force?: boolean) => {
      setFullscreen((previous) => {
        const next = force ?? !previous;
        onFullscreenChange?.(next);
        return next;
      });
    },
    [onFullscreenChange],
  );

  const toggleOutline = useCallback((force?: boolean) => {
    setOutlineOpen((previous) => force ?? !previous);
  }, []);

  /* ---------- 复制 / 图片 ---------- */
  const copyAll = useCallback(() => {
    void navigator.clipboard?.writeText(valueRef.current);
  }, []);

  const insertMarkdown = useCallback(
    (text: string, options?: { wrap?: [string, string]; selectInserted?: boolean }) => {
      const resolved = resolveTarget();
      if (!resolved) return;
      const state = resolved.state;
      const selected = state.text.slice(state.start, state.end);
      const inserted = options?.wrap
        ? options.wrap[0] + (selected || text) + options.wrap[1]
        : text;
      const caret = state.start + inserted.length;
      applyToTarget(resolved.target, {
        text: state.text.slice(0, state.start) + inserted + state.text.slice(state.end),
        start: options?.selectInserted ? state.start : caret,
        end: caret,
      });
    },
    [applyToTarget, resolveTarget],
  );

  const handleImageFile = useCallback(
    async (file: File) => {
      if (!onImagePaste) return;
      const url = await onImagePaste(file);
      if (!url) return;
      const alt = file.name.replace(/\.[^.]+$/, "") || "image";
      insertMarkdown(`![${alt}](${url})`);
    },
    [insertMarkdown, onImagePaste],
  );

  /* ---------- 任务勾选 ---------- */
  const handleTaskToggle = useCallback(
    (taskOffset: number, checked: boolean) => {
      if (readOnly) return;
      const current = valueRef.current;
      if (taskOffset < 0 || taskOffset >= current.length) return;
      const patched = current.slice(0, taskOffset) + (checked ? "x" : " ") + current.slice(taskOffset + 1);
      const custom = onTaskToggle?.(checked, taskOffset, patched);
      commitValue(typeof custom === "string" ? custom : patched, taskOffset, "task");
    },
    [commitValue, onTaskToggle, readOnly],
  );

  /* ---------- 快捷键 ---------- */
  const shortcutMap = useMemo(() => {
    if (config.shortcuts === false) return {} as Record<string, string>;
    const map = { ...DEFAULT_SHORTCUTS };
    if (typeof config.shortcuts === "object") {
      for (const [key, action] of Object.entries(config.shortcuts)) {
        const normalized = key.toLowerCase();
        if (action === false) delete map[normalized];
        else map[normalized] = action;
      }
    }
    return map;
  }, [config.shortcuts]);

  const handleShortcut = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>): boolean => {
      if (event.nativeEvent.isComposing) return false;
      const accelerator = acceleratorOf(event);
      if (accelerator === "mod+z") {
        event.preventDefault();
        undo();
        return true;
      }
      if (accelerator === "mod+shift+z" || accelerator === "mod+y") {
        event.preventDefault();
        redo();
        return true;
      }
      if (accelerator === "mod+s") {
        event.preventDefault();
        onSave?.(valueRef.current);
        return true;
      }
      if (accelerator === "mod+alt+enter") {
        event.preventDefault();
        toggleFullscreen();
        return true;
      }
      if (accelerator === "f3") {
        event.preventDefault();
        goNextRef.current();
        return true;
      }
      if (accelerator === "shift+f3") {
        event.preventDefault();
        goPrevRef.current();
        return true;
      }
      const action = shortcutMap[accelerator];
      if (!action) return false;
      event.preventDefault();
      if (action.startsWith("heading")) {
        applyHeadingLevel(Number(action.slice("heading".length)) as 0 | 1 | 2 | 3 | 4 | 5 | 6);
        return true;
      }
      runToolbar(action as ToolbarItemName);
      return true;
    },
    [applyHeadingLevel, onSave, redo, runToolbar, shortcutMap, toggleFullscreen, undo],
  );

  /**
   * 根节点的捕获阶段快捷键。
   *
   * 查找框要能在任意焦点位置唤起（工具栏、预览区、甚至没聚焦时点开菜单后），
   * 单靠 textarea 的 onKeyDown 覆盖面不够；用捕获还能抢在输入框的 Esc 失焦之前关掉查找框。
   *
   * mod+f / mod+g / mod+h 必须在这里就 preventDefault：否则宿主容器（浏览器标签页、
   * WebView2）会接着弹出自己的原生查找条 / 历史页。软件侧建议在 window 捕获阶段也拦一层，
   * 但那里一旦 stopPropagation，这里的处理就拿不到事件了。
   */
  const handleRootKeyDownCapture = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (!config.search.enabled || event.nativeEvent.isComposing) return;
      const accelerator = acceleratorOf(event);
      if (accelerator === "escape" && searchOpen) {
        event.preventDefault();
        event.stopPropagation();
        closeSearchRef.current();
        return;
      }
      if (accelerator === "mod+f") {
        // 只开查找；替换行留给折叠箭头手动展开（Ctrl/⌘+H 才直接带出来）
        event.preventDefault();
        openSearchRef.current(undefined, false);
        return;
      }
      if (accelerator === "mod+h") {
        event.preventDefault();
        openSearchRef.current(undefined, true);
        return;
      }
      if (accelerator === "mod+g" || accelerator === "mod+shift+g") {
        // 沿用浏览器习惯：Ctrl/⌘+G 找下一个、加 Shift 找上一个
        event.preventDefault();
        if (!searchOpen) openSearchRef.current(undefined, false);
        else if (accelerator === "mod+shift+g") goPrevRef.current();
        else goNextRef.current();
        return;
      }
      if (accelerator === "f3" || accelerator === "shift+f3") {
        event.preventDefault();
        if (accelerator === "shift+f3") goPrevRef.current();
        else goNextRef.current();
      }
    },
    [config.search.enabled, searchOpen],
  );

  useEffect(() => {
    if (!fullscreen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") toggleFullscreen(false);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [fullscreen, toggleFullscreen]);

  /**
   * 挡掉宿生的原生查找快捷键（`config.search.blockHostFind`）。
   *
   * 浏览器标签页 / WebView2 / Electron 都会自己吃掉 Ctrl+F / G / H 弹原生查找条，
   * 光在根节点 preventDefault 拦不住——那些是宿主在 window 层（甚至浏览器进程）处理的。
   * 所以在 window **捕获阶段** 再拦一层：按键落在编辑器内部时才动手，
   * 编辑器以外的地方完全不受影响。
   *
   * 只 preventDefault、绝不 stopPropagation：宿主自己的处理器（以及下面根节点那套）
   * 还得照常收到事件。多个编辑器实例同时挂载时各自守卫各自的根节点，互不干扰。
   */
  useEffect(() => {
    if (!config.search.enabled || !config.search.blockHostFind) return;
    const guard = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      const root = rootRef.current;
      if (!root || !event.target || !root.contains(event.target as Node)) return;
      const accelerator = acceleratorOf(event);
      if (
        accelerator === "mod+f" ||
        accelerator === "mod+g" ||
        accelerator === "mod+shift+g" ||
        accelerator === "mod+h" ||
        accelerator === "f3" ||
        accelerator === "shift+f3"
      ) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", guard, true);
    return () => window.removeEventListener("keydown", guard, true);
  }, [config.search.blockHostFind, config.search.enabled]);

  /* ---------- 滚动同步 ---------- */
  useEffect(() => {
    if (mode !== "split" || !config.preview.syncScroll) return;
    const editor = sourceElRef.current;
    const preview = previewRef.current;
    if (!editor || !preview) return;
    return bindScrollSync({
      editor,
      preview,
      lineHeight: config.editor.fontSize * config.editor.lineHeight,
      mode: config.preview.syncScrollMode,
    });
  }, [
    mode,
    config.preview.syncScroll,
    config.preview.syncScrollMode,
    config.editor.fontSize,
    config.editor.lineHeight,
  ]);

  /* ---------- 对外回调 ---------- */
  useEffect(() => {
    onOutlineChange?.(doc.outline);
  }, [doc.outline, onOutlineChange]);

  /*
   * 统计拆成两档：「文档级」（字数/段数/阅读时长）只在文本变化时算，
   * 「光标行列」只依赖文本 + 光标偏移。这样按方向键挪光标时，
   * 文档级那部分直接命中 memo，只剩一次二分定位，不用再扫一遍全文。
   */
  const docStats = useMemo(
    () => computeDocStats(value, config.statusBar.readingSpeed),
    [value, config.statusBar.readingSpeed],
  );
  const cursor = useMemo(() => computeCursor(value, selection.start), [value, selection.start]);
  const stats: MarkdownStats = useMemo(
    () => ({ ...docStats, cursor: { ...cursor, selection: selection.end - selection.start } }),
    [docStats, cursor, selection],
  );

  useEffect(() => {
    onStatsChange?.(stats);
  }, [stats, onStatsChange]);

  const statsRef = useRef(stats);
  statsRef.current = stats;
  const docRef = useRef(doc);
  docRef.current = doc;

  /* ---------- 滚动到行 ---------- */
  const scrollToLine = useCallback(
    (line: number) => {
      if (mode === "read") {
        const container = previewRef.current;
        if (!container) return;
        const nodes = container.querySelectorAll<HTMLElement>("[data-line]");
        let target: HTMLElement | null = null;
        nodes.forEach((node) => {
          if (Number(node.dataset.line) <= line) target = node;
        });
        if (target) {
          const element = target as HTMLElement;
          const top = element.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
          container.scrollTo({ top: top - 12, behavior: "smooth" });
          return;
        }
      }
      sourceRef.current?.scrollToLine(line);
    },
    [mode],
  );

  /* ---------- 查找 / 替换：跳转与改写 ---------- */
  const clampIndex = useCallback((index: number, list: SearchMatch[]) => {
    if (!list.length) return -1;
    return Math.min(Math.max(index, 0), list.length - 1);
  }, []);

  /** 命中不在可视区时把它滚到中间；用高亮层的真实位置测量，自动换行也不会算错 */
  const scrollMatchIntoView = useCallback(() => {
    const root = rootRef.current;
    const element = sourceElRef.current;
    if (!root || !element) return;
    const mark = root.querySelector<HTMLElement>(".mde-find-hit.is-current");
    if (!mark) return;
    const markRect = mark.getBoundingClientRect();
    /*
     * 必须换算成「内容坐标」再算目标 scrollTop：mark 的视口位置取决于高亮层自己的
     * scrollTop 是否跟手，而层刚挂载 / 刚重建时可能还停在旧位置（textarea 已经滚了），
     * 直接拿视口差 += 会把视图滚过头——实测能偏出一整屏，当前命中反而跑到视口外。
     * 用 markRect - 层的盒顶 + 层的 scrollTop 得到与滚动无关的内容偏移，对同步状态免疫。
     */
    const layer = root.querySelector<HTMLElement>(".mde-find-layer");
    const markTop = layer
      ? markRect.top - layer.getBoundingClientRect().top + layer.scrollTop
      : markRect.top - element.getBoundingClientRect().top + element.scrollTop;
    const viewTop = element.scrollTop;
    const viewBottom = viewTop + element.clientHeight;
    const margin = 28;
    if (markTop >= viewTop + margin && markTop + markRect.height <= viewBottom - margin) return;
    element.scrollTop = markTop - element.clientHeight / 2 + markRect.height / 2;
  }, []);

  const revealMatch = useCallback(
    (match: SearchMatch, select: boolean) => {
      if (modeRef.current === "read") {
        scrollToLine(offsetToLine(valueRef.current, match.start));
        return;
      }
      // 不抢焦点：查找框里连按 Enter 要一直是「下一个」，抢回来就成了在编辑器里换行
      if (select) sourceRef.current?.setSelection(match.start, match.end, false);
      requestAnimationFrame(scrollMatchIntoView);
    },
    [scrollMatchIntoView, scrollToLine, updateSelection],
  );

  // 命中集合变了（改查询词 / 改文本）→ 把当前命中挪到光标最近的那个
  useEffect(() => {
    if (!searchOpen || !matches.length) return;
    const index = nextMatchIndex(matches, selectionRef.current.start, true);
    if (index >= 0) setMatchIndex(index);
  }, [matches, searchOpen]);

  // 当前命中变了 → 滚动过去；按钮 / 快捷键触发时顺带选中
  useEffect(() => {
    if (!searchOpen || !matches.length) return;
    const index = clampIndex(matchIndex, matches);
    if (index < 0) return;
    revealMatch(matches[index], selectOnRevealRef.current);
    selectOnRevealRef.current = false;
  }, [clampIndex, matchIndex, matches, revealMatch, searchOpen]);

  /** goToMatch 里要回调 revealMatch，用 ref 转发避免声明顺序与依赖抖动 */
  const revealMatchRef = useRef<((match: SearchMatch, select: boolean) => void) | null>(null);
  revealMatchRef.current = revealMatch;

  const goToMatch = useCallback((index: number, select: boolean) => {
    const list = matchesRef.current;
    if (!list.length || index < 0) return;
    selectOnRevealRef.current = select;
    if (index === matchIndexRef.current) {
      // 只有一个命中时下标不变，effect 不会触发，这里直接定位一次
      const current = list[clampIndex(index, list)];
      if (current) revealMatchRef.current?.(current, select);
      return;
    }
    setMatchIndex(index);
  }, []);

  const goNext = useCallback(() => {
    const list = matchesRef.current;
    if (!list.length) return;
    const current = list[clampIndex(matchIndexRef.current, list)];
    goToMatch(nextMatchIndex(list, current ? current.end : 0, config.search.loop), true);
  }, [clampIndex, config.search.loop, goToMatch]);

  const goPrev = useCallback(() => {
    const list = matchesRef.current;
    if (!list.length) return;
    const current = list[clampIndex(matchIndexRef.current, list)];
    goToMatch(prevMatchIndex(list, current ? current.start : 0, config.search.loop), true);
  }, [clampIndex, config.search.loop, goToMatch]);

  const replaceCurrent = useCallback(() => {
    if (readOnly) return;
    const list = matchesRef.current;
    const index = clampIndex(matchIndexRef.current, list);
    if (index < 0) return;
    const text = valueRef.current;
    const match = list[index];
    const replacement = expandReplacement(
      text.slice(match.start, match.end),
      searchQuery,
      searchReplace,
      searchOptions,
    );
    const result = replaceMatch(text, match, replacement);
    selectOnRevealRef.current = true;
    commitValue(result.text, result.caret, "search");
  }, [clampIndex, commitValue, readOnly, searchOptions, searchQuery, searchReplace]);

  const replaceAll = useCallback(() => {
    if (readOnly) return;
    const list = matchesRef.current;
    if (!list.length) return;
    const text = valueRef.current;
    const result = replaceAllMatches(text, list, (matched) =>
      expandReplacement(matched, searchQuery, searchReplace, searchOptions),
    );
    commitValue(result.text, result.caret, "search");
  }, [commitValue, readOnly, searchOptions, searchQuery, searchReplace]);

  const openSearch = useCallback(
    (query?: string, withReplace?: boolean) => {
      if (!config.search.enabled) return;
      if (query !== undefined) setSearchQuery(query);
      else if (config.search.seedFromSelection) {
        const { start, end } = selectionRef.current;
        const selected = valueRef.current.slice(start, end);
        if (selected && !selected.includes("\n") && selected.length < 200) setSearchQuery(selected);
      }
      // withReplace 省略时按配置走（Ctrl/⌘+F 传 false、Ctrl/⌘+H 传 true）
      const wantReplace = withReplace ?? config.search.showReplace;
      setSearchShowReplace(wantReplace);
      setSearchFocusToken((token) => token + 1);
      setSearchOpen(true);
    },
    [config.search.enabled, config.search.seedFromSelection, config.search.showReplace],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    sourceRef.current?.focus();
  }, []);

  goNextRef.current = goNext;
  goPrevRef.current = goPrev;
  openSearchRef.current = openSearch;
  closeSearchRef.current = closeSearch;

  /* ---------- 命令式 API ---------- */
  const apiRef = useRef<MarkdownEditorInstance | null>(null);
  const api: MarkdownEditorInstance = {
    focus: () => sourceRef.current?.focus(),
    blur: () => sourceRef.current?.blur(),
    getValue: () => valueRef.current,
    setValue: (next, options) => {
      valueRef.current = next;
      if (!isControlled) setInnerValue(next);
      if (options?.emitChange !== false) onChange?.(next, { source: "api", mode: modeRef.current });
    },
    insertText: (text, options) => insertMarkdown(text, options),
    getSelection: () => {
      const target = getTargetHandle();
      const state = target ? target.getState() : { text: valueRef.current, start: 0, end: 0 };
      return { start: state.start, end: state.end, text: state.text.slice(state.start, state.end) };
    },
    setSelection: (start, end = start) => {
      updateSelection(start, end);
      sourceRef.current?.setSelection(start, end);
    },
    getMode: () => modeRef.current,
    setMode: (next) => changeMode(next),
    getStats: () => statsRef.current,
    getOutline: () => docRef.current.outline,
    getDocument: () =>
      parseMarkdown(valueRef.current, { allowHtml: config.preview.allowHtml, breaks: config.preview.breaks }),
    runCommand: (name) => runToolbar(name),
    undo,
    redo,
    scrollToLine,
    toggleFullscreen,
    toggleOutline,
    openSearch,
    closeSearch,
  };
  apiRef.current = api;

  useImperativeHandle(ref, () => api, [api]);
  const readyRef = useRef(false);
  useEffect(() => {
    if (readyRef.current) return;
    readyRef.current = true;
    if (apiRef.current) onReady?.(apiRef.current);
  }, [onReady]);

  /**
   * 传给预览的两个回调要钉成恒定引用。
   *
   * 它们在预览 context 里，一旦每次渲染换新，两千多个块的 memo 就全废了；
   * 而宿主很可能是直接写 `onTaskToggle={(...) => ...}` 传进来的。
   * 这里用 ref 转发：引用恒定，调用的始终是最新的那个实现。
   */
  const linkClickRef = useRef(onLinkClick);
  linkClickRef.current = onLinkClick;
  const stableLinkClick = useCallback<NonNullable<typeof onLinkClick>>(
    (href, event) => linkClickRef.current?.(href, event),
    [],
  );

  const taskToggleRef = useRef(handleTaskToggle);
  taskToggleRef.current = handleTaskToggle;
  const stableTaskToggle = useCallback(
    (taskOffset: number, checked: boolean) => taskToggleRef.current(taskOffset, checked),
    [],
  );

  /* ---------- 工具栏状态 ---------- */
  /**
   * 内容没变时沿用上一次的对象引用。
   *
   * 工具栏按钮有几十个，每敲一个字都重渲染一次是笔不小的固定开销；而格式状态
   * 只有 9 个字段，绝大多数按键并不改变它（在普通段落里打字，九个字段全都不动）。
   * 这里做一次「值相等就复用旧引用」的收敛，配合 Toolbar 的 memo，
   * 打字路径上工具栏基本不再重渲染。
   */
  const formatsRef = useRef<ActiveFormats | null>(null);
  const formats = useMemo(() => {
    const next = detectFormats(value, selection.start, selection.end);
    const previous = formatsRef.current;
    if (
      previous &&
      previous.heading === next.heading &&
      previous.bold === next.bold &&
      previous.italic === next.italic &&
      previous.strike === next.strike &&
      previous.mark === next.mark &&
      previous.inlineCode === next.inlineCode &&
      previous.quote === next.quote &&
      previous.bulletList === next.bulletList &&
      previous.orderedList === next.orderedList &&
      previous.taskList === next.taskList
    ) {
      return previous;
    }
    formatsRef.current = next;
    return next;
  }, [value, selection]);

  const handleCustomTool = useCallback(
    (tool: MarkdownCustomTool) => {
      if (apiRef.current) tool.onClick(apiRef.current);
    },
    [],
  );

  const handleOutlineSelect = useCallback(
    (item: { line: number }) => scrollToLine(item.line),
    [scrollToLine],
  );

  /* ---------- 渲染 ---------- */
  /** 纯渲染模式：任何编辑器外壳都不出现，高度也交给内容决定 */
  const renderOnly = mode === "render";
  const rootStyle: CSSProperties = {
    ...themeVars,
    height: renderOnly ? "auto" : resolveHeight(height, "100%"),
    minHeight: renderOnly ? undefined : resolveHeight(minHeight, "320px"),
    maxHeight: renderOnly ? undefined : resolveHeight(maxHeight, "none"),
    ...style,
  };

  const previewVisible = mode === "split" || mode === "read" || renderOnly;
  const sourceVisible = mode === "split" || mode === "code";
  const chromeVisible = !renderOnly;

  return (
    <div
      ref={rootRef}
      className={`mde-root${fullscreen ? " is-fullscreen" : ""}${readOnly ? " is-readonly" : ""}${
        className ? ` ${className}` : ""
      }${config.theme.className ? ` ${config.theme.className}` : ""}`}
      style={rootStyle}
      data-theme={resolvedTheme}
      data-mode={mode}
      onKeyDownCapture={handleRootKeyDownCapture}
    >
      {config.toolbar.show && chromeVisible && (
        <Toolbar
          config={config}
          labels={labels}
          mode={mode}
          available={available}
          formats={formats}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          outlineOpen={outlineOpen}
          fullscreen={fullscreen}
          readOnly={readOnly}
          inactive={mode === "read"}
          themeVars={themeVars}
          resolvedTheme={resolvedTheme}
          onCommand={runToolbar}
          onHeading={applyHeadingLevel}
          onAlert={applyAlert}
          onCallout={applyCalloutBlock}
          onModeChange={changeMode}
          onToggleOutline={() => toggleOutline()}
          onToggleFullscreen={() => toggleFullscreen()}
          onCopyAll={copyAll}
          onCustomTool={handleCustomTool}
        />
      )}

      <div className="mde-body">
        {config.search.enabled && chromeVisible && searchOpen && (
          <SearchBox
            config={config}
            labels={labels}
            query={searchQuery}
            replaceText={searchReplace}
            options={searchOptions}
            showReplace={searchShowReplace}
            matchCount={matches.length}
            matchIndex={matchIndex}
            readOnly={readOnly}
            focusToken={searchFocusToken}
            onQueryChange={setSearchQuery}
            onReplaceChange={setSearchReplace}
            onOptionsChange={setSearchOptions}
            onToggleReplace={() => setSearchShowReplace((previous) => !previous)}
            onNext={goNext}
            onPrev={goPrev}
            onReplace={replaceCurrent}
            onReplaceAll={replaceAll}
            onClose={closeSearch}
          />
        )}

        {outlineOpen && chromeVisible && (
          <Outline
            items={doc.outline}
            config={config}
            labels={labels}
            activeLine={stats.cursor.line}
            onSelect={handleOutlineSelect}
          />
        )}

        <div
          className="mde-panes"
          style={mode === "split" ? { gridTemplateColumns: splitColumns(splitRatio, config.split) } : undefined}
        >
          {sourceVisible && (
            <SourceEditor
              ref={sourceRef}
              value={value}
              onChange={handleSourceChange}
              onSelectionChange={updateSelection}
              config={config}
              readOnly={readOnly}
              placeholder={placeholder ?? config.editor.placeholder}
              autoFocus={autoFocus}
              className={mode === "code" ? "is-code-only" : undefined}
              onKeyDown={handleShortcut}
              onImageFile={handleImageFile}
              onElement={handleSourceElement}
              matches={matches}
              matchIndex={matchIndex}
              highlightOnlyCurrent={!config.search.highlightAll}
            />
          )}

          {mode === "split" && config.split.resizable && (
            <div
              className="mde-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(event) => {
                event.preventDefault();
                const container = event.currentTarget.parentElement;
                if (!container) return;
                const rect = container.getBoundingClientRect();
                const width = Math.max(1, rect.width);
                const clamp = (value: number) => Math.min(0.8, Math.max(0.2, value));
                let ratio = splitRatio;
                /**
                 * 拖拽期间直接改容器样式，不走 state。
                 *
                 * 每次 pointermove 都 setSplitRatio 的话，整棵编辑器（连同预览那几百个块）
                 * 会跟着重渲染，拖动手感立刻变成幻灯片。这里改成只在松手时提交一次，
                 * 拖动过程纯粹是一次样式写入——合成器直接吃下，不掉帧。
                 */
                const move = (moveEvent: PointerEvent) => {
                  const next = clamp((moveEvent.clientX - rect.left) / width);
                  if (next === ratio) return;
                  ratio = next;
                  container.style.gridTemplateColumns = splitColumns(next, config.split);
                };
                const up = () => {
                  window.removeEventListener("pointermove", move);
                  window.removeEventListener("pointerup", up);
                  setSplitRatio(ratio);
                };
                window.addEventListener("pointermove", move);
                window.addEventListener("pointerup", up);
              }}
            />
          )}

          {previewVisible && (
            <div className="mde-preview-pane" ref={previewRef}>
              <MarkdownPreview
                doc={doc}
                config={config}
                labels={labels}
                readOnly={readOnly}
                onLinkClick={stableLinkClick}
                onTaskToggle={stableTaskToggle}
              />
            </div>
          )}

        </div>
      </div>

      {config.statusBar.show && chromeVisible && (
        <StatusBar config={config} labels={labels} stats={stats} mode={mode} />
      )}
    </div>
  );
});

MarkdownEditor.displayName = "MarkdownEditor";
