import { useState, useEffect, useRef, useCallback } from "react";
import { Editor, loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import { config, MdEditor } from "md-editor-rt";
import "md-editor-rt/lib/style.css";
import "katex/dist/katex.min.css";
import "cropperjs/dist/cropper.css";
import "highlight.js/styles/atom-one-dark.css";
import { Note } from "../types";
import { monacoEditorConfig } from "../config/monacoEditor";
import { markdownEditorConfig } from "../config/markdownEditor";
import { save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useToast } from "./Toast";

loader.config({ monaco });

type EditorType = "monaco" | "markdown";
let markdownExtensionsPromise: Promise<void> | null = null;

const ensureMarkdownExtensions = () => {
  if (!markdownExtensionsPromise) {
    markdownExtensionsPromise = Promise.all([
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

interface NoteEditorProps {
  note: Note | null;
  onSave: (id: number, title: string, content: string, categoryId: number | null) => Promise<void>;
  onDelete: () => void;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  onSave,
  onDelete,
}) => {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [editorType, setEditorType] = useState<EditorType>("monaco");
  const [isMarkdownLoading, setIsMarkdownLoading] = useState(false);
  const [fontSize, setFontSize] = useState(15);
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
  const [lastSavedAt, setLastSavedAt] = useState<string | null>(null);
  const { showToast } = useToast();

  const handleExport = useCallback(async () => {
    if (!note) return;
    try {
      const defaultFileName = title || "无标题笔记";
      const filePath = await save({
        defaultPath: defaultFileName,
        filters: [{ name: "Markdown", extensions: ["md"] }],
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

  const changeFontSize = useCallback((delta: number) => {
    setFontSize((prev) => Math.max(10, Math.min(28, prev + delta)));
  }, []);

  // 切换笔记时重置状态
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

  // Ctrl+S 快捷键
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

  // 统计信息
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
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        <p>选择一个笔记或创建新笔记</p>
      </div>
    );
  }

  return (
    <div className={`h-full flex flex-col ${isFullscreen ? "fixed inset-0 z-50 bg-white" : ""}`}>
      {/* 标题栏 */}
      <div className="p-3 pb-2 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={handleTitleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="笔记标题"
            className="flex-1 px-4 py-2.5 rounded-xl border border-gray-200 focus:outline-none focus:ring-2 focus:ring-gray-400 focus:border-transparent text-base font-medium shadow-sm bg-gray-50 hover:bg-white transition-colors"
          />
          <button
            onClick={onDelete}
            className="px-3 py-2 bg-red-50 text-red-600 rounded-xl hover:bg-red-100 transition-colors text-sm font-medium flex items-center gap-1.5"
            title="删除笔记"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
            删除
          </button>
        </div>
      </div>

      {/* 工具栏 */}
      <div className="px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* 段0：保存状态 */}
          <div className="flex items-center gap-1.5 mr-1 text-xs text-gray-400">
            {hasUnsavedChangesRef.current ? (
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                未保存
              </span>
            ) : lastSavedAt ? (
              <span className="flex items-center gap-1">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                {formatSavedTime(lastSavedAt)}
              </span>
            ) : null}
          </div>

          <div className="w-px h-4 bg-gray-200 mx-1" />

          {/* 段1：字号控制 */}
          <button
            onClick={() => changeFontSize(-1)}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
            title="缩小字号"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 12H4" />
            </svg>
          </button>
          <span className="text-xs text-gray-500 w-6 text-center select-none">{fontSize}</span>
          <button
            onClick={() => changeFontSize(1)}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
            title="放大字号"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>

          <div className="w-px h-4 bg-gray-200 mx-1" />

          {/* 段2：主题切换 */}
                    {/* 全屏 */}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
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

          <div className="w-px h-4 bg-gray-200 mx-1" />

          {/* 段3：操作按钮 */}
          <button
            onClick={handleExport}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
            title="导出笔记"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>

          <button
            onClick={handleCopyContent}
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors"
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
            className="p-1.5 text-gray-500 hover:bg-gray-100 rounded-lg transition-colors disabled:opacity-40"
            title={isMarkdownLoading ? "正在加载Markdown编辑器" : `切换到${editorType === "monaco" ? "Markdown" : "Monaco"}`}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>

          <div className="flex-1" />

          {/* 段4：统计 */}
          <div className="flex items-center gap-2 text-xs text-gray-400 select-none">
            <span title="字数">{wordCount} 字</span>
            <span className="text-gray-200">|</span>
            <span title="行数">{lineCount} 行</span>
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
              options={{
                ...(monacoEditorConfig as any),
                fontSize,
              }}
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
            <MdEditor
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
          </div>
        )}
      </div>
    </div>
  );
};
