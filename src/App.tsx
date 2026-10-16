import { lazy, Suspense, useState, useEffect, useCallback, useRef } from "react";
import "@/App.css";
import type { Category, ExternalTextFile, Note } from "@/interface/note";
import type { AiPromptEntry, AiProvider, AiSettings } from "@/interface/ai";
import type { AppSettings } from "@/interface/settings";
import type { ExportTarget } from "@/interface/exportCategory";
import type { SettingsSection } from "@/interface/settingsModal";
import type { PropertiesTarget } from "@/interface/ui";
import { DEFAULT_AI_SETTINGS } from "@/config/aiDefaults";
import { DEFAULT_APP_SETTINGS } from "@/config/appDefaults";
import { loadAiConfig, saveSetting, saveAllSettings, savePrompts, ensureSettingsSeeded } from "@/stores/aiSettingsStore";
import { loadAppSettings, saveAppSetting, resetAppSettings } from "@/stores/appSettingsStore";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import * as notesApi from "@/api/notes";
import * as categoriesApi from "@/api/categories";
import * as aiApi from "@/api/ai";
import * as settingsApi from "@/api/settings";
import { Sidebar } from "@/components/layout/Sidebar";
import { Modal } from "@/components/common/Modal";
import { PropertiesModal } from "@/components/common/PropertiesModal";
import { ToastProvider, useToast } from "@/components/common/Toast";

import { WelcomeDashboard } from "@/components/layout/WelcomeDashboard";
import { AIChatPanel } from "@/components/ai/AIChatPanel";

import { SettingsModal } from "@/components/settings/SettingsModal";
import { ExportCategoryModal } from "@/components/data/ExportCategoryModal";
import { saveNoteAsFile } from "@/utils/noteFileExport";
import { useConfirm } from "@/components/common/ConfirmDialog";
import { Icon } from "@/components/common/Icon";

const NoteEditor = lazy(() =>
  import("@/components/editor/NoteEditor").then((module) => ({
    default: module.NoteEditor,
  }))
);

