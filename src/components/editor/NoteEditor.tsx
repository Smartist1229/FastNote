/**
 * 笔记编辑器：标题输入 + 自研 Markdown 编辑器正文 + 状态栏/工具栏。
 *
 * 保存链路：编辑 → scheduleSave（500ms 防抖）→ saveNow → onSave 写库；
 * 外部文件模式改走 onSaveExternal 直接写回磁盘，临时预览（AI 回复）永不落库。
 * 防抖与保存状态都由 ref 承载；saveNow 仅依赖保存回调、通知和当前语言，不依赖正文。
 * 输入法组合期间（compositionstart → end）不排保存，结束后统一补一次。
 *
 * 编辑器（src/markdown-editor）是受控的：内容与模式都由这里持有，
 * 配色由 config/markdownEditor.ts 从软件主题令牌换算后注入，跟随设置与主题实时变化。
 */
import { useI18n } from "@/i18n";
import { lazy, Suspense, useState, useEffect, useLayoutEffect, useMemo, useRef, useCallback } from "react";
import type { NoteEditorProps, NoteEditorActions } from "@/interface/note/editor";
import type { MarkdownEditorInstance, MarkdownEditorMode } from "@/markdown-editor";
import { buildNoteEditorConfig } from "@/config/editor/markdownEditor";
import { FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_EDITOR_SETTINGS } from "@/config/app/appDefaults";
import { openExternalLink } from "@/lib/app/externalLink";
import { saveNoteAsFile } from "@/lib/note/noteFileExport";
import { saveAttachment } from "@/api/system/attachments";
import { cacheImageSize } from "@/lib/markdown/imageSrc";
import { useAttachmentImages } from "@/hooks/useAttachmentImages";
import { useToast } from "@/components/common/Toast";
import { useShortcutAction } from "@/features/shortcuts/useShortcutAction";
import { AiSparkleIcon } from "@/components/common/icons";
import { Icon } from "@/components/common/Icon";
import { useActiveThemeTokens, useResolvedThemeMode } from "@/lib/theme/themeRuntime";
import { pluginContributions, usePluginContributions, type PluginEditorToolbarEntry } from "@/plugins/contributions";
import { pluginHost } from "@/plugins/host";
import type { EditorToolbarContext } from "@/plugins/types";

/** 按需加载：编辑器带解析器与样式，首屏不必打包进来 */
const MarkdownEditor = lazy(() =>
  import("@/markdown-editor").then((module) => ({ default: module.MarkdownEditor })),
);

/** 编辑器正文字号的兜底值（设置在读取失败时使用） */
const FONT_SIZE_FALLBACK = DEFAULT_EDITOR_SETTINGS.fontSize;

/**
 * 底部统计（非空白字符数 / 行数）。
 *
 * 百万字文档上 `replace(/\s/g)` + `split("\n")` 是十几毫秒的全文扫描，
 * 不能跟着每个按键跑：这里按 250ms 防抖算一次，输入过程中数字保持上一次的值。
 */
