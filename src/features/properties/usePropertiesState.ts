/**
 * 笔记属性域：属性弹窗目标、标签、历史版本，以及标签增删改 / 历史回滚。
 *
 * 属性窗自己不发请求：只在目标笔记变化时拉一次标签与历史，之后的增删改
 * 都让 Rust 回传最新列表覆盖本地 state。
 */
import { useEffect, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, ExternalTextFile, Note, NoteHistoryEntry, Tag } from "@/interface/note/note";
import type { PropertiesTarget } from "@/interface/app/ui";
import type { NoteEditorActions } from "@/interface/note/editor";
import * as notesApi from "@/api/note/notes";
import * as tagsApi from "@/api/note/tags";
import { useI18n } from "@/i18n";
import { errorText } from "@/lib/app/errorText";
import { useToast } from "@/components/common/Toast";

export interface UsePropertiesStateParams {
  notes: Note[];
  categories: Category[];
  setNotes: Dispatch<SetStateAction<Note[]>>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  selectedNote: Note | null;
  historyPreview: NoteHistoryEntry | null;
  tempNote: { id: string; title: string; content: string } | null;
  externalFile: ExternalTextFile | null;
  setHistoryPreview: Dispatch<SetStateAction<NoteHistoryEntry | null>>;
  editorActionsRef: RefObject<NoteEditorActions | null>;
  saveQueueRef: RefObject<Promise<void>>;
}

