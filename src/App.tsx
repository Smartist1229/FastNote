/**
 * FastNote 根组件：只做外壳布局与各业务域 hook 的装配；领域状态全部在 src/features/** 内。
 * 跨域前向引用通过 ref 桥接（见下方 refs），副作用时机与拆分前完全一致。
 */
import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import "@/App.css";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import type { EncryptionScope } from "@/interface/system/encryption";
import { EncryptDialog, RootChangeDialog, RootSetupDialog, UnlockDialog } from "@/components/common/EncryptionDialogs";
import { Sidebar } from "@/components/layout/Sidebar";
import { Modal } from "@/components/common/Modal";
import type { NoteEditorActions } from "@/interface/note/editor";
import { ToastProvider, useToast } from "@/components/common/Toast";
import { pluginHost } from "@/plugins/host";
import { emitAppEvent } from "@/shared/bus";
import { WelcomeDashboard } from "@/components/layout/WelcomeDashboard";
import { SelectionAiToolbar } from "@/components/editor/SelectionAiToolbar";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { PluginModal } from "@/components/common/PluginModal";
import { useRecentFiles } from "@/hooks/useRecentFiles";
import { useSearchHistory } from "@/hooks/useSearchHistory";
import { UpdateDialog } from "@/components/common/UpdateDialog";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { flushThemeSettings } from "@/stores/themeStore";
import * as tagsApi from "@/api/note/tags";
import * as aiApi from "@/api/ai/ai";

import { useSettingsState, type SettingsRuntime } from "@/features/settings/useSettingsState";
import { useAiState } from "@/features/ai/useAiState";
import { useAiNoteActions } from "@/features/ai/useAiNoteActions";
import { useCategoriesState } from "@/features/categories/useCategoriesState";
import { useNoteSelection } from "@/features/noteSelection/useNoteSelection";
import { useNotesState } from "@/features/notes/useNotesState";
import { usePropertiesState } from "@/features/properties/usePropertiesState";
import { useTrashState } from "@/features/trash/useTrashState";
import { useEncryptionState } from "@/features/encryption/useEncryptionState";
import { useExternalFiles } from "@/features/externalFiles/useExternalFiles";
import { useExportState } from "@/features/export/useExportState";
import { usePalette } from "@/features/palette/usePalette";
import { useShortcutAction } from "@/features/shortcuts/useShortcutAction";
import { applyShortcutOverrides } from "@/features/shortcuts/runtime";

/** 编辑器依赖 CodeMirror，体积较大：懒加载让首屏先出侧栏与欢迎页，Suspense 负责占位 */
const NoteEditor = lazy(() =>
  import("@/components/editor/NoteEditor").then((module) => ({
    default: module.NoteEditor,
  }))
);

/**
 * 设置 / 命令面板 / 属性 / 导出 / AI 面板合计上万行，且只在用户打开时出现：
 * 全部改成按需加载，避免它们和它们依赖的编辑器渲染层进首屏主包。
 */
const AIChatPanel = lazy(() =>
  import("@/components/ai/AIChatPanel").then((module) => ({ default: module.AIChatPanel }))
);
const SettingsModal = lazy(() =>
  import("@/components/settings/SettingsModal").then((module) => ({ default: module.SettingsModal }))
);
const CommandPalette = lazy(() =>
  import("@/components/common/CommandPalette").then((module) => ({ default: module.CommandPalette }))
);
const PropertiesModal = lazy(() =>
  import("@/components/common/PropertiesModal").then((module) => ({ default: module.PropertiesModal }))
);
const ExportCategoryModal = lazy(() =>
  import("@/components/data/ExportCategoryModal").then((module) => ({
    default: module.ExportCategoryModal,
  }))
);

