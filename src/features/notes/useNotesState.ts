/**
 * 笔记域：全量笔记列表 / 计数 / 排序 / 搜索关键词 / 侧栏聚焦高亮，
 * 以及统一的 loadData、保存串行队列与笔记本身的增删改。
 *
 * notes 始终是全量列表：分组抽屉、收藏视图、搜索都从它派生，切分组不重新请求。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, ExternalTextFile, Note, NoteHistoryEntry } from "@/interface/note/note";
import type { ConfirmOptions } from "@/interface/app/ui";
import type { EncryptionScope } from "@/interface/system/encryption";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/ai/aiAccess";
import * as notesApi from "@/api/note/notes";
import * as categoriesApi from "@/api/note/categories";
import { emitAppEvent, onAppEvent } from "@/shared/bus";
import { pluginContributions } from "@/plugins/contributions";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseNotesStateParams {
  setCategories: Dispatch<SetStateAction<Category[]>>;
  categoriesRef: RefObject<Category[]>;
  selectedCategoryId: string | null;
  setSelectedCategoryId: Dispatch<SetStateAction<string | null>>;
  setExpandedDrawer: (value: string | 'all' | 'uncategorized' | null) => void;
  selectedNote: Note | null;
  selectedNoteRef: RefObject<Note | null>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  notesRef: RefObject<Note[]>;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
  externalFileRef: RefObject<ExternalTextFile | null>;
  flushExternalRef: RefObject<(() => void) | null>;
  setTempNote: Dispatch<SetStateAction<{ id: string; title: string; content: string } | null>>;
  setHistoryPreview: Dispatch<SetStateAction<NoteHistoryEntry | null>>;
  setExternalFile: Dispatch<SetStateAction<ExternalTextFile | null>>;
  /** 新建笔记时套用的 AI 档位（来自 AI 设置） */
  defaultNoteAiAccess: AiAccessLevel;
  /** 排序落库后同步运行时状态（设置域提供） */
  applyAppSetting: (category: "view", field: string, value: boolean | number | string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

export function useNotesState({
  setCategories,
  categoriesRef,
  selectedCategoryId,
  setSelectedCategoryId,
  setExpandedDrawer,
  selectedNote,
  selectedNoteRef,
  setSelectedNote,
  notesRef,
  requestUnlockRef,
  externalFileRef,
  flushExternalRef,
  setTempNote,
  setHistoryPreview,
  setExternalFile,
  defaultNoteAiAccess,
  applyAppSetting,
  confirm,
}: UseNotesStateParams) {
  const { t } = useI18n();
  const { showToast } = useToast();

  /** 全量笔记：分组抽屉、收藏视图、搜索都从它派生，因此不按当前分组裁剪 */
  const [notes, setNotes] = useState<Note[]>([]);
  /** 「全部笔记」计数，与 notes 同源，仅供侧边栏展示 */
  const [allNotesCount, setAllNotesCount] = useState<number>(0);
  /** 排序状态：与 appSettings.view 同步，改动经 handleSortByChange 落库并触发重载 */
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortOrder, setSortOrder] = useState<string>("asc");
  /** 搜索关键词：纯前端过滤，不写库也不重新请求 */
  const [searchQuery, setSearchQuery] = useState("");
  /** AI 打开笔记时用于聚焦高亮的笔记 ID（变化即触发一次动画） */
  const [focusNoteId, setFocusNoteId] = useState<string | null>(null);
  /** 侧边栏高亮计时器：40ms 后点亮、2.6s 后熄灭；重复打开前先清掉旧计时器 */
  const focusTimerRef = useRef<number | null>(null);
  /** 保存串行队列：连续保存串成 Promise 链，避免写库乱序让旧内容覆盖新内容 */
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  /** 先清零再在下一帧赋值，保证重复打开同一条笔记时高亮动画仍会重放 */
  const flashFocus = useCallback((noteId: string) => {
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    setFocusNoteId(null);
    focusTimerRef.current = window.setTimeout(() => {
      setFocusNoteId(noteId);
      focusTimerRef.current = window.setTimeout(() => {
        setFocusNoteId(null);
        focusTimerRef.current = null;
      }, 2600);
    }, 40);
  }, []);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    };
  }, []);

  /**
   * 笔记/分组的统一刷新入口：并行拉取后整体替换内存列表。
   * 依赖 sortBy/sortOrder，排序变化会自动重载；AI 侧改库后经
   * `fastnote-data-changed` 也走到这里。选中笔记不在新列表里时清空（已被删除）。
   */
  const loadData = useCallback(async () => {
    try {
      // 抽屉视图下所有分组的笔记都从 notes 派生，因此必须始终持有全量笔记，
      // 不能按 selectedCategoryId 过滤，否则打开某个分组会让其它分组瞬间变空。
      const [cats, allNotes] = await Promise.all([
        categoriesApi.getCategories(),
        notesApi.getNotes(null, sortBy, sortOrder),
      ]);
      setCategories(cats);
      setNotes(allNotes);
      setAllNotesCount(allNotes.length);
      // 分组可能在别处被删（如 AI 调用 deleteCategory），这里统一校验，避免
      // selectedCategoryId 悬空，否则之后「新建笔记」会带上一个已不存在的分组 ID。
      setSelectedCategoryId((prev) => (prev !== null && !cats.some((c) => c.id === prev) ? null : prev));
      const currentSelectedNote = selectedNoteRef.current;
      if (currentSelectedNote) {
        const updatedNote = allNotes.find((note) => note.id === currentSelectedNote.id);
        setSelectedNote(updatedNote ?? null);
      }
    } catch (error) {
      console.error("Failed to load data:", error);
    }
  }, [sortBy, sortOrder]);

  // 订阅数据变更广播：统一触发重载
  useEffect(() => onAppEvent("fastnote-data-changed", () => { void loadData(); }), [loadData]);

  // 首次挂载与排序变化时加载；其余刷新由上面的广播触发
  useEffect(() => { loadData(); }, [loadData]);

  // 让零依赖回调始终能拿到最新值
  useEffect(() => { notesRef.current = notes; }, [notes, notesRef]);

  /** 新建笔记并选中；省略 categoryId 用当前分组，title 省略时叫「无标题」 */
  const handleCreateNote = async (categoryId?: string | null, title?: string) => {
    const targetCategory = categoryId === undefined ? selectedCategoryId : categoryId;
    // 锁着的加密分组不能写入：先解锁，解锁后用户再点一次新建
    if (targetCategory !== null) {
      const category = categoriesRef.current.find((c) => c.id === targetCategory);
      if (category?.is_encrypted && category.is_locked) {
        void requestUnlockRef.current('category', targetCategory);
        return;
      }
    }
    // 新建笔记：撤掉上层叠着的电脑文件 / AI 预览
    if (externalFileRef.current) {
      flushExternalRef.current?.();
      externalFileRef.current = null;
    }
    setTempNote(null);
    setHistoryPreview(null);
    setExternalFile(null);
    try {
      const note = await notesApi.createNote(
        title?.trim() || t("无标题"),
        "",
        targetCategory,
        defaultNoteAiAccess,
      );
      setNotes((prev) => [...prev, note]);
      setSelectedNote(note);
      setSelectedCategoryId(targetCategory);
      setExpandedDrawer(targetCategory === null ? 'uncategorized' : targetCategory);
      emitAppEvent("fastnote-data-changed");
      void pluginContributions.emitHook("note-create", { note, isExternal: false });
    } catch (error) {
      console.error("Failed to create note:", error);
    }
  };

  /** 临时预览（AI 回复）另存为真实笔记：写库后打开它，叠放层一并清空 */
  const handleSavePreviewToCategory = async (categoryId: string | null, title: string, content: string) => {
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
      void pluginContributions.emitHook("note-create", { note, isExternal: false });
    } catch (error) {
      console.error("Failed to save preview as note:", error);
      showToast(t("保存失败，请重试"), "error");
      throw error;
    }
  };

  /**
   * 笔记落库：所有保存排进同一队列串行执行，保证写入顺序与编辑顺序一致。
   * 成功后同步 notes 与 selectedNote 的 updated_at，只更新仍处于选中态的那条。
   */
  const handleSaveNote = async (id: string, title: string, content: string, categoryId: string | null) => {
    // 锁着的加密笔记没有可用密钥：后端会拒绝，这里直接跳过避免把明文停留在队列里
    const target = notesRef.current.find((n) => n.id === id);
    if (target && target.enc_mode !== 0 && target.is_locked) return;
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        await notesApi.updateNote(id, title, content, categoryId);
        const now = new Date().toISOString();
        setNotes((prev) =>
          prev.map((n) => (n.id === id ? { ...n, title, content, category_id: categoryId, updated_at: now } : n))
        );
        if (selectedNoteRef.current?.id === id) {
          setSelectedNote((prev) =>
            prev && prev.id === id ? { ...prev, title, content, category_id: categoryId, updated_at: now } : prev
          );
        }
      } catch (error) {
        console.error("Failed to save note:", error);
      }
    });
    await saveQueueRef.current;
  };

  /** 删除当前笔记：软删除进回收站，刷新列表后清空选中 */
  const handleDeleteNote = async () => {
    if (!selectedNote) return;
    // 加密笔记不能进回收站；临时解锁也不放行，必须先永久解密（后端同样会拒绝）
    if (selectedNote.enc_mode !== 0) {
      showToast(t("加密笔记需先永久解密才能删除"), "info");
      return;
    }
    const noteId = selectedNote.id;
    const confirmed = await confirm({
      title: t("删除笔记"),
      message: t("确定要将这条笔记移入回收站吗？"),
      confirmText: t("移入回收站"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.moveToTrash(noteId);
      await loadData();
      setSelectedNote((current) => (current?.id === noteId ? null : current));
      showToast(t("删除成功！"), "success");
      void pluginContributions.emitHook("note-delete", { noteId });
    } catch (error) {
      console.error("Failed to delete note:", error);
      showToast(t("删除失败，请重试"), "error");
    }
  };

  /** 侧边栏右键删除：软删除进回收站，删的是当前打开的笔记时清空选中 */
  const handleDeleteNoteFromSidebar = async (note: Note) => {
    if (note.enc_mode !== 0) {
      showToast(t("加密笔记需先永久解密才能删除"), "info");
      return;
    }
    const confirmed = await confirm({
      title: t("删除笔记"),
      message: t("确定要将这条笔记移入回收站吗？"),
      confirmText: t("移入回收站"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.moveToTrash(note.id);
      await loadData();
      if (selectedNote?.id === note.id) setSelectedNote(null);
      showToast(t("删除成功！"), "success");
      void pluginContributions.emitHook("note-delete", { noteId: note.id });
    } catch {
      showToast(t("删除失败"), "error");
    }
  };

  /** 切换收藏（置顶）：收藏的笔记在分组内置顶，并出现在收藏视图 */
  const handleTogglePin = async (note: Note) => {
    try {
      await notesApi.pinNote(note.id, !note.is_pinned);
      await loadData();
      showToast(note.is_pinned ? t("已取消收藏") : t("已收藏"), "success");
    } catch {
      showToast(t("操作失败"), "error");
    }
  };

  /**
   * 设置单篇笔记的 AI 访问档位（0 禁止 / 1 只读 / 2 完全）。
   * 只改档位，不动正文；本地 notes 状态同步更新，
   * AI 面板的权限快照依赖它重新计算（下一轮对话即生效）。
   */
  const handleSetNoteAiAccess = async (note: Note, level: AiAccessLevel) => {
    if (note.ai_access === level) return;
    try {
      await notesApi.setNoteAiAccess(note.id, level);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, ai_access: level } : n)));
      setSelectedNote((prev) => (prev && prev.id === note.id ? { ...prev, ai_access: level } : prev));
      showToast(t("「{name}」的 AI 访问已设为{level}", {
        name: note.title || t("无标题"), level: t(AI_ACCESS_LABELS[level]),
      }), "success");
    } catch {
      showToast(t("操作失败，请重试"), "error");
    }
  };

  /** 把笔记移动到指定分组（null = 未分类） */
  const handleMoveNoteToCategory = async (note: Note, categoryId: string | null) => {
    if (note.category_id === categoryId) return;
    try {
      await notesApi.updateNote(note.id, note.title, note.content, categoryId);
      await loadData();
      setSelectedCategoryId(categoryId);
      showToast(t("移动成功"), "success");
    } catch {
      showToast(t("移动失败"), "error");
    }
  };

  /** 重命名笔记标题：走 update_note，正文原样带回 */
  const handleRenameNote = async (note: Note, title: string) => {
    try {
      await notesApi.updateNote(note.id, title, note.content, note.category_id);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, title } : n)));
      if (selectedNoteRef.current?.id === note.id) {
        setSelectedNote((prev) => (prev && prev.id === note.id ? { ...prev, title } : prev));
      }
      showToast(t("已更新笔记标题"), "success");
    } catch {
      showToast(t("重命名失败，请重试"), "error");
    }
  };

  /** 排序字段：走 applyAppSetting，内部会同步本地的 sortBy 并触发列表重新拉取 */
  const handleSortByChange = useCallback(
    (value: string) => applyAppSetting("view", "sortBy", value),
    [applyAppSetting],
  );

  const handleToggleSortOrder = useCallback(
    () => applyAppSetting("view", "sortOrder", sortOrder === "asc" ? "desc" : "asc"),
    [sortOrder, applyAppSetting],
  );

  /**
   * 欢迎页「最近更新」列表：只在 notes 变化时排一次。
   * 直接在 JSX 里 [...notes].sort 会让每次渲染都重排一遍全量笔记。
   */
  const recentNotes = useMemo(
    () => [...notes].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
    [notes],
  );

  return {
    notes,
    setNotes,
    allNotesCount,
    sortBy,
    setSortBy,
    sortOrder,
    setSortOrder,
    searchQuery,
    setSearchQuery,
    focusNoteId,
    flashFocus,
    notesRef,
    saveQueueRef,
    loadData,
    recentNotes,
    handleCreateNote,
    handleSavePreviewToCategory,
    handleSaveNote,
    handleDeleteNote,
    handleDeleteNoteFromSidebar,
    handleTogglePin,
    handleSetNoteAiAccess,
    handleMoveNoteToCategory,
    handleRenameNote,
    handleSortByChange,
    handleToggleSortOrder,
  };
}
