/**
 * FastNote 根组件：只做外壳布局与各业务域 hook 的装配；领域状态全部在 src/features/** 内。
 * 跨域前向引用通过 ref 桥接（见下方 refs），副作用时机与拆分前完全一致。
 */
import { lazy, Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import "@/App.css";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import type { EncryptionScope } from "@/interface/system/encryption";
import { EncryptDialog, RootChangeDialog, RootSetupDialog, UnlockDialog } from "@/components/common/EncryptionDialogs";
import { Sidebar } from "@/components/layout/Sidebar";
import {
  InlineRenameProvider,
  type InlineRenameApi,
  type InlineRenameTarget,
} from "@/components/layout/inlineRename";
import type { Note } from "@/interface/note/note";
import { hasOpenModalLayer } from "@/lib/app/modalLayer";
import { setPlainKeyInEditable } from "@/features/shortcuts/runtime";
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
import { takeRecoveryNotice } from "@/api/system/system";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { flushThemeSettings } from "@/stores/themeStore";
import * as tagsApi from "@/api/note/tags";
import * as aiApi from "@/api/ai/ai";

import { useSettingsState, type SettingsRuntime } from "@/features/settings/useSettingsState";
import { useAiState } from "@/features/ai/useAiState";
import { useAiNoteActions } from "@/features/ai/useAiNoteActions";
import { useCategoriesState } from "@/features/categories/useCategoriesState";
import { useEditorTabs } from "@/features/tabs/useEditorTabs";
import { activeTabEditor, setActiveEditorKey, tabFlush } from "@/features/tabs/activeEditor";
import { tabTitleOf } from "@/features/tabs/types";
import { EditorTabs } from "@/components/layout/EditorTabs";
import { useNotesState } from "@/features/notes/useNotesState";
import { usePropertiesState } from "@/features/properties/usePropertiesState";
import { useTrashState } from "@/features/trash/useTrashState";
import { useEncryptionState } from "@/features/encryption/useEncryptionState";
import { useExternalFiles } from "@/features/externalFiles/useExternalFiles";
import { useExportState } from "@/features/export/useExportState";
import { usePalette, type PaletteTabsApi } from "@/features/palette/usePalette";
import { useShortcutAction } from "@/features/shortcuts/useShortcutAction";
import { applyShortcutOverrides } from "@/features/shortcuts/runtime";

/** 编辑器依赖 CodeMirror，体积较大：懒加载让首屏先出侧栏与欢迎页，Suspense 负责占位 */
const EditorPane = lazy(() =>
  import("@/components/editor/EditorPane").then((module) => ({ default: module.EditorPane })),
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

/** 历史版本时间格式化随编辑面板一起放到了 EditorPane（那里才知道标签的语言环境） */

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

  /**
   * 上次启动时数据库损坏被重建过 → 提示一次（后端取走即清空，不会反复弹）。
   *
   * 这条提示只有在「真的发生了」时才出现：用户看到的是空库 + 原文件保留的位置，
   * 而不是一个凭空打不开的应用。
   */
  useEffect(() => {
    void takeRecoveryNotice()
      .then((file) => {
        if (!file) return;
        showToast(
          t("上次启动时数据库文件损坏，已重建为空库。原文件保留为 {value1}，可在备份设置里恢复数据。", {
            value1: file,
          }),
          "error",
        );
      })
      .catch(() => undefined);
  }, [showToast, t]);

  /** 纯 UI 局部状态：侧栏折叠 / 唤出把手 / 侧栏视图 */
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isRevealHandleVisible, setIsRevealHandleVisible] = useState(false);
  const [sidebarView, setSidebarView] = useState<'groups' | 'favorites'>('groups');
  /**
   * 正在就地改名的目标（笔记或分组，互斥）。
   * F2、右键「重命名」、行内输入框三处入口共用同一份状态——分成两个状态的话
   * 同时为真时会出现两个输入框。
   */
  const [renameTarget, setRenameTarget] = useState<InlineRenameTarget | null>(null);
  /** 改名动作的实现（放在 ref 里，让 Context 值只随 renameTarget 变化） */
  const renameImplRef = useRef<Omit<InlineRenameApi, "target">>({
    start: () => {},
    commit: () => {},
    cancel: () => {},
  });

  /**
   * 编辑器命令式动作：按标签存放在模块里（见 features/tabs/activeEditor），
   * 这里用 getter 形状的 ref 读取，`current` 每次取都是激活标签的那一份——
   * 多标签下后挂载的隐藏实例不会把它顶掉，也不必等一次重渲染才更新。
   */
  const editorActionsRef = useMemo<{ current: NoteEditorActions | null }>(
    () => ({
      get current() {
        return activeTabEditor()?.actions ?? null;
      },
    }),
    [],
  );
  const editorCursorOffsetRef = useRef(0);
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
  /**
   * 编辑区标签：笔记 / 电脑文件 / AI 预览 / 历史版本各占一个标签。
   * 它对外仍暴露 `selectedNote` / `setSelectedNote` / `editorNote` / `overlayActive`，
   * 其余域（加密、笔记、属性、AI）据此继续工作，不必知道标签的存在。
   */
  const tabs = useEditorTabs({
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    requestUnlockRef,
    lockOnceUnlockedRef,
    flashFocusRef,
    notesRef,
    pendingUnlockNoteRef,
    restoreEnabled: settings.appSettings.layout.restoreTabs,
  });
  const notes = useNotesState({
    setCategories: categories.setCategories,
    categoriesRef: categories.categoriesRef,
    selectedCategoryId: categories.selectedCategoryId,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    selectedNoteRef: tabs.selectedNoteRef,
    setSelectedNote: tabs.setSelectedNote,
    notesRef,
    requestUnlockRef,
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

  /**
   * 「当前编辑器」指向激活标签：命令面板、Ctrl+S、侧栏右键「保存笔记」都从这里取。
   * 动作本身按标签存在模块里，这里只需把激活 key 同步过去。
   */
  setActiveEditorKey(tabs.activeKey);

  /**
   * 标签与笔记列表对齐：后台标签保存后列表变了，切回来若还用旧快照会把内容顶回去；
   * 笔记被删除或被加密锁定，对应标签也要跟着消失（明文副本不该留在标签栏里）。
   */
  useEffect(() => {
    if (!notes.dataLoaded) return;
    tabs.syncNotes(notes.notes);
  }, [notes.notes, notes.dataLoaded, tabs.syncNotes]);

  /** 首次加载完成后恢复上次的标签（设置「启动时恢复标签」打开时才恢复） */
  useEffect(() => {
    if (!notes.dataLoaded || !settings.appSettingsLoaded) return;
    tabs.restoreTabs(notes.notes);
  }, [notes.dataLoaded, notes.notes, settings.appSettingsLoaded, tabs.restoreTabs]);

  // 插件的 ctx.notes.getCurrent()：只暴露真实笔记（电脑文件 / AI 预览 / 未选中一律 null）
  useEffect(() => {
    pluginHost.setCurrentNoteProvider(() => {
      if (tabs.activeTab?.kind !== "note") return null;
      const note = tabs.selectedNoteRef.current;
      if (!note) return null;
      return { id: note.id, title: note.title, isLocked: Boolean(note.is_locked) };
    });
    return () => pluginHost.setCurrentNoteProvider(null);
  }, [tabs.activeTab?.kind, tabs.selectedNoteRef]);

  /**
   * 插件侧的 ctx.tabs：只做转发，真正的副作用（外部文件写回 / 加密锁回 / 换激活项）
   * 都留在标签域里，插件不需要也不应该关心。
   */
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  useEffect(() => {
    const findTab = (target: string) => {
      const current = tabsRef.current;
      return (
        current.tabs.find((tab) => tab.key === target) ??
        current.tabs.find((tab) => tab.kind === "note" && tab.note.id === target) ??
        null
      );
    };
    pluginHost.setTabsBridge({
      list: () =>
        tabsRef.current.tabs.map((tab) => ({
          key: tab.key,
          kind: tab.kind,
          noteId: tab.kind === "note" ? tab.note.id : null,
          title: tabTitleOf(tab),
          active: tab.key === tabsRef.current.activeKey,
        })),
      activate: (target) => {
        const tab = findTab(target);
        if (!tab) return false;
        tabsRef.current.activateTab(tab.key);
        return true;
      },
      close: (target) => {
        const tab = findTab(target);
        if (!tab) return false;
        tabsRef.current.closeTab(tab.key);
        return true;
      },
      open: (noteId) => {
        const note = notesRef.current.find((item) => item.id === noteId);
        if (!note) return false;
        tabsRef.current.openNote(note);
        return true;
      },
    });
    return () => pluginHost.setTabsBridge(null);
  }, []);

  const properties = usePropertiesState({
    notes: notes.notes,
    categories: categories.categories,
    setNotes: notes.setNotes,
    setSelectedNote: tabs.setSelectedNote,
    selectedNote: tabs.selectedNote,
    activeTab: tabs.activeTab,
    openHistoryTab: tabs.openHistoryTab,
    editorActionsRef,
    saveQueueRef: notes.saveQueueRef,
  });
  const trash = useTrashState({ loadData: notes.loadData, requestUnlockRef, confirm });
  const encryption = useEncryptionState({
    notes: notes.notes,
    setNotes: notes.setNotes,
    categories: categories.categories,
    setCategories: categories.setCategories,
    selectedNoteRef: tabs.selectedNoteRef,
    setSelectedNote: tabs.setSelectedNote,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    loadData: notes.loadData,
    showTrashModal: trash.showTrashModal,
    setTrashNotes: trash.setTrashNotes,
    setPropertiesTarget: properties.setPropertiesTarget,
    openNote: tabs.openNote,
    pendingUnlockNoteRef,
    autoLockMinutes: settings.appSettings.general.autoLockMinutes,
  });
  requestUnlockRef.current = encryption.requestUnlock;
  lockOnceUnlockedRef.current = encryption.lockOnceUnlocked;

  const externalFiles = useExternalFiles({
    openExternalTab: tabs.openExternalTab,
    pushRecentFile,
    categoriesRef: categories.categoriesRef,
    requestUnlockRef,
    defaultNoteAiAccess: ai.defaultNoteAiAccess,
    setNotes: notes.setNotes,
    setSelectedNote: tabs.setSelectedNote,
    setSelectedCategoryId: categories.setSelectedCategoryId,
    setExpandedDrawer: categories.setExpandedDrawer,
    confirm,
  });
  const aiActions = useAiNoteActions({
    selectedNoteRef: tabs.selectedNoteRef,
    setSelectedNote: tabs.setSelectedNote,
    setNotes: notes.setNotes,
    handleSaveNote: notes.handleSaveNote,
    editorCursorOffsetRef,
  });
  const exportState = useExportState({ selectedNote: tabs.selectedNote });

  const { selectedNote, editorNote, overlayActive } = tabs;

  /**
   * 就地改名的三个动作。实现放 ref、Context 值只随 `renameTarget` 变化：
   * 否则每次 App 重渲染（打字、保存、列表刷新）都会让侧栏每一行跟着重渲染。
   */
  renameImplRef.current = {
    start: (target: InlineRenameTarget) => {
      /*
       * 笔记：只在「这一行确实看不见」时才动抽屉——
       * - 侧栏被折叠 → 先展开，否则输入框在屏幕外；
       * - 已经展开着「全部笔记」→ 所有行都露着，别把用户塞回分组视图；
       * - 展开的正是它所在分组 → 保持。
       * 分组：标题行无论如何都在，不用动抽屉。
       */
      if (target.kind === "note") {
        if (isSidebarCollapsed) setIsSidebarCollapsed(false);
        const drawerKey = target.note.category_id === null ? "uncategorized" : target.note.category_id;
        const current = categories.expandedDrawer;
        if (current !== drawerKey && current !== "all") categories.setExpandedDrawer(drawerKey);
      } else if (isSidebarCollapsed) {
        setIsSidebarCollapsed(false);
      }
      setRenameTarget(target);
    },
    commit: (target: InlineRenameTarget, value: string) => {
      setRenameTarget(null);
      const next = value.trim();
      // 空名与「没改动」都不写库：留个空标题等于把笔记 / 分组变成无名条目
      if (!next) return;
      if (target.kind === "note") {
        if (next === target.note.title) return;
        void notes.handleRenameNote(target.note, next);
      } else {
        if (next === target.category.name) return;
        void categories.handleRenameCategory(target.category, next);
      }
    },
    cancel: () => setRenameTarget(null),
  };
  const renameApi = useMemo<InlineRenameApi>(
    () => ({
      target: renameTarget,
      start: (target) => renameImplRef.current.start(target),
      commit: (target, value) => renameImplRef.current.commit(target, value),
      cancel: () => renameImplRef.current.cancel(),
    }),
    [renameTarget],
  );

  /**
   * AI 面板眼里的「当前笔记」：激活标签是笔记就用它；预览 / 历史版本标签本身没有可写的正文，
   * 但档位要按**来源笔记**算——否则打开一篇「禁止 AI」笔记的预览，面板会从禁止退回完全可用。
   */
  const aiContextNote: Note | null = (() => {
    if (selectedNote) return selectedNote;
    const tab = tabs.activeTab;
    if (tab?.kind === "temp" && tab.sourceNoteId) {
      return notes.notes.find((note) => note.id === tab.sourceNoteId) ?? null;
    }
    if (tab?.kind === "history") {
      return notes.notes.find((note) => note.id === tab.entry.note_id) ?? null;
    }
    return null;
  })();

  /**
   * 当前笔记的生效档位 = min(笔记, 所属分组)；没有可用笔记时按"完全"处理（不限制面板本身）。
   * 加密内容不参与 AI：不论档位如何都按 0 处理。
   */
  const currentNoteAiLevel: AiAccessLevel = !aiContextNote
    ? 2
    : aiContextNote.enc_mode !== 0
      ? 0
      : ((Math.min(
          aiContextNote.ai_access,
          aiContextNote.category_id !== null
            ? categories.categories.find((c) => c.id === aiContextNote.category_id)?.ai_access ?? 2
            : 2,
        ) as AiAccessLevel) ?? 2);

  /** AI 面板是否应丢掉笔记上下文：叠放层激活，或当前笔记是加密内容（加密内容不参与 AI） */
  const aiNoteContextBlocked =
    overlayActive || (selectedNote != null && selectedNote.enc_mode !== 0);

  /**
   * 命令面板用的标签快照与操作。标题空白的笔记统一显示「无标题」，
   * 免得命令列表里出现一条没有名字的「切换到标签：」。
   */
  const paletteTabsApi: PaletteTabsApi = {
    items: tabs.tabs.map((tab) => ({
      key: tab.key,
      title: tabTitleOf(tab).trim() || t("无标题"),
      active: tab.key === tabs.activeKey,
      preview: tab.isPreview === true,
      kind: tab.kind,
    })),
    activeKey: tabs.activeKey,
    activate: tabs.activateTab,
    close: tabs.closeTab,
    pin: tabs.promoteTab,
    closeOthers: tabs.closeOtherTabs,
    closeLeft: tabs.closeTabsToLeft,
    closeRight: tabs.closeTabsToRight,
    closeAll: tabs.closeAllTabs,
  };

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
    tabsApi: paletteTabsApi,
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
  /* 标签间切换与关闭：走标签域，加密守卫 / 外部文件写回都由它统一处理 */
  useShortcutAction("app.nextTab", () => tabs.cycleTab(1));
  useShortcutAction("app.prevTab", () => tabs.cycleTab(-1));
  useShortcutAction("app.closeTab", () => tabs.closeActiveTab());
  /**
   * 保存键由宿主统一分发到激活标签：编辑器自己注册会被后挂载的隐藏标签顶掉。
   * 电脑文件写回原文件，其余（笔记 / AI 预览 / 历史版本）走导出到文件。
   */
  useShortcutAction("app.save", () => {
    const active = tabs.activeTab;
    if (active?.kind === "external") tabFlush(active.key)?.();
    else exportState.exportNoteRef.current?.();
  });

  useShortcutAction("app.renameNote", () => {
    // 每次都重新进入：改名状态卡住时（比如那一行被搜索过滤掉了）再按一次就能重来
    if (!selectedNote || hasOpenModalLayer()) return;
    // 搜索结果里不提供改名：结果行可能同时出现在多个分组里，改名入口只留给真实列表
    if (notes.searchQuery.trim().length > 0) return;
    renameImplRef.current.start({ kind: "note", note: selectedNote });
  });
  /**
   * Delete 只删「笔记列表中选中的那篇」。焦点在编辑器 / 输入框里时不触发
   * （那是删字，由快捷键运行时统一挡掉），有弹窗挂着也不触发。
   */
  useShortcutAction("app.deleteNote", () => {
    if (!selectedNote || hasOpenModalLayer()) return;
    // 裸键删除不弹确认：进回收站是可逆的，提示条上有「撤销」，比确认框快一步
    void notes.handleDeleteNoteFromSidebar(selectedNote, { skipConfirm: true });
  });

  /**
   * 「列表意图」跟随鼠标落点：最后一下点在笔记行上 → 裸键（Delete / F2）作用在列表；
   * 点到别处（正文、搜索框、命令面板…）立刻收回。放在捕获阶段，先清后由行点击重设。
   */
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest("[data-note-id]")) setPlainKeyInEditable(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, []);

  /**
   * 搜索词 / 侧栏视图一变，正在改名的笔记行可能已经不在列表里：
   * 直接退出笔记改名，避免「输入框不见了但状态还在」。分组头不受搜索影响，保持不动。
   */
  useEffect(() => {
    setRenameTarget((prev) => (prev?.kind === "note" ? null : prev));
  }, [notes.searchQuery, sidebarView]);

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
          {/* 就地改名状态下发给笔记行：四个渲染点共用同一份，不必层层传 props */}
          <InlineRenameProvider value={renameApi}>
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
              onSelectNote={(note, mode) => {
                // 从列表里选笔记：记下「用户此刻在列表上」，随后编辑器自动拿走焦点也不影响裸键。
                // mode 由行内的点击次数决定（单击预览 / 双击常驻），直接透传给标签域。
                setPlainKeyInEditable(true);
                tabs.openNote(note, mode);
              }}
              onToggleDrawer={categories.toggleDrawer}
              onToggleCollapse={() => setIsSidebarCollapsed(true)}
              isCollapsed={isSidebarCollapsed}
              onToggleAiPanel={settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined}
              isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
              onCreateCategory={categories.handleCreateCategory}
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
          </InlineRenameProvider>
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

        {/* 主内容区：标签栏 + 编辑器 + AI 面板（AI 面板作为 flex 兄弟节点，永远挤压而不遮挡） */}
        <div className="relative flex-1 flex overflow-hidden min-w-0">
          <div className="relative flex-1 bg-surface min-w-0 overflow-hidden flex flex-col">
            {/* 标签栏：没有标签时（欢迎页）整条不出现 */}
            <EditorTabs
              tabs={tabs.tabs}
              activeKey={tabs.activeKey}
              onActivate={(key) => {
                tabs.activateTab(key);
                // 点标签栏是「准备接着写」的信号：把焦点送进编辑器。
                // 从侧栏点开笔记则不抢焦点，留给列表（Delete / F2 要作用在列表上）。
                requestAnimationFrame(() => activeTabEditor()?.actions?.focus());
              }}
              onPromote={tabs.promoteTab}
              onClose={tabs.closeTab}
              onCloseOthers={tabs.closeOtherTabs}
              onCloseLeft={tabs.closeTabsToLeft}
              onCloseRight={tabs.closeTabsToRight}
              onCloseAll={tabs.closeAllTabs}
              onMoveTab={tabs.moveTab}
            />
            {/* 编辑层：标签面板绝对定位叠在同一块区域里，切换只切可见性 */}
            <div className="relative flex-1 min-h-0">
              {tabs.tabs.length === 0 ? (
                <WelcomeDashboard
                  totalNotes={notes.notes.length}
                  categoryCount={categories.categories.length}
                  trashCount={trash.trashNotes.length}
                  recentNotes={notes.recentNotes}
                  recentFiles={recentFiles}
                  showRecentList={settings.appSettings.layout.welcomeRecentList}
                  onOpenRecentFile={(path) => void externalFiles.openExternalFile(path)}
                  onRemoveRecentFile={removeRecentFile}
                  onCreateNote={() => notes.handleCreateNote()}
                  onOpenTrash={trash.handleOpenTrash}
                  onOpenTextFile={externalFiles.handleOpenTextFileDialog}
                  onSelectNote={tabs.openNote}
                  onToggleAiPanel={settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined}
                  isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
                />
              ) : (
                <Suspense
                  fallback={
                    <div className="h-full flex flex-col items-center justify-center gap-3">
                      <div className="w-8 h-8 border-2 border-primary-200 border-t-primary-500 rounded-full animate-spin" />
                      <p className="text-sm text-faint">{t("正在加载编辑器...")}</p>
                    </div>
                  }
                >
                  {/*
                   * 每个标签一个编辑器实例，首次激活才挂载、之后保持挂载（隐藏而非销毁）：
                   * 切回来时滚动位置、撤销历史、视图模式都还在，不会像单实例换内容那样被重置。
                   */}
                  {tabs.tabs.map((tab) => (
                    <EditorPane
                      key={tab.key}
                      tab={tab}
                      isActive={tab.key === tabs.activeKey}
                      categories={categories.categories}
                      editorSettings={settings.appSettings.editor}
                      shortcutBindings={settings.appSettings.shortcuts}
                      enableAI={settings.appSettings.general.enableAI}
                      isAiPanelOpen={settings.appSettings.general.enableAI && ai.aiPanelOpen}
                      onToggleAiPanel={
                        settings.appSettings.general.enableAI ? ai.toggleAiPanel : undefined
                      }
                      onSaveNote={notes.handleSaveNote}
                      onCursorOffsetChange={handleCursorOffsetChange}
                      onSavePreviewToCategory={notes.handleSavePreviewToCategory}
                      onWriteExternal={externalFiles.handleWriteExternal}
                      onSaveExternalToNote={externalFiles.handleSaveExternalToNote}
                      onRollbackHistory={properties.applyHistoryRollback}
                      onCloseTab={() => tabs.closeTab(tab.key)}
                      onEdit={() => tabs.promoteTab(tab.key)}
                    />
                  ))}
                </Suspense>
              )}
              {/* 选中文本浮出的 AI 工具条：纯浮层，不改编辑器内部结构；加密笔记不参与 AI */}
              {settings.appSettings.general.enableAI &&
                tabs.activeTab?.kind === "note" &&
                selectedNote?.enc_mode === 0 && (
                  <SelectionAiToolbar
                    onAddToChat={ai.handleSelectionAddRef}
                    noteId={selectedNote?.id ?? null}
                    noteTitle={selectedNote?.title || ""}
                  />
                )}
            </div>
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
                onOpenInEditor={(title, content) =>
                  tabs.handleOpenInEditor(title, content, aiContextNote?.id ?? null)
                }
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
                isExternalFile={tabs.activeTab?.kind === "external"}
                pendingNoteRef={ai.pendingNoteRef}
              />
            </Suspense>
          )}
        </div>
      </div>

      {/* 分类弹窗 */}
      <Modal isOpen={categories.showCategoryModal} onClose={() => categories.setShowCategoryModal(false)} title={t("创建分类")}>
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
          {categories.deletingCategory?.is_encrypted && (
            <div className="rounded-xl bg-danger-soft border border-line px-3 py-2 text-[11px] text-danger-strong leading-relaxed">
              {t("该分组已加密：组内笔记会一并永久删除（不进回收站、无法恢复）。加密分组的密钥跟随分组，只删分组会留下一堆打不开的密文，所以不能单独保留笔记；想保留请先「解密分组」。")}
            </div>
          )}
          <label
            className={
              categories.deletingCategory?.is_encrypted
                ? "flex items-center gap-2.5 cursor-not-allowed"
                : "flex items-center gap-2.5 cursor-pointer group"
            }
          >
            <input
              type="checkbox"
              checked={categories.deleteCategoryNotes}
              onChange={(e) => categories.setDeleteCategoryNotes(e.target.checked)}
              disabled={!!categories.deletingCategory?.is_encrypted}
              className="w-4 h-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/20 disabled:opacity-50"
            />
            <span className={`text-sm transition-colors ${categories.deletingCategory?.is_encrypted ? "text-faint" : "text-muted group-hover:text-body"}`}>
              {categories.deletingCategory?.is_encrypted
                ? t("删除组内全部笔记（加密分组必选）")
                : t("同时删除该分类下的所有笔记")}
            </span>
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
                  {/* 加密笔记也能勾选删除：删除只看 id，不需要明文 */}
                  <input
                    type="checkbox"
                    checked={trash.selectedTrashIds.has(note.id)}
                    onChange={() => trash.toggleTrashSelect(note.id)}
                    className="w-4 h-4 rounded border-line-strong text-primary-500 focus:ring-primary-500/20"
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
                    {note.enc_mode !== 0 && (
                      <button
                        onClick={() => trash.handleDecryptTrashNote(note)}
                        className="toolbar-btn hover:bg-primary-50! hover:text-primary-600!"
                        title={note.enc_mode === 1 ? t("永久解密") : t("此笔记随所属分组加密，请在分组上操作")}
                      >
                        <Icon name="security-unlock" className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button onClick={() => trash.handleDeletePermanent(note.id)} className="toolbar-btn hover:bg-danger-soft! hover:text-danger!" title={t("永久删除")}>
                      <Icon name="app-trash" className="w-3.5 h-3.5" />
                    </button>
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
            onOpenNote={tabs.openNote}
            onLoadTagNotes={(tag) => tagsApi.listNotesByTag(tag.name)}
            recentCommandIds={palette.recentCommandIds}
            onCommandRun={palette.recordCommand}
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