/** 历史版本时间：按界面语言显示本地时间到分钟；非法值原样返回。 */
const formatHistoryTime = (iso: string, locale: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(locale, {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

function AppContent() {
  const { locale, t } = useI18n();
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const { recentFiles, pushRecentFile, removeRecentFile } = useRecentFiles();
  const { searchHistory, pushSearchQuery, removeSearchQuery, clearSearchHistory } = useSearchHistory();

  useEffect(() => {
    if (isTauri()) void invoke("set_app_locale", { locale }).catch(console.error);
  }, [locale]);

  /** 插件宿主：桥接 toast 并初始化（init 幂等，StrictMode 双调用安全） */
  useEffect(() => {
    pluginHost.setToastDispatcher((message, type) => showToast(message, type));
    void pluginHost.init();
  }, []);

  /** 纯 UI 局部状态：侧栏折叠 / 唤出把手 / 侧栏视图 */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRevealHandleVisible, setIsRevealHandleVisible] = useState(false);
  const [sidebarView, setSidebarView] = useState<'groups' | 'favorites'>('groups');

  /** 编辑器命令式动作与光标偏移：只在 AI 插入 / 命令面板时读取，用 ref 避免逐字重渲染 */
  const editorActionsRef = useRef<NoteEditorActions | null>(null);
  const editorCursorOffsetRef = useRef(0);
  const registerEditorActions = useCallback((actions: NoteEditorActions | null) => {
    editorActionsRef.current = actions;
  }, []);
  const handleCursorOffsetChange = useCallback((offset: number) => {
    editorCursorOffsetRef.current = offset;
  }, []);

  /**
   * 跨域前向引用：后定义的域把实现写进这些 ref，先定义的域在回调触发时读取。
   * 只为打破 hook 定义顺序，不改变任何副作用时机。
   */
  const sortSetterRef = useRef<(value: string) => void>(() => {});
  const sortOrderSetterRef = useRef<(value: "asc" | "desc") => void>(() => {});
  const sidebarCollapsedSetterRef = useRef<(value: boolean) => void>(() => {});
  const aiPanelOpenSetterRef = useRef<(value: boolean) => void>(() => {});
  const settingsRuntimeRef = useRef<SettingsRuntime>({
    setSortBy: (value) => sortSetterRef.current(value),
    setSortOrder: (value) => sortOrderSetterRef.current(value),
    setIsSidebarCollapsed: (value) => sidebarCollapsedSetterRef.current(value),
    setAiPanelOpen: (value) => aiPanelOpenSetterRef.current(value),
  });
  const loadDataRef = useRef<() => Promise<void>>(async () => {});
  const requestUnlockRef = useRef<(scope: EncryptionScope, id: string, permanent?: boolean) => void>(() => {});
  const lockOnceUnlockedRef = useRef<(scope: EncryptionScope, id: string, clearSelected?: boolean) => void>(() => {});
  const flashFocusRef = useRef<(noteId: string) => void>(() => {});
  const pendingUnlockNoteRef = useRef<string | null>(null);
  const notesRef = useRef<import("@/interface/note/note").Note[]>([]);

  const settings = useSettingsState({ confirm, runtime: settingsRuntimeRef.current });
  const ai = useAiState({ enableAI: settings.appSettings.general.enableAI });
  const categories = useCategoriesState({
    loadDataRef,
    requestUnlockRef,
    lockOnceUnlockedRef,
    defaultCategoryAiAccess: ai.defaultCategoryAiAccess,
  });
  const selection = useNoteSelection({
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    requestUnlockRef,
    lockOnceUnlockedRef,
    flashFocusRef,
    notesRef,
    pendingUnlockNoteRef,
  });
  const notes = useNotesState({
    setCategories: categories.setCategories,
    categoriesRef: categories.categoriesRef,
    selectedCategoryId: categories.selectedCategoryId,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    selectedNote: selection.selectedNote,
    selectedNoteRef: selection.selectedNoteRef,
    setSelectedNote: selection.setSelectedNote,
    notesRef,
    requestUnlockRef,
    externalFileRef: selection.externalFileRef,
    flushExternalRef: selection.flushExternalRef,
    setTempNote: selection.setTempNote,
    setHistoryPreview: selection.setHistoryPreview,
    setExternalFile: selection.setExternalFile,
    defaultNoteAiAccess: ai.defaultNoteAiAccess,
    applyAppSetting: settings.applyAppSetting,
    confirm,
  });
  // 后定义域回填前向引用（渲染期赋值，effect / 事件触发时一定已就绪）
  sortSetterRef.current = notes.setSortBy;
  sortOrderSetterRef.current = notes.setSortOrder as (value: "asc" | "desc") => void;
  flashFocusRef.current = notes.flashFocus;
  loadDataRef.current = notes.loadData;
  aiPanelOpenSetterRef.current = ai.setAiPanelOpen;
  sidebarCollapsedSetterRef.current = setIsSidebarCollapsed;

  // 插件的 ctx.notes.getCurrent()：只暴露真实笔记（外部文件 / 临时草稿 / 未选中一律 null）
  useEffect(() => {
    pluginHost.setCurrentNoteProvider(() => {
      if (selection.externalFileRef.current) return null;
      const note = selection.selectedNoteRef.current;
      if (!note) return null;
      return { id: note.id, title: note.title, isLocked: Boolean(note.is_locked) };
    });
    return () => pluginHost.setCurrentNoteProvider(null);
  }, [selection.externalFileRef, selection.selectedNoteRef]);

  const properties = usePropertiesState({
    notes: notes.notes,
    categories: categories.categories,
    setNotes: notes.setNotes,
    setSelectedNote: selection.setSelectedNote,
    selectedNote: selection.selectedNote,
    historyPreview: selection.historyPreview,
    tempNote: selection.tempNote,
    externalFile: selection.externalFile,
    setHistoryPreview: selection.setHistoryPreview,
    editorActionsRef,
    saveQueueRef: notes.saveQueueRef,
  });
  const trash = useTrashState({ loadData: notes.loadData, requestUnlockRef, confirm });
  const encryption = useEncryptionState({
    notes: notes.notes,
    setNotes: notes.setNotes,
    categories: categories.categories,
    setCategories: categories.setCategories,
    selectedNoteRef: selection.selectedNoteRef,
    setSelectedNote: selection.setSelectedNote,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    loadData: notes.loadData,
    showTrashModal: trash.showTrashModal,
    setTrashNotes: trash.setTrashNotes,
    setPropertiesTarget: properties.setPropertiesTarget,
    openNote: selection.openNote,
    pendingUnlockNoteRef,
    autoLockMinutes: settings.appSettings.general.autoLockMinutes,
  });
  requestUnlockRef.current = encryption.requestUnlock;
  lockOnceUnlockedRef.current = encryption.lockOnceUnlocked;

  const externalFiles = useExternalFiles({
    externalFileRef: selection.externalFileRef,
    externalFileIdRef: selection.externalFileIdRef,
    flushExternalRef: selection.flushExternalRef,
    setTempNote: selection.setTempNote,
    setHistoryPreview: selection.setHistoryPreview,
    setExternalFile: selection.setExternalFile,
    pushRecentFile,
    categoriesRef: categories.categoriesRef,
    requestUnlockRef,
    defaultNoteAiAccess: ai.defaultNoteAiAccess,
    setNotes: notes.setNotes,
    setSelectedNote: selection.setSelectedNote,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    confirm,
  });
  const aiActions = useAiNoteActions({
    selectedNoteRef: selection.selectedNoteRef,
    setSelectedNote: selection.setSelectedNote,
    setNotes: notes.setNotes,
    handleSaveNote: notes.handleSaveNote,
    editorCursorOffsetRef,
  });
  const exportState = useExportState({ selectedNote: selection.selectedNote });

  const { selectedNote, editorNote, overlayActive, externalFile, historyPreview } = selection;

  /**
   * 当前笔记的生效档位 = min(笔记, 所属分组)；没有打开笔记时按"完全"处理（不限制面板本身）。
   * 加密内容不参与 AI：不论档位如何都按 0 处理。
   */
  const currentNoteAiLevel: AiAccessLevel = !selectedNote
    ? 2
    : selectedNote.enc_mode !== 0
      ? 0
      : ((Math.min(
          selectedNote.ai_access,
          selectedNote.category_id !== null
            ? categories.categories.find((c) => c.id === selectedNote.category_id)?.ai_access ?? 2
            : 2,
        ) as AiAccessLevel) ?? 2);

  /** AI 面板是否应丢掉笔记上下文：叠放层激活，或当前笔记是加密内容（加密内容不参与 AI） */
  const aiNoteContextBlocked =
    overlayActive || (selectedNote != null && selectedNote.enc_mode !== 0);

  const palette = usePalette({
    categories: categories.categories,
    selectedCategoryId: categories.selectedCategoryId,
    editorNote,
    selectedNote,
    overlayActive,
    searchQuery: notes.searchQuery,
    setSearchQuery: notes.setSearchQuery,
    sortBy: notes.sortBy,
    sortOrder: notes.sortOrder,
    theme: settings.theme,
    shortcutBindings: settings.appSettings.shortcuts,
    aiPanelOpen: ai.aiPanelOpen,
    isSidebarCollapsed,
    setIsSidebarCollapsed,
    sidebarView,
    setSidebarView,
    enableAI: settings.appSettings.general.enableAI,
    handleCreateNote: notes.handleCreateNote,
    handleCreateCategoryNamed: categories.handleCreateCategoryNamed,
    handleOpenTrash: trash.handleOpenTrash,
    handleOpenTextFileDialog: externalFiles.handleOpenTextFileDialog,
    toggleAiPanel: ai.toggleAiPanel,
    handleSortByChange: notes.handleSortByChange,
    handleToggleSortOrder: notes.handleToggleSortOrder,
    handleThemeChange: settings.handleThemeChange,
    lockEverything: encryption.lockEverything,
    hasUnlockedEncryption: encryption.hasUnlockedEncryption,
    loadData: notes.loadData,
    openSettings: settings.openSettings,
    exportNoteRef: exportState.exportNoteRef,
    setPropertiesTarget: properties.setPropertiesTarget,
    editorActionsRef,
  });

  /**
   * 快捷键：设置一读回（或用户改键）就把整份覆盖表推给运行时。
   * 运行时负责重算反查表、重注册系统全局热键，并把失败项（被别的软件占用）记下来。
   */
  useEffect(() => {
    applyShortcutOverrides(settings.appSettings.shortcuts);
  }, [settings.appSettings.shortcuts]);

  /* 宿主动作：键位在 config/shortcuts 里，这里只关心「按下之后干什么」 */
  useShortcutAction("app.newNote", () => notes.handleCreateNote());
  useShortcutAction("app.quickNote", () => notes.handleCreateNote());
  useShortcutAction("app.settings", () => settings.openSettings("general"));
  useShortcutAction("app.toggleSidebar", () => setIsSidebarCollapsed((collapsed) => !collapsed));
  useShortcutAction("app.toggleAi", () => {
    if (settings.appSettings.general.enableAI) ai.toggleAiPanel();
  });

  // 生产环境屏蔽原生右键菜单；开发环境保留，方便审查元素
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      if (import.meta.env.PROD) {
        e.preventDefault();
      }
    };
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  return (
    <div className="h-screen flex flex-col bg-app">
      <div className="relative flex flex-1 overflow-hidden">
        {/* 侧边栏：分组 + 笔记抽屉式融合（可折叠） */}
        <div className={`sidebar-shell ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
          <Sidebar
            categories={categories.categories}
            notes={notes.notes}
            allNotesCount={notes.allNotesCount}
            selectedCategoryId={categories.selectedCategoryId}
            selectedNoteId={selectedNote?.id || null}
            expandedDrawer={categories.expandedDrawer}
            focusNoteId={notes.focusNoteId}
            searchQuery={notes.searchQuery}
            onSearchQueryChange={notes.setSearchQuery}
            useRegex={settings.appSettings.general.noteSearchRegex}
            onRegexChange={(v) => settings.applyAppSetting("general", "noteSearchRegex", v)}
            semanticEnabled={settings.appSettings.general.semanticSearch}
            semanticIndexing={settings.semanticIndexing}
            onCommitSearch={pushSearchQuery}
            searchHistory={searchHistory}
            onRemoveSearchHistory={removeSearchQuery}
            onClearSearchHistory={clearSearchHistory}
            sortBy={notes.sortBy}
            onSortByChange={notes.handleSortByChange}
            sortOrder={notes.sortOrder}
            onToggleSortOrder={notes.handleToggleSortOrder}
            onSelectNote={selection.openNote}
            onToggleDrawer={categories.toggleDrawer}
            onToggleCollapse={() => setIsSidebarCollapsed(true)}
            isCollapsed={isSidebarCollapsed}
            onToggleAiPanel={settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined}
            isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
            onCreateCategory={categories.handleCreateCategory}
            onEditCategory={categories.handleEditCategory}
            onDeleteCategory={categories.handleDeleteCategory}
            onCreateNote={notes.handleCreateNote}
            onMoveToCategory={notes.handleMoveNoteToCategory}
            onDeleteNote={notes.handleDeleteNoteFromSidebar}
            onOpenTrash={trash.handleOpenTrash}
            onShowNoteProperties={(note) => properties.setPropertiesTarget({ kind: "note", note })}
            onShowCategoryProperties={(category) => properties.setPropertiesTarget({ kind: "category", category })}
            onShowGroupProperties={(name, noteCount) => properties.setPropertiesTarget({ kind: "group", name, noteCount })}
            onOpenSettings={() => settings.openSettings("general")}
            onExportGroup={exportState.setExportTarget}
            onSaveNote={exportState.handleExportNoteFromMenu}
            onNotesUpdated={notes.loadData}
            hoverDropCategoryId={externalFiles.hoverDropCategoryId}
            isFileDragActive={externalFiles.isFileDragActive}
            view={sidebarView}
            onViewChange={setSidebarView}
            onTogglePin={notes.handleTogglePin}
            onEncryptNote={encryption.handleEncryptNote}
            onLockNote={encryption.handleLockNote}
            onDecryptNote={(note) => void encryption.requestUnlock("note", note.id, true)}
            onEncryptCategory={encryption.handleEncryptCategory}
            onLockCategory={encryption.handleLockCategory}
            onDecryptCategory={(category) => void encryption.requestUnlock("category", category.id, true)}
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
              title={t("显示分组侧边栏")}
              aria-label={t("显示分组侧边栏")}
            >
              <Icon name="app-chevron-right" className="w-3.5 h-3.5" />
              <span className="sidebar-reveal-label">{t("分组")}</span>
            </button>
          </>
        )}

        {/* 主内容区：编辑器 + AI 面板（AI 面板作为 flex 兄弟节点，永远挤压而不遮挡） */}
        <div className="relative flex-1 flex overflow-hidden min-w-0">
          <div className="relative flex-1 bg-surface min-w-0 overflow-hidden">
            <Suspense
              fallback={
                <div className="h-full flex flex-col items-center justify-center gap-3">
                  <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                  <p className="text-sm text-faint">{t("正在加载编辑器...")}</p>
                </div>
              }
            >
              {/* 编辑器与欢迎页互斥：没有可展示的笔记时才出欢迎页，AI 面板不受影响 */}
              {editorNote ? (
                <div className="editor-layer">
                  {/* 预览层激活时不传外部文件路径，避免把 AI 内容写回磁盘 */}
                  <NoteEditor
                    note={editorNote}
                    editable={historyPreview === null}
                    historyPreview={
                      historyPreview
                        ? {
                            savedAt: formatHistoryTime(historyPreview.saved_at, locale),
                            onRollback: () => void properties.handleRollbackFromPreview(),
                            onExit: () => selection.setHistoryPreview(null),
                          }
                        : undefined
                    }
                    isTemporary={selection.tempNote != null && historyPreview === null}
                    onCloseTemporary={selection.handleCloseTemporary}
                    categories={categories.categories}
                    onSaveToCategory={notes.handleSavePreviewToCategory}
                    onSave={notes.handleSaveNote}
                    onDelete={notes.handleDeleteNote}
                    onCursorOffsetChange={handleCursorOffsetChange}
                    editorSettings={settings.appSettings.editor}
                    shortcutBindings={settings.appSettings.shortcuts}
                    onToggleAiPanel={settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined}
                    isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
                    onRegisterExport={exportState.registerExportNote}
                    externalFilePath={historyPreview || selection.tempNote ? null : externalFile?.path ?? null}
                    onSaveExternal={externalFiles.handleWriteExternal}
                    onSaveExternalToNote={externalFiles.handleSaveExternalToNote}
                    onCloseExternal={externalFiles.handleCloseExternalFile}
                    onRegisterFlushExternal={selection.registerFlushExternal}
                    onRegisterActions={registerEditorActions}
                    enableAI={settings.appSettings.general.enableAI}
                  />
                  {/* 选中文本浮出的 AI 工具条：纯浮层，不改编辑器内部结构；加密笔记不参与 AI */}
                  {settings.appSettings.general.enableAI && selectedNote?.enc_mode === 0 && (
                    <SelectionAiToolbar
                      onAddToChat={ai.handleSelectionAddRef}
                      noteId={selectedNote?.id ?? null}
                      noteTitle={selectedNote?.title || ""}
                    />
                  )}
                </div>
              ) : (
                <WelcomeDashboard
                  totalNotes={notes.notes.length}
                  categoryCount={categories.categories.length}
                  trashCount={trash.trashNotes.length}
                  recentNotes={notes.recentNotes}
                  recentFiles={recentFiles}
                  onOpenRecentFile={(path) => void externalFiles.openExternalFile(path)}
                  onRemoveRecentFile={removeRecentFile}
                  onCreateNote={() => notes.handleCreateNote()}
                  onOpenTrash={trash.handleOpenTrash}
                  onOpenTextFile={externalFiles.handleOpenTextFileDialog}
                  onSelectNote={selection.openNote}
                  onToggleAiPanel={settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined}
                  isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
                />
              )}
            </Suspense>
          </div>

          {/* AI 面板与编辑器是 flex 兄弟：展开时挤压编辑区而非覆盖；
              叠放层激活时清空笔记上下文，避免 AI 误读底下的真实笔记。
              首次展开才加载，之后保持挂载以保留会话状态。 */}
          {ai.aiPanelMounted && (
            <Suspense fallback={null}>
              <AIChatPanel
                isOpen={ai.aiPanelOpen && settings.appSettings.general.enableAI}
                onClose={() => {
                  ai.setAiPanelOpen(false);
                }}
                noteTitle={aiNoteContextBlocked ? "" : selectedNote?.title || ""}
                noteContent={aiNoteContextBlocked ? "" : selectedNote?.content || ""}
                currentNoteId={aiNoteContextBlocked ? null : selectedNote?.id ?? null}
                categories={categories.categories}
                currentNoteAiLevel={currentNoteAiLevel}
                aiPrompts={ai.aiPrompts}
                aiSettings={ai.aiSettings}
                onAiSettingsChange={(patch) => ai.setAiSettings((prev) => ({ ...prev, ...patch }))}
                editorSettings={settings.appSettings.editor}
                onOpenAiMemory={() => settings.openSettings("memory")}
                onInsertText={aiActions.handleAiInsertText}
                onReplaceContent={aiActions.handleAiReplaceContent}
                onOpenInEditor={selection.handleOpenInEditor}
                onOpenProviderSettings={() => {
                  settings.openSettings("provider");
                  aiApi.getAiProviders().then((list) => {
                    ai.setProviderModalProviders(list);
                    if (list.length > 0 && !ai.providerModalSelectedId) {
                      ai.setProviderModalSelectedId(list[0].id);
                    }
                  });
                }}
                enableAI={settings.appSettings.general.enableAI}
                isExternalFile={!!externalFile && !overlayActive}
                pendingNoteRef={ai.pendingNoteRef}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* 分类弹窗 */}
      <Modal isOpen={categories.showCategoryModal} onClose={() => categories.setShowCategoryModal(false)} title={categories.editingCategory ? t("编辑分类") : t("创建分类")}>
        <div className="space-y-4">
          <input
            type="text"
            value={categories.categoryName}
            onChange={(e) => categories.setCategoryName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") categories.handleSaveCategory(); }}
            placeholder={t("输入分类名称...")}
            autoFocus
            className="w-full px-4 py-2.5 input-modern text-sm"
          />
          <div className="flex gap-2 justify-end">
            <button onClick={() => categories.setShowCategoryModal(false)} className="btn-ghost px-4 py-2 text-sm">
              {t("取消")}
            </button>
            <button onClick={categories.handleSaveCategory} className="btn-primary px-4 py-2 text-sm">
              {t("保存")}
            </button>
          </div>
        </div>
      </Modal>

      {/* 删除分类弹窗 */}
      <Modal isOpen={categories.showDeleteCategoryModal} onClose={() => categories.setShowDeleteCategoryModal(false)} title={t("删除分类")}>
        <div className="space-y-4" onKeyDown={(e) => { if (e.key === "Enter") categories.confirmDeleteCategory(); }}>
          <p className="text-sm text-body">
            {t("确定要删除分类「{name}」吗？", { name: categories.deletingCategory?.name ?? "" })}
          </p>
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={categories.deleteCategoryNotes}
              onChange={(e) => categories.setDeleteCategoryNotes(e.target.checked)}
              className="w-4 h-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/20"
            />
            <span className="text-sm text-muted group-hover:text-body transition-colors">{t("同时删除该分类下的所有笔记")}</span>
          </label>
          <div className="flex gap-2 justify-end pt-1">
            <button onClick={() => categories.setShowDeleteCategoryModal(false)} className="btn-ghost px-4 py-2 text-sm">
              {t("取消")}
            </button>
            <button onClick={categories.confirmDeleteCategory} className="px-4 py-2 text-sm font-medium text-on-accent bg-danger rounded-xl hover:bg-danger-strong transition-colors shadow-xs">
              {t("删除")}
            </button>
          </div>
        </div>
      </Modal>

      {/* 回收站弹窗：固定宽高，列表长短不影响窗口尺寸（内容在内部滚动） */}
      <Modal isOpen={trash.showTrashModal} onClose={() => trash.setShowTrashModal(false)} title={t("回收站")} width={560} height={520}>
        <div className="flex h-full min-h-0 flex-col gap-3">
          {trash.trashNotes.length > 0 && (
            <div className="flex items-center justify-between gap-2 flex-shrink-0">
              <div className="flex items-center gap-1.5 text-xs text-faint">
                {trash.selectedTrashIds.size > 0
                  ? <span className="text-primary-500 font-medium">{t("共 {count} 条，已选 {selected} 条", { count: trash.trashNotes.length, selected: trash.selectedTrashIds.size })}</span>
                  : <span>{t("共 {count} 条", { count: trash.trashNotes.length })}</span>}
              </div>
              <div className="flex items-center gap-1.5">
                {trash.selectedTrashIds.size > 0 && (
                  <>
                    <button onClick={trash.handleRestoreSelected} className="px-2.5 py-1 text-xs font-medium bg-success text-on-accent rounded-lg hover:bg-success-strong transition-colors">
                      {t("还原选中")}
                    </button>
                    <button onClick={trash.handleDeleteSelected} className="px-2.5 py-1 text-xs font-medium bg-danger text-on-accent rounded-lg hover:bg-danger-strong transition-colors">
                      {t("删除选中")}
                    </button>
                  </>
                )}
                <button onClick={trash.handleEmptyTrash} className="px-2.5 py-1 text-xs font-medium text-danger border border-danger-line rounded-lg hover:bg-danger-soft transition-colors">
                  {t("清空回收站")}
                </button>
              </div>
            </div>
          )}
          <div className="flex-1 overflow-y-auto space-y-1">
            {trash.trashNotes.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12">
                <div className="w-12 h-12 rounded-2xl bg-surface-alt flex items-center justify-center mb-3">
                  <Icon name="app-trash-thin" className="w-6 h-6 text-faint-soft" />
                </div>
                <p className="text-sm text-faint">{t("回收站为空")}</p>
              </div>
            ) : (
              trash.trashNotes.map((note) => (
                <div key={note.id} className="flex items-center gap-2.5 p-2.5 rounded-xl hover:bg-app transition-colors group">
                  <input
                    type="checkbox"
                    checked={trash.selectedTrashIds.has(note.id)}
                    onChange={() => trash.toggleTrashSelect(note.id)}
                    disabled={note.enc_mode !== 0}
                    title={note.enc_mode !== 0 ? t("加密笔记需先永久解密才能删除") : undefined}
                    className="w-4 h-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/20 disabled:opacity-40"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-body truncate">
                      {note.is_locked && (
                        <Icon
                          name="security-sealed"
                          className="mr-1 inline h-3 w-3 -translate-y-px text-faint"
                        />
                      )}
                      {note.title || t("无标题")}
                    </p>
                    <p className="text-[11px] text-faint mt-0.5">{t("删除于 {date}", { date: trash.formatTrashDate(note.deleted_at) })}</p>
                  </div>
                  <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                    <button onClick={() => trash.handleRestoreNote(note.id)} className="toolbar-btn hover:bg-success-soft! hover:text-success!" title={t("还原")}>
                      <Icon name="app-restore" className="w-3.5 h-3.5" />
                    </button>
                    {note.enc_mode === 0 ? (
                      <button onClick={() => trash.handleDeletePermanent(note.id)} className="toolbar-btn hover:bg-danger-soft! hover:text-danger!" title={t("永久删除")}>
                        <Icon name="app-trash" className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => trash.handleDecryptTrashNote(note)}
                        className="toolbar-btn hover:bg-primary-50! hover:text-primary-600!"
                        title={note.enc_mode === 1 ? t("永久解密") : t("此笔记随所属分组加密，请在分组上操作")}
                      >
                        <Icon name="security-unlock" className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>

      {/* 统一设置窗口：锚点式布局，融合软件设置 / AI 设置 / 记忆 / 备份恢复。
          关闭即卸载（状态每次打开都会重置），因此可以按需加载 */}
      {settings.showSettings && (
        <Suspense fallback={null}>
          <SettingsModal
            isOpen={settings.showSettings}
            onClose={() => {
              // 主题落库有防抖，关窗时把最后一次取色冲下去，避免改完立刻关闭丢设置
              void flushThemeSettings();
              settings.setShowSettings(false);
            }}
            defaultSection={settings.settingsSection}
            appSettings={settings.appSettings}
            onAppSettingChange={settings.applyAppSetting}
            onResetAppSettings={settings.handleResetAppSettings}
            onResetEditorSettings={settings.handleResetEditorSettings}
            onResetThemeSettings={settings.handleResetThemeSettings}
            aiSettings={ai.aiSettings}
            onAiSettingsChange={ai.setAiSettings}
            aiProviders={ai.providerModalProviders}
            aiSelectedProviderId={ai.providerModalSelectedId}
            onAiProvidersChange={(list) => {
              ai.setProviderModalProviders(list);
              emitAppEvent("fastnote-providers-changed");
            }}
            onAiSelectedProviderChange={ai.setProviderModalSelectedId}
            aiPrompts={ai.aiPrompts}
            onAiPromptsChange={ai.setAiPrompts}
            categories={categories.categories}
            notes={notes.notes}
            onSetCategoryAiAccess={categories.handleSetCategoryAiAccess}
            onSetNoteAiAccess={notes.handleSetNoteAiAccess}
            theme={settings.theme}
            onThemeChange={settings.handleThemeChange}
            onRequestRootPasswordChange={() => {
              if (!encryption.encryptionStatus?.root_set) {
                showToast(t("尚未设置根密码"), "info");
                return;
              }
              encryption.setShowRootChange(true);
            }}
          />
        </Suspense>
      )}

      {/* 命令面板 / 快速跳转：Ctrl+P 跳转、Ctrl+Shift+P 命令 */}
      {palette.paletteOpen && (
        <Suspense fallback={null}>
          <CommandPalette
            key={palette.paletteNonce}
            open={palette.paletteOpen}
            initialMode={palette.paletteMode}
            notes={notes.notes}
            categories={categories.categories}
            tags={palette.paletteTags}
            commands={palette.paletteCommands}
            tabHints={palette.paletteTabHints}
            currentNoteId={selectedNote?.id ?? null}
            onClose={() => palette.setPaletteOpen(false)}
            onOpenNote={selection.openNote}
            onLoadTagNotes={(tag) => tagsApi.listNotesByTag(tag.name)}
          />
        </Suspense>
      )}

      {/* 导出分组：右键分组菜单进入，可导出为压缩包或电子书 */}
      {exportState.exportTarget && (
        <Suspense fallback={null}>
          <ExportCategoryModal
            target={exportState.exportTarget}
            onClose={() => exportState.setExportTarget(null)}
            onDone={notes.loadData}
          />
        </Suspense>
      )}

      {/* 属性弹窗：右键「笔记属性 / 分组属性」进入，可修改字段带行内编辑 */}
      {properties.propertiesTargetLive && (
        <Suspense fallback={null}>
          <PropertiesModal
            target={properties.propertiesTargetLive}
            categories={categories.categories}
            onClose={() => properties.setPropertiesTarget(null)}
            onRenameNote={notes.handleRenameNote}
            onMoveNote={notes.handleMoveNoteToCategory}
            onTogglePin={notes.handleTogglePin}
            onRenameCategory={categories.handleRenameCategory}
            onSetNoteAiAccess={notes.handleSetNoteAiAccess}
            onSetCategoryAiAccess={categories.handleSetCategoryAiAccess}
            enableAI={settings.appSettings.general.enableAI}
            tags={properties.noteTags}
            onAddTags={properties.handleAddTags}
            onRemoveTag={properties.handleRemoveTag}
            onRenameTag={properties.handleRenameTag}
            history={properties.noteHistory}
            onPreviewHistory={properties.handlePreviewHistory}
            onRollbackHistory={properties.handleRollbackNoteHistory}
            onDeleteHistory={properties.handleDeleteNoteHistory}
            onClearHistory={properties.handleClearNoteHistory}
            onCreateHistoryVersion={properties.handleCreateNoteHistoryVersion}
            onToggleHistoryPinned={properties.handleToggleNoteHistoryPinned}
            onEncryptNote={encryption.handleEncryptNote}
            onUnlockNote={(note) => void encryption.requestUnlock("note", note.id)}
            onLockNote={encryption.handleLockNote}
            onDecryptNote={(note) => void encryption.requestUnlock("note", note.id, true)}
            onEncryptCategory={encryption.handleEncryptCategory}
            onUnlockCategory={(category) => void encryption.requestUnlock("category", category.id)}
            onLockCategory={encryption.handleLockCategory}
            onDecryptCategory={(category) => void encryption.requestUnlock("category", category.id, true)}
          />
        </Suspense>
      )}

      {/* 系统文件拖拽落点提示：纯展示，pointer-events-none 不影响命中检测 */}
      {externalFiles.isFileDragActive && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none px-3.5 py-2 rounded-xl bg-tooltip/90 text-on-accent text-xs shadow-lg">
          {t("松开即可打开文件 · 拖到某个分组上可导入该分组")}
        </div>
      )}

      {/* 更新弹窗：手动检查到新版本时展示说明与操作 */}
      <UpdateDialog />

      {/* 根密码设置：首次启动未设置时强制弹出，onClose 是空操作 */}
      <RootSetupDialog isOpen={encryption.showRootSetup} onSubmit={encryption.handleRootSetup} />

      {/* 根密码修改：关于页作者名 5 连击进入 */}
      <RootChangeDialog
        isOpen={encryption.showRootChange}
        onClose={() => encryption.setShowRootChange(false)}
        onSubmit={encryption.handleRootChange}
      />

      {/* 加密笔记 / 分组：未缓存根 KEK 时弹窗内多要一次根密码 */}
      <EncryptDialog
        isOpen={encryption.encryptTarget !== null}
        mode={encryption.encryptTarget?.scope ?? "note"}
        requiresRoot={!encryption.encryptionStatus?.root_cached}
        noteCount={
          encryption.encryptTarget?.scope === "category"
            ? notes.notes.filter((n) => n.category_id === encryption.encryptTarget!.id && !n.is_deleted).length
            : undefined
        }
        onClose={() => encryption.setEncryptTarget(null)}
        onSubmit={encryption.handleEncryptSubmit}
      />

      {/* 解锁 / 永久解密：提示、已错次数与根密码可用性都来自 encryption_info */}
      <UnlockDialog
        isOpen={encryption.unlockTarget !== null}
        mode={encryption.unlockTarget?.scope ?? "note"}
        permanent={encryption.unlockTarget?.permanent ?? false}
        hint={encryption.unlockTarget?.info.hint ?? null}
        attempts={encryption.unlockTarget?.info.attempts ?? 0}
        rootAllowed={encryption.unlockTarget?.info.root_allowed ?? false}
        rootWrapped={encryption.unlockTarget?.info.root_wrapped ?? false}
        onClose={() => {
          pendingUnlockNoteRef.current = null;
          encryption.setUnlockTarget(null);
        }}
        onSubmit={encryption.handleUnlockSubmit}
      />

      {/* 通用确认弹窗：替换原生 confirm()，样式跟随主题 */}
      {confirmDialog}

      {/* 插件弹窗队列：ctx.ui.modal() 串行显示 */}
      <PluginModal />
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