const countContent = (text: string): { chars: number; lines: number } => ({
  chars: text ? text.replace(/\s/g, "").length : 0,
  lines: text ? text.split("\n").length : 0,
});

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  editable = true,
  historyPreview,
  onSave,
  onDelete,
  onCursorOffsetChange,
  editorSettings,
  shortcutBindings,
  onToggleAiPanel,
  isAiPanelOpen = false,
  isTemporary = false,
  onCloseTemporary,
  categories = [],
  onSaveToCategory,
  onRegisterExport,
  externalFilePath = null,
  onSaveExternal,
  onSaveExternalToNote,
  onCloseExternal,
  onRegisterFlushExternal,
  onRegisterActions,
  enableAI,
}) => {
  const { locale, t } = useI18n();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [contentCounts, setContentCounts] = useState(() => countContent(""));
  useEffect(() => {
    const timer = window.setTimeout(() => setContentCounts(countContent(content)), 250);
    return () => window.clearTimeout(timer);
  }, [content]);
  /** 由 externalFilePath 派生：该模式下标题只读、内容写回原文件而不写库 */
  const isExternal = externalFilePath != null;
  /** 只读：外部文件模式的标题、历史版本预览，或宿主显式关闭编辑 */
  const isReadOnly = !editable || isExternal;
  /** 输入法组合中：拼音等未上屏的中间态不该触发保存 */
  const isComposingRef = useRef(false);
  /** 当前明暗模式与主题令牌：编辑器的配色由这两者换算，它不会自己去读 CSS 变量 */
  const resolvedThemeMode = useResolvedThemeMode();
  const themeTokens = useActiveThemeTokens();
  /** 编辑器设置：缺键回退到默认配置（老版本库里可能没存新增字段） */
  const settings = editorSettings ?? DEFAULT_EDITOR_SETTINGS;
  /**
   * 视图模式：由这里受控持有。
   * 设置里改默认视图会同步到已打开的编辑器，用户手动切换也保留在本次会话里。
   */
  const [mode, setMode] = useState<MarkdownEditorMode>(settings.defaultMode);
  useEffect(() => {
    setMode(settings.defaultMode);
  }, [settings.defaultMode]);
  const lastNoteIdRef = useRef<string | null>(null);
  /** note 的镜像：命令式动作（如回滚前丢弃草稿）要读当前内容，但不能进 effect 依赖 */
  const noteRef = useRef(note);
  useEffect(() => {
    noteRef.current = note;
  }, [note]);
  /** 标题/正文/分组的最新值镜像：saveNow 读 ref，避免闭包拿到上一轮 state */
  const latestTitleRef = useRef("");
  const latestContentRef = useRef("");
  const latestCategoryIdRef = useRef<string | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  /** 保存状态机：isSaving 串行化写库；hasPendingSave 表示写入期间又改了，写完要补一轮 */
  const isSavingRef = useRef(false);
  const hasPendingSaveRef = useRef(false);
  /** 与上次落盘的内容是否有差异（决定是否真的调 onSave） */
  const hasUnsavedChangesRef = useRef(false);
  /**
   * 切走时排队补写的快照（按笔记 id）。
   *
   * 补写要排在正在进行的写库之后，是个异步窗口：这期间切回来，宿主手里的
   * `note.content` 可能还是补写前的旧值。直接采用会把刚打的字回填掉，编辑器
   * 的受控 value 一变，光标就掉回文首。只要快照还没落库，切换与同步都以它为准。
   */
  const pendingWritesRef = useRef(
    new Map<string, { title: string; content: string; categoryId: string | null }>(),
  );
  /** 防抖计时器 id；切笔记时清掉，防止把旧笔记内容写进新笔记 */
  const saveTimerRef = useRef<number | null>(null);
  const currentNoteIdRef = useRef<string | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  /** 外部文件写回失败标记：顶部提示条显示「保存失败」 */
  const [saveError, setSaveError] = useState(false);
  const { showToast } = useToast();
  /** 设置里的默认字号：Ctrl/⌘ + 0 与工具栏的字号按钮都还原到它 */
  const defaultFontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, settings.fontSize ?? FONT_SIZE_FALLBACK),
  );
  /** 缩放出来的临时字号；null 表示当前就是设置的默认字号 */
  const [fontSizeOverride, setFontSizeOverride] = useState<number | null>(null);
  const editorFontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, fontSizeOverride ?? defaultFontSize),
  );

  // 设置里改了默认字号时，放弃临时缩放值，直接采用新的默认字号
  useEffect(() => {
    setFontSizeOverride(null);
  }, [defaultFontSize]);

  /**
   * 字号缩放由编辑器自己做（Ctrl/⌘ + 滚轮、Ctrl/⌘ + = / - / 0）：
   * 这里只接住结果，不写设置——缩放是临时的，点工具栏的字号按钮或按 Ctrl+0 回到默认。
   */
  const handleFontSizeChange = useCallback((size: number | null) => {
    setFontSizeOverride(size === defaultFontSize ? null : size);
  }, [defaultFontSize]);

  /**
   * 编辑器配置：行为来自软件设置的「编辑器」分区，配色由当前主题令牌换算。
   * 设置整对象进依赖：任一改动都会重建配置并即时生效（编辑器内部按 config 深合并）。
   */
  const editorConfig = useMemo(
    () =>
      buildNoteEditorConfig(
        settings,
        themeTokens,
        resolvedThemeMode,
        editorFontSize,
        locale,
        shortcutBindings,
      ),
    [settings, themeTokens, resolvedThemeMode, editorFontSize, locale, shortcutBindings],
  );
  /** 用 ref 承载临时标记，避免它进入 saveNow 的依赖链 */
  const isTemporaryRef = useRef(false);
  useEffect(() => {
    isTemporaryRef.current = isTemporary;
  }, [isTemporary]);

  /** 用 ref 承载「外部文件模式」与写回回调，避免它们进入 saveNow 的依赖链 */
  const isExternalRef = useRef(false);
  const onSaveExternalRef = useRef<((content: string) => Promise<void>) | undefined>(undefined);
  useEffect(() => {
    isExternalRef.current = isExternal;
    onSaveExternalRef.current = onSaveExternal;
    if (isExternal) setSaveError(false);
  }, [isExternal, onSaveExternal]);

  /** 临时预览的「保存到分组」下拉菜单 */
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [isSavingToCategory, setIsSavingToCategory] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);
  /** 插件工具栏横向滚动容器：滚轮转横向要挂原生非 passive 监听 */
  const pluginBarRef = useRef<HTMLDivElement>(null);

  /** 临时预览 / 电脑文件另存为真实笔记：取编辑器里当前（可能改过）的标题与内容 */
  const handleSaveToCategory = async (categoryId: string | null) => {
    const saver = isExternal ? onSaveExternalToNote : onSaveToCategory;
    if (!saver || isSavingToCategory) return;
    setIsSavingToCategory(true);
    try {
      await saver(categoryId, latestTitleRef.current, latestContentRef.current);
    } finally {
      setIsSavingToCategory(false);
      setSaveMenuOpen(false);
    }
  };

  /** 另存为文件（Ctrl+S / 工具栏 / 侧边栏右键共用）；用户取消保存时静默返回，不提示成功 */
  const handleExport = useCallback(async () => {
    if (!note) return;
    // 加密笔记的明文只存在于本次解锁期间，不允许落成外部文件
    if (note.enc_mode !== 0) {
      showToast(t("加密笔记不支持导出，请先永久解密"), "error");
      return;
    }
    try {
      if (await saveNoteAsFile(title, content)) {
        showToast(t("导出成功！"), "success");
      }
    } catch (error) {
      console.error("导出失败:", error);
      showToast(t("导出失败，请重试"), "error");
    }
  }, [note, title, content, showToast, t]);

  // 把「保存笔记到文件」交给外部调用（侧边栏笔记右键菜单）
  useEffect(() => {
    onRegisterExport?.(handleExport);
    return () => onRegisterExport?.(null);
  }, [onRegisterExport, handleExport]);

  /**
   * 编辑器实例：命令面板的「切换视图 / 全屏 / 查找」通过它执行。
   * 编辑器是懒加载的，`onReady` 之前 ref 为空——动作里每次现取 ref，
   * 所以注册得早也没关系，调用时拿不到就当没这个命令。
   */
  const editorApiRef = useRef<MarkdownEditorInstance | null>(null);
  const handleEditorReady = useCallback((api: MarkdownEditorInstance) => {
    editorApiRef.current = api;
  }, []);
  useEffect(() => {
    const actions: NoteEditorActions = {
      setMode: (next) => editorApiRef.current?.setMode(next),
      toggleFullscreen: () => editorApiRef.current?.toggleFullscreen(),
      openSearch: (withReplace) => editorApiRef.current?.openSearch(undefined, withReplace),
      focus: () => editorApiRef.current?.focus(),
      discardPendingEdits: () => {
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        hasUnsavedChangesRef.current = false;
        hasPendingSaveRef.current = false;
        const current = noteRef.current;
        if (current) {
          setTitle(current.title);
          setContent(current.content);
          latestTitleRef.current = current.title;
          latestContentRef.current = current.content;
          latestCategoryIdRef.current = current.category_id;
          setLastSavedAt(current.updated_at);
        }
      },
    };
    onRegisterActions?.(actions);
    // 注意：这里不能把 editorApiRef 置空。
    // StrictMode / 组件重挂载会执行一次 cleanup 再重新挂载 effect，而 MarkdownEditor 的
    // onReady 有一次性守卫，不会再次回调，置空会让 api 永久丢失，插件工具栏点插入时
    // 就会一直判为「编辑器未就绪」。真正的 api 生命周期由 MarkdownEditor 自身管理。
    return () => {
      onRegisterActions?.(null);
    };
  }, [onRegisterActions]);

  const handleCopyContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      showToast(t("内容已复制到剪贴板"), "success");
    } catch (err) {
      console.error("复制失败:", err);
      showToast(t("复制失败"), "error");
    }
  }, [content, showToast, t]);

  /** onSave 的 ref 镜像：切换笔记时的补写不能进 effect 依赖，否则每次渲染都会重跑切换逻辑 */
  const onSaveRef = useRef(onSave);
  useEffect(() => { onSaveRef.current = onSave; }, [onSave]);

  /**
   * 切换笔记前，把防抖窗口里还没落盘的输入补写一次。
   * 不补写的话，最后一次输入后 500ms 内切走会丢掉这几个字（外部文件模式另有 flush 回调，
   * 普通笔记走这里）。写入排在进行中的保存之后，避免"旧内容后写"覆盖这次的新内容。
   * 只处理真实笔记：临时预览与电脑文件用伪 id 前缀（temp:/external:），本来就不落库。
   */
  const flushPendingSave = (noteId: string | null) => {
    if (noteId === null || noteId.startsWith("temp:") || noteId.startsWith("external:")) return;
    if (!hasUnsavedChangesRef.current) return;
    const snapshot = {
      title: latestTitleRef.current,
      content: latestContentRef.current,
      categoryId: latestCategoryIdRef.current,
    };
    const pending = pendingWritesRef.current;
    pending.set(noteId, snapshot);
    hasUnsavedChangesRef.current = false;
    const write = async () => {
      // 最多等 2s：正常写库是毫秒级，超时就按顺序直接写，不让切换卡死
      const deadline = Date.now() + 2000;
      while (isSavingRef.current && Date.now() < deadline) {
        await new Promise((resolve) => window.setTimeout(resolve, 15));
      }
      await onSaveRef.current(noteId, snapshot.title, snapshot.content, snapshot.categoryId);
    };
    void write().then(
      () => {
        // 期间又排了更新的快照就留着它，别把新的删掉
        if (pending.get(noteId) === snapshot) pending.delete(noteId);
      },
      (error) => {
        // 快照保留：宿主手里的旧内容不能拿来覆盖这次没写进去的输入
        console.error("切换笔记前保存失败:", error);
        showToast(t("保存失败，请重试"), "error");
      },
    );
  };

  /**
   * 保持编辑器在宿主 UI 交互时不失焦：在 mousedown 的默认行为触发 blur 之前，
   * 用捕获阶段拦截点击——若目标属于宿主自定义 UI（带 data-editor-blur-ignore="true"），
   * 立即 preventDefault 阻止原生失焦，并同步 refocus，让插件 insertText 依赖的
   * selection 始终留在 contenteditable 内部。
   *
   * 只认 data 属性标记，NoteEditor 不需要知道宿主有哪些 UI——解耦。
   * 配置 keepFocusOnHostClick = false 时完全不注册，点击宿主 UI 编辑器正常失焦。
   */
  const keepFocusOnHostClick = settings.keepFocusOnHostClick !== false;
  useLayoutEffect(() => {
    if (!keepFocusOnHostClick) return;
    const handler = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[data-editor-blur-ignore="true"]')) {
        e.preventDefault();
        editorApiRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", handler, true);
    return () => document.removeEventListener("mousedown", handler, true);
  }, [keepFocusOnHostClick]);

  /**
   * 切换笔记：整块重置本地状态、脏标记与防抖计时器，避免串稿；
   * 同一 id 的内容更新不在这里处理，交给下面的同步 effect。
   *
   * 必须是 useLayoutEffect：普通 effect 在首帧画完之后才跑，
   * 换笔记时会先拿上一篇的内容画一帧，看起来就是整块闪一下。
   */
  useLayoutEffect(() => {
    if (note) {
      if (lastNoteIdRef.current !== note.id) {
        const oldId = lastNoteIdRef.current;
        // 先把上一篇没存完的输入补写掉，再切换（用切换前的 id，不能用 note.id）
        flushPendingSave(lastNoteIdRef.current);
        // 显式 blur：清掉旧光标，避免切到新笔记后 selection 还残留在旧位置
        editorApiRef.current?.blur();
        currentNoteIdRef.current = note.id;
        /*
         * 这篇上次切走时还有补写没落库：宿主手里的 note 是补写前的旧值，
         * 用快照顶上，否则刚打的字会被旧内容回填、光标跟着掉回文首。
         */
        const pending = pendingWritesRef.current.get(note.id);
        const initialTitle = pending?.title ?? note.title;
        const initialContent = pending?.content ?? note.content;
        setTitle(initialTitle);
        setContent(initialContent);
        latestTitleRef.current = initialTitle;
        latestContentRef.current = initialContent;
        latestCategoryIdRef.current = pending ? pending.categoryId : note.category_id;
        lastNoteIdRef.current = note.id;
        hasUnsavedChangesRef.current = false;
        hasPendingSaveRef.current = false;
        setLastSavedAt(note.updated_at);
        setSaveError(false);
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        // 内容更新完后 rAF refocus 到新笔记，让 selection 回到文首
        requestAnimationFrame(() => editorApiRef.current?.focus());
        void pluginContributions.emitHook("note-switch", { oldNoteId: oldId, newNoteId: note.id });
      }
    } else {
      // 关闭笔记（note 变 null）也要把未落盘的输入补写掉
      const oldId = lastNoteIdRef.current;
      flushPendingSave(lastNoteIdRef.current);
      currentNoteIdRef.current = null;
      setTitle("");
      setContent("");
      latestTitleRef.current = "";
      latestContentRef.current = "";
      latestCategoryIdRef.current = null;
      lastNoteIdRef.current = null;
      if (oldId !== null) {
        void pluginContributions.emitHook("note-switch", { oldNoteId: oldId, newNoteId: null });
      }
    }
  }, [note, t]);

  /**
   * 同一篇笔记被外部改写时（如列表刷新回来的数据）同步进编辑器；
   * 本地有未保存改动就不覆盖，否则用户的输入会被旧数据冲掉。
   * 切走时排队的补写没落库前，宿主的数据也可能比它旧，同样不能覆盖。
   */
  useEffect(() => {
    if (!note || lastNoteIdRef.current !== note.id) return;
    if (pendingWritesRef.current.has(note.id) || hasUnsavedChangesRef.current) return;
    if (note.title !== latestTitleRef.current) {
      setTitle(note.title);
      latestTitleRef.current = note.title;
    }
    if (note.content !== latestContentRef.current) {
      setContent(note.content);
      latestContentRef.current = note.content;
      onCursorOffsetChange?.(note.content.length);
    }
  }, [note?.title, note?.content, note?.id, onCursorOffsetChange]);

  /**
   * 保存：走宿主的 `app.save` 动作（默认 mod+s，可在设置里改）。
   * 不再自己挂 window keydown —— 那样改键位对它无效，也会和插件抢同一个键。
   * 外部文件模式立即写回磁盘，普通笔记走导出/保存链路。
   */
  useShortcutAction("app.save", () => {
    if (isExternalRef.current) void saveNowRef.current();
    else void handleExport();
  });

  /**
   * 立即落盘，两条分支：
   * - 电脑文件：写回原文件，失败置 saveError 由顶部提示条展示；
   * - 普通笔记：onSave 写库，保存期间切换了笔记就收手，由末尾重新触发一次针对新笔记的保存。
   * 用 do/while + hasPendingSave 串行化，避免慢写入期间的新改动被后一次保存覆盖。
   */
  const saveNow = useCallback(async () => {
    // 临时预览（AI 回复）永不落库
    if (isTemporaryRef.current) return;
    // 外部文件模式：把内容写回电脑上的原文件，不落库
    if (isExternalRef.current) {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (isComposingRef.current || isSavingRef.current) {
        hasPendingSaveRef.current = true;
        return;
      }
      if (!hasUnsavedChangesRef.current) return;
      isSavingRef.current = true;
      try {
        do {
          hasPendingSaveRef.current = false;
          const savedContent = latestContentRef.current;
          await onSaveExternalRef.current?.(savedContent);
          // 写入期间又敲了字：脏标记不能被这次（旧快照的）写入清掉，否则丢字
          if (latestContentRef.current !== savedContent) hasPendingSaveRef.current = true;
          if (!hasPendingSaveRef.current) {
            hasUnsavedChangesRef.current = false;
            setLastSavedAt(new Date().toISOString());
            setSaveError(false);
          }
        } while (hasPendingSaveRef.current);
      } catch (error) {
        console.error("写入电脑文件失败:", error);
        setSaveError(true);
      } finally {
        isSavingRef.current = false;
      }
      return;
    }
    const savingNoteId = currentNoteIdRef.current;
    if (!savingNoteId || !hasUnsavedChangesRef.current) return;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (isComposingRef.current) {
      hasPendingSaveRef.current = true;
      return;
    }
    if (isSavingRef.current) {
      hasPendingSaveRef.current = true;
      return;
    }
    isSavingRef.current = true;
    try {
      do {
        hasPendingSaveRef.current = false;
        const savedTitle = latestTitleRef.current;
        const savedContent = latestContentRef.current;
        const savedCategoryId = latestCategoryIdRef.current;
        await onSave(savingNoteId, savedTitle, savedContent, savedCategoryId);
        /*
         * 写入期间又改了内容：这次写进去的是旧快照，脏标记不能清。
         * 否则宿主把旧内容回声进 note 时，下面的同步 effect 会拿旧文本覆盖新输入，
         * 编辑器的受控 value 一缩，光标就跟着掉回文首。
         */
        if (
          latestTitleRef.current !== savedTitle ||
          latestContentRef.current !== savedContent ||
          latestCategoryIdRef.current !== savedCategoryId
        ) {
          hasPendingSaveRef.current = true;
        }
        if (!hasPendingSaveRef.current) {
          hasUnsavedChangesRef.current = false;
          pendingWritesRef.current.delete(savingNoteId);
          const savedAt = new Date().toISOString();
          setLastSavedAt(savedAt);
          void pluginContributions.emitHook("note-save", {
            noteId: savingNoteId,
            content: savedContent,
            savedAt,
          });
        }
      } while (hasPendingSaveRef.current && currentNoteIdRef.current === savingNoteId);
    } catch (error) {
      // 写库失败：保留脏标记，下次输入或切笔记时会再试一次；同时必须提示，否则用户以为已保存
      hasUnsavedChangesRef.current = true;
      console.error("保存笔记失败:", error);
      showToast(t("保存失败，请重试"), "error");
    } finally {
      isSavingRef.current = false;
    }
    if (hasPendingSaveRef.current && currentNoteIdRef.current !== savingNoteId) {
      void saveNow();
    }
  }, [onSave, showToast, t]);

  /** saveNow 的 ref：供 keydown 在定义顺序更早的位置调用 */
  const saveNowRef = useRef<() => void>(() => {});
  useEffect(() => { saveNowRef.current = saveNow; }, [saveNow]);

  /** 把「立即写回电脑文件」交给外部（切换/关闭文件前 flush） */
  useEffect(() => {
    onRegisterFlushExternal?.(() => {
      if (isExternalRef.current && hasUnsavedChangesRef.current) void saveNow();
    });
    return () => onRegisterFlushExternal?.(null);
  }, [onRegisterFlushExternal, saveNow]);

  /** 500ms 防抖：连续输入只在停手后落盘一次，重排计时器保证以最后一次输入为准 */
  const scheduleSave = useCallback(() => {
    hasUnsavedChangesRef.current = true;
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow();
    }, 500);
  }, [saveNow]);

  const handleTitleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTitle = e.target.value;
    setTitle(newTitle);
    latestTitleRef.current = newTitle;
    if (!isComposingRef.current) scheduleSave();
  };

  const handleContentChange = (value: string) => {
    const newContent = value || "";
    // 编辑器把外部传入的 value 同步回去时也会回调一次 onChange，这不是用户编辑；
    // 与最新值比较即可过滤掉这类回填，否则一打开笔记就会被标记「编辑中」并白白保存一次。
    if (newContent === latestContentRef.current) return;
    setContent(newContent);
    latestContentRef.current = newContent;
    // 编辑器内部光标位置不透出给外部，插入/AI 引用统一以文末作为锚点
    onCursorOffsetChange?.(newContent.length);
    if (!isComposingRef.current) scheduleSave();
  };

  const handleCompositionStart = () => {
    isComposingRef.current = true;
  };
  const handleCompositionEnd = () => {
    isComposingRef.current = false;
    scheduleSave();
  };

  /**
   * 粘贴 / 拖入的图片：落盘成内容寻址附件，返回相对路径。
   *
   * 编辑器拿到返回值后自己插入 `![alt](path)`，所以这里只负责存盘与报错。
   * 尺寸先写进内存缓存：刚贴进来的图立刻能按比例占位，不用等第二次渲染。
   */
  const handleImagePaste = useCallback(
    async (file: File): Promise<string | null> => {
      if (isReadOnly) return null;
      try {
        const meta = await saveAttachment(file);
        cacheImageSize(meta.path, meta.width, meta.height);
        return meta.path;
      } catch (e) {
        showToast(
          t("图片保存失败：{value1}", { value1: e instanceof Error ? e.message : String(e) }),
          "error",
        );
        return null;
      }
    },
    [isReadOnly, showToast, t],
  );

  /** 预览/阅读态把 attachments/… 换成 fastnote-asset://…，并按已知宽高提前占位 */
  const resolveImage = useAttachmentImages(content);

  const wordCount = contentCounts.chars;
  const lineCount = contentCounts.lines;
  /** 已保存时间戳只显示 时:分；非法日期返回空串（new Date 不抛错，必须显式判断 Invalid Date） */
  const formatSavedTime = (value: string | null) => {
    if (!value) return "";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  };

  /** 外部文件写回状态（顶部提示条用） */
  const externalStatus = saveError
    ? { text: t("保存失败"), cls: "text-danger" }
    : hasUnsavedChangesRef.current
    ? { text: t("保存中…"), cls: "text-info" }
    : lastSavedAt
    ? { text: t("已保存 {time}", { time: formatSavedTime(lastSavedAt) }), cls: "text-success" }
    : null;

  /**
   * 插件工具栏：订阅贡献版本号（number 快照，避免 getSnapshot 每次返回新数组导致无限重渲染）。
   * 版本或笔记状态变化时重新按 when 过滤；insertText 走编辑器实例 API，
   * 编辑器懒加载未就绪或只读时返回 false（不改 markdown-editor 模块）。
   */
  const contributions = usePluginContributions();
  const insertIntoEditor = useCallback(
    (text: string): boolean => {
      if (isReadOnly) return false;
      const api = editorApiRef.current;
      if (!api) return false;
      api.insertText(text);
      return true;
    },
    [isReadOnly],
  );
  const editorToolbarContext = useMemo<EditorToolbarContext>(
    () => ({
      noteId: note?.id ?? null,
      title,
      content,
      mode,
      insertText: insertIntoEditor,
    }),
    [note?.id, title, content, mode, insertIntoEditor],
  );
  const editorToolbarItems = useMemo(
    () => contributions.editorToolbar(editorToolbarContext),
    [editorToolbarContext, contributions],
  );
  /**
   * 插件工具栏横向滚轮：React 的 onWheel 走 passive 监听，preventDefault 无效，只能挂原生。
   * 没有横向溢出、或已经滚到两端时不拦截，滚轮继续交给外层页面。
   */
  useEffect(() => {
    const el = pluginBarRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // 触控板横向手势（deltaY 为 0）保持原生行为
      if (event.deltaY === 0) return;
      const max = el.scrollWidth - el.clientWidth;
      if (max <= 0) return;
      const next = el.scrollLeft + (event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY);
      if (next <= 0 || next >= max) return;
      event.preventDefault();
      el.scrollLeft = next;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [editorToolbarItems.length]);
  /** 插件工具栏按钮：同步异常与异步 reject 都只记日志，不影响编辑器 */
  const runEditorToolbarItem = (item: PluginEditorToolbarEntry): void => {
    try {
      void Promise.resolve(item.onClick(pluginHost.createPluginContext(item.pluginId))).catch((e) =>
        console.error("插件工具栏按钮执行失败：", e),
      );
    } catch (e) {
      console.error("插件工具栏按钮执行失败：", e);
    }
  };

  if (!note) {
    return (
      <div className="h-full flex items-center justify-center text-faint text-sm">
        <p>{t("选择一个笔记或创建新笔记")}</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* 历史版本预览：只读叠层，回滚与退出都放在这条提示里 */}
      {historyPreview && (
        <div className="px-4 py-2 bg-info-soft/70 border-b border-info-line flex items-center justify-between gap-2 flex-shrink-0">
          <span className="text-[11px] text-info-deep truncate">
            {t("历史版本预览 · {time} · 内容只读，不会保存", { time: historyPreview.savedAt })}
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              onClick={historyPreview.onRollback}
              title={t("恢复此版本，并删除它及之后的所有历史版本")}
              className="text-[11px] px-2 py-0.5 rounded-md text-on-accent bg-primary-500 hover:bg-primary-600 transition-colors"
            >
              {t("回滚到此版本")}
            </button>
            <button
              onClick={historyPreview.onExit}
              className="text-[11px] px-2 py-0.5 rounded-md text-info-deep hover:bg-info-soft transition-colors"
            >
              {t("退出预览")}
            </button>
          </div>
        </div>
      )}
      {isTemporary && (
        <div className="px-4 py-2 bg-warning-soft/70 border-b border-warning-line flex items-center justify-between flex-shrink-0">
          <span className="text-[11px] text-warning-deep">{t("临时预览 · 来自 AI 回复，不会保存为笔记")}</span>
          <button
            onClick={onCloseTemporary}
            className="text-[11px] px-2 py-0.5 rounded-md text-warning-deep hover:bg-warning-soft transition-colors"
          >
            {t("关闭")}
          </button>
        </div>
      )}
      {/* 电脑文件提示条：说明正在编辑本机文件、编辑会实时写回 */}
      {isExternal && (
        <div className="px-4 py-2 bg-info-soft/70 border-b border-info-line flex items-center justify-between gap-2 flex-shrink-0">
          <div className="flex items-center gap-1 min-w-0">
            <Icon name="ai-file-text" className="w-3.5 h-3.5 text-info flex-shrink-0" />
            <span className="text-[11px] text-info-deep truncate" title={externalFilePath ?? undefined}>
              {t("正在编辑电脑文件")}
            </span>
            {externalStatus && (
              <span className={`text-[11px] flex-shrink-0 ${externalStatus.cls}`}>· {externalStatus.text}</span>
            )}
            {enableAI && (
              <span className="text-[11px] text-faint truncate" title={t("AI 无法读取内容，请保存到分组")}>
                {t("AI 无法读取该内容，请先保存到分组。")}
              </span>
            )}
          </div>
          <button
            onClick={onCloseExternal}
            className="text-[11px] px-1.5 py-0.5 rounded-md text-info-deep hover:bg-info-soft transition-colors"
          >
            {t("关闭")}
          </button>
        </div>
      )}
      {/* 标题栏 */}
      <div className="px-4 py-3 flex-shrink-0">
        <div className="flex items-center gap-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={handleTitleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            readOnly={isReadOnly}
            placeholder={t("输入笔记标题...")}
            title={
              historyPreview
                ? t("历史版本预览不可编辑")
                : isExternal
                  ? t("标题即电脑上的文件名，不可修改")
                  : undefined
            }
            className="title-input flex-1 px-4 py-2.5 text-lg font-semibold text-ink placeholder:text-faint bg-transparent"
          />
          {!isTemporary && !isExternal && !historyPreview && (
            <button
              onClick={onDelete}
              className="toolbar-btn hover:bg-danger-soft! hover:text-danger!"
              title={t("删除笔记")}
            >
              <Icon name="editor-trash" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 工具栏 */}
      <div data-editor-blur-ignore="true" className="px-4 py-1.5 border-b border-line-soft/80 flex-shrink-0 bg-app/50">
        <div className="flex items-center gap-2 min-w-0">
          {/* ① 固定左组：保存状态 + AI + 导出 + 复制，永不滚动 */}
          <div className="flex items-center gap-1 shrink-0">
            {/* 保存状态：临时预览 / 电脑文件模式下换成「保存到分组」按钮 */}
            <div className="flex items-center gap-1.5 text-xs text-faint">
              {isTemporary || isExternal ? (
                (isExternal ? onSaveExternalToNote : onSaveToCategory) && (
                  <div className="relative" ref={saveMenuRef}>
                    <button
                      onClick={() => setSaveMenuOpen((open) => !open)}
                      disabled={isSavingToCategory}
                      className={`flex items-center justify-center p-1.5 rounded-md transition-colors disabled:opacity-50 ${
                        saveMenuOpen
                          ? "bg-primary-50 text-primary-500"
                          : "text-muted hover:bg-surface-alt hover:text-body"
                      }`}
                      title={isSavingToCategory ? t("保存中...") : t("保存到分组")}
                    >
                      <Icon name="editor-save-to-group" className="w-3.5 h-3.5" />
                    </button>
                    {saveMenuOpen && (
                      <div className="absolute left-0 top-full mt-1 z-30 w-44 max-h-60 overflow-y-auto py-1 bg-surface border border-line rounded-lg shadow-lg">
                        <button
                          onClick={() => handleSaveToCategory(null)}
                          className="w-full text-left px-3 py-1.5 text-[12px] text-body hover:bg-app transition-colors"
                        >
                          {t("未分组")}
                        </button>
                        {categories.map((category) => (
                          <button
                            key={category.id}
                            onClick={() => handleSaveToCategory(category.id)}
                            className="w-full text-left px-3 py-1.5 text-[12px] text-body hover:bg-app transition-colors truncate"
                            title={category.name}
                          >
                            {category.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              ) : hasUnsavedChangesRef.current ? (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-warning-soft text-warning">
                  <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse-dot" />
                  <span className="text-[11px] font-medium">{t("编辑中")}</span>
                </span>
              ) : lastSavedAt ? (
                <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-faint">
                  <Icon name="editor-check" className="w-3 h-3 text-success" />
                  <span className="text-[11px]">{formatSavedTime(lastSavedAt)}</span>
                </span>
              ) : null}
            </div>

            {/* AI 对话：关闭 AI 能力时连同前面的分隔线一起隐藏，避免留下一条多余的竖线 */}
            {onToggleAiPanel && (
              <>
                <div className="divider" />
                <button
                  onClick={onToggleAiPanel}
                  className={`toolbar-btn relative ${isAiPanelOpen ? "bg-primary-50! text-primary-500!" : ""}`}
                  title={isAiPanelOpen ? t("关闭 AI 对话") : t("打开 AI 对话")}
                  aria-pressed={isAiPanelOpen}
                >
                  <AiSparkleIcon className="w-4 h-4" />
                  {isAiPanelOpen && (
                    <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary-500" />
                  )}
                </button>
              </>
            )}

            <div className="divider" />

            {/* 导出（电脑文件模式下内容本就写回原文件，无需再导出） */}
            {!isExternal && (
              <button
                onClick={handleExport}
                className="toolbar-btn"
                title={t("导出笔记 (Ctrl+S)")}
              >
                <Icon name="editor-export" className="w-4 h-4" />
              </button>
            )}

            {/* 复制 */}
            <button
              onClick={handleCopyContent}
              className="toolbar-btn"
              title={t("复制内容")}
            >
              <Icon name="editor-copy" className="w-4 h-4" />
            </button>
          </div>

          {/* ② 插件滚动区：横向溢出时滚轮转横向，条本身随时可隐藏 */}
          {editorToolbarItems.length > 0 ? (
            <div
              ref={pluginBarRef}
              className="flex items-center gap-1 min-w-0 flex-1 overflow-x-auto no-scrollbar"
            >
              <div className="divider shrink-0" />
              {editorToolbarItems.map((item) => (
                <button
                  key={`${item.pluginId}:${item.id}`}
                  type="button"
                  onClick={() => runEditorToolbarItem(item)}
                  className={
                    item.icon
                      ? "toolbar-btn shrink-0"
                      : "toolbar-btn shrink-0 w-auto! min-w-8 max-w-[10rem] px-2 whitespace-nowrap"
                  }
                  title={item.title}
                >
                  {item.icon ? (
                    <Icon name={item.icon} className="w-4 h-4" />
                  ) : (
                    <span className="text-[11px] leading-none whitespace-nowrap truncate">{item.label}</span>
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 min-w-0" />
          )}

          {/* ③ 固定右组：统计 + 字号，永不滚动 */}
          <div className="flex items-center gap-2 shrink-0 ml-auto">
            {/* 统计 */}
            <div
              data-plugin-hook="editor-stats"
              className="flex items-center gap-2 text-[11px] text-faint-soft select-none"
            >
              <span className="px-2 py-0.5 rounded-md bg-surface-alt/80 text-faint" title={t("字数")}>{t(wordCount === 1 ? "1 字" : "{count} 字", { count: wordCount.toLocaleString(locale) })}</span>
              <span className="px-2 py-0.5 rounded-md bg-surface-alt/80 text-faint" title={t("行数")}>{t(lineCount === 1 ? "1 行" : "{count} 行", { count: lineCount.toLocaleString(locale) })}</span>
            </div>

            {/* 字体大小显示：点击还原为设置里的默认字号 */}
            <button
              onClick={() => setFontSizeOverride(null)}
              className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
                editorFontSize === defaultFontSize
                  ? "text-faint-soft cursor-default"
                  : "text-faint hover:bg-surface-alt hover:text-body"
              }`}
              title={t("点击还原默认字号（{size} px）", { size: defaultFontSize })}
            >
              {editorFontSize} px
            </button>
          </div>
        </div>
      </div>

      {/* 编辑器 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div className="editor-container h-full">
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center text-sm text-faint">
                {t("正在加载 Markdown 编辑器...")}
              </div>
            }
          >
            {/* 内容与模式都受控：值走保存链路，模式跟随设置里的默认视图 */}
            <MarkdownEditor
              value={content}
              mode={mode}
              onModeChange={setMode}
              config={editorConfig}
              readOnly={isReadOnly}
              onChange={handleContentChange}
              onReady={handleEditorReady}
              onFontSizeChange={handleFontSizeChange}
              onImagePaste={handleImagePaste}
              resolveImage={resolveImage}
              onLinkClick={(href) => {
                // 页内锚点（脚注 ↔ 正文）留在编辑器里滚动，不能交给浏览器
                if (href.startsWith("#")) return true;
                // 其余走「链接打开方式」：默认系统浏览器；选软件内打开则交给内置浏览器窗口
                void openExternalLink(href).catch(() => undefined);
                return false;
              }}
              style={{ height: "100%" }}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
};