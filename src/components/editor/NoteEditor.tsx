import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import type { MarkdownEditorModule, NoteEditorProps } from "@/interface/editor";
import { markdownEditorConfig } from "@/config/markdownEditor";
import { FONT_SIZE_MIN, FONT_SIZE_MAX, DEFAULT_EDITOR_SETTINGS } from "@/config/appDefaults";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveNoteAsFile } from "@/utils/noteFileExport";
import { useToast } from "@/components/common/Toast";
import { AiSparkleIcon } from "@/components/common/icons";
import { Icon } from "@/components/common/Icon";

let markdownEditorModulePromise: Promise<MarkdownEditorModule> | null = null;
let markdownExtensionsPromise: Promise<void> | null = null;

const loadMarkdownEditorModule = () => {
  if (!markdownEditorModulePromise) {
    markdownEditorModulePromise = import("md-editor-rt");
  }
  return markdownEditorModulePromise;
};

const ensureMarkdownExtensions = () => {
  if (!markdownExtensionsPromise) {
    markdownExtensionsPromise = Promise.all([
      loadMarkdownEditorModule(),
      import("md-editor-rt/lib/style.css"),
      import("katex/dist/katex.min.css"),
      import("cropperjs/dist/cropper.css"),
      import("highlight.js/styles/atom-one-dark.css"),
      import("screenfull"),
      import("katex"),
      import("cropperjs"),
      import("mermaid"),
      import("highlight.js"),
      import("prettier"),
      import("prettier/plugins/markdown"),
      import("echarts"),
    ]).then(
      ([
        { config },
        _markdownStyle,
        _katexStyle,
        _cropperStyle,
        _highlightStyle,
        screenfull,
        katex,
        cropper,
        mermaid,
        highlight,
        prettier,
        parserMarkdown,
        echarts,
      ]) => {
        config({
          editorExtensions: {
            prettier: {
              prettierInstance: prettier,
              parserMarkdownInstance: parserMarkdown,
            },
            highlight: {
              instance: highlight.default,
            },
            screenfull: {
              instance: screenfull.default,
            },
            katex: {
              instance: katex.default,
            },
            cropper: {
              instance: cropper.default,
            },
            mermaid: {
              instance: mermaid.default,
            },
            echarts: {
              instance: echarts,
            },
          },
        });
      }
    );
  }
  return markdownExtensionsPromise;
};

const MarkdownEditor = lazy(async () => {
  await ensureMarkdownExtensions();
  const { MdEditor } = await loadMarkdownEditorModule();
  return { default: MdEditor };
});

