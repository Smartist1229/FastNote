/**
 * 侧边栏：主窗口最左侧的导航区（宽度与折叠由外层 .sidebar-shell 控制）。
 *
 * 数据全部由 App 传入，且 categories / notes 必须是全量——抽屉里各分组的笔记都由 notes 派生，
 * 按选中分组过滤会让其它分组瞬间变空。本组件只做本地派生：分组 map、搜索命中、收藏聚合。
 *
 * 交互约束：
 * - expandedDrawer 由 App 持有，同一时刻只展开一个抽屉（手风琴）。
 * - searchQuery 非空时忽略 view，扁平展示三组搜索结果。
 * - 副作用：内部拖拽落点直接调 notesApi.updateNote 写 category_id，成功后 onNotesUpdated() 刷新全局。
 * - 主列表带正文（AI 需要读未打开的笔记），搜索直接在 notes 上匹配，无需额外请求。
 */
import { useI18n } from "@/i18n";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Category, Note } from "@/interface/note";
import type { SidebarProps } from "@/interface/sidebar";
import type { ContextMenuItem } from "@/interface/ui";
import * as notesApi from "@/api/notes";
import { useToast } from '@/components/common/Toast';
import { ContextMenu, useContextMenu } from '@/components/common/ContextMenu';
import { CategoryDrawer, UncategorizedDrawer, ChildNotesDrawer, DrawerNoteItem } from '@/components/layout/CategoryDrawer';
import { AiSparkleIcon } from '@/components/common/icons';
import { Icon } from '@/components/common/Icon';
import { buildGroupMenu, buildNoteMenu, isSearchGroupKind } from '@/config/contextMenus';
import type { GroupMenuKind } from '@/config/contextMenus';
import { buildNoteMatcher, findMatchRanges, searchNotes, type NoteSearchHit } from '@/lib/noteSearch';
import { useSemanticSearch } from '@/lib/useSemanticSearch';
/** 排序选项：value 直接作为后端排序字段使用 */
const SORT_OPTIONS = [{ value: 'updated_at', label: '更新时间' }, { value: 'created_at', label: '创建时间' }, { value: 'title', label: '标题' }];
/** 排序浮层宽度（px）：定位时用它把浮层夹在视口内 */
const SORT_MENU_WIDTH = 132;
const ORPHAN_GROUP_ID = -1; // 虚拟分组 ID：承载 category_id 指向已删除分组的遗留笔记
/* ---------- 侧边栏宽度（拖拽右边缘调节，规则与 AI 对话面板一致） ----------
 * 宽度不落库：每次启动都是默认值。理由是侧边栏宽度高度依赖窗口尺寸，
 * 记住一个窄窗口下的宽度，换到大屏反而显得局促，收益不如"拖一下就调好"。
 */
const MIN_SIDEBAR_WIDTH = 250;
const MAX_SIDEBAR_WIDTH = 480;
const DEFAULT_SIDEBAR_WIDTH = 272;
/** 主内容区保底宽度：侧边栏上限 = 可用宽度 − 该值，窗口越宽侧边栏越能放宽到 MAX_SIDEBAR_WIDTH */
const SIDEBAR_CONTENT_MIN_WIDTH = 560;
/** 搜索视图四个虚拟分组 → 展开状态 key */
const SEARCH_GROUP_KEY: Record<string, 'all' | 'title' | 'content' | 'semantic'> = {
  'search-all': 'all',
  'search-title': 'title',
  'search-content': 'content',
  'search-semantic': 'semantic',
};
/** 右键命中的分组：真实分组带 category，默认分组 / 搜索分组带名称与笔记列表 */
type GroupMenuTarget =
  | { kind: 'category'; category: Category; notes: Note[] }
  | { kind: Exclude<GroupMenuKind, 'category'>; name: string; notes: Note[] };
/**
 * 侧边栏主体。
 *
 * 关键 props：
 * - selectedNoteId / focusNoteId：前者是当前打开项，后者只在 AI 打开笔记时短暂置位（用于滚动定位）。
 * - hoverDropCategoryId / isFileDragActive：由 App 的系统级文件拖拽事件驱动，与内部指针拖拽互不干扰。
 * - onExportGroup / onSaveNote / onMoveToCategory 等均透传给右键菜单，本组件不直接改笔记内容。
 */
