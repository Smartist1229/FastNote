/**
 * 电脑文件域：系统文件拖拽高亮 / 落点命中、打开外部文本文件、
 * 写回磁盘、另存为笔记与导入分组。
 *
 * 笔记拖拽用 pointer 事件（组件内），系统文件拖拽用 elementFromPoint + data-drop-category。
 */
import { useCallback, useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, ExternalTextFile, Note, NoteHistoryEntry } from "@/interface/note/note";
import type { ConfirmOptions } from "@/interface/app/ui";
import type { EncryptionScope } from "@/interface/system/encryption";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import * as notesApi from "@/api/note/notes";
import { emitAppEvent } from "@/shared/bus";
import { t as translateNow, useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseExternalFilesParams {
  externalFileRef: RefObject<ExternalTextFile | null>;
  externalFileIdRef: RefObject<number>;
  flushExternalRef: RefObject<(() => void) | null>;
  setTempNote: Dispatch<SetStateAction<{ id: string; title: string; content: string } | null>>;
  setHistoryPreview: Dispatch<SetStateAction<NoteHistoryEntry | null>>;
  setExternalFile: Dispatch<SetStateAction<ExternalTextFile | null>>;
  pushRecentFile: (path: string, name: string) => void;
  categoriesRef: RefObject<Category[]>;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  defaultNoteAiAccess: AiAccessLevel;
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  setSelectedCategoryId: (value: string | null) => void;
  setExpandedDrawer: (value: string | 'all' | 'uncategorized' | null) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export function useExternalFiles({
  externalFileRef,
  externalFileIdRef,
  flushExternalRef,
  setTempNote,
  setHistoryPreview,
  setExternalFile,
  pushRecentFile,
  categoriesRef,
  requestUnlockRef,
  defaultNoteAiAccess,
  setNotes,
  setSelectedNote,
  setSelectedCategoryId,
  setExpandedDrawer,
  confirm,
}: UseExternalFilesParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 系统文件拖拽经过时命中的分组 id（用于侧边栏高亮） */
  const [hoverDropCategoryId, setHoverDropCategoryId] = useState<string | null>(null);
  /** 是否有系统文件正拖拽在窗口上方（用于显示落点提示） */
  const [isFileDragActive, setIsFileDragActive] = useState(false);

  /** 打开电脑上的文本文件：读失败（非文本/过大）只 toast 报错，不进入外部文件模式 */
  const openExternalFile = useCallback(async (path: string) => {
    // 换文件前先把上一份的待写入 flush 掉（此时回调仍指向旧路径）
    flushExternalRef.current?.();
    try {
      const file = await notesApi.readTextFile(path);
      externalFileIdRef.current += 1;
      // 打开文件是最新的用户动作：先收起 AI 预览与历史预览，笔记作为底层保留
      setTempNote(null);
      setHistoryPreview(null);
      setExternalFile({ id: `external:${externalFileIdRef.current}`, ...file });
      // 读成功了才记进最近列表：打不开的文件不值得占一个位置
      pushRecentFile(path, file.name);
    } catch (e) {
      // 文件拖拽监听持有这个回调：全局翻译读取最新语言，不因切换语言重新注册监听。
      showToast(typeof e === "string" ? e : translateNow("打开文件失败"), "error");
    }
  }, [showToast, pushRecentFile, flushExternalRef, externalFileIdRef, setTempNote, setHistoryPreview, setExternalFile]);

  /** 关闭电脑文件：先 flush 写入，再露出下面一层（原笔记，或欢迎页） */
  const handleCloseExternalFile = useCallback(() => {
    flushExternalRef.current?.();
    setExternalFile(null);
  }, [flushExternalRef, setExternalFile]);

  /** 外部文件另存为笔记：写库后切到新笔记，叠放层一并清空 */
  const handleSaveExternalToNote = async (categoryId: string | null, title: string, content: string) => {
    // 另存前先触发一次写回，把最后一点改动交给原文件（不等待完成）
    flushExternalRef.current?.();
    try {
      const note = await notesApi.createNote(title, content, categoryId, defaultNoteAiAccess);
      setNotes((prev) => [...prev, note]);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId === null ? 'uncategorized' : categoryId);
      setTempNote(null);
      setHistoryPreview(null);
      setExternalFile(null);
      setSelectedNote(note);
      showToast(t("已保存为笔记"), "success");
      emitAppEvent("fastnote-data-changed");
    } catch (error) {
      console.error("Failed to save external file as note:", error);
      showToast(t("保存失败，请重试"), "error");
      throw error;
    }
  };

  /** 写回磁盘：编辑器 500ms 防抖后调用；失败由 NoteEditor 捕获并显示保存错误 */
  const handleWriteExternal = useCallback(async (content: string) => {
    const target = externalFileRef.current;
    if (!target) return;
    await notesApi.writeTextFile(target.path, content);
  }, [externalFileRef]);

  /** 拖文件到分组：确认后把文件内容导入为该分组下的一条笔记 */
  const handleDropFileToCategory = useCallback(async (path: string, categoryId: string) => {
    const category = categoriesRef.current.find((c) => c.id === categoryId);
    // 锁着的加密分组无法写入：导入得到的是明文，也必须先解锁
    if (category?.is_encrypted && category.is_locked) {
      void requestUnlockRef.current('category', categoryId);
      return;
    }
    const ok = await confirm({
      title: translateNow("导入文件到分组"),
      message: translateNow("是否将文件内容导入分组「{name}」？", { name: category?.name ?? "" }),
      confirmText: translateNow("导入"),
    });
    if (!ok) return;
    try {
      const file = await notesApi.readTextFile(path);
      await notesApi.createNote(file.name, file.content, categoryId, defaultNoteAiAccess);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId);
      showToast(translateNow("已导入到分组"), "success");
      emitAppEvent("fastnote-data-changed");
    } catch (e) {
      showToast(typeof e === "string" ? e : translateNow("导入失败"), "error");
    }
  }, [confirm, defaultNoteAiAccess, showToast, categoriesRef, requestUnlockRef, setSelectedCategoryId, setExpandedDrawer]);

  /** 欢迎页「打开文本文件」：系统文件选择框 → 按外部文件模式打开 */
  const handleOpenTextFileDialog = useCallback(async () => {
    try {
      const selected = await openFileDialog({
        title: translateNow("打开文本文件"), multiple: false, directory: false,
      });
      if (typeof selected === "string") await openExternalFile(selected);
    } catch (e) {
      console.error("打开文件失败:", e);
      showToast(translateNow("打开文件失败"), "error");
    }
  }, [openExternalFile, showToast]);

  /**
   * 系统级文件拖拽监听：Tauri 接管了 webview 的拖放处理器，
   * 因此这里能拿到真实文件路径，并自行做落点命中检测。
   * 坐标是物理像素，需除以 devicePixelRatio 后再交给 elementFromPoint。
   */
  useEffect(() => {
    // 纯浏览器预览（无 Tauri 运行时）下没有系统拖拽事件，直接跳过
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const hitCategory = (clientX: number, clientY: number): string | null => {
      const el = document.elementFromPoint(clientX, clientY);
      const catEl = el?.closest("[data-drop-category]") as HTMLElement | null;
      if (!catEl) return null;
      return catEl.dataset.dropCategory ?? null;
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsFileDragActive(true);
          const dpr = window.devicePixelRatio || 1;
          setHoverDropCategoryId(hitCategory(payload.position.x / dpr, payload.position.y / dpr));
        } else if (payload.type === "leave") {
          setIsFileDragActive(false);
          setHoverDropCategoryId(null);
        } else if (payload.type === "drop") {
          setIsFileDragActive(false);
          setHoverDropCategoryId(null);
          const path = payload.paths?.[0];
          if (!path) return;
          const dpr = window.devicePixelRatio || 1;
          const categoryId = hitCategory(payload.position.x / dpr, payload.position.y / dpr);
          if (categoryId !== null) void handleDropFileToCategory(path, categoryId);
          else void openExternalFile(path);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("注册文件拖拽监听失败:", e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalFile, handleDropFileToCategory]);

  return {
    hoverDropCategoryId,
    isFileDragActive,
    openExternalFile,
    handleCloseExternalFile,
    handleSaveExternalToNote,
    handleWriteExternal,
    handleDropFileToCategory,
    handleOpenTextFileDialog,
  };
}
