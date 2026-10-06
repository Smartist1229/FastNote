import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { Note, Category } from "../types";
import { markdownEditorConfig } from "../config/markdownEditor";
import { openUrl } from "@tauri-apps/plugin-opener";
import { saveNoteAsFile } from "../utils/noteFileExport";
import { useToast } from "./Toast";
import { AiSparkleIcon } from "./icons";
import { Icon } from "./Icon";

type MarkdownEditorModule = typeof import("md-editor-rt");
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

/** 编辑器正文字号（px）：Ctrl/⌘ + 滚轮缩放，范围 12–24，持久化在本地 */
const EDITOR_FONT_SIZE_KEY = "fastnote-editor-font-size";
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 24;
const FONT_SIZE_DEFAULT = 16;

interface NoteEditorProps {
  note: Note | null;
  onSave: (id: number, title: string, content: string, categoryId: number | null) => Promise<void>;
  onDelete: () => void;
  onCursorOffsetChange?: (offset: number) => void;
  /** 打开/关闭 AI 对话面板 */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
  /** 临时预览模式（AI 回复）：只在界面上展示，绝不写入数据库 */
  isTemporary?: boolean;
  /** 关闭临时预览（回到欢迎页） */
  onCloseTemporary?: () => void;
  /** 全部分组：临时预览下「保存到分组」菜单用 */
  categories?: Category[];
  /** 把临时预览另存为真实笔记（保存到指定分组） */
  onSaveToCategory?: (categoryId: number | null, title: string, content: string) => Promise<void>;
  /** 把「保存笔记到文件」的能力暴露给外部（侧边栏右键菜单用，等价于 Ctrl+S） */
  onRegisterExport?: (exportNote: (() => void) | null) => void;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onSave,
  onDelete,
  onCursorOffsetChange,
  onToggleAiPanel,
  isAiPanelOpen = false,
  isTemporary = false,
  onCloseTemporary,
  categories = [],
  onSaveToCategory,
  onRegisterExport,
}) => {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
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
  const { showToast } = useToast();
  /** 编辑器正文字号：Ctrl/⌘ + 滚轮调整 */
  const [editorFontSize, setEditorFontSize] = useState(() => {
    const saved = Number(localStorage.getItem(EDITOR_FONT_SIZE_KEY));
    return saved >= FONT_SIZE_MIN && saved <= FONT_SIZE_MAX ? saved : FONT_SIZE_DEFAULT;
  });
  const editorWrapRef = useRef<HTMLDivElement>(null);

  // 记住字号，下次打开保持
  useEffect(() => {
    localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(editorFontSize));
  }, [editorFontSize]);

  // Ctrl/⌘ + 滚轮缩放：必须用非 passive 监听，否则阻止不了 WebView 自身的页面缩放
  useEffect(() => {
    const el = editorWrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setEditorFontSize((size) =>
        Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size + (e.deltaY < 0 ? 1 : -1)))
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  /** 用 ref 承载临时标记，避免它进入 saveNow 的依赖链 */
  const isTemporaryRef = useRef(false);
  useEffect(() => {
    isTemporaryRef.current = isTemporary;
  }, [isTemporary]);

  /** 临时预览的「保存到分组」下拉菜单 */
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [isSavingToCategory, setIsSavingToCategory] = useState(false);
  const saveMenuRef = useRef<HTMLDivElement>(null);

  // 点菜单外部收起
  useEffect(() => {
    if (!saveMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (saveMenuRef.current && !saveMenuRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [saveMenuOpen]);

  /** 临时预览另存为真实笔记：取编辑器里当前（可能改过）的标题与内容 */
  const handleSaveToCategory = async (categoryId: number | null) => {
    if (!onSaveToCategory || isSavingToCategory) return;
    setIsSavingToCategory(true);
    try {
      await onSaveToCategory(categoryId, latestTitleRef.current, latestContentRef.current);
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
      handleExport();
    }
  };
  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleExport]);

  const saveNow = useCallback(async () => {
    // 临时预览（AI 回复）永不落库
    if (isTemporaryRef.current) return;
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
            placeholder="输入笔记标题..."
            className="title-input flex-1 px-4 py-2.5 text-base font-semibold text-slate-800 placeholder:text-slate-300"
          />
          {!isTemporary && (
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
          {/* 保存状态：临时预览下换成「保存到分组」按钮 */}
          <div className="flex items-center gap-1.5 mr-2 text-xs text-slate-400">
            {isTemporary ? (
              onSaveToCategory && (
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

          {/* 导出 */}
          <button
            onClick={handleExport}
            className="toolbar-btn"
            title="导出笔记 (Ctrl+S)"
          >
            <Icon name="editor-export" className="w-3.5 h-3.5" />
          </button>

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