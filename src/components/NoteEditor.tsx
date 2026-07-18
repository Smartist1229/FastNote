import { lazy, Suspense, useState, useEffect, useRef, useCallback } from "react";
import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { Note } from "../types";
import { monacoEditorConfig } from "../config/monacoEditor";
import { markdownEditorConfig } from "../config/markdownEditor";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useToast } from "./Toast";

import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";

self.MonacoEnvironment = {
  getWorker(_, label) {
    if (label === "typescript" || label === "javascript") return new tsWorker();
    if (label === "json") return new jsonWorker();
    return new editorWorker();
  },
};

loader.config({ monaco });

type EditorType = "monaco" | "markdown";
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

interface NoteEditorProps {
  note: Note | null;
  onSave: (id: number, title: string, content: string, categoryId: number | null) => Promise<void>;
  onDelete: () => void;
  onCursorOffsetChange?: (offset: number) => void;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onSave,
  onDelete,
  onCursorOffsetChange,
}) => {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [editorType, setEditorType] = useState<EditorType>("monaco");
  const [isMarkdownLoading, setIsMarkdownLoading] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const isComposingRef = useRef(false);
  const [editorKey] = useState(0);
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
  const editorContainerRef = useRef<HTMLDivElement>(null);
  const monacoEditorRef = useRef<any>(null);
  const cursorDisposableRef = useRef<{ dispose: () => void } | null>(null);
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const { showToast } = useToast();

  const handleExport = useCallback(async () => {
    if (!note) return;
    try {
      const defaultFileName = title || "无标题笔记";
      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [
          { name: "Plain Text", extensions: ["txt", "text"] },
          { name: "Markdown", extensions: ["md", "mdx"] },
          { name: "JSON", extensions: ["json", "jsonc"] },
          { name: "HTML", extensions: ["html", "htm", "xhtml"] },
          { name: "Source Code", extensions: ["js", "ts", "jsx", "tsx", "py", "java", "c", "cpp", "h", "css", "scss", "less"] },
          { name: "Config File", extensions: ["ini", "yaml", "yml", "toml", "env"] },
          { name: "Table Text", extensions: ["csv", "tsv"] },
          { name: "XML", extensions: ["xml", "svg"] },
          { name: "Log File", extensions: ["log"] },
          { name: "All Files", extensions: ["*"] }
        ],
      });
      if (filePath) {
        let exportContent = content;
        const metadata = ["---"];
        if (title) metadata.push(`title: "${title}"`);
        if (note.created_at) metadata.push(`created: ${note.created_at.split("T")[0]}`);
        metadata.push("---\n");
        exportContent = metadata.join("\n") + exportContent;
        await writeTextFile(filePath, exportContent);
        showToast("导出成功！", "success");
      }
    } catch (error) {
      console.error("导出失败:", error);
      showToast("导出失败，请重试", "error");
    }
  }, [note, title, content, showToast]);

  const handleCopyContent = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(content);
      showToast("内容已复制到剪贴板", "success");
    } catch (err) {
      console.error("复制失败:", err);
      showToast("复制失败", "error");
    }
  }, [content, showToast]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

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

  useEffect(() => {
    return () => {
      cursorDisposableRef.current?.dispose();
      cursorDisposableRef.current = null;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        handleExport();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleExport]);

  const saveNow = useCallback(async () => {
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
    setContent(newContent);
    latestContentRef.current = newContent;
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
    <div className={`h-full flex flex-col ${isFullscreen ? "fixed inset-0 z-50 bg-white" : ""}`}>
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
          <button
            onClick={onDelete}
            className="toolbar-btn hover:!bg-red-50 hover:!text-red-500"
            title="删除笔记"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </button>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="px-4 py-1.5 border-b border-slate-100/80 flex-shrink-0 bg-slate-50/50">
        <div className="flex items-center gap-1 flex-wrap">
          {/* 保存状态 */}
          <div className="flex items-center gap-1.5 mr-2 text-xs text-slate-400">
            {hasUnsavedChangesRef.current ? (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-50 text-amber-600">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse-dot" />
                <span className="text-[11px] font-medium">编辑中</span>
              </span>
            ) : lastSavedAt ? (
              <span className="flex items-center gap-1.5 px-2 py-1 rounded-md text-slate-400">
                <svg className="w-3 h-3 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-[11px]">{formatSavedTime(lastSavedAt)}</span>
              </span>
            ) : null}
          </div>

          <div className="divider" />

          {/* 全屏 */}
          <button
            onClick={toggleFullscreen}
            className="toolbar-btn"
            title={isFullscreen ? "退出全屏" : "全屏编辑"}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {isFullscreen ? (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              )}
            </svg>
          </button>

          <div className="divider" />

          {/* 导出 */}
          <button
            onClick={handleExport}
            className="toolbar-btn"
            title="导出笔记 (Ctrl+S)"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>

          {/* 复制 */}
          <button
            onClick={handleCopyContent}
            className="toolbar-btn"
            title="复制内容"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          {/* 编辑器切换 */}
          <button
            onClick={async () => {
              if (editorType === "monaco") {
                setIsMarkdownLoading(true);
                try {
                  await ensureMarkdownExtensions();
                  setEditorType("markdown");
                } catch (error) {
                  console.error("Failed to load markdown editor extensions:", error);
                  showToast("Markdown编辑器加载失败", "error");
                } finally {
                  setIsMarkdownLoading(false);
                }
              } else {
                setEditorType("monaco");
              }
            }}
            disabled={isMarkdownLoading}
            className="toolbar-btn disabled:opacity-30"
            title={isMarkdownLoading ? "正在加载Markdown编辑器" : `切换到${editorType === "monaco" ? "Markdown" : "Monaco"}`}
          >
            {isMarkdownLoading ? (
              <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
              </svg>
            )}
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
      <div ref={editorContainerRef} className="flex-1 min-h-0 overflow-hidden">
        {editorType === "monaco" ? (
          <div className="editor-container h-full">
            <Editor
              key={editorKey}
              height="100%"
              defaultLanguage="markdown"
              value={content}
              onChange={handleContentChange}
              onMount={(editor) => {
                monacoEditorRef.current = editor;
                cursorDisposableRef.current?.dispose();
                const updateCursorOffset = () => {
                  const model = editor.getModel();
                  const position = editor.getPosition();
                  if (!model || !position) return;
                  onCursorOffsetChange?.(model.getOffsetAt(position));
                };
                updateCursorOffset();
                cursorDisposableRef.current = editor.onDidChangeCursorPosition(updateCursorOffset);
              }}
              options={monacoEditorConfig as any}
            />
          </div>
        ) : (
          <div
            className="editor-container h-full"
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
                onChange={(value) => {
                  const newContent = value || "";
                  setContent(newContent);
                  latestContentRef.current = newContent;
                  if (!isComposingRef.current) scheduleSave();
                }}
                style={{ height: "100%" }}
              />
            </Suspense>
          </div>
        )}
      </div>
    </div>
  );
};
