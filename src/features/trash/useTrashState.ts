/**
 * 回收站域：列表、多选集合与恢复 / 彻底删除 / 清空。
 *
 * trashNotes 只在回收站操作时更新，欢迎页计数也取自它。
 */
import { useState } from "react";
import type { Note } from "@/interface/note/note";
import type { ConfirmOptions } from "@/interface/app/ui";
import type { EncryptionScope } from "@/interface/system/encryption";
import * as notesApi from "@/api/note/notes";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseTrashStateParams {
  loadData: () => Promise<void>;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export function useTrashState({ loadData, requestUnlockRef, confirm }: UseTrashStateParams) {
  const { locale, t } = useI18n();
  const { showToast } = useToast();

  /** 回收站：列表 + 多选集合 */
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashNotes, setTrashNotes] = useState<Note[]>([]);
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<string>>(new Set());

  /** 打开回收站：每次重新拉取，避免展示过期数据 */
  const handleOpenTrash = async () => {
    try {
      const notes = await notesApi.getTrashNotes();
      setTrashNotes(notes);
      setSelectedTrashIds(new Set());
      setShowTrashModal(true);
    } catch (error) {
      console.error("Failed to load trash:", error);
      showToast(t("加载回收站失败"), "error");
    }
  };

  /** 回收站里的加密笔记：先永久解密才能删除；enc_mode=2 的组密文只能在分组上解密 */
  const handleDecryptTrashNote = (note: Note) => {
    if (note.enc_mode !== 1) {
      showToast(t("此笔记随所属分组加密，请在分组上操作"), "info");
      return;
    }
    void requestUnlockRef.current("note", note.id, true);
  };

  const handleRestoreNote = async (id: string) => {
    try {
      await notesApi.restoreNote(id);
      setTrashNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedTrashIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await loadData();
      showToast(t("笔记已还原"), "success");
    } catch (error) {
      // 目标分组已加密时后端会拒绝（明文笔记不能落进加密分组）
      let message = t("还原失败");
      if (typeof error === "string") {
        try {
          const parsed = JSON.parse(error) as { code?: string };
          if (parsed?.code === "category_encrypted") {
            message = t("该分组已加密，请先解密分组再还原");
          }
        } catch {
          // 普通字符串错误：保留通用提示
        }
      }
      showToast(message, "error");
    }
  };

  const handleDeletePermanent = async (id: string) => {
    if (trashNotes.find((n) => n.id === id)?.enc_mode !== 0) {
      showToast(t("加密笔记需先永久解密才能删除"), "info");
      return;
    }
    try {
      await notesApi.deleteNotePermanently(id);
      setTrashNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedTrashIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      showToast(t("笔记已永久删除"), "success");
    } catch {
      showToast(t("删除失败"), "error");
    }
  };

  const handleEmptyTrash = async () => {
    if (trashNotes.length === 0) return;
    // 加密笔记不参与清空：它们留在回收站里，等用户先永久解密
    const removableIds = trashNotes.filter((n) => n.enc_mode === 0).map((n) => n.id);
    if (removableIds.length === 0) {
      showToast(t("加密笔记需先永久解密才能删除"), "info");
      return;
    }
    const confirmed = await confirm({
      title: t("清空回收站"),
      message: t("确定要清空回收站吗？此操作不可恢复。"),
      confirmText: t("清空回收站"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const skipped = await notesApi.deleteMultipleNotesPermanently(removableIds);
      // 加密笔记不会提交给后端，所以后端 skipped 常为 0；剩余条数要靠本地列表算
      const remaining = trashNotes.length - removableIds.length + skipped;
      setSelectedTrashIds(new Set());
      setTrashNotes(await notesApi.getTrashNotes());
      await loadData();
      showToast(
        remaining > 0
          ? t("已跳过 {count} 篇加密笔记，请先永久解密", { count: remaining })
          : t("回收站已清空"),
        "success",
      );
    } catch {
      showToast(t("清空回收站失败"), "error");
    }
  };

  const handleRestoreSelected = async () => {
    if (selectedTrashIds.size === 0) return;
    for (const id of selectedTrashIds) { await handleRestoreNote(id); }
  };

  const handleDeleteSelected = async () => {
    if (selectedTrashIds.size === 0) return;
    const ids = Array.from(selectedTrashIds);
    const removableIds = trashNotes
      .filter((n) => ids.includes(n.id) && n.enc_mode === 0)
      .map((n) => n.id);
    const encryptedCount = ids.length - removableIds.length;
    if (removableIds.length === 0) {
      showToast(t("加密笔记需先永久解密才能删除"), "info");
      return;
    }
    const confirmed = await confirm({
      title: t("永久删除"),
      message: t("确定要永久删除选中的笔记吗？此操作不可恢复。"),
      confirmText: t("永久删除"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      const skipped = await notesApi.deleteMultipleNotesPermanently(removableIds);
      setSelectedTrashIds(new Set());
      setTrashNotes(await notesApi.getTrashNotes());
      await loadData();
      const total = skipped + encryptedCount;
      showToast(
        total > 0
          ? t("已跳过 {count} 篇加密笔记，请先永久解密", { count: total })
          : t("已永久删除"),
        "success",
      );
    } catch {
      showToast(t("删除失败"), "error");
    }
  };

  const toggleTrashSelect = (id: string) => {
    setSelectedTrashIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const formatTrashDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleString(locale, {
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
  };

  return {
    showTrashModal,
    setShowTrashModal,
    trashNotes,
    setTrashNotes,
    selectedTrashIds,
    handleOpenTrash,
    handleDecryptTrashNote,
    handleRestoreNote,
    handleDeletePermanent,
    handleEmptyTrash,
    handleRestoreSelected,
    handleDeleteSelected,
    toggleTrashSelect,
    formatTrashDate,
  };
}
