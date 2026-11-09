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
    const note = trashNotes.find((n) => n.id === id);
    /*
     * 加密笔记删除不需要解密：密文本身是可删除的数据。
     * 但它没有明文副本，删了就是真没了，所以额外给一次确认。
     */
    if (note && note.enc_mode !== 0) {
      const confirmed = await confirm({
        title: t("永久删除加密笔记"),
        message: t("「{name}」是加密笔记，永久删除后没有任何明文副本可以恢复。确定继续吗？", {
          name: note.title || t("无标题"),
        }),
        confirmText: t("永久删除"),
        danger: true,
      });
      if (!confirmed) return;
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
    // 加密笔记同样清掉：删除只看 id，不需要明文
    const removableIds = trashNotes.map((n) => n.id);
    const encryptedCount = trashNotes.filter((n) => n.enc_mode !== 0).length;
    const confirmed = await confirm({
      title: t("清空回收站"),
      message:
        encryptedCount > 0
          ? t("确定要清空回收站吗？其中 {count} 篇加密笔记没有明文副本，删除后无法恢复。", {
              count: encryptedCount,
            })
          : t("确定要清空回收站吗？此操作不可恢复。"),
      confirmText: t("清空回收站"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.deleteMultipleNotesPermanently(removableIds);
      setSelectedTrashIds(new Set());
      setTrashNotes(await notesApi.getTrashNotes());
      await loadData();
      showToast(t("回收站已清空"), "success");
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
    const removableIds = ids;
    const encryptedCount = trashNotes.filter(
      (n) => ids.includes(n.id) && n.enc_mode !== 0,
    ).length;
    const confirmed = await confirm({
      title: t("永久删除"),
      message:
        encryptedCount > 0
          ? t("确定要永久删除选中的笔记吗？其中 {count} 篇加密笔记没有明文副本，删除后无法恢复。", {
              count: encryptedCount,
            })
          : t("确定要永久删除选中的笔记吗？此操作不可恢复。"),
      confirmText: t("永久删除"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.deleteMultipleNotesPermanently(removableIds);
      setSelectedTrashIds(new Set());
      setTrashNotes(await notesApi.getTrashNotes());
      await loadData();
      showToast(t("已永久删除"), "success");
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
