/**
 * 导出域：右键「导出分组」的目标，以及编辑器导出回调的注册与右键菜单导出。
 */
import { useCallback, useRef, useState } from "react";
import type { Note } from "@/interface/note/note";
import type { ExportTarget } from "@/interface/note/exportCategory";
import { saveNoteAsFile } from "@/lib/note/noteFileExport";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseExportStateParams {
  selectedNote: Note | null;
}

export function useExportState({ selectedNote }: UseExportStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 右键「导出分组」的目标（真实分组 / 默认分组 / 搜索分组归一成同一结构） */
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  /** NoteEditor 注册进来的「保存笔记到文件」（等价 Ctrl+S），侧边栏右键菜单调用 */
  const exportNoteRef = useRef<(() => void) | null>(null);

  /** 注册编辑器导出的回调，侧边栏右键菜单通过 exportNoteRef 调用；卸载时传 null 注销 */
  const registerExportNote = useCallback((fn: (() => void) | null) => {
    exportNoteRef.current = fn;
  }, []);

  /** 侧边栏右键「保存笔记」：打开中的笔记交给编辑器（内容最新），其余按 id 读正文后导出 */
  const handleExportNoteFromMenu = async (note: Note) => {
    if (note.enc_mode !== 0) {
      showToast(t("加密笔记不支持导出，请先永久解密"), "error");
      return;
    }
    if (selectedNote?.id === note.id && exportNoteRef.current) {
      exportNoteRef.current();
      return;
    }
    try {
      if (await saveNoteAsFile(note.title, note.content)) {
        showToast(t("导出成功！"), "success");
      }
    } catch (e) {
      console.error("导出失败:", e);
      showToast(t("导出失败，请重试"), "error");
    }
  };

  return {
    exportTarget,
    setExportTarget,
    exportNoteRef,
    registerExportNote,
    handleExportNoteFromMenu,
  };
}