export function usePropertiesState({
  notes,
  categories,
  setNotes,
  setSelectedNote,
  selectedNote,
  historyPreview,
  tempNote,
  externalFile,
  setHistoryPreview,
  editorActionsRef,
  saveQueueRef,
}: UsePropertiesStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 属性窗目标：笔记 / 分组 / 导出分组；null 表示关闭 */
  const [propertiesTarget, setPropertiesTarget] = useState<PropertiesTarget | null>(null);
  /** 当前属性窗笔记的标签，由 Rust 回传的最新列表覆盖 */
  const [noteTags, setNoteTags] = useState<Tag[]>([]);
  /** 当前属性窗笔记的历史版本 */
  const [noteHistory, setNoteHistory] = useState<NoteHistoryEntry[]>([]);

  /** 属性弹窗展示的对象：用最新的 notes / categories 覆盖打开时的快照，弹窗内编辑后能立即反映新值 */
  const propertiesTargetLive: PropertiesTarget | null =
    propertiesTarget === null
      ? null
      : propertiesTarget.kind === "note"
        ? { kind: "note", note: notes.find((n) => n.id === propertiesTarget.note.id) ?? propertiesTarget.note }
        : propertiesTarget.kind === "category"
          ? { kind: "category", category: categories.find((c) => c.id === propertiesTarget.category.id) ?? propertiesTarget.category }
          : propertiesTarget;

  /**
   * 打开属性窗（或切换目标笔记）时拉一次标签。
   * 依赖用 `note.id` 而不是整个 target 对象：target 每次渲染都是新对象，
   * 按对象比较会一直重发请求，输入框里的草稿也会被反复冲掉。
   */
  const propertiesNoteId = propertiesTarget?.kind === "note" ? propertiesTarget.note.id : null;
  useEffect(() => {
    if (propertiesNoteId === null) {
      setNoteTags([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await tagsApi.listNoteTags(propertiesNoteId);
        if (alive) setNoteTags(list);
      } catch {
        if (alive) setNoteTags([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [propertiesNoteId]);

  /** 历史版本与标签同源：目标笔记变化时重拉，关闭属性窗即清空 */
  useEffect(() => {
    if (propertiesNoteId === null) {
      setNoteHistory([]);
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const list = await notesApi.getNoteHistory(propertiesNoteId);
        if (alive) setNoteHistory(list);
      } catch {
        if (alive) setNoteHistory([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [propertiesNoteId]);

  /**
   * 把某个历史版本写回笔记，并同步列表与编辑器里的同一篇。
   * 后端会同时删掉这条版本及所有更新的版本，且不会生成新的历史。成功返回 true。
   */
  const applyHistoryRollback = async (entry: NoteHistoryEntry): Promise<boolean> => {
    try {
      // 只丢弃「编辑器里正显示这篇笔记」时的草稿；编辑别的笔记 / 外部文件时不能动它。
      // 随后等保存队列落地：否则排队中的保存会排在回滚之后，把刚回滚的内容又写回去。
      const editingTarget =
        !historyPreview && !tempNote && !externalFile && selectedNote?.id === entry.note_id;
      if (editingTarget) editorActionsRef.current?.discardPendingEdits();
      await saveQueueRef.current;
      const updated = await notesApi.rollbackNoteHistory(entry.id);
      setNotes((prev) => prev.map((n) => (n.id === updated.id ? updated : n)));
      setSelectedNote((prev) => (prev && prev.id === updated.id ? updated : prev));
      setNoteHistory(await notesApi.getNoteHistory(updated.id));
      return true;
    } catch (error) {
      showToast(t("回滚失败：{error}", { error: errorText(error) }), "error");
      return false;
    }
  };

  const handleRollbackNoteHistory = async (entry: NoteHistoryEntry) => {
    if (await applyHistoryRollback(entry)) {
      showToast(t("已回滚到所选历史版本（该版本及更新的版本已删除）"), "success");
    }
  };

  /** 属性窗「预览」：关掉属性窗，用伪笔记在编辑器里只读展示这个版本 */
  const handlePreviewHistory = (entry: NoteHistoryEntry) => {
    setHistoryPreview(entry);
    setPropertiesTarget(null);
  };

  /** 顶部提示条里的回滚：成功才退出预览，失败留在预览里方便重试 */
  const handleRollbackFromPreview = async () => {
    if (!historyPreview) return;
    if (await applyHistoryRollback(historyPreview)) {
      setHistoryPreview(null);
      showToast(t("已回滚到所选历史版本（该版本及更新的版本已删除）"), "success");
    }
  };

  /* ---------------- 标签 ----------------
   * 属性窗自己不发请求：只在目标笔记变化时拉一次，之后的增删改都让 Rust 回传最新列表，
   * 用回传值覆盖本地 state——避免"写入成功了但列表还是旧的"这类要再刷一次才对得上的情况。
   */
  const handleAddTags = async (note: Note, names: string[]) => {
    try {
      const next = await tagsApi.addNoteTags(note.id, names, "user");
      setNoteTags(next);
      showToast(names.length > 1
        ? t("已添加 {count} 个标签", { count: names.length })
        : t("已添加标签「{name}」", { name: names[0] }), "success");
    } catch (error) {
      showToast(t("添加标签失败：{error}", { error: errorText(error) }), "error");
    }
  };

  const handleRemoveTag = async (note: Note, name: string) => {
    try {
      // 不传 source：用户在自己的属性窗里操作，看到的都是自己能删的（AI 标签没有删除按钮）
      const next = await tagsApi.removeNoteTags(note.id, [name]);
      setNoteTags(next);
      showToast(t("已移除标签「{name}」", { name }), "success");
    } catch (error) {
      showToast(t("移除标签失败：{error}", { error: errorText(error) }), "error");
    }
  };

  /** 标签改名是全局的（改的是"词"），改完重拉当前笔记的标签以刷新计数与合并结果 */
  const handleRenameTag = async (id: number, name: string) => {
    try {
      await tagsApi.renameTag(id, name);
      const noteId = propertiesTargetLive?.kind === "note" ? propertiesTargetLive.note.id : null;
      if (noteId != null) setNoteTags(await tagsApi.listNoteTags(noteId));
      showToast(t("已重命名标签"), "success");
    } catch (error) {
      showToast(t("重命名失败：{error}", { error: errorText(error) }), "error");
    }
  };

  /** 删除单条历史版本：只刷新属性窗里的列表，笔记本身不动 */
  const handleDeleteNoteHistory = async (entry: NoteHistoryEntry) => {
    try {
      await notesApi.deleteNoteHistoryEntry(entry.id);
      setNoteHistory((prev) => prev.filter((item) => item.id !== entry.id));
      showToast(t("已删除该历史版本"), "success");
    } catch (error) {
      showToast(t("删除失败：{error}", { error: errorText(error) }), "error");
    }
  };

  /** 清空当前笔记的全部历史版本 */
  const handleClearNoteHistory = async () => {
    if (propertiesNoteId === null) return;
    try {
      await notesApi.clearNoteHistory(propertiesNoteId);
      setNoteHistory([]);
      showToast(t("已清空历史版本"), "success");
    } catch (error) {
      showToast(t("清空失败：{error}", { error: errorText(error) }), "error");
    }
  };

  /** 手动把当前状态存成一个历史版本；内容没变时后端不会重复写 */
  const handleCreateNoteHistoryVersion = async () => {
    if (propertiesNoteId === null) return;
    try {
      const created = await notesApi.createNoteHistoryVersion(propertiesNoteId);
      setNoteHistory(await notesApi.getNoteHistory(propertiesNoteId));
      showToast(created ? t("已保存当前版本") : t("当前内容与最新版本相同"), created ? "success" : "info");
    } catch (error) {
      showToast(t("保存版本失败：{error}", { error: errorText(error) }), "error");
    }
  };

  /** 固定 / 取消固定历史版本：固定的版本不会被自动清理 */
  const handleToggleNoteHistoryPinned = async (entry: NoteHistoryEntry) => {
    try {
      const pinned = !entry.pinned;
      await notesApi.setNoteHistoryPinned(entry.id, pinned);
      setNoteHistory((prev) => prev.map((item) => (item.id === entry.id ? { ...item, pinned } : item)));
      showToast(pinned ? t("已固定该版本") : t("已取消固定"), "success");
    } catch (error) {
      showToast(t("操作失败：{error}", { error: errorText(error) }), "error");
    }
  };

  return {
    propertiesTarget,
    setPropertiesTarget,
    propertiesTargetLive,
    propertiesNoteId,
    noteTags,
    setNoteTags,
    noteHistory,
    setNoteHistory,
    handleAddTags,
    handleRemoveTag,
    handleRenameTag,
    handleRollbackNoteHistory,
    handlePreviewHistory,
    handleRollbackFromPreview,
    handleDeleteNoteHistory,
    handleClearNoteHistory,
    handleCreateNoteHistoryVersion,
    handleToggleNoteHistoryPinned,
  };
}
