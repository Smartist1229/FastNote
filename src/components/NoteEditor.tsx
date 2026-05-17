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

        // 生成前置元数据
        const metadata = ["---"];
        if (title) metadata.push(`title: "${title}"`);
        if (note.created_at)
          metadata.push(`created: ${note.created_at.split("T")[0]}`);
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
        hasUnsavedChangesRef.current = false;
        hasPendingSaveRef.current = false;
        if (saveTimerRef.current !== null) {
          window.clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
      }
      lastNoteIdRef.current = note.id;
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

  if (!note) {
    return (
      <div className="h-full flex items-center justify-center text-gray-500 text-sm">
        <p>选择一个笔记或创建新笔记</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b border-gray-200 flex-shrink-0">
        <div className="flex items-center gap-2 mb-2">
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={handleTitleChange}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            placeholder="笔记标题"
            className="flex-1 px-3 py-2 rounded-lg border border-gray-300 focus:outline-none focus:ring-2 focus:ring-gray-500 focus:border-transparent text-base font-medium shadow-sm"
          />
          <button
            onClick={onDelete}
            className="px-3 py-1.5 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors shadow-sm text-sm"
          >
            删除
          </button>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-gray-100 rounded px-2 py-1">
            <span className="text-xs text-gray-600">字数:</span>
            <span className="text-xs font-semibold text-gray-800">{content.length}</span>
          </div>

          <button
            onClick={handleExport}
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title="导出笔记"
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
          </button>

          <button
            onClick={handleCopyContent}
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title="复制内容"
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

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
            className="p-1.5 hover:bg-gray-100 rounded transition-colors"
            title={
              isMarkdownLoading
                ? "正在加载Markdown编辑器"
                : `切换到${editorType === "monaco" ? "MdEditor" : "MonacoEditor"}`
            }
          >
            <svg className="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
            </svg>
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        {editorType === "monaco" ? (
          <div className="editor-container h-full">
            <Editor
              key={editorKey}
              height="100%"
              defaultLanguage="markdown"
              value={content}
              onChange={handleContentChange}
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
