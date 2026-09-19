import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import "./App.css";
import { Note, Category, AiProvider } from "./types";
import * as api from "./api";
import { Sidebar } from "./components/Sidebar";
import { Modal } from "./components/Modal";
import { ToastProvider, useToast } from "./components/Toast";
import { WelcomeDashboard } from "./components/WelcomeDashboard";
import { AIChatPanel } from "./components/AIChatPanel";
import { AiProviderModal } from "./components/AiProviderModal";
import { confirm } from "@tauri-apps/plugin-dialog";

const NoteEditor = lazy(() =>
  import("./components/NoteEditor").then((module) => ({
    default: module.NoteEditor,
  }))
);

function AppContent() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortOrder, setSortOrder] = useState<string>("asc");
  const [allNotesCount, setAllNotesCount] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState("");
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  const [expandedDrawer, setExpandedDrawer] = useState<number | 'all' | 'uncategorized' | null>(null);
  /** AI 打开笔记时用于聚焦高亮的笔记 ID（变化即触发一次动画） */
  const [focusNoteId, setFocusNoteId] = useState<number | null>(null);
  /** 分组侧边栏是否折叠（腾出宽度给编辑器/AI 面板） */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  /** 折叠后鼠标贴近左边缘时浮现唤出把手 */
  const [isRevealHandleVisible, setIsRevealHandleVisible] = useState(false);
  const [showCategoryModal, setShowCategoryModal] = useState(false);
  const [editingCategory, setEditingCategory] = useState<Category | null>(null);
  const [categoryName, setCategoryName] = useState("");
  const [showDeleteCategoryModal, setShowDeleteCategoryModal] = useState(false);
  const [deletingCategory, setDeletingCategory] = useState<Category | null>(null);
  const [deleteCategoryNotes, setDeleteCategoryNotes] = useState(false);
  const [showTrashModal, setShowTrashModal] = useState(false);
  const [trashNotes, setTrashNotes] = useState<Note[]>([]);
  const [selectedTrashIds, setSelectedTrashIds] = useState<Set<number>>(new Set());
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [editorCursorOffset, setEditorCursorOffset] = useState(0);
  const [showProviderModal, setShowProviderModal] = useState(false);
  const [providerModalProviders, setProviderModalProviders] = useState<AiProvider[]>([]);
  const [providerModalSelectedId, setProviderModalSelectedId] = useState<number>(0);
  const { showToast } = useToast();
  const selectedNoteRef = useRef<Note | null>(selectedNote);
  const notesRef = useRef<Note[]>(notes);
  const focusTimerRef = useRef<number | null>(null);

  /** 打开笔记：记录当前分组，并让侧边栏展开/聚焦到这条笔记 */
  const openNote = useCallback((note: Note) => {
    setSelectedNote(note);
    setSelectedCategoryId(note.category_id);
    setExpandedDrawer(note.category_id === null ? 'uncategorized' : note.category_id);
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    // 先清零再在下一帧赋值，保证重复打开同一条笔记时高亮动画仍会重放
    setFocusNoteId(null);
    focusTimerRef.current = window.setTimeout(() => {
      setFocusNoteId(note.id);
      focusTimerRef.current = window.setTimeout(() => {
        setFocusNoteId(null);
        focusTimerRef.current = null;
      }, 2600);
    }, 40);
  }, []);

  /** 展开/收起 AI 对话面板 */
  const toggleAiPanel = useCallback(() => setAiPanelOpen((open) => !open), []);

  /** 展开/收起分组抽屉（点击同一分组可收起） */
  const toggleDrawer = useCallback((key: number | 'all' | 'uncategorized') => {
    setExpandedDrawer((current) => {
      const next = current === key ? null : key;
      // 'all' 是聚合视图，新建笔记时按"未分类"处理
      if (typeof next === 'number') setSelectedCategoryId(next);
      else if (next === 'uncategorized' || next === 'all') setSelectedCategoryId(null);
      return next;
    });
  }, []);

  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (import.meta.env.PROD) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  const loadData = useCallback(async () => {
    try {
      // 抽屉视图下所有分组的笔记都从 notes 派生，因此必须始终持有全量笔记，
      // 不能按 selectedCategoryId 过滤，否则打开某个分组会让其它分组瞬间变空。
      const [cats, allNotes] = await Promise.all([
        api.getCategories(),
        api.getNotes(null, sortBy, sortOrder),
      ]);
      setCategories(cats);
      setNotes(allNotes);
      setAllNotesCount(allNotes.length);
      const currentSelectedNote = selectedNoteRef.current;
      if (currentSelectedNote) {
        const updatedNote = allNotes.find((note) => note.id === currentSelectedNote.id);
        if (updatedNote) {
          setSelectedNote({ ...updatedNote });
        } else {
          setSelectedNote(null);
        }
      }
    } catch (error) {
      console.error("Failed to load data:", error);
    }
  }, [sortBy, sortOrder]);

  useEffect(() => {
    const handler = () => loadData();
    window.addEventListener("fastnote-data-changed", handler);
    return () => window.removeEventListener("fastnote-data-changed", handler);
  }, [loadData]);

  useEffect(() => { loadData(); }, [loadData]);
  useEffect(() => { selectedNoteRef.current = selectedNote; }, [selectedNote]);
  useEffect(() => { notesRef.current = notes; }, [notes]);

  // AI selectNote 工具：切换当前打开的笔记，并展开对应分组、聚焦高亮
  useEffect(() => {
    const handler = (e: Event) => {
      const { noteId } = (e as CustomEvent).detail;
      const note = notesRef.current.find((n) => n.id === noteId);
      if (note) openNote(note);
    };
    window.addEventListener("fastnote-select-note", handler);
    return () => window.removeEventListener("fastnote-select-note", handler);
  }, [openNote]);

  useEffect(() => {
    return () => {
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    };
  }, []);

  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());

  const handleCreateNote = async (categoryId?: number | null) => {
    const targetCategory = categoryId === undefined ? selectedCategoryId : categoryId;
    try {
      const note = await api.createNote("无标题", "", targetCategory);
      setNotes((prev) => [...prev, note]);
      setSelectedNote(note);
      setSelectedCategoryId(targetCategory);
      setExpandedDrawer(targetCategory === null ? 'uncategorized' : targetCategory);
      window.dispatchEvent(new CustomEvent('fastnote-data-changed'));
    } catch (error) {
      console.error("Failed to create note:", error);
    }
  };

  const handleSaveNote = async (id: number, title: string, content: string, categoryId: number | null) => {
    saveQueueRef.current = saveQueueRef.current.then(async () => {
      try {
        await api.updateNote(id, title, content, categoryId);
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

  const applyAiContentChange = async (nextContent: string) => {
    const current = selectedNoteRef.current;
    if (!current) {
      showToast("请先选择一条笔记", "error");
      return;
    }

    const updatedNote = { ...current, content: nextContent, updated_at: new Date().toISOString() };
    setSelectedNote(updatedNote);
    selectedNoteRef.current = updatedNote;
    setNotes((prev) => prev.map((note) => (note.id === current.id ? updatedNote : note)));
    await handleSaveNote(current.id, current.title, nextContent, current.category_id);
  };

  const handleAiInsertText = async (text: string) => {
    const current = selectedNoteRef.current;
    if (!current) {
      showToast("请先选择一条笔记", "error");
      return;
    }
    const offset = Math.max(0, Math.min(editorCursorOffset, current.content.length));
    const prefix = current.content.slice(0, offset);
    const suffix = current.content.slice(offset);
    const separatorBefore = prefix && !prefix.endsWith("\n") ? "\n" : "";
    const separatorAfter = suffix && !text.endsWith("\n") ? "\n" : "";
    const nextContent = `${prefix}${separatorBefore}${text}${separatorAfter}${suffix}`;
    await applyAiContentChange(nextContent);
    setEditorCursorOffset(offset + separatorBefore.length + text.length + separatorAfter.length);
    showToast("已插入到笔记", "success");
  };

  const handleAiReplaceContent = async (text: string) => {
    await applyAiContentChange(text);
    setEditorCursorOffset(text.length);
    showToast("已替换笔记内容", "success");
  };

  const handleDeleteNote = async () => {
    if (!selectedNote) return;
    const noteId = selectedNote.id;
    const confirmed = await confirm("确定要将这条笔记移入回收站吗？", "删除笔记");
    if (!confirmed) return;
    try {
      await api.moveToTrash(noteId);
      await loadData();
      setSelectedNote((current) => (current?.id === noteId ? null : current));
      showToast("删除成功！", "success");
    } catch (error) {
      console.error("Failed to delete note:", error);
      showToast("删除失败，请重试", "error");
    }
  };

  const handleOpenTrash = async () => {
    try {
      const notes = await api.getTrashNotes();
      setTrashNotes(notes);
      setSelectedTrashIds(new Set());
      setShowTrashModal(true);
    } catch (error) {
      console.error("Failed to load trash:", error);
      showToast("加载回收站失败", "error");
    }
  };

  const handleRestoreNote = async (id: number) => {
    try {
      await api.restoreNote(id);
      setTrashNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedTrashIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      await loadData();
      showToast("笔记已还原", "success");
    } catch (error) {
      showToast("还原失败", "error");
    }
  };

  const handleDeletePermanent = async (id: number) => {
    try {
      await api.deleteNotePermanently(id);
      setTrashNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedTrashIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      showToast("笔记已永久删除", "success");
    } catch (error) {
      showToast("删除失败", "error");
    }
  };

  const handleEmptyTrash = async () => {
    if (trashNotes.length === 0) return;
    const confirmed = await confirm("确定要清空回收站吗？此操作不可恢复。", "清空回收站");
    if (!confirmed) return;
    try {
      await api.deleteMultipleNotesPermanently(trashNotes.map((n) => n.id));
      setTrashNotes([]);
      setSelectedTrashIds(new Set());
      await loadData();
      showToast("回收站已清空", "success");
    } catch (error) {
      showToast("清空回收站失败", "error");
    }
  };

  const handleRestoreSelected = async () => {
    if (selectedTrashIds.size === 0) return;
    for (const id of selectedTrashIds) { await handleRestoreNote(id); }
  };

  const handleDeleteSelected = async () => {
    if (selectedTrashIds.size === 0) return;
    const confirmed = await confirm("确定要永久删除选中的笔记吗？此操作不可恢复。", "永久删除");
    if (!confirmed) return;
    const ids = Array.from(selectedTrashIds);
    try {
      await api.deleteMultipleNotesPermanently(ids);
      setTrashNotes((prev) => prev.filter((n) => !ids.includes(n.id)));
      setSelectedTrashIds(new Set());
      await loadData();
      showToast("已永久删除", "success");
    } catch (error) {
      showToast("删除失败", "error");
    }
  };

  const toggleTrashSelect = (id: number) => {
    setSelectedTrashIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const formatTrashDate = (dateStr: string | null) => {
    if (!dateStr) return "-";
    try {
      const d = new Date(dateStr);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    } catch { return dateStr; }
  };

  const handleCreateCategory = () => {
    setEditingCategory(null);
    setCategoryName("");
    setShowCategoryModal(true);
  };

  const handleEditCategory = (category: Category) => {
    setEditingCategory(category);
    setCategoryName(category.name);
    setShowCategoryModal(true);
  };

  const handleSaveCategory = async () => {
    if (!categoryName.trim()) return;
    try {
      if (editingCategory) { await api.updateCategory(editingCategory.id, categoryName); }
      else { await api.createCategory(categoryName); }
      await loadData();
      setShowCategoryModal(false);
    } catch (error) {
      console.error("Failed to save category:", error);
    }
  };

  const handleDeleteCategory = (category: Category) => {
    setDeletingCategory(category);
    setDeleteCategoryNotes(false);
    setShowDeleteCategoryModal(true);
  };

  const confirmDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      await api.deleteCategory(deletingCategory.id, deleteCategoryNotes);
      if (selectedCategoryId === deletingCategory.id) { setSelectedCategoryId(null); }
      await loadData();
      setShowDeleteCategoryModal(false);
      showToast("删除成功", "success");
    } catch (error) {
      console.error("Failed to delete category:", error);
      showToast("删除失败: " + error, "error");
    }
  };

  return (
    <div className="h-screen flex flex-col bg-slate-50">
      <div className="relative flex flex-1 overflow-hidden">
        {/* 侧边栏：分组 + 笔记抽屉式融合（可折叠） */}
        <div className={`sidebar-shell ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
          <Sidebar
            categories={categories}
            notes={notes}
            allNotesCount={allNotesCount}
            selectedCategoryId={selectedCategoryId}
            selectedNoteId={selectedNote?.id || null}
            expandedDrawer={expandedDrawer}
            focusNoteId={focusNoteId}
            searchQuery={searchQuery}
            onSearchQueryChange={setSearchQuery}
            sortBy={sortBy}
            onSortByChange={setSortBy}
            sortOrder={sortOrder}
            onToggleSortOrder={() => setSortOrder((order) => (order === "asc" ? "desc" : "asc"))}
            onSelectNote={openNote}
            onToggleDrawer={toggleDrawer}
            onToggleCollapse={() => setIsSidebarCollapsed(true)}
            isCollapsed={isSidebarCollapsed}
            onToggleAiPanel={toggleAiPanel}
            isAiPanelOpen={aiPanelOpen}
            onCreateCategory={handleCreateCategory}
            onEditCategory={handleEditCategory}
            onDeleteCategory={handleDeleteCategory}
            onCreateNote={handleCreateNote}
            onMoveToCategory={async (note, categoryId) => {
              try {
                await api.updateNote(note.id, note.title, note.content, categoryId);
                await loadData();
                setSelectedCategoryId(categoryId);
                showToast("移动成功", "success");
              } catch {
                showToast("移动失败", "error");
              }
            }}
            onDeleteNote={async (note) => {
              const confirmed = await confirm("确定要将这条笔记移入回收站吗？", "删除笔记");
              if (!confirmed) return;
              try {
                await api.moveToTrash(note.id);
                await loadData();
                if (selectedNote?.id === note.id) setSelectedNote(null);
                showToast("删除成功！", "success");
              } catch {
                showToast("删除失败", "error");
              }
            }}
            onOpenTrash={handleOpenTrash}
            onNotesUpdated={loadData}
          />
        </div>

        {/* 侧边栏折叠后的唤出把手：鼠标移到左边缘时浮现 */}
        {isSidebarCollapsed && (
          <>
            <div
              className="sidebar-reveal-zone"
              aria-hidden="true"
              onMouseEnter={() => setIsRevealHandleVisible(true)}
              onMouseLeave={() => setIsRevealHandleVisible(false)}
            />
            <button
              className={`sidebar-reveal ${isRevealHandleVisible ? 'is-visible' : ''}`}
              onMouseEnter={() => setIsRevealHandleVisible(true)}
              onMouseLeave={() => setIsRevealHandleVisible(false)}
              onFocus={() => setIsRevealHandleVisible(true)}
              onBlur={() => setIsRevealHandleVisible(false)}
              onClick={() => {
                setIsSidebarCollapsed(false);
                setIsRevealHandleVisible(false);
              }}
              title="显示分组侧边栏"
              aria-label="显示分组侧边栏"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
              <span className="sidebar-reveal-label">分组</span>
            </button>
          </>
        )}

        {/* 主内容区：编辑器 + AI 面板（AI 面板作为 flex 兄弟节点，永远挤压而不遮挡） */}
        <div className="relative flex-1 flex overflow-hidden min-w-0">
          <div className="relative flex-1 bg-white min-w-0 overflow-hidden">
            <Suspense
              fallback={
                <div className="h-full flex flex-col items-center justify-center gap-3">
                  <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                  <p className="text-sm text-slate-400">正在加载编辑器...</p>
                </div>
              }
            >
              {/* 编辑器与欢迎页互斥渲染：无笔记时欢迎页可用，AI 面板依然在右侧可用 */}
              {selectedNote ? (
                <div className="editor-layer">
                  <NoteEditor
                    note={selectedNote}
                    onSave={handleSaveNote}
                    onDelete={handleDeleteNote}
                    onCursorOffsetChange={setEditorCursorOffset}
                    onToggleAiPanel={toggleAiPanel}
                    isAiPanelOpen={aiPanelOpen}
                  />
                </div>
              ) : (
                <WelcomeDashboard
                  totalNotes={notes.length}
                  categoryCount={categories.length}
                  trashCount={trashNotes.length}
                  recentNotes={[...notes].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())}
                  onCreateNote={() => handleCreateNote()}
                  onOpenTrash={handleOpenTrash}
                  onSelectNote={openNote}
                  onToggleAiPanel={toggleAiPanel}
                  isAiPanelOpen={aiPanelOpen}
                />
              )}
            </Suspense>
          </div>

          <AIChatPanel
            isOpen={aiPanelOpen}
            onClose={() => setAiPanelOpen(false)}
            noteTitle={selectedNote?.title || ""}
            noteContent={selectedNote?.content || ""}
            currentNoteId={selectedNote?.id ?? null}
            onInsertText={handleAiInsertText}
            onReplaceContent={handleAiReplaceContent}
            onOpenProviderSettings={() => {
              setShowProviderModal(true);
              api.getAiProviders().then((list) => {
                setProviderModalProviders(list);
                if (list.length > 0 && !providerModalSelectedId) {
                  setProviderModalSelectedId(list[0].id);
                }
              });
            }}
          />
        </div>
      </div>

      {/* 分类弹窗 */}
      <Modal isOpen={showCategoryModal} onClose={() => setShowCategoryModal(false)} title={editingCategory ? "编辑分类" : "创建分类"}>
        <div className="space-y-4">
          <input
            type="text"
            value={categoryName}
            onChange={(e) => setCategoryName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleSaveCategory(); }}
            placeholder="输入分类名称..."
            autoFocus
            className="w-full px-4 py-2.5 input-modern text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => setShowCategoryModal(false)} className="btn-ghost px-4 py-2 text-sm">
              取消
            </button>
            <button onClick={handleSaveCategory} className="btn-primary px-4 py-2 text-sm">
              保存
            </button>
          </div>
        </div>
      </Modal>

      {/* 删除分类弹窗 */}
      <Modal isOpen={showDeleteCategoryModal} onClose={() => setShowDeleteCategoryModal(false)} title="删除分类">
        <div className="space-y-4" onKeyDown={(e) => { if (e.key === "Enter") confirmDeleteCategory(); }}>
          <p className="text-sm text-slate-600">
            确定要删除分类「<span className="font-medium text-slate-800">{deletingCategory?.name}</span>」吗？
          </p>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={deleteCategoryNotes}
              onChange={(e) => setDeleteCategoryNotes(e.target.checked)}
              className="w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-500/20"
            />
            <span className="text-sm text-slate-500 group-hover:text-slate-700 transition-colors">同时删除该分类下的所有笔记</span>
          </label>
          <div className="flex gap-2 justify-end pt-1">
            <button onClick={() => setShowDeleteCategoryModal(false)} className="btn-ghost px-4 py-2 text-sm">
              取消
            </button>
            <button onClick={confirmDeleteCategory} className="px-4 py-2 text-sm font-medium text-white bg-red-500 rounded-xl hover:bg-red-600 transition-colors shadow-sm">
              删除
            </button>
          </div>
        </div>
      </Modal>

      {/* 回收站弹窗 */}
      <Modal isOpen={showTrashModal} onClose={() => setShowTrashModal(false)} title="回收站">
        <div className="space-y-3 min-h-[200px] max-h-[60vh] flex flex-col">
          {trashNotes.length > 0 && (
            <div className="flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-slate-400">
                <span>共 {trashNotes.length} 条</span>
                {selectedTrashIds.size > 0 && <span className="text-primary-500 font-medium">，已选 {selectedTrashIds.size} 条</span>}
              </div>
              <div className="flex items-center gap-1.5">
                {selectedTrashIds.size > 0 && (
                  <>
                    <button onClick={handleRestoreSelected} className="px-2.5 py-1 text-xs font-medium bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 transition-colors">
                      还原选中
                    </button>
                    <button onClick={handleDeleteSelected} className="px-2.5 py-1 text-xs font-medium bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors">
                      删除选中
                    </button>
                  </>
                )}
                <button onClick={handleEmptyTrash} className="px-2.5 py-1 text-xs font-medium text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">
                  清空回收站
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-1">
            {trashNotes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
                  <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </div>
                <p className="text-sm text-slate-400">回收站为空</p>
              </div>
            ) : (
              trashNotes.map((note) => (
                <div key={note.id} className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-slate-50 transition-colors group">
                  <input
                    type="checkbox"
                    checked={selectedTrashIds.has(note.id)}
                    onChange={() => toggleTrashSelect(note.id)}
                    className="w-4 h-4 rounded border-slate-300 text-primary-500 focus:ring-primary-500/20"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-700 truncate">{note.title || "无标题"}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">删除于 {formatTrashDate(note.deleted_at)}</p>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button onClick={() => handleRestoreNote(note.id)} className="toolbar-btn hover:!bg-emerald-50 hover:!text-emerald-600" title="还原">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                      </svg>
                    </button>
                    <button onClick={() => handleDeletePermanent(note.id)} className="toolbar-btn hover:!bg-red-50 hover:!text-red-500" title="永久删除">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>

      {/* AI 服务商配置弹窗（全局） */}
      <AiProviderModal
        isOpen={showProviderModal}
        onClose={() => setShowProviderModal(false)}
        providers={providerModalProviders}
        selectedProviderId={providerModalSelectedId}
        onProvidersChange={(list) => {
          setProviderModalProviders(list);
          window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
        }}
        onSelectedProviderChange={setProviderModalSelectedId}
      />
    </div>
  );
}

function App() {
  return (
    <ToastProvider>
      <AppContent />
    </ToastProvider>
  );
}

export default App;