function AppContent() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [selectedNote, setSelectedNote] = useState<Note | null>(null);
  /** AI 回复的临时预览：只在编辑器里展示，绝不写入数据库（软件新开时为 null → 正常显示欢迎页） */
  const [tempNote, setTempNote] = useState<{ id: number; title: string; content: string } | null>(null);
  /** 临时预览的负 id 计数器：每次打开都换一个新 id，确保编辑器一定会刷新成新内容 */
  const tempNoteIdRef = useRef(-1);
  /**
   * 正在直接编辑的电脑文本文件：null 表示普通笔记模式。
   * 内容只留在界面上，改一个字就写回原文件（不落库）。
   */
  const [externalFile, setExternalFile] = useState<ExternalTextFile | null>(null);
  /** 电脑文件的负 id 计数器：与临时预览分区间，避免两边 id 撞车 */
  const externalFileIdRef = useRef(-1000000);
  /** 外部文件模式的镜像 ref：供 openNote 之类零依赖回调做判断 */
  const externalFileRef = useRef<ExternalTextFile | null>(null);
  /** NoteEditor 注册进来的「立即写回电脑文件」，切换/关闭前先 flush，避免丢掉最后一次编辑 */
  const flushExternalRef = useRef<(() => void) | null>(null);
  /** 系统文件拖拽经过时命中的分组 id（用于侧边栏高亮） */
  const [hoverDropCategoryId, setHoverDropCategoryId] = useState<number | null>(null);
  /** 是否有系统文件正拖拽在窗口上方（用于显示落点提示） */
  const [isFileDragActive, setIsFileDragActive] = useState(false);
  /** 分组列表的镜像 ref：拖拽回调里拿分组名做确认提示，避免频繁重注册监听 */
  const categoriesRef = useRef<Category[]>([]);
  /** 临时预览对应的伪笔记：id 为负数哨兵值，落库操作会被 NoteEditor 的 isTemporary 挡掉 */
  const tempPreviewNote: Note | null = tempNote
    ? { id: tempNote.id, title: tempNote.title, content: tempNote.content, category_id: null, created_at: "", updated_at: "", is_deleted: false, deleted_at: null, is_pinned: false }
    : null;
  /** 电脑文件对应的伪笔记：标题=文件名、内容=文件内容，同样不落库 */
  const externalFileNote: Note | null = externalFile
    ? { id: externalFile.id, title: externalFile.name, content: externalFile.content, category_id: null, created_at: "", updated_at: "", is_deleted: false, deleted_at: null, is_pinned: false }
    : null;
  /** 编辑器当前展示的内容：三层叠放，最上层优先 —— AI 预览 > 电脑文件 > 真实笔记 */
  const editorNote = tempPreviewNote ?? externalFileNote ?? selectedNote;
  /** 是否有叠放层（AI 预览 / 电脑文件）盖在真实笔记之上：此时 AI 面板不引用底层笔记 */
  const overlayActive = tempNote != null || externalFile != null;
  /**
   * AI 回复「在编辑器中打开」：把预览叠到最上层。
   * 底下的电脑文件 / 笔记保留不动，关闭预览后自然回到上一层。
   */
  const handleOpenInEditor = (title: string, content: string) => {
    // 预览会盖住当前层：先把电脑文件的待写入 flush 掉，避免丢最后一次编辑
    flushExternalRef.current?.();
    tempNoteIdRef.current -= 1;
    setTempNote({ id: tempNoteIdRef.current, title, content });
  };
  /** 关闭 AI 临时预览：露出下面一层（电脑文件或原笔记；都没有则回欢迎页） */
  const handleCloseTemporary = () => {
    setTempNote(null);
  };
  const [selectedCategoryId, setSelectedCategoryId] = useState<number | null>(null);
  const [sortBy, setSortBy] = useState<string>("created_at");
  const [sortOrder, setSortOrder] = useState<string>("asc");
  const [allNotesCount, setAllNotesCount] = useState<number>(0);
  const [searchQuery, setSearchQuery] = useState("");
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  const [expandedDrawer, setExpandedDrawer] = useState<number | 'all' | 'uncategorized' | null>(null);
  /** 侧边栏视图：'groups' 分组视图 / 'favorites' 收藏聚合视图 */
  const [sidebarView, setSidebarView] = useState<'groups' | 'favorites'>('groups');
  /** 右键「属性」查看的对象：null 表示弹窗关闭 */
  const [propertiesTarget, setPropertiesTarget] = useState<PropertiesTarget | null>(null);
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
  /** 统一设置窗口：null 表示关闭，否则为打开时的分区 */
  const [showSettings, setShowSettings] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  /** AI 服务商列表（统一设置里的服务商分区使用） */
  const [providerModalProviders, setProviderModalProviders] = useState<AiProvider[]>([]);
  const [providerModalSelectedId, setProviderModalSelectedId] = useState<number>(0);
  /** 软件设置：启动读库，读不到的键回退默认值 */
  const [appSettings, setAppSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  /** 软件设置是否已从数据库读回：读回前不碰开机启动快捷方式，避免用默认值覆盖用户设置 */
  const [appSettingsLoaded, setAppSettingsLoaded] = useState(false);
  /**
   * AI 记忆 / 前置提示词 + AI 全局设置。
   * 全部持久化在 SQLite 的 app_settings 表里：启动时读库，读不到的键回退默认值；
   * 首次运行会把老版本存在 localStorage 的设置自动迁移进库。
   */
  const [aiPrompts, setAiPrompts] = useState<AiPromptEntry[]>([]);
  const [aiSettings, setAiSettings] = useState<AiSettings>(DEFAULT_AI_SETTINGS);
  /** 设置是否已从数据库读回：读回前不写库，避免用默认值覆盖用户数据 */
  const [aiConfigLoaded, setAiConfigLoaded] = useState(false);
  /** 右键「导出分组」的目标（真实分组 / 默认分组 / 搜索分组归一成同一结构），非 null 时打开导出窗口 */
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);
  /** NoteEditor 注册进来的「保存笔记到文件」（等价 Ctrl+S），侧边栏右键菜单调用 */
  const exportNoteRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAiConfig()
      .then(({ settings, prompts, migrated }) => {
        if (cancelled) return;
        setAiSettings(settings);
        setAiPrompts(prompts);
        setAiConfigLoaded(true);
        // 首次运行：把每个设置项显式写入一行，方便排查"哪一项被改过"
        if (migrated) ensureSettingsSeeded(settings);
      })
      .catch((e) => {
        console.error('读取设置失败，使用默认值：', e);
        if (!cancelled) setAiConfigLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  // 设置变化后只写变化的那一项（读回之前不写，避免覆盖库里已有值）
  const prevSettingsRef = useRef<AiSettings | null>(null);
  useEffect(() => {
    if (!aiConfigLoaded) return;
    const prev = prevSettingsRef.current;
    prevSettingsRef.current = aiSettings;
    if (!prev) {
      // 第一次拿到设置：与默认值不同的项补齐写入，保证库里始终有一份完整记录
      saveAllSettings(aiSettings);
      return;
    }
    for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
      if (prev[field] !== aiSettings[field]) saveSetting(field, aiSettings[field]);
    }
  }, [aiSettings, aiConfigLoaded]);

  // 记忆列表变化后写库
  const prevPromptsRef = useRef<AiPromptEntry[] | null>(null);
  useEffect(() => {
    if (!aiConfigLoaded) return;
    const prev = prevPromptsRef.current;
    prevPromptsRef.current = aiPrompts;
    if (!prev) return;                       // 首次读回不入库
    if (JSON.stringify(prev) !== JSON.stringify(aiPrompts)) savePrompts(aiPrompts);
  }, [aiPrompts, aiConfigLoaded]);
  const { showToast } = useToast();
  const { confirm, confirmDialog } = useConfirm();
  const selectedNoteRef = useRef<Note | null>(selectedNote);
  const notesRef = useRef<Note[]>(notes);
  const focusTimerRef = useRef<number | null>(null);

  /* ------------------------------ 软件设置 ------------------------------ */

  /**
   * 启动时读取软件设置：优先读数据库，读不到的键回退 config/appDefaults.ts 的默认值。
   * 读取成功后同步到各处的运行时状态；「启动生效」的项（如清理回收站）只在这里执行一次。
   */
  useEffect(() => {
    let cancelled = false;
    loadAppSettings()
      .then((settings) => {
        if (cancelled) return;
        setAppSettings(settings);
        setAppSettingsLoaded(true);
        setSortBy(settings.view.sortBy);
        setSortOrder(settings.view.sortOrder);
        setIsSidebarCollapsed(settings.layout.sidebarCollapsed);
        setAiPanelOpen(settings.layout.aiPanelOpen);
        if (settings.general.cleanTrashOnStartup) {
          // 清空回收站：永久删除里面的全部笔记（仅在启动时执行一次）
          notesApi
            .getTrashNotes()
            .then((list) =>
              list.length > 0 ? notesApi.deleteMultipleNotesPermanently(list.map((n) => n.id)) : undefined,
            )
            .catch((e) => console.error("清空回收站失败：", e));
        }
      })
      .catch((e) => console.error("读取软件设置失败，使用默认值：", e));
    return () => { cancelled = true; };
  }, []);

  /**
   * 写入软件设置：更新内存状态并实时持久化到数据库。
   * 「实时生效」的项在这里额外同步运行时状态；「重启生效」的项（布局）只落库，不动当前界面。
   */
  const applyAppSetting = useCallback(
    (category: keyof AppSettings, field: string, value: boolean | number | string) => {
      setAppSettings((prev) => ({ ...prev, [category]: { ...prev[category], [field]: value } }));
      saveAppSetting(category as never, field as never, value as never);
      // 笔记列表排序需要立刻反映到运行时状态，否则要刷新后才会生效
      if (category === "view") {
        if (field === "sortBy") setSortBy(value as string);
        if (field === "sortOrder") setSortOrder(value as "asc" | "desc");
      }

      // 托盘图标变更：交由 Rust 侧创建/移除（托盘生命周期不归 webview 管）
      if (category === "general" && field === "trayEnabled") {
        settingsApi.setTrayEnabled(value as boolean).catch((e) => {
          console.error("切换托盘图标失败：", e);
        });
      }
    },
    [],
  );

  // 单实例、托盘、关闭到托盘、开机启动都由 Rust 侧处理（见 src-tauri/src/lib.rs）：
  // 前端不再持有托盘图标，也不再监听窗口关闭事件，避免窗口隐藏后 JS 失联导致托盘失效。

  /**
   * 开机自启动：只在「开机自启动」开关真正变化时才创建/删除启动文件夹里的快捷方式。
   * 首次读回设置时不动手（启动时由 Rust 的 sync_autostart_shortcut 兜底补齐缺失的快捷方式）。
   * 「开机后最小化到托盘」不进快捷方式，启动时读库决定，所以切它完全不会重写快捷方式。
   */
  const prevAutostartRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (!appSettingsLoaded) return;
    const { autostart } = appSettings.general;
    const prev = prevAutostartRef.current;
    prevAutostartRef.current = autostart;
    if (prev === null || prev === autostart) return;
    settingsApi.setAutostart(autostart);
  }, [appSettingsLoaded, appSettings.general.autostart]);

  /** 打开统一设置窗口，并定位到指定分区 */
  const openSettings = useCallback((section: SettingsSection = "general") => {
    setSettingsSection(section);
    setShowSettings(true);
  }, []);

  /** 恢复软件默认设置：删库里全部 app.config.* 键，运行时状态同步回默认 */
  const handleResetAppSettings = useCallback(async () => {
    const ok = await confirm({
      title: "恢复软件默认设置",
      message: "将把通用（含托盘图标、关闭窗口行为、开机自启动）、编辑器、笔记列表、界面布局等软件设置恢复为默认值（AI 设置不受影响）。",
      confirmText: "恢复默认",
      danger: true,
    });
    if (!ok) return;
    await resetAppSettings();
    const d = DEFAULT_APP_SETTINGS;
    setAppSettings(d);
    // 排序是实时生效项，立即同步；布局是启动项，只落默认值、下次启动才应用
    setSortBy(d.view.sortBy);
    setSortOrder(d.view.sortOrder);
    showToast("已恢复软件默认设置", "success");
  }, [confirm, showToast]);

  /* ------------------------- 运行时状态 ↔ 设置同步 ------------------------- */

  /** 排序字段：走 applyAppSetting，内部会同步本地的 sortBy 并触发列表重新拉取 */
  const handleSortByChange = useCallback(
    (value: string) => applyAppSetting("view", "sortBy", value),
    [applyAppSetting],
  );

  const handleToggleSortOrder = useCallback(
    () => applyAppSetting("view", "sortOrder", sortOrder === "asc" ? "desc" : "asc"),
    [sortOrder, applyAppSetting],
  );

  /** 打开笔记：记录当前分组，并让侧边栏展开/聚焦到这条笔记 */
  const openNote = useCallback((note: Note) => {
    // 打开真实笔记：撤掉上层叠着的电脑文件 / AI 预览（先 flush 未写完的文件内容）
    if (externalFileRef.current) {
      flushExternalRef.current?.();
      externalFileRef.current = null;
    }
    setTempNote(null);
    setExternalFile(null);
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

  /** 展开/收起 AI 对话面板（只改当前界面，不写设置） */
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
        categoriesApi.getCategories(),
        notesApi.getNotes(null, sortBy, sortOrder),
      ]);
      setCategories(cats);
      setNotes(allNotes);
      setAllNotesCount(allNotes.length);
      // 分组可能被"别处"删掉（例如 AI 调用了 deleteCategory 工具，走不到删除分组弹窗里
      // 那句重置逻辑）。这里统一校验一次，避免 selectedCategoryId 悬空，
      // 否则之后"新建笔记"会带着一个已不存在的分组 ID。
      setSelectedCategoryId((prev) => (prev !== null && !cats.some((c) => c.id === prev) ? null : prev));
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
  useEffect(() => {
    selectedNoteRef.current = selectedNote;
  }, [selectedNote]);
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
    // 新建笔记：撤掉上层叠着的电脑文件 / AI 预览
    if (externalFileRef.current) {
      flushExternalRef.current?.();
      externalFileRef.current = null;
    }
    setTempNote(null);
    setExternalFile(null);
    try {
      const note = await notesApi.createNote("无标题", "", targetCategory);
      setNotes((prev) => [...prev, note]);
      setSelectedNote(note);
      setSelectedCategoryId(targetCategory);
      setExpandedDrawer(targetCategory === null ? 'uncategorized' : targetCategory);
      window.dispatchEvent(new CustomEvent('fastnote-data-changed'));
    } catch (error) {
      console.error("Failed to create note:", error);
    }
  };

  /** 临时预览（AI 回复）另存为真实笔记：写库后打开它，叠放层一并清空 */
  const handleSavePreviewToCategory = async (categoryId: number | null, title: string, content: string) => {
    try {
      const note = await notesApi.createNote(title, content, categoryId);
      setNotes((prev) => [...prev, note]);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId === null ? 'uncategorized' : categoryId);
      setTempNote(null);
      setExternalFile(null);
      setSelectedNote(note);
      showToast("已保存为笔记", "success");
      window.dispatchEvent(new CustomEvent('fastnote-data-changed'));
    } catch (error) {
      console.error("Failed to save preview as note:", error);
      showToast("保存失败，请重试", "error");
      throw error;
    }
  };

  /* ------------------------- 电脑文件（拖入 / 打开） ------------------------- */

  // 让零依赖回调始终能拿到最新值
  useEffect(() => { externalFileRef.current = externalFile; }, [externalFile]);
  useEffect(() => { categoriesRef.current = categories; }, [categories]);

  /** NoteEditor 注册「立即写回」能力：切换 / 关闭文件前调用，避免丢掉最后一次编辑 */
  const registerFlushExternal = useCallback((fn: (() => void) | null) => {
    flushExternalRef.current = fn;
  }, []);

  /** 打开电脑上的文本文件：读失败（非文本/过大）只 toast 报错，不进入外部文件模式 */
  const openExternalFile = useCallback(async (path: string) => {
    // 换文件前先把上一份的待写入 flush 掉（此时回调仍指向旧路径）
    flushExternalRef.current?.();
    try {
      const file = await notesApi.readTextFile(path);
      externalFileIdRef.current -= 1;
      // 打开文件是最新的用户动作：先收起 AI 预览，笔记作为底层保留
      setTempNote(null);
      setExternalFile({ id: externalFileIdRef.current, ...file });
    } catch (e) {
      showToast(typeof e === "string" ? e : "打开文件失败", "error");
    }
  }, [showToast]);

  /** 关闭电脑文件：先 flush 写入，再露出下面一层（原笔记，或欢迎页） */
  const handleCloseExternalFile = useCallback(() => {
    flushExternalRef.current?.();
    setExternalFile(null);
  }, []);

  /** 外部文件另存为笔记：写库后切到新笔记，叠放层一并清空 */
  const handleSaveExternalToNote = async (categoryId: number | null, title: string, content: string) => {
    // 另存前先把最后一点改动同步回原文件
    flushExternalRef.current?.();
    try {
      const note = await notesApi.createNote(title, content, categoryId);
      setNotes((prev) => [...prev, note]);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId === null ? 'uncategorized' : categoryId);
      setTempNote(null);
      setExternalFile(null);
      setSelectedNote(note);
      showToast("已保存为笔记", "success");
      window.dispatchEvent(new CustomEvent('fastnote-data-changed'));
    } catch (error) {
      console.error("Failed to save external file as note:", error);
      showToast("保存失败，请重试", "error");
      throw error;
    }
  };

  /** 外部文件写回电脑：由编辑器防抖触发 */
  const handleWriteExternal = useCallback(async (content: string) => {
    const target = externalFileRef.current;
    if (!target) return;
    await notesApi.writeTextFile(target.path, content);
  }, []);

  /** 拖文件到分组：确认后把文件内容导入为该分组下的一条笔记 */
  const handleDropFileToCategory = useCallback(async (path: string, categoryId: number) => {
    const category = categoriesRef.current.find((c) => c.id === categoryId);
    const ok = await confirm({
      title: "导入文件到分组",
      message: `是否将文件内容导入分组「${category?.name ?? ""}」？`,
      confirmText: "导入",
    });
    if (!ok) return;
    try {
      const file = await notesApi.readTextFile(path);
      await notesApi.createNote(file.name, file.content, categoryId);
      setSelectedCategoryId(categoryId);
      setExpandedDrawer(categoryId);
      showToast("已导入到分组", "success");
      window.dispatchEvent(new CustomEvent('fastnote-data-changed'));
    } catch (e) {
      showToast(typeof e === "string" ? e : "导入失败", "error");
    }
  }, [confirm, showToast]);

  /** 欢迎页「打开文本文件」：系统文件选择框 → 打开（规则同拖入） */
  const handleOpenTextFileDialog = useCallback(async () => {
    try {
      const selected = await openFileDialog({ multiple: false, directory: false });
      if (typeof selected === "string") await openExternalFile(selected);
    } catch (e) {
      console.error("打开文件失败:", e);
      showToast("打开文件失败", "error");
    }
  }, [openExternalFile, showToast]);

  /**
   * 系统级文件拖拽监听：Tauri 替换了 webview 的拖放处理器，
   * 因此这里能拿到真实文件路径，并自行做落点命中检测。
   */
  useEffect(() => {
    // 纯浏览器预览（无 Tauri 运行时）下没有系统拖拽事件，直接跳过
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;
    const hitCategory = (clientX: number, clientY: number): number | null => {
      const el = document.elementFromPoint(clientX, clientY);
      const catEl = el?.closest("[data-drop-category]") as HTMLElement | null;
      if (!catEl) return null;
      const id = Number(catEl.dataset.dropCategory);
      return Number.isFinite(id) ? id : null;
    };
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setIsFileDragActive(true);
          const dpr = window.devicePixelRatio || 1;
          setHoverDropCategoryId(hitCategory(payload.position.x / dpr, payload.position.y / dpr));
        } else if (payload.type === "leave") {
          setIsFileDragActive(false);
          setHoverDropCategoryId(null);
        } else if (payload.type === "drop") {
          setIsFileDragActive(false);
          setHoverDropCategoryId(null);
          const path = payload.paths?.[0];
          if (!path) return;
          const dpr = window.devicePixelRatio || 1;
          const categoryId = hitCategory(payload.position.x / dpr, payload.position.y / dpr);
          if (categoryId !== null) void handleDropFileToCategory(path, categoryId);
          else void openExternalFile(path);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => console.error("注册文件拖拽监听失败:", e));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openExternalFile, handleDropFileToCategory]);

  const handleSaveNote = async (id: number, title: string, content: string, categoryId: number | null) => {
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

  /** 侧边栏笔记右键「保存笔记」，等价于 Ctrl+S。
   *  打开着的笔记用编辑器里的实时内容（可能还没落库）；没打开的笔记直接导出库里存的内容。 */
  const registerExportNote = useCallback((fn: (() => void) | null) => {
    exportNoteRef.current = fn;
  }, []);

  const handleExportNoteFromMenu = async (note: Note) => {
    if (selectedNote?.id === note.id && exportNoteRef.current) {
      exportNoteRef.current();
      return;
    }
    try {
      if (await saveNoteAsFile(note.title, note.content)) {
        showToast("导出成功！", "success");
      }
    } catch (e) {
      console.error("导出失败:", e);
      showToast("导出失败，请重试", "error");
    }
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
    const confirmed = await confirm({
      title: "删除笔记",
      message: "确定要将这条笔记移入回收站吗？",
      confirmText: "移入回收站",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.moveToTrash(noteId);
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
      const notes = await notesApi.getTrashNotes();
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
      await notesApi.restoreNote(id);
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
      await notesApi.deleteNotePermanently(id);
      setTrashNotes((prev) => prev.filter((n) => n.id !== id));
      setSelectedTrashIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
      showToast("笔记已永久删除", "success");
    } catch (error) {
      showToast("删除失败", "error");
    }
  };

  const handleEmptyTrash = async () => {
    if (trashNotes.length === 0) return;
    const confirmed = await confirm({
      title: "清空回收站",
      message: "确定要清空回收站吗？此操作不可恢复。",
      confirmText: "清空回收站",
      danger: true,
    });
    if (!confirmed) return;
    try {
      await notesApi.deleteMultipleNotesPermanently(trashNotes.map((n) => n.id));
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
    const confirmed = await confirm({
      title: "永久删除",
      message: "确定要永久删除选中的笔记吗？此操作不可恢复。",
      confirmText: "永久删除",
      danger: true,
    });
    if (!confirmed) return;
    const ids = Array.from(selectedTrashIds);
    try {
      await notesApi.deleteMultipleNotesPermanently(ids);
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
      if (editingCategory) { await categoriesApi.updateCategory(editingCategory.id, categoryName); }
      else { await categoriesApi.createCategory(categoryName); }
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

  /** 重命名分组（属性弹窗内联编辑调用） */
  const handleRenameCategory = async (category: Category, name: string) => {
    try {
      await categoriesApi.updateCategory(category.id, name);
      await loadData();
      showToast("已更新分组名称", "success");
    } catch {
      showToast("更新失败", "error");
    }
  };

  /** 切换收藏（置顶）：收藏的笔记在分组内置顶，并出现在收藏视图 */
  const handleTogglePin = async (note: Note) => {
    try {
      await notesApi.pinNote(note.id, !note.is_pinned);
      await loadData();
      showToast(note.is_pinned ? "已取消收藏" : "已收藏", "success");
    } catch {
      showToast("操作失败", "error");
    }
  };

  /** 把笔记移动到指定分组（null = 未分类） */
  const handleMoveNoteToCategory = async (note: Note, categoryId: number | null) => {
    if (note.category_id === categoryId) return;
    try {
      await notesApi.updateNote(note.id, note.title, note.content, categoryId);
      await loadData();
      setSelectedCategoryId(categoryId);
      showToast("移动成功", "success");
    } catch {
      showToast("移动失败", "error");
    }
  };

  const confirmDeleteCategory = async () => {
    if (!deletingCategory) return;
    try {
      await categoriesApi.deleteCategory(deletingCategory.id, deleteCategoryNotes);
      if (selectedCategoryId === deletingCategory.id) { setSelectedCategoryId(null); }
      await loadData();
      setShowDeleteCategoryModal(false);
      showToast("删除成功", "success");
    } catch (error) {
      console.error("Failed to delete category:", error);
      showToast("删除失败: " + error, "error");
    }
  };

  /** 属性弹窗展示的对象：用最新的 notes / categories 覆盖打开时的快照，弹窗内编辑后能立即反映新值 */
  const propertiesTargetLive: PropertiesTarget | null =
    propertiesTarget === null
      ? null
      : propertiesTarget.kind === "note"
        ? { kind: "note", note: notes.find((n) => n.id === propertiesTarget.note.id) ?? propertiesTarget.note }
        : propertiesTarget.kind === "category"
          ? { kind: "category", category: categories.find((c) => c.id === propertiesTarget.category.id) ?? propertiesTarget.category }
          : propertiesTarget;

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
            onSortByChange={handleSortByChange}
            sortOrder={sortOrder}
            onToggleSortOrder={handleToggleSortOrder}
            onSelectNote={openNote}
            onToggleDrawer={toggleDrawer}
            onToggleCollapse={() => setIsSidebarCollapsed(true)}
            isCollapsed={isSidebarCollapsed}
            onToggleAiPanel={appSettings.general.enableAI ? toggleAiPanel : undefined}
            isAiPanelOpen={appSettings.general.enableAI && aiPanelOpen}
            onCreateCategory={handleCreateCategory}
            onEditCategory={handleEditCategory}
            onDeleteCategory={handleDeleteCategory}
            onCreateNote={handleCreateNote}
            onMoveToCategory={handleMoveNoteToCategory}
            onDeleteNote={async (note) => {
              const confirmed = await confirm({
                title: "删除笔记",
                message: "确定要将这条笔记移入回收站吗？",
                confirmText: "移入回收站",
                danger: true,
              });
              if (!confirmed) return;
              try {
                await notesApi.moveToTrash(note.id);
                await loadData();
                if (selectedNote?.id === note.id) setSelectedNote(null);
                showToast("删除成功！", "success");
              } catch {
                showToast("删除失败", "error");
              }
            } }
            onOpenTrash={handleOpenTrash}
            onShowNoteProperties={(note) => setPropertiesTarget({ kind: "note", note })}
            onShowCategoryProperties={(category) => setPropertiesTarget({ kind: "category", category })}
            onShowGroupProperties={(name, noteCount) => setPropertiesTarget({ kind: "group", name, noteCount })}
            onOpenSettings={() => openSettings("general")}
            onExportGroup={setExportTarget}
            onSaveNote={handleExportNoteFromMenu}
            onNotesUpdated={loadData}
            hoverDropCategoryId={hoverDropCategoryId}
            isFileDragActive={isFileDragActive}
            view={sidebarView}
            onViewChange={setSidebarView}
            onTogglePin={handleTogglePin}
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
              <Icon name="app-chevron-right" className="w-3.5 h-3.5" />
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
              {editorNote ? (
                <div className="editor-layer">
                  <NoteEditor
                    note={editorNote}
                    isTemporary={tempNote != null}
                    onCloseTemporary={handleCloseTemporary}
                    categories={categories}
                    onSaveToCategory={handleSavePreviewToCategory}
                    onSave={handleSaveNote}
                    onDelete={handleDeleteNote}
                    onCursorOffsetChange={setEditorCursorOffset}
                    fontSize={appSettings.editor.fontSize}
                    ctrlScrollZoom={appSettings.editor.ctrlScrollZoom}
                    onToggleAiPanel={appSettings.general.enableAI ? toggleAiPanel : undefined}
                    isAiPanelOpen={appSettings.general.enableAI && aiPanelOpen}
                    onRegisterExport={registerExportNote}
                    externalFilePath={tempNote ? null : externalFile?.path ?? null}
                    onSaveExternal={handleWriteExternal}
                    onSaveExternalToNote={handleSaveExternalToNote}
                    onCloseExternal={handleCloseExternalFile}
                    onRegisterFlushExternal={registerFlushExternal}
                    enableAI={appSettings.general.enableAI}
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
                  onOpenTextFile={handleOpenTextFileDialog}
                  onSelectNote={openNote}
                  onToggleAiPanel={appSettings.general.enableAI ? toggleAiPanel : undefined}
                  isAiPanelOpen={appSettings.general.enableAI && aiPanelOpen}
                />
              )}
            </Suspense>
          </div>

          <AIChatPanel
            isOpen={aiPanelOpen}
            onClose={() => setAiPanelOpen(false)}
            noteTitle={overlayActive ? "" : selectedNote?.title || ""}
            noteContent={overlayActive ? "" : selectedNote?.content || ""}
            currentNoteId={overlayActive ? null : selectedNote?.id ?? null}
            aiPrompts={aiPrompts}
            aiSettings={aiSettings}
            onAiSettingsChange={(patch) => setAiSettings((prev) => ({ ...prev, ...patch }))}
            onOpenAiMemory={() => openSettings("memory")}
            onInsertText={handleAiInsertText}
            onReplaceContent={handleAiReplaceContent}
            onOpenInEditor={handleOpenInEditor}
            onOpenProviderSettings={() => {
              openSettings("provider");
              aiApi.getAiProviders().then((list) => {
                setProviderModalProviders(list);
                if (list.length > 0 && !providerModalSelectedId) {
                  setProviderModalSelectedId(list[0].id);
                }
              });
            }}
            enableAI={appSettings.general.enableAI}
            isExternalFile={!!externalFile && !overlayActive}
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
                  <Icon name="app-trash-thin" className="w-6 h-6 text-slate-300" />
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
                      <Icon name="app-restore" className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => handleDeletePermanent(note.id)} className="toolbar-btn hover:!bg-red-50 hover:!text-red-500" title="永久删除">
                      <Icon name="app-trash" className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </Modal>

      {/* 统一设置窗口：锚点式布局，融合软件设置 / AI 设置 / 记忆 / 备份恢复 */}
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        defaultSection={settingsSection}
        appSettings={appSettings}
        onAppSettingChange={applyAppSetting}
        onResetAppSettings={handleResetAppSettings}
        aiSettings={aiSettings}
        onAiSettingsChange={setAiSettings}
        aiProviders={providerModalProviders}
        aiSelectedProviderId={providerModalSelectedId}
        onAiProvidersChange={(list) => {
          setProviderModalProviders(list);
          window.dispatchEvent(new CustomEvent('fastnote-providers-changed'));
        }}
        onAiSelectedProviderChange={setProviderModalSelectedId}
        aiPrompts={aiPrompts}
        onAiPromptsChange={setAiPrompts}
      />

      {/* 导出分组：右键分组菜单进入，可导出为压缩包或电子书 */}
      <ExportCategoryModal
        target={exportTarget}
        onClose={() => setExportTarget(null)}
        onDone={loadData}
      />

      {/* 属性弹窗：右键「笔记属性 / 分组属性」进入，可修改字段带行内编辑 */}
      <PropertiesModal
        target={propertiesTargetLive}
        categories={categories}
        onClose={() => setPropertiesTarget(null)}
        onRenameNote={async (note, title) => {
          await handleSaveNote(note.id, title, note.content, note.category_id);
          showToast("已更新笔记标题", "success");
        }}
        onMoveNote={handleMoveNoteToCategory}
        onTogglePin={handleTogglePin}
        onRenameCategory={handleRenameCategory}
      />

      {/* 系统文件拖拽落点提示：纯展示，pointer-events-none 不影响命中检测 */}
      {isFileDragActive && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] pointer-events-none px-3.5 py-2 rounded-xl bg-slate-800/90 text-white text-xs shadow-lg">
          松开即可打开文件 · 拖到某个分组上可导入该分组
        </div>
      )}

      {/* 通用确认弹窗：替换原生 confirm()，样式跟随主题 */}
      {confirmDialog}
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
