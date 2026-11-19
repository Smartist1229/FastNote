/**
 * 笔记域：全量笔记列表 / 计数 / 排序 / 搜索关键词 / 侧栏聚焦高亮，
 * 以及统一的 loadData、保存串行队列与笔记本身的增删改。
 *
 * notes 始终是全量列表：分组抽屉、收藏视图、搜索都从它派生，切分组不重新请求。
 */
import { logAction, SAVE_THROTTLE_MS } from "@/lib/app/actionLog";
import { buildAutoTitle } from "@/lib/note/autoTitle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";
import type { Category, Note } from "@/interface/note/note";
import type { ConfirmOptions } from "@/interface/app/ui";
import type { EncryptionScope } from "@/interface/system/encryption";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/ai/aiAccess";
import * as notesApi from "@/api/note/notes";
import * as categoriesApi from "@/api/note/categories";
import { onAppEvent } from "@/shared/bus";
import { activeTabEditor } from "@/features/tabs/activeEditor";
import { pluginContributions } from "@/plugins/contributions";
import { useI18n } from "@/i18n";
import { useToast } from "@/components/common/Toast";

export interface UseNotesStateParams {
  setCategories: Dispatch<SetStateAction<Category[]>>;
  categoriesRef: RefObject<Category[]>;
  selectedCategoryId: string | null;
  setSelectedCategoryId: Dispatch<SetStateAction<string | null>>;
  setExpandedDrawer: (value: string | 'all' | 'uncategorized' | null) => void;
  /** 实时选中项：异步操作（删除撤销）要按「操作那一刻」的现场判断，不能用闭包快照 */
  selectedNoteRef: RefObject<Note | null>;
  setSelectedNote: Dispatch<SetStateAction<Note | null>>;
  notesRef: RefObject<Note[]>;
  requestUnlockRef: { current: (scope: EncryptionScope, id: string, permanent?: boolean) => void };
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
  selectedNoteRef,
  setSelectedNote,
  notesRef,
  requestUnlockRef,
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
  /**
   * 首次加载是否已完成：恢复上次标签要等它——空库和「还没加载」都会得到空数组，
   * 分不清就会把上次的标签当成「笔记已删除」清掉。
   */
  const [dataLoaded, setDataLoaded] = useState(false);
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
      setDataLoaded(true);
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

  /**
   * 新建笔记：**先只落库，不打开编辑面板**。
   *
   * 没给标题时用「新笔记 + 时间戳」命名，由 App 接着在侧栏里就地改名；
   * 用户回车（哪怕什么都没输）之后，App 才把它打开成常驻标签。
   * 命令面板带标题参数的调用属于「已经想好名字」，照旧直接打开。
   */
  const handleCreateNote = async (categoryId?: string | null, title?: string): Promise<Note | undefined> => {
    const targetCategory = categoryId === undefined ? selectedCategoryId : categoryId;
    // 锁着的加密分组不能写入：先解锁，解锁后用户再点一次新建
    if (targetCategory !== null) {
      const category = categoriesRef.current.find((c) => c.id === targetCategory);
      if (category?.is_encrypted && category.is_locked) {
        void requestUnlockRef.current('category', targetCategory);
        return undefined;
      }
    }
    try {
      const explicitTitle = title?.trim();
      const note = await notesApi.createNote(
        explicitTitle || buildAutoTitle(t("新笔记")),
        "",
        targetCategory,
        defaultNoteAiAccess,
      );
      logAction("note.create", note.title);
      setNotes((prev) => [...prev, note]);
      // 就地更新，不再 emit → loadData 全量读回：新笔记已经在内存里，
      // 重拉一遍只会让侧栏闪一下，还会把刚挂上的命名框冲掉。
      setAllNotesCount((count) => count + 1);
      setSelectedCategoryId(targetCategory);
      setExpandedDrawer(targetCategory === null ? 'uncategorized' : targetCategory);
      void pluginContributions.emitHook("note-create", { note, isExternal: false });
      if (explicitTitle) {
        // 名字已经有了，不用再命名：直接打开并聚焦，和旧行为一致
        setSelectedNote(note);
        requestAnimationFrame(() => activeTabEditor()?.actions?.focus());
      }
      return note;
    } catch (error) {
      console.error("Failed to create note:", error);
      return undefined;
    }
  };