/** 编辑器正文字号的兜底值（设置在读取失败时使用） */
const FONT_SIZE_FALLBACK = DEFAULT_EDITOR_SETTINGS.fontSize;

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onSave,
  onDelete,
  onCursorOffsetChange,
  fontSize,
  ctrlScrollZoom = true,
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
}) => {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  /** 是否处于「直接编辑电脑文件」模式 */
  const isExternal = externalFilePath != null;
  const isComposingRef = useRef(false);
  const lastNoteIdRef = useRef<number | null>(null);
  const latestTitleRef = useRef("");
  const latestContentRef = useRef("");
  const latestCategoryIdRef = useRef<number | null>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const isSavingRef = useRef(false);
  const hasPendingSaveRef = useRef(false);
  const hasUnsavedChangesRef = useRef(false);
  const saveTimerRef = useRef<number | null>(null);
  const currentNoteIdRef = useRef<number | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  /** 外部文件写回失败标记：顶部提示条显示「保存失败」 */
  const [saveError, setSaveError] = useState(false);
  const { showToast } = useToast();
  /** 设置里的默认字号：滚轮缩放只临时改覆盖值，点工具栏可还原到它 */
  const defaultFontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, fontSize ?? FONT_SIZE_FALLBACK),
  );
  /** 滚轮临时缩放出来的字号；null 表示当前就是设置的默认字号 */
  const [fontSizeOverride, setFontSizeOverride] = useState<number | null>(null);
  const editorFontSize = Math.min(
    FONT_SIZE_MAX,
    Math.max(FONT_SIZE_MIN, fontSizeOverride ?? defaultFontSize),
  );
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // 设置里改了默认字号时，放弃临时缩放值，直接采用新的默认字号
  useEffect(() => {
    setFontSizeOverride(null);
  }, [defaultFontSize]);

  // Ctrl/⌘ + 滚轮缩放：必须用非 passive 监听，否则阻止不了 WebView 自身的页面缩放
  // 只改临时的当前字号，不写设置；点工具栏字号按钮可还原为设置的默认字号
  useEffect(() => {
    const el = editorWrapRef.current;
    if (!el || !ctrlScrollZoom) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const step = e.deltaY < 0 ? 1 : -1;
      setFontSizeOverride(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, editorFontSize + step)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ctrlScrollZoom, editorFontSize]);
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

  /** 临时预览 / 电脑文件另存为真实笔记：取编辑器里当前（可能改过）的标题与内容 */
  const handleSaveToCategory = async (categoryId: number | null) => {
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

  const handleExport = useCallback(async () => {
    if (!note) return;
    try {
      if (await saveNoteAsFile(title, content)) {
        showToast("导出成功！", "success");
      }
    } catch (error) {
      console.error("导出失败:", error);
      showToast("导出失败，请重试", "error");
    }
  }, [note, title, content, showToast]);

  // 把「保存笔记到文件」交给外部调用（侧边栏笔记右键菜单）
  useEffect(() => {
    onRegisterExport?.(handleExport);
    return () => onRegisterExport?.(null);
  }, [onRegisterExport, handleExport]);

  const handleCopyContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      showToast("内容已复制到剪贴板", "success");
    } catch (err) {
      console.error("复制失败:", err);
      showToast("复制失败", "error");
    }
  }, [content, showToast]);

  useEffect(() => {
    if (note) {
      if (lastNoteIdRef.current !== note.id) {
        currentNoteIdRef.current = note.id;
        setTitle(note.title);
        setContent(note.content);
        latestTitleRef.current = note.title;
        latestContentRef.current = note.content;
        latestCategoryIdRef.current = note.category_id;
        lastNoteIdRef.current = note.id;
        hasUnsavedChangesRef.current = false;
        hasPendingSaveRef.current = false;
        setLastSavedAt(note.updated_at);
        setSaveError(false);
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      }
    } else {
      currentNoteIdRef.current = null;
      setTitle("");
      setContent("");
      latestTitleRef.current = "";
      latestContentRef.current = "";
      latestCategoryIdRef.current = null;
      lastNoteIdRef.current = null;
    }
  }, [note]);

  useEffect(() => {
    if (!note || lastNoteIdRef.current !== note.id || hasUnsavedChangesRef.current) return;
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

  const handleKeyDown = (e: KeyboardEvent) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      // 外部文件模式：Ctrl+S 立即把内容写回电脑上的原文件
      if (isExternalRef.current) void saveNowRef.current();
      else handleExport();
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleExport]);

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
          await onSaveExternalRef.current?.(latestContentRef.current);
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
        await onSave(
          savingNoteId,
          latestTitleRef.current,
          latestContentRef.current,
          latestCategoryIdRef.current
        );
        if (!hasPendingSaveRef.current) {
          hasUnsavedChangesRef.current = false;
          setLastSavedAt(new Date().toISOString());
        }
      } while (hasPendingSaveRef.current && currentNoteIdRef.current === savingNoteId);
    } finally {
      isSavingRef.current = false;
    }
    if (hasPendingSaveRef.current && currentNoteIdRef.current !== savingNoteId) {
      void saveNow();
    }
  }, [onSave]);

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

  const handleContentChange = (value: string | undefined) => {
    const newContent = value || "";
    // md-editor-rt 在「外部赋值同步进编辑器」时也会触发 onChange（内部 docChanged 为真），
    // 这类回填不是用户编辑，直接忽略，避免一打开笔记就被标记「编辑中」并无意义地保存。
    if (newContent === latestContentRef.current) return;
    setContent(newContent);
    latestContentRef.current = newContent;
    // 富文本编辑器不暴露光标位置，统一以文末作为插入锚点
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

  const wordCount = content ? content.replace(/\s/g, "").length : 0;
  const lineCount = content ? content.split("\n").length : 0;
  const formatSavedTime = (t: string | null) => {
    if (!t) return "";
    try {
      const d = new Date(t);
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch {
      return "";
    }
  };

  /** 外部文件写回状态（顶部提示条用） */
  const externalStatus = saveError
    ? { text: "保存失败", cls: "text-red-500" }
    : hasUnsavedChangesRef.current
    ? { text: "保存中…", cls: "text-sky-500" }
    : lastSavedAt
    ? { text: `已保存 ${formatSavedTime(lastSavedAt)}`, cls: "text-emerald-600" }
    : null;

  if (!note) {
    return (
      <div className="h-full flex items-center justify-center text-slate-400 text-sm">
        <p>选择一个笔记或创建新笔记</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {isTemporary && (
        <div className="px-4 py-2 bg-amber-50/70 border-b border-amber-100 flex items-center justify-between flex-shrink-0">
          <span className="text-[11px] text-amber-700">临时预览 · 来自 AI 回复，不会保存为笔记</span>
          <button
            onClick={onCloseTemporary}
            className="text-[11px] px-2 py-0.5 rounded-md text-amber-700 hover:bg-amber-100 transition-colors"
          >
            关闭
          </button>
        </div>
      )}
      {/* 电脑文件提示条：说明正在编辑本机文件、编辑会实时写回 */}
      {isExternal && (
        <div className="px-4 py-2 bg-sky-50/70 border-b border-sky-100 flex items-center justify-between gap-3 flex-shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <Icon name="ai-file-text" className="w-3.5 h-3.5 text-sky-600 flex-shrink-0" />
            <span className="text-[11px] text-sky-700 truncate" title={externalFilePath ?? undefined}>
              正在编辑电脑中的文件 · {title || externalFilePath}
            </span>
            {externalStatus && (
              <span className={`text-[11px] flex-shrink-0 ${externalStatus.cls}`}>· {externalStatus.text}</span>
            )}
          </div>
          <button
            onClick={onCloseExternal}
            className="text-[11px] px-2 py-0.5 rounded-md text-sky-700 hover:bg-sky-100 transition-colors"
          >
            关闭
          </button>
        </div>
      )}
      {/* 标题栏 */}
      <div className="px-4 py-3 border-b border-slate-100 flex-shrink-0">
        <div className="flex items-center gap-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={handleTitleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            readOnly={isExternal}
            placeholder="输入笔记标题..."
            title={isExternal ? "标题即电脑上的文件名，不可修改" : undefined}
            className={`title-input flex-1 px-4 py-2.5 text-base font-semibold text-slate-800 placeholder:text-slate-300 ${
              isExternal ? "cursor-default select-text" : ""
            }`}
          />
          {!isTemporary && !isExternal && (
            <button
              onClick={onDelete}
              className="toolbar-btn hover:!bg-red-50 hover:!text-red-500"
              title="删除笔记"
            >
              <Icon name="editor-trash" className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* 工具栏 */}
      <div className="px-4 py-1.5 border-b border-slate-100/80 flex-shrink-0 bg-slate-50/50">
        <div className="flex items-center gap-1 flex-wrap">
          {/* 保存状态：临时预览 / 电脑文件模式下换成「保存到分组」按钮 */}
          <div className="flex items-center gap-1.5 mr-2 text-xs text-slate-400">
            {isTemporary || isExternal ? (
              (isExternal ? onSaveExternalToNote : onSaveToCategory) && (
                <div className="relative" ref={saveMenuRef}>
                  <button
                    onClick={() => setSaveMenuOpen((open) => !open)}
                    disabled={isSavingToCategory}
                    className={`flex items-center justify-center p-1.5 rounded-md transition-colors disabled:opacity-50 ${
                      saveMenuOpen
                        ? "bg-primary-50 text-primary-500"
                        : "text-slate-500 hover:bg-slate-100 hover:text-slate-600"
                    }`}
                    title={isSavingToCategory ? "保存中..." : "保存到分组"}
                  >
                    <Icon name="editor-save-to-group" className="w-3.5 h-3.5" />
                  </button>
                  {saveMenuOpen && (
                    <div className="absolute left-0 top-full mt-1 z-30 w-44 max-h-60 overflow-y-auto py-1 bg-white border border-slate-200 rounded-lg shadow-lg">
                      <button
                        onClick={() => handleSaveToCategory(null)}
                        className="w-full text-left px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50 transition-colors"
                      >
                        未分组
                      </button>
                      {categories.map((category) => (
                        <button
                          key={category.id}
                          onClick={() => handleSaveToCategory(category.id)}
                          className="w-full text-left px-3 py-1.5 text-[12px] text-slate-600 hover:bg-slate-50 transition-colors truncate"
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
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 text-amber-600">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
                <span className="text-[11px] font-medium">编辑中</span>
              </span>
            ) : lastSavedAt ? (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-slate-400">
                <Icon name="editor-check" className="w-3 h-3 text-emerald-500" />
                <span className="text-[11px]">{formatSavedTime(lastSavedAt)}</span>
              </span>
            ) : null}
          </div>

          <div className="divider" />

          {/* AI 对话 */}
          {onToggleAiPanel && (
            <button
              onClick={onToggleAiPanel}
              className={`toolbar-btn relative ${isAiPanelOpen ? "!bg-primary-50 !text-primary-500" : ""}`}
              title={isAiPanelOpen ? "关闭 AI 对话" : "打开 AI 对话"}
              aria-pressed={isAiPanelOpen}
            >
              <AiSparkleIcon className="w-3.5 h-3.5" />
              {isAiPanelOpen && (
                <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-primary-500" />
              )}
            </button>
          )}

          <div className="divider" />

          {/* 导出（电脑文件模式下内容本就写回原文件，无需再导出） */}
          {!isExternal && (
            <button
              onClick={handleExport}
              className="toolbar-btn"
              title="导出笔记 (Ctrl+S)"
            >
              <Icon name="editor-export" className="w-3.5 h-3.5" />
            </button>
          )}

          {/* 复制 */}
          <button
            onClick={handleCopyContent}
            className="toolbar-btn"
            title="复制内容"
          >
            <Icon name="editor-copy" className="w-3.5 h-3.5" />
          </button>

          <div className="flex-1" />

          {/* 统计 */}
          <div className="flex items-center gap-2 text-[11px] text-slate-300 select-none">
            <span className="px-2 py-0.5 rounded-md bg-slate-100/80 text-slate-400" title="字数">{wordCount} 字</span>
            <span className="px-2 py-0.5 rounded-md bg-slate-100/80 text-slate-400" title="行数">{lineCount} 行</span>
          </div>

          {/* 字体大小显示：点击还原为设置里的默认字号 */}
          <button
            onClick={() => setFontSizeOverride(null)}
            className={`shrink-0 px-2 py-0.5 rounded-md text-[11px] font-medium transition-colors ${
              editorFontSize === defaultFontSize
                ? "text-slate-300 cursor-default"
                : "text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            }`}
            title={`点击还原默认字号（${defaultFontSize} px）`}
          >
            {editorFontSize} px
          </button>
        </div>
      </div>

      {/* 编辑器 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <div
          ref={editorWrapRef}
          className="editor-container h-full"
          style={{ "--md-editor-font-size": `${editorFontSize}px` } as React.CSSProperties}
          onClick={async (e) => {
            const target = e.target as HTMLElement;
            const link = target.closest("a");
            if (link && link.href) {
              e.preventDefault();
              try {
                await openUrl(link.href);
              } catch (error) {
                console.error("Failed to open link:", error);
              }
            }
          }}
        >
          <Suspense
            fallback={
              <div className="h-full flex items-center justify-center text-sm text-slate-400">
                正在加载 Markdown 编辑器...
              </div>
            }
          >
            <MarkdownEditor
              value={content}
              {...markdownEditorConfig}
              onChange={handleContentChange}
              style={{ height: "100%" }}
            />
          </Suspense>
        </div>
      </div>
    </div>
  );
};