export const Sidebar: React.FC<SidebarProps> = ({
  categories,
  notes,
  allNotesCount,
  selectedCategoryId,
  selectedNoteId,
  expandedDrawer,
  focusNoteId,
  searchQuery,
  onSearchQueryChange,
  useRegex = false,
  onRegexChange,
  semanticEnabled = false,
  semanticIndexing = false,
  onCommitSearch,
  searchHistory = [],
  onRemoveSearchHistory,
  onClearSearchHistory,
  sortBy,
  onSortByChange,
  sortOrder,
  onToggleSortOrder,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  view,
  onViewChange,
  onToggleDrawer,
  onToggleCollapse,
  isCollapsed = false,
  onToggleAiPanel,
  isAiPanelOpen = false,
  onOpenSettings,
  onExportGroup,
  onSaveNote,
  onCreateCategory,
  onEditCategory,
  onDeleteCategory,
  onCreateNote,
  onMoveToCategory,
  onOpenTrash,
  onShowNoteProperties,
  onShowCategoryProperties,
  onShowGroupProperties,
  onNotesUpdated,
  hoverDropCategoryId = null,
  isFileDragActive = false,
}) => {
  const { t } = useI18n();
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();
  const { showToast } = useToast();
  /** 排序下拉浮层：位置在点击时按按钮 rect 算出，用 fixed 定位避免被列表滚动容器裁掉 */
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState<{ open: boolean; top: number; left: number; width: number }>({ open: false, top: 0, left: 0, width: 0 });
  const currentSortLabel = SORT_OPTIONS.find(o => o.value === sortBy)?.label || "更新时间";
  /** 当前右键命中的笔记；与 groupMenuRef 二选一，两者都有值时优先按分组菜单渲染 */
  const noteContextMenuRef = useRef<Note | null>(null);
  /** 侧边栏滚动容器 ref：拖动笔记时自动滚动 */
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  /** 自动滚动的动画帧 id，用于清理 */
  const autoScrollRafRef = useRef<number | null>(null);
  /** 当前指针 Y 坐标：由 pointermove 写入，由自动滚动的 rAF 循环读取 */
  const dragYRef = useRef<number | null>(null);
  /* ---------- 内部拖拽：笔记 → 分组（指针事件） ---------- */
  // Tauri 已禁用系统级 HTML5 拖放，因此用 pointerdown/move/up 自行实现；
  // 落点用 document.elementFromPoint 命中 [data-drop-category]，不依赖 dragover 事件。
  /** 按下时命中的笔记 id（尚未进入拖拽） */
  const pointerNoteIdRef = useRef<number | null>(null);
  /** 按下起点，用于判断是否超过拖拽阈值 */
  const pointerStartRef = useRef<{ x: number; y: number } | null>(null);
  /** 是否已真正进入拖拽（超过阈值） */
  const isPointerDraggingRef = useRef(false);
  /** 刚结束一次拖拽：抑制随之而来的 click，避免拖完又顺手打开笔记 */
  const suppressClickRef = useRef(false);
  /** 被拖笔记的标题（用于浮层显示） */
  const pointerTitleRef = useRef('');
  /** 拖拽浮层（跟随指针显示笔记标题） */
  const [dragGhost, setDragGhost] = useState<{ x: number; y: number; title: string } | null>(null);
  /** 指针拖拽当前悬停的分组 id（内部拖拽高亮） */
  const [dragHoverCategoryId, setDragHoverCategoryId] = useState<number | null>(null);
  /** 搜索历史下拉是否展开（聚焦时展开，失焦延后收起） */
  const [historyOpen, setHistoryOpen] = useState(false);
  const isSearching = searchQuery.trim().length > 0;
  /** 停止自动滚动并清空指针坐标 */
  const stopAutoScroll = () => {
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    dragYRef.current = null;
  };
  /**
   * 指针靠近容器上下边缘 60px 时自动滚动。
   * 用 rAF 而不是在 pointermove 里滚动：指针停在边缘不动时也要持续滚，且逐帧推进更平滑。
   * 速度随贴近程度线性增长（1 → 16px/帧），离开边缘即退出循环，等下一次 pointermove 重新拉起。
   */
  const startAutoScroll = (container: HTMLDivElement) => {
    if (autoScrollRafRef.current) return; // 已在滚动中
    const loop = () => {
      const mouseY = dragYRef.current;
      if (mouseY === null) {
        autoScrollRafRef.current = null;
        return;
      }
      const rect = container.getBoundingClientRect();
      const threshold = 60;
      const edgeDist = Math.min(mouseY - rect.top, rect.bottom - mouseY);
      if (edgeDist < threshold && rect.height > 0) {
        const speedRatio = Math.max(0, (threshold - edgeDist) / threshold);
        const baseSpeed = 1;
        const maxSpeed = 16;
        const speed = baseSpeed + speedRatio * (maxSpeed - baseSpeed);
        const direction = mouseY - rect.top < rect.height / 2 ? -1 : 1;
        container.scrollTop += speed * direction;
        // 离边缘越近滚动越快，继续循环
        autoScrollRafRef.current = requestAnimationFrame(loop);
      } else {
        // 不在边缘：停止循环，等待下一次 onDragOver 重新启动
        autoScrollRafRef.current = null;
      }
    };
    autoScrollRafRef.current = requestAnimationFrame(loop);
  };
  /** 分组 id → 笔记列表；额外的一桶（ORPHAN_GROUP_ID）收留分组已删除的孤儿笔记 */
  const categorized = useMemo(() => {
    const map = new Map<number, Note[]>();
    for (const category of categories) {
      map.set(
        category.id,
        notes.filter((n) => n.category_id === category.id)
      );
    }
    const categoryIds = new Set(categories.map((c) => c.id));
    // 分组已被删除但笔记的 category_id 仍指向它的历史遗留数据
    map.set(
      ORPHAN_GROUP_ID,
      notes.filter((n) => n.category_id !== null && !categoryIds.has(n.category_id as number))
    )
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, notes]);
  const uncategorizedNotes = useMemo(
    () => notes.filter((n) => n.category_id === null),
    [notes]
  );
  /** 收藏聚合视图：所有已收藏笔记（沿用后端排序：置顶优先 + 当前排序字段） */
  const favoriteNotes = useMemo(() => notes.filter((n) => n.is_pinned), [notes]);
  /**
   * 搜索：主列表已经带正文，直接在 notes 上匹配，不再额外拉数据。
   *
   * 匹配、片段、命中区间统一由 lib/noteSearch 计算（是否正则也在这里生效），
   * 三个虚拟分组共用同一批结果，避免"标题组和正文组判定不一致"这种不一致。
   */
  const { hits: searchHits, invalid: invalidRegex } = useMemo(
    () => searchNotes(notes, searchQuery.trim(), useRegex),
    [notes, searchQuery, useRegex],
  );
  /** 语义命中异步补位：关键词结果不等它，避免慢请求把搜索框卡住 */
  const { hits: semanticHits, loading: semanticLoading } = useSemanticSearch(
    searchQuery.trim(),
    semanticEnabled,
    notes,
  );
  const noteById = useMemo(() => new Map(notes.map((note) => [note.id, note])), [notes]);
  /**
   * 语义命中转成与关键词命中同构的结构：抽屉只认 NoteSearchHit。
   * 语义命中本身没有位置信息，但片段里若字面出现查询词，顺手标黄。
   */
  const semanticHitInfos = useMemo(() => {
    const keywordIds = new Set(searchHits.map((h) => h.note.id));
    const matcher = buildNoteMatcher(searchQuery.trim(), false);
    const out: NoteSearchHit[] = [];
    for (const hit of semanticHits) {
      if (out.length >= 15) break;
      // 关键词已经命中过的笔记不再放入语义组，两组的「全部」才不会被重复项撑长
      if (keywordIds.has(hit.note_id)) continue;
      const note = noteById.get(hit.note_id);
      if (!note) continue;
      out.push({
        note,
        titleRanges: [],
        snippetRanges: findMatchRanges(matcher, hit.snippet),
        snippet: hit.snippet,
        titleOnly: false,
      });
    }
    return out;
  }, [semanticHits, searchHits, noteById, searchQuery]);
  const semanticMatches = useMemo(() => semanticHitInfos.map((h) => h.note), [semanticHitInfos]);
  /** id → 命中信息：关键词与语义合并，列表据此渲染标题/片段高亮 */
  const hitMap = useMemo(() => {
    const map = new Map<number, NoteSearchHit>();
    for (const hit of searchHits) map.set(hit.note.id, hit);
    for (const hit of semanticHitInfos) map.set(hit.note.id, hit);
    return map;
  }, [searchHits, semanticHitInfos]);
  /** 搜索视图「全部搜索结果」：关键词命中在前，语义补位在后 */
  const searchMatches = useMemo(
    () => [...searchHits.map((h) => h.note), ...semanticMatches],
    [searchHits, semanticMatches],
  );
  /** 搜索视图「标题命中」：标题里有命中的笔记 */
  const titleMatches = useMemo(
    () => searchHits.filter((h) => h.titleRanges.length > 0).map((h) => h.note),
    [searchHits],
  );
  /** 搜索视图「正文命中」：标题未命中、但正文包含关键词的笔记（与标题命中互补，避免重复） */
  const contentMatches = useMemo(
    () => searchHits.filter((h) => h.titleRanges.length === 0).map((h) => h.note),
    [searchHits],
  );
  /** 搜索视图内各默认分组的展开状态：默认收起，先看各组的命中数量 */
  const [searchGroupOpen, setSearchGroupOpen] = useState({ all: false, title: false, content: false, semantic: false });
  const toggleSearchGroup = (key: 'all' | 'title' | 'content' | 'semantic') =>
    setSearchGroupOpen((s) => ({ ...s, [key]: !s[key] }));
  // 每次开始新的搜索都回到收起状态，避免上一次展开的组把结果全铺开
  useEffect(() => {
    if (isSearching) setSearchGroupOpen({ all: false, title: false, content: false, semantic: false });
  }, [isSearching]);
  /** 笔记右键：记录目标并弹出菜单（搜索视图 / 收藏视图共用） */
  const handleNoteContextMenu = (e: React.MouseEvent, note: Note) => {
    noteContextMenuRef.current = note;
    handleContextMenu(e);
  };
  /** 右键命中的分组（真实分组 / 默认分组 / 搜索视图分组） */
  const groupMenuRef = useRef<GroupMenuTarget | null>(null);
  /** 分组菜单：菜单项差异交给 config/contextMenus 的构建函数 */
  const buildGroupContextMenu = (target: GroupMenuTarget): ContextMenuItem[] => {
    const name = target.kind === 'category' ? target.category.name : t(target.name);
    const isSearchGroup = isSearchGroupKind(target.kind);
    const isExpanded =
      target.kind === 'category'
        ? expandedDrawer === target.category.id
        : target.kind === 'all'
          ? expandedDrawer === 'all'
          : target.kind === 'uncategorized'
            ? expandedDrawer === 'uncategorized'
            : searchGroupOpen[SEARCH_GROUP_KEY[target.kind]];
    return buildGroupMenu(target.kind, isExpanded, {
      onToggleDrawer: () => {
        switch (target.kind) {
          case 'category':
            onToggleDrawer(target.category.id);
            break;
          case 'all':
          case 'uncategorized':
            onToggleDrawer(target.kind);
            break;
          default:
            toggleSearchGroup(SEARCH_GROUP_KEY[target.kind]);
            break;
        }
      },
      onCreateNote: () => onCreateNote(target.kind === 'category' ? target.category.id : null),
      onExport: () =>
        onExportGroup({
          name,
          defaultFileName: isSearchGroup ? t('"{query}" 的搜索结果', { query: searchQuery.trim() }) : name,
          notes: target.notes,
        }),
      onRename: () => {
        if (target.kind === 'category') onEditCategory(target.category);
      },
      onCreateCategory,
      onDelete: () => {
        if (target.kind === 'category') onDeleteCategory(target.category);
      },
      onShowProperties: () => {
        if (target.kind === 'category') onShowCategoryProperties(target.category);
        else onShowGroupProperties(target.name, target.notes.length);
      },
    }).map((item) => ({ ...item, label: t(item.label) }));
  };
  /** 笔记菜单：交给 config/contextMenus 的构建函数 */
  const buildNoteContextMenu = (note: Note): ContextMenuItem[] =>
    buildNoteMenu(note, categories, {
      onOpenNote: () => onSelectNote(note),
      onSaveNote: () => onSaveNote(note),
      onMoveToCategory: (categoryId) => onMoveToCategory(note, categoryId),
      onTogglePin: () => onTogglePin(note),
      onDeleteNote: () => onDeleteNote(note),
      onShowProperties: () => onShowNoteProperties(note),
    }).map((item) => ({
      ...item,
      label: t(item.label),
      // Only the first submenu entry is built-in; the remaining names belong to users.
      submenu: item.submenu?.map((sub, index) => index === 0 ? { ...sub, label: t(sub.label) } : sub),
    }));
  /**
   * 拖拽落点写库：侧边栏里唯一直接改数据的地方。
   * 落点与笔记当前分组相同时直接返回——否则会白白触发一次 update + 全量刷新，列表还会闪一下。
   */
  const handleDropToCategory = async (noteIdStr: string, categoryId: number | null) => {
    const noteId = parseInt(noteIdStr, 10);
    if (isNaN(noteId)) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note || note.category_id === categoryId) return;
    try {
      await notesApi.updateNote(note.id, note.title, note.content, categoryId);
      showToast(t("笔记分组已更新"), 'success');
      await onNotesUpdated();
    } catch {
      showToast(t("更新笔记分组失败"), 'error');
    }
  };
  /** 供指针事件回调调用，始终指向最新一次渲染的 handler（避免闭包里的 notes 过期） */
  const dropToCategoryRef = useRef(handleDropToCategory);
  dropToCategoryRef.current = handleDropToCategory;
  /** 指针坐标处命中的分组 id（用 elementFromPoint 做落点检测） */
  const findCategoryIdAt = (x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const catEl = el?.closest('[data-drop-category]') as HTMLElement | null;
    if (!catEl) return null;
    const id = Number(catEl.dataset.dropCategory);
    return Number.isFinite(id) ? id : null;
  };
  /** 笔记卡片上按下：先记录候选，等移动超过阈值才真正进入拖拽（不影响单击打开） */
  const handleNotePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement;
    if (target.closest('button')) return; // 点删除等按钮不算拖拽
    const noteEl = target.closest('[data-note-id]') as HTMLElement | null;
    if (!noteEl) return;
    const id = Number(noteEl.dataset.noteId);
    if (!Number.isFinite(id)) return;
    pointerNoteIdRef.current = id;
    pointerStartRef.current = { x: e.clientX, y: e.clientY };
    isPointerDraggingRef.current = false;
    pointerTitleRef.current = noteEl.querySelector('h4')?.textContent || t("无标题");
  };
  // 指针拖拽：window 级监听只绑定一次（空依赖数组），可变状态全放 ref，避免反复解绑重绑。
  // 位移不足 5px 视为点击，保证单击打开笔记不受影响。
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const start = pointerStartRef.current;
      if (pointerNoteIdRef.current === null || !start) return;
      if (!isPointerDraggingRef.current) {
        if (Math.abs(e.clientX - start.x) < 5 && Math.abs(e.clientY - start.y) < 5) return;
        isPointerDraggingRef.current = true;
        document.body.style.userSelect = 'none'; // 拖拽期间禁止选中文本
      }
      e.preventDefault();
      dragYRef.current = e.clientY;
      const container = sidebarScrollRef.current;
      if (container) startAutoScroll(container);
      setDragGhost({ x: e.clientX, y: e.clientY, title: pointerTitleRef.current });
      setDragHoverCategoryId(findCategoryIdAt(e.clientX, e.clientY));
    };
    const onUp = (e: PointerEvent) => {
      const noteId = pointerNoteIdRef.current;
      const wasDragging = isPointerDraggingRef.current;
      const categoryId = wasDragging ? findCategoryIdAt(e.clientX, e.clientY) : null;
      pointerNoteIdRef.current = null;
      pointerStartRef.current = null;
      isPointerDraggingRef.current = false;
      document.body.style.userSelect = '';
      setDragGhost(null);
      setDragHoverCategoryId(null);
      stopAutoScroll();
      if (wasDragging) {
        // 拖拽结束后紧跟着的 click 要吞掉，避免又打开笔记
        suppressClickRef.current = true;
        window.setTimeout(() => { suppressClickRef.current = false; }, 0);
        if (noteId !== null && categoryId !== null) {
          void dropToCategoryRef.current(String(noteId), categoryId);
        }
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const categoryCount = categories.length;
  /* ---------- 宽度拖拽（右边缘） ----------
   * 宽度本身挂在外层 .sidebar-shell 上（折叠动画在那里，auto→0 无法过渡），
   * 所以本组件只负责把结果写成 --sidebar-w 变量，由 CSS 消费。
   */
  const sidebarRef = useRef<HTMLDivElement>(null);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  /** 可用宽度：主窗口行的实际宽度（不含侧边栏自身，否则会形成"改宽度→回调→再改宽度"的循环） */
  const [availWidth, setAvailWidth] = useState(0);
  const resizingRef = useRef(false);
  /** 上一次实际写进 --sidebar-w 的值：尺寸没变就不重写，避免 ResizeObserver 反复触发样式写入 */
  const writtenWidthRef = useRef(0);
  /** 刚开始拖拽时补一次"可用宽度"实测：窗口如果是在折叠期间被缩小的，ResizeObserver 那会儿是跳过的 */
  const measureAvailWidth = useCallback(() => {
    const host = sidebarRef.current?.parentElement?.parentElement;
    return host ? host.clientWidth : 0;
  }, []);  /** 折叠状态：折叠时外壳宽 0，此时不要按"可用宽度"夹取，否则会记下一个被压扁的宽度 */
  const isCollapsedRef = useRef(isCollapsed);
  isCollapsedRef.current = isCollapsed;
  useLayoutEffect(() => {
    if (isCollapsed) return;
    const host = sidebarRef.current?.parentElement?.parentElement;
    if (!host) return;
    // 只监听父容器的内容盒：外壳宽度变化属于"自己的变化"，不参与观测，否则可能自激
    const update = () => {
      if (isCollapsedRef.current) return;
      const next = host.clientWidth;
      setAvailWidth((prev) => (prev === next ? prev : next));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [isCollapsed]);
  /** 上限：可用宽度 − 内容区保底；窗口越窄上限越小，正文永远不会被挤变形 */
  const maxSidebarWidth = availWidth > 0
    ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, availWidth - SIDEBAR_CONTENT_MIN_WIDTH))
    : MAX_SIDEBAR_WIDTH;
  /** 实际渲染宽度 = min(用户设定宽度, 上限)：派生而不回写 state，窗口变宽时能恢复到用户原设定值 */
  const effectiveSidebarWidth = Math.min(sidebarWidth, maxSidebarWidth);
  // 宽度落到外壳变量上：折叠时 width 归零的是 CSS，变量保留用户设定值，展开后即恢复
  useLayoutEffect(() => {
    const shell = sidebarRef.current?.parentElement;
    if (!shell) return;
    if (writtenWidthRef.current === effectiveSidebarWidth) return;
    writtenWidthRef.current = effectiveSidebarWidth;
    shell.style.setProperty('--sidebar-w', `${effectiveSidebarWidth}px`);
  }, [effectiveSidebarWidth]);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizingRef.current = true;
    /* 外壳必须是 .sidebar-shell（本组件根节点的父级）：拖拽期间要在它身上关掉宽度过渡。
       挂错了元素过渡照常生效，快速拖动时外壳宽度追不上指针，与主内容区之间就会拉出一条大间隙。 */
    const shell = sidebarRef.current?.parentElement;
    shell?.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    /* 侧边栏贴着窗口左边缘，但窗口可能有原生边框/内边距，所以取根节点的左边界而不是 0；
       每次拖拽实测一次，同时把可用宽度刷新到最新（窗口可能在拖拽前刚被改过大小）。 */
    const measured = measureAvailWidth();
    if (measured > 0) setAvailWidth((prev) => (prev === measured ? prev : measured));
    const limit = measured > 0
      ? Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, measured - SIDEBAR_CONTENT_MIN_WIDTH))
      : maxSidebarWidth;
    const originX = sidebarRef.current?.getBoundingClientRect().left ?? 0;
    const mm = (ev: MouseEvent) => {
      if (!resizingRef.current) return;
      // 必须取整：小数宽度会让侧边栏内所有文字落在半个像素上，看起来发虚
      setSidebarWidth(Math.round(Math.max(MIN_SIDEBAR_WIDTH, Math.min(limit, ev.clientX - originX))));
    };
    const mu = () => {
      resizingRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      // 等 React 把最终宽度刷进 DOM 后再恢复过渡，避免回弹
      requestAnimationFrame(() => shell?.classList.remove('is-resizing'));
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }, [maxSidebarWidth, measureAvailWidth]);
  return (
    <div ref={sidebarRef} className="relative h-full sidebar-bg border-r border-line/80 flex flex-col overflow-hidden">
      {/* 右边缘拖拽把手：调节侧边栏宽度（上下限见 MIN/MAX_SIDEBAR_WIDTH） */}
      <div
        data-resize-handle="sidebar"
        className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-200/50 active:bg-primary-300/50 transition-colors z-30"
        onMouseDown={onResizeStart}
        title={t("拖拽调整侧边栏宽度")}
        aria-hidden="true"
      />
      {/* Logo + 头部按钮 */}
      <div className="px-3.5 pt-3.5 pb-2 flex-shrink-0">
        <div className="relative flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-primary-500 leading-none">FastNote</h1>
            <p className="text-[10px] text-primary-400 mt-0.5">{t("简洁高效")}</p>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {/* 设置：全局入口（含 AI 设置与备份恢复） */}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="sidebar-header-btn"
                title={t("设置")}
                aria-label={t("设置")}
              >
                <Icon name="ai-settings" className="w-4 h-4" />
              </button>
            )}
            {/* 全局 AI 入口：没有打开笔记编辑页时也能打开 AI 窗口 */}
            {onToggleAiPanel && (
              <button
                onClick={onToggleAiPanel}
                className={`sidebar-header-btn ${isAiPanelOpen ? 'is-active' : ''}`}
                title={isAiPanelOpen ? t("关闭 AI 对话") : t("打开 AI 对话")}
                aria-pressed={isAiPanelOpen}
              >
                <AiSparkleIcon className="w-4 h-4" />
              </button>
            )}
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className={`sidebar-header-btn ${isCollapsed ? 'is-collapsed' : ''}`}
                title={t("隐藏分组侧边栏")}
                aria-label={t("隐藏分组侧边栏")}
              >
                <Icon name="sidebar-chevron-left" className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>
      {/* 搜索 + 新建 */}
      <div className="px-3 pb-2 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1 min-w-0">
            <Icon
              name="sidebar-search"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-faint-soft pointer-events-none"
            />
            <input
              type="text"
              placeholder={useRegex ? t("正则搜索笔记...") : t("搜索笔记...")}
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              onFocus={() => setHistoryOpen(searchHistory.length > 0)}
              onBlur={() => {
                // 延后关闭：早于 click 收起的话，历史条目还没来得及响应点击就没了
                window.setTimeout(() => setHistoryOpen(false), 120);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  // 回车视为"这次搜索定了"：同时折叠下拉，避免它盖住刚出的结果
                  setHistoryOpen(false);
                  onCommitSearch?.(searchQuery);
                }
                if (e.key === 'Escape') setHistoryOpen(false);
              }}
              className={`w-full pl-8 py-1.5 text-xs input-modern ${isSearching ? 'pr-12' : 'pr-7'}`}
            />
            {isSearching && (
              <button
                onClick={() => onSearchQueryChange('')}
                className="absolute right-7 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-faint-soft hover:text-muted hover:bg-surface-alt transition-colors"
                title={t("清空搜索")}
              >
                <Icon name="sidebar-close" className="w-3.5 h-3.5" />
              </button>
            )}
            {/* 正则开关：放进输入框右侧，点按时不让输入框失焦，方便边输边切 */}
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onRegexChange?.(!useRegex)}
              disabled={!onRegexChange}
              aria-pressed={useRegex}
              aria-label={t("正则搜索")}
              title={
                useRegex
                  ? t("正则搜索：开（点击关闭）")
                  : t("正则搜索：关（点击开启，支持 (待办|备忘)、^周报\\d+$）")
              }
              className={`absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-md transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary-300 disabled:opacity-40 ${
                useRegex
                  ? "bg-primary-50 text-primary-600"
                  : "text-faint-soft hover:bg-surface-alt hover:text-muted"
              }`}
            >
              <Icon name="sidebar-regex" className="w-3 h-3" />
            </button>
            {/* 历史下拉：聚焦时出现；历史为空或已开始输入都不打扰 */}
            {historyOpen && searchHistory.length > 0 && !isSearching && (
              <div className="absolute left-0 right-0 top-full mt-1 z-30 rounded-lg border border-line bg-surface shadow-card-hover overflow-hidden">
                <div className="flex items-center justify-between px-2.5 pt-1.5 pb-1">
                  <span className="text-[10px] text-faint">{t("搜索历史")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      onClearSearchHistory?.();
                      setHistoryOpen(false);
                    }}
                    className="text-[10px] text-faint-soft hover:text-danger transition-colors"
                  >
                    {t("清空")}
                  </button>
                </div>
                {searchHistory.map((item) => (
                  <div
                    key={item}
                    className="group flex items-center gap-1 px-1 pb-0.5 last:pb-1"
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSearchQueryChange(item);
                        setHistoryOpen(false);
                        onCommitSearch?.(item);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-1.5 px-1.5 py-1 rounded-md text-left hover:bg-surface-alt transition-colors"
                    >
                      <Icon name="welcome-clock" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
                      <span className="truncate text-[11px] text-muted">{item}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemoveSearchHistory?.(item)}
                      title={t("删除这条历史")}
                      className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-faint-soft opacity-0 group-hover:opacity-100 transition-opacity hover:text-danger hover:bg-danger-soft"
                    >
                      <Icon name="sidebar-close" className="w-2.5 h-2.5" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={() => onCreateNote(selectedCategoryId)}
            className="btn-primary w-7 h-7 flex items-center justify-center flex-shrink-0"
            title={t("新建笔记")}
          >
            <Icon name="sidebar-plus-bold" className="w-3.5 h-3.5" />
          </button>
          <button onClick={onOpenTrash} className="toolbar-btn !w-7 !h-7 flex-shrink-0" title={t("回收站")}>
            <Icon name="sidebar-trash" className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {/* 视图切换（分组 / 收藏）+ 排序 */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-3.5 py-1.5 flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <div className="flex items-center rounded-lg bg-surface/70 border border-line/70 p-0.5">
            <button
              onClick={() => onViewChange('groups')}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                view === 'groups' ? 'bg-primary-500 text-on-accent shadow-sm' : 'text-faint hover:text-body'
              }`}
              title={t("分组视图")}
            >
              <Icon name="sidebar-folder" className="w-3 h-3" />
              {t("分组")}
            </button>
            <button
              onClick={() => onViewChange('favorites')}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                view === 'favorites' ? 'bg-primary-500 text-on-accent shadow-sm' : 'text-faint hover:text-body'
              }`}
              title={t("收藏视图")}
            >
              <Icon name="sidebar-star-filled" className="w-3 h-3" />
              {t("收藏")}
            </button>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
          {/* 排序方式：自定义浮层（原生 select 在深/浅主题下样式突兀），fixed 定位避免被滚动容器裁切 */}
          <button
            ref={sortBtnRef}
            className={"sort-trigger" + (sortMenu.open ? " is-open" : "")}
            title={t("排序方式：{value1}", { value1: t(currentSortLabel) })}
            aria-label={t("排序方式：{value1}", { value1: t(currentSortLabel) })}
            onClick={() => {
              const r = sortBtnRef.current?.getBoundingClientRect();
              setSortMenu({ open: !sortMenu.open, top: (r?.bottom ?? 0) + 4, left: r?.left ?? 0, width: r?.width ?? 0 });
            }}
          >
            <Icon name="sidebar-sort" className="w-3.5 h-3.5" />
          </button>
          {sortMenu.open && (
            <>
              <div
                className="fixed inset-0 z-50 cursor-pointer"
                onClick={() => setSortMenu((m) => ({ ...m, open: false }))}
              />
              <div
                className="pop-menu"
                style={{
                  position: "fixed",
                  top: sortMenu.top,
                  // 菜单居中于图标按钮，并夹在视口内（窄窗口右侧不出界）
                  left: Math.min(
                    Math.max(8, sortMenu.left + sortMenu.width / 2 - SORT_MENU_WIDTH / 2),
                    Math.max(8, window.innerWidth - SORT_MENU_WIDTH - 8),
                  ),
                  minWidth: SORT_MENU_WIDTH,
                }}
              >
                {SORT_OPTIONS.map((o) => (
                  <button
                    key={o.value}
                    className={"pop-menu-item" + (sortBy === o.value ? " is-active" : "")}
                    onClick={() => { onSortByChange(o.value); setSortMenu(m => ({ ...m, open: false })); }}
                  >
                    <Icon name="sidebar-check" className={"w-3 h-3 flex-shrink-0 " + (sortBy === o.value ? "opacity-100" : "opacity-0")} />
                    <span>{t(o.label)}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            onClick={onToggleSortOrder}
            className="w-5 h-5 flex items-center justify-center rounded-md text-faint hover:bg-surface/80 hover:text-primary-500 transition-all"
            title={sortOrder === 'asc' ? t("切换为降序") : t("切换为升序")}
          >
            <Icon
              name="sidebar-chevron-up"
              className={`w-3 h-3 transition-transform duration-200 ${sortOrder === 'desc' ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            onClick={onCreateCategory}
            className="w-5 h-5 flex items-center justify-center rounded-md text-faint hover:bg-surface/80 hover:text-primary-500 transition-all"
            title={t("创建分组")}
          >
            <Icon name="sidebar-folder-plus" className="w-4 h-4" />
          </button>
        </div>
      </div>
      {/* 搜索模式：忽略分组，扁平展示全部命中笔记；否则展示分组抽屉列表 */}
      <div
        ref={sidebarScrollRef}
        className={`flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3 min-h-0 drawer-scroll ${dragGhost !== null || isFileDragActive ? 'drawer-dragging' : ''
          }`}
        onPointerDown={handleNotePointerDown}
        onClickCapture={(e) => {
          // 拖拽刚结束时吞掉 click，避免"拖到分组"又触发"打开笔记"
          if (suppressClickRef.current) {
            e.stopPropagation();
            e.preventDefault();
          }
        }}
      >
        {isSearching ? (
          searchMatches.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-4">
              <div className="w-10 h-10 rounded-2xl bg-surface-alt flex items-center justify-center mb-3">
                <Icon name="sidebar-search" className="w-5 h-5 text-faint-soft" />
              </div>
              <p className="text-xs text-faint">{semanticLoading ? t("正在按语义查找…") : t("无匹配笔记")}</p>
              {/* 开了正则最容易"什么都不出来"—至少说清楚是表达式本身没通过编译，而不是库里没有 */}
              {invalidRegex ? (
                <p className="text-[10px] text-warning mt-1 text-center px-2">
                  {t("这不是合法的正则表达式，检查写法或点搜索框里的 .* 按钮关闭正则")}
                </p>
              ) : (
                <p className="text-[10px] text-faint-soft mt-1">
                  {semanticEnabled && semanticIndexing ? t("语义索引构建中，结果可能还不完整") : t("换个关键词试试")}
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* 搜索视图：只做结果展示的虚拟分组，不能新建笔记，分组菜单也没有增删改 */}
              <CategoryDrawer
                category={null}
                notes={searchMatches}
                isExpanded={searchGroupOpen.all}
                isAllNotes={true}
                headerTitle={t("全部搜索结果")}
                headerIcon="sidebar-search"
                hits={hitMap}
                selectedNoteId={selectedNoteId}
                focusNoteId={focusNoteId}
                onToggle={() => toggleSearchGroup('all')}
                onSelectNote={onSelectNote}
                onDeleteNote={onDeleteNote}
                onTogglePin={onTogglePin}
                onCreateNote={() => { }}
                onContextMenu={(e) => {
                  groupMenuRef.current = { kind: 'search-all', name: '全部搜索结果', notes: searchMatches };
                  handleContextMenu(e);
                }}
                onNoteContextMenu={handleNoteContextMenu}
              />
              <CategoryDrawer
                category={null}
                notes={titleMatches}
                isExpanded={searchGroupOpen.title}
                isAllNotes={true}
                headerTitle={t("标题命中")}
                headerIcon="sidebar-note"
                hits={hitMap}
                selectedNoteId={selectedNoteId}
                focusNoteId={focusNoteId}
                onToggle={() => toggleSearchGroup('title')}
                onSelectNote={onSelectNote}
                onDeleteNote={onDeleteNote}
                onTogglePin={onTogglePin}
                onCreateNote={() => { }}
                onContextMenu={(e) => {
                  groupMenuRef.current = { kind: 'search-title', name: '标题命中', notes: titleMatches };
                  handleContextMenu(e);
                }}
                onNoteContextMenu={handleNoteContextMenu}
              />
              <CategoryDrawer
                category={null}
                notes={contentMatches}
                isExpanded={searchGroupOpen.content}
                isAllNotes={true}
                headerTitle={t("正文命中")}
                headerIcon="sidebar-list"
                hits={hitMap}
                selectedNoteId={selectedNoteId}
                focusNoteId={focusNoteId}
                onToggle={() => toggleSearchGroup('content')}
                onSelectNote={onSelectNote}
                onDeleteNote={onDeleteNote}
                onTogglePin={onTogglePin}
                onCreateNote={() => { }}
                onContextMenu={(e) => {
                  groupMenuRef.current = { kind: 'search-content', name: '正文命中', notes: contentMatches };
                  handleContextMenu(e);
                }}
                onNoteContextMenu={handleNoteContextMenu}
              />
              {/* 语义组只在有结果时出现：空组对"逐字输入"的搜索没有信息量 */}
              {semanticEnabled && semanticMatches.length > 0 && (
                <CategoryDrawer
                  category={null}
                  notes={semanticMatches}
                  isExpanded={searchGroupOpen.semantic}
                  isAllNotes={true}
                  headerTitle={t("语义相关")}
                  headerIcon="ai-bolt"
                  hits={hitMap}
                  selectedNoteId={selectedNoteId}
                  focusNoteId={focusNoteId}
                  onToggle={() => toggleSearchGroup('semantic')}
                  onSelectNote={onSelectNote}
                  onDeleteNote={onDeleteNote}
                  onTogglePin={onTogglePin}
                  onCreateNote={() => { }}
                  onContextMenu={(e) => {
                    groupMenuRef.current = { kind: 'search-semantic', name: '语义相关', notes: semanticMatches };
                    handleContextMenu(e);
                  }}
                  onNoteContextMenu={handleNoteContextMenu}
                />
              )}
              {semanticEnabled && semanticMatches.length > 0 && (
                <p className="px-3 pt-1 pb-2 text-[10px] leading-relaxed text-faint-soft">
                  {t("「语义相关」由本地模型按相似度推断，不同模型效果不同，未必精准。")}
                </p>
              )}
            </div>
          )
        ) : view === 'favorites' ? (
          favoriteNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-4">
              <div className="w-10 h-10 rounded-2xl bg-surface-alt flex items-center justify-center mb-3">
                <Icon name="sidebar-star" className="w-5 h-5 text-faint-soft" />
              </div>
              <p className="text-xs text-faint">{t("暂无收藏")}</p>
              <p className="text-[10px] text-faint-soft mt-1">{t("点击笔记右侧的星标即可收藏")}</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {favoriteNotes.map((note) => (
                <DrawerNoteItem
                  key={note.id}
                  note={note}
                  isSelected={selectedNoteId === note.id}
                  isFocused={focusNoteId === note.id}
                  onSelectNote={onSelectNote}
                  onDeleteNote={onDeleteNote}
                  onTogglePin={onTogglePin}
                  showIcon
                  onContextMenu={handleNoteContextMenu}
                />
              ))}
            </div>
          )
        ) : (
          <div className="space-y-0.5">
            {/* 全部笔记：默认分组，菜单里没有重命名 / 删除分组 */}
            <CategoryDrawer
              category={null}
              notes={notes}
              isExpanded={expandedDrawer === 'all'}
              isAllNotes={true}
              selectedNoteId={selectedNoteId}
              focusNoteId={focusNoteId}
              onToggle={() => onToggleDrawer('all')}
              onSelectNote={onSelectNote}
              onDeleteNote={onDeleteNote}
              onTogglePin={onTogglePin}
              onCreateNote={() => onCreateNote(null)}
              onContextMenu={(e) => {
                groupMenuRef.current = { kind: 'all', name: '全部笔记', notes };
                handleContextMenu(e);
              }}
              onNoteContextMenu={handleNoteContextMenu}
            />
            {/* 未分类：默认分组，同样没有重命名 / 删除分组 */}
            <UncategorizedDrawer
              notes={uncategorizedNotes}
              isExpanded={expandedDrawer === 'uncategorized'}
              selectedNoteId={selectedNoteId}
              focusNoteId={focusNoteId}
              onToggle={() => onToggleDrawer('uncategorized')}
              onSelectNote={onSelectNote}
              onDeleteNote={onDeleteNote}
              onTogglePin={onTogglePin}
              onNoteContextMenu={handleNoteContextMenu}
              onContextMenu={(e) => {
                groupMenuRef.current = { kind: 'uncategorized', name: '未分类', notes: uncategorizedNotes };
                handleContextMenu(e);
              }}
            />
            {(categorized.get(ORPHAN_GROUP_ID) || []).length > 0 && (
              <ChildNotesDrawer
                notes={categorized.get(ORPHAN_GROUP_ID) || []}
                isExpanded={expandedDrawer === ORPHAN_GROUP_ID}
                selectedNoteId={selectedNoteId}
                focusNoteId={focusNoteId}
                onToggle={() => onToggleDrawer(ORPHAN_GROUP_ID)}
                onSelectNote={onSelectNote}
                onDeleteNote={onDeleteNote}
                onTogglePin={onTogglePin}
                onNoteContextMenu={handleNoteContextMenu}
              />
            )}
            <div className="h-1" />
            {categories.length === 0 && (
              <div className="px-3 py-5 text-center">
                <Icon name="sidebar-folder-thin" className="w-8 h-8 text-faint-soft mx-auto mb-2" />
                <p className="text-xs text-faint">{t("暂无分组")}</p>
                <p className="text-[10px] text-faint-soft mt-0.5">{t("点击上方 + 创建分组")}</p>
              </div>
            )}
            {categories.map((category) => {
              const ownNotes = categorized.get(category.id) || [];
              // 两种拖拽来源用不同高亮：系统文件（绿） / 内部拖笔记（靛蓝）
              const dropClass =
                hoverDropCategoryId === category.id
                  ? 'drop-target-file'
                  : dragHoverCategoryId === category.id
                    ? 'drop-target-note'
                    : '';
              return (
                <div
                  key={category.id}
                  data-drop-category={category.id}
                  className={`rounded-xl transition-colors ${dropClass}`}
                >
                  <CategoryDrawer
                    category={category}
                    notes={ownNotes}
                    isExpanded={expandedDrawer === category.id}
                    isAllNotes={false}
                    selectedNoteId={selectedNoteId}
                    focusNoteId={focusNoteId}
                    onToggle={() => onToggleDrawer(category.id)}
                    onSelectNote={onSelectNote}
                    onDeleteNote={onDeleteNote}
                    onCreateNote={() => onCreateNote(category.id)}
                    onContextMenu={(e) => {
                      groupMenuRef.current = { kind: 'category', category, notes: ownNotes };
                      handleContextMenu(e);
                    }}
                    onNoteContextMenu={handleNoteContextMenu}
                    onTogglePin={onTogglePin}
                />
                </div>
              );
            })}
          </div>
        )}
      </div>
      {/* 底部统计 + 刷新界面：打包后没有浏览器的右键"刷新"，这里给一个常驻入口 */}
      <div className="px-4 py-2 border-t border-line/60 flex-shrink-0">
        <div className="flex items-center justify-between text-[11px] text-faint">
          <span>{t(categoryCount === 1 ? "1 个分组" : "{count} 个分组", { count: categoryCount })}</span>
          <div className="flex items-center gap-1.5">
            <span>{t(allNotesCount === 1 ? "1 篇笔记" : "{count} 篇笔记", { count: allNotesCount })}</span>
            <button
              onClick={() => window.location.reload()}
              className="p-1 -mr-1 rounded-md text-faint-soft hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-90"
              title={t("刷新界面")}
              aria-label={t("刷新界面")}
            >
              <Icon name="sidebar-refresh" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
      {/* 拖拽浮层：跟随指针，pointer-events-none 不影响落点检测 */}
      {dragGhost && (
        <div
          className="note-drag-ghost"
          style={{ left: dragGhost.x + 12, top: dragGhost.y + 12 }}
        >
          {dragGhost.title}
        </div>
      )}
      {/* 右键菜单 */}
      <ContextMenu
        items={
          groupMenuRef.current
            ? buildGroupContextMenu(groupMenuRef.current)
            : noteContextMenuRef.current
              ? buildNoteContextMenu(noteContextMenuRef.current)
              : []
        }
        position={menuPos}
        onClose={() => {
          groupMenuRef.current = null;
          noteContextMenuRef.current = null;
          closeMenu();
        }}
      />
    </div>
  );
};