  /** 临时预览（AI 回复）另存为真实笔记：写库后打开它；预览标签由调用方关闭 */
  const handleSavePreviewToCategory = async (categoryId: string | null, title: string, content: string) => {
    try {
      const note = await notesApi.createNote(title, content, categoryId, defaultNoteAiAccess);
      logAction("note.save_preview", title);
      setNotes((prev) => [...prev, note]);
      // 同上：就地更新，不做一次全量读回；成功提示放到所有状态落地之后
      setAllNotesCount((count) => count + 1);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId === null ? 'uncategorized' : categoryId);
      setSelectedNote(note);
      void pluginContributions.emitHook("note-create", { note, isExternal: false });
      showToast(t("已保存为笔记"), "success");
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
        logAction("note.save", title, { key: `save-${id}`, throttleMs: SAVE_THROTTLE_MS });
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

  /** 正在删除中的笔记 id：按住 Delete 连发时挡住重复请求 */
  const deletingIdsRef = useRef(new Set<string>());

  /**
   * 侧边栏 / 列表删除：软删除进回收站，并给一条带「撤销」的提示。
   *
   * `skipConfirm` 给 Delete 键用：那是一次可撤销的轻操作，弹框反而更碍事
   * （确认框 → 确定 → 又后悔，比「直接删 → 撤销」多两步）。右键菜单仍走确认框，
   * 因为那是用户主动翻菜单找到的，多半是真要删。
   */
  const handleDeleteNoteFromSidebar = async (note: Note, options?: { skipConfirm?: boolean }) => {
    // 按住 Delete 会连发：同一篇在删完之前只处理一次，免得重复请求 + 弹一串提示
    if (deletingIdsRef.current.has(note.id)) return;
    // 加密笔记同样可以进回收站：删除不碰明文，还原后密钥还在，照样能解
    if (!options?.skipConfirm) {
      const confirmed = await confirm({
        title: t("删除笔记"),
        message:
          note.enc_mode !== 0
            ? t("这是加密笔记，删除会把它移入回收站（密钥一并保留，还原后仍可解密）。确定继续吗？")
            : t("确定要将这条笔记移入回收站吗？"),
        confirmText: t("移入回收站"),
        danger: true,
      });
      if (!confirmed) return;
    }
    /**
     * 删除那一刻它是不是正开着。
     * 撤销要按这个恢复现场：删的是正在看的那篇，恢复后接着看它；
     * 删的是列表里没打开的一条，恢复后只让它回到列表，不抢用户当前焦点。
     */
    const wasOpen = selectedNoteRef.current?.id === note.id;
    deletingIdsRef.current.add(note.id);
    try {
      await notesApi.moveToTrash(note.id);
      logAction("note.trash", note.title);
      await loadData();
      if (wasOpen) setSelectedNote(null);
      showToast(t("已移入回收站"), "success", {
        label: t("撤销"),
        onClick: () => {
          void (async () => {
            try {
              await notesApi.restoreNote(note.id);
              await loadData();
              // 只还原删除前的现场：当时开着才重新打开
              if (wasOpen) setSelectedNote(note);
              logAction("note.restore", note.title);
              showToast(t("已恢复"), "success");
            } catch {
              showToast(t("恢复失败，请到回收站重试"), "error");
            }
          })();
        },
      });
      void pluginContributions.emitHook("note-delete", { noteId: note.id });
    } catch {
      showToast(t("删除失败"), "error");
    } finally {
      deletingIdsRef.current.delete(note.id);
    }
  };

  /** 切换收藏（置顶）：收藏的笔记在分组内置顶，并出现在收藏视图 */
  const handleTogglePin = async (note: Note) => {
    try {
      await notesApi.pinNote(note.id, !note.is_pinned);
      logAction(note.is_pinned ? "note.unpin" : "note.pin", note.title);
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
      logAction("note.ai_access", `${note.title} → ${level}`);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, ai_access: level } : n)));
      setSelectedNote((prev) => (prev && prev.id === note.id ? { ...prev, ai_access: level } : prev));
      showToast(t("「{name}」的 AI 访问已设为{level}", {
        name: note.title || t("无标题"), level: t(AI_ACCESS_LABELS[level]),
      }), "success");
    } catch {
      showToast(t("操作失败，请重试"), "error");
    }
  };

  /**
   * 把笔记移动到指定分组（null = 未分类）。拖拽与右键菜单共用这一条。
   *
   * 以前走 update_note（整篇正文回传 + 历史/加密/语义索引全套）再 loadData 全量读回，
   * 大库上要卡几秒；现在后端只 UPDATE category_id，前端就地改内存列表。
   *
   * 移动完成后：expandedDrawer 是单槽手风琴，把它指向目标分组就等于「关闭 A、打开 B」；
   * 同时同步 selectedNote，否则正在编辑的那篇下一次 Ctrl+S 会用旧 category_id 把它挪回去。
   * 提示放到全部状态更新之后，不会再出现「toast 先到、列表后到」。
   */
  const handleMoveNoteToCategory = async (note: Note, categoryId: string | null) => {
    if (note.category_id === categoryId) return;
    // 前端先挡掉两类加密场景，省一次注定失败的往返；后端也做同样的校验兜底
    if (note.enc_mode !== 0) {
      showToast(t("加密笔记不能移动到其他分组"), "error");
      return;
    }
    if (categoriesRef.current.find((c) => c.id === categoryId)?.is_encrypted) {
      showToast(t("该分组已加密，组内笔记不可单独新建或移入"), "error");
      return;
    }
    try {
      await notesApi.moveNoteToCategory(note.id, categoryId);
      logAction("note.move", `${note.title} -> ${categoryId ?? "(ungrouped)"}`);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, category_id: categoryId } : n)));
      if (selectedNoteRef.current?.id === note.id) {
        setSelectedNote((prev) => (prev && prev.id === note.id ? { ...prev, category_id: categoryId } : prev));
      }
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId === null ? 'uncategorized' : categoryId);
      showToast(t("移动成功"), "success");
    } catch {
      showToast(t("移动失败"), "error");
    }
  };

  /** 重命名笔记标题：走 update_note，正文原样带回 */
  const handleRenameNote = async (note: Note, title: string) => {
    try {
      await notesApi.updateNote(note.id, title, note.content, note.category_id);
      logAction("note.rename", title);
      setNotes((prev) => prev.map((n) => (n.id === note.id ? { ...n, title } : n)));
      if (selectedNoteRef.current?.id === note.id) {
        setSelectedNote((prev) => (prev && prev.id === note.id ? { ...prev, title } : prev));
      }
      // 成功不弹提示：改名是就地发生的，标题已经在眼前变了，再弹一条只是噪音
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
    setAllNotesCount,
    dataLoaded,
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
    handleDeleteNoteFromSidebar,
    handleTogglePin,
    handleSetNoteAiAccess,
    handleMoveNoteToCategory,
    handleRenameNote,
    handleSortByChange,
    handleToggleSortOrder,
  };
}
