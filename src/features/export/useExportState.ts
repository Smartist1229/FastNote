/**
 * 导出域：右键「导出分组」的目标，以及「保存当前笔记到文件」的取用入口。
 *
 * 保存回调按标签存放（见 features/tabs/activeEditor）：多标签下每个编辑器实例都会注册一次，
 * 用单槽 ref 会被最后挂载的隐藏标签顶掉。这里的 `exportNoteRef` 是一个 getter 形状的对象，
 * 读 `.current` 时才去取当前激活标签的句柄。
 */
import { useCallback, useMemo, useState } from "react";
import type { Note } from "@/interface/note/note";
import type { ExportTarget } from "@/interface/note/exportCategory";
import { saveNoteAsFile } from "@/lib/note/noteFileExport";
import { activeTabExport } from "@/features/tabs/activeEditor";
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
  /** 每次读都现取激活标签的「保存笔记到文件」（等价 Ctrl+S） */
  const exportNoteRef = useMemo<{ current: (() => void) | null }>(
    () => ({
      get current() {
        return activeTabExport();
      },
    }),
    [],
  );

  /** 侧边栏右键「保存笔记」：打开中的笔记交给编辑器（内容最新），其余按 id 读正文后导出 */
  const handleExportNoteFromMenu = useCallback(async (note: Note) => {
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
  }, [exportNoteRef, selectedNote?.id, showToast, t]);

  return {
    exportTarget,
    setExportTarget,
    exportNoteRef,
    handleExportNoteFromMenu,
  };
}
