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
 */
import { useEffect, useMemo, useRef, useState } from 'react';
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
/** 排序选项：value 直接作为后端排序字段使用 */
const SORT_OPTIONS = [{ value: 'updated_at', label: '更新时间' }, { value: 'created_at', label: '创建时间' }, { value: 'title', label: '标题' }];
/** 排序浮层宽度（px）：定位时用它把浮层夹在视口内 */
const SORT_MENU_WIDTH = 132;
const ORPHAN_GROUP_ID = -1; // 虚拟分组 ID：承载 category_id 指向已删除分组的遗留笔记
/** 搜索视图三个虚拟分组 → 展开状态 key */
const SEARCH_GROUP_KEY: Record<string, 'all' | 'title' | 'content'> = {
  'search-all': 'all',
  'search-title': 'title',
  'search-content': 'content',
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
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();
  const { showToast } = useToast();
  /** 排序下拉浮层：位置在点击时按按钮 rect 算出，用 fixed 定位避免被列表滚动容器裁掉 */
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState<{ open: boolean; top: number; left: number; width: number }>({ open: false, top: 0, left: 0, width: 0 });
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
  const query = searchQuery.trim().toLowerCase();
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
  /** 搜索视图「全部搜索结果」：标题或正文命中即可，保持后端排序 */
  const searchMatches = useMemo(
    () => notes.filter((n) => n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query)),
    [notes, query]
  );
  /** 搜索视图「标题命中」：标题包含关键词的笔记 */
  const titleMatches = useMemo(
    () => notes.filter((n) => n.title.toLowerCase().includes(query)),
    [notes, query]
  );
  /** 搜索视图「正文命中」：标题未命中、但正文包含关键词的笔记（与标题命中互补，避免重复） */
  const contentMatches = useMemo(
    () => notes.filter((n) => !n.title.toLowerCase().includes(query) && n.content.toLowerCase().includes(query)),
    [notes, query]
  );
  /** 搜索视图内三个默认分组的展开状态：默认展开，结果立即可见 */
  const [searchGroupOpen, setSearchGroupOpen] = useState({ all: true, title: true, content: true });
  const toggleSearchGroup = (key: 'all' | 'title' | 'content') =>
    setSearchGroupOpen((s) => ({ ...s, [key]: !s[key] }));
  // 每次开始新的搜索都重置为全部展开，避免上一次的折叠状态挡住结果
  useEffect(() => {
    if (isSearching) setSearchGroupOpen({ all: true, title: true, content: true });
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
    const name = target.kind === 'category' ? target.category.name : target.name;
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
          defaultFileName: isSearchGroup ? `"${searchQuery.trim()}" 的搜索结果` : name,
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
        else onShowGroupProperties(name, target.notes.length);
      },
    });
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
    });
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
      showToast('笔记分组已更新', 'success');
      await onNotesUpdated();
    } catch {
      showToast('更新笔记分组失败', 'error');
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
    pointerTitleRef.current = noteEl.querySelector('h4')?.textContent || '无标题';
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
  return (
    <div className="h-full sidebar-bg border-r border-line/80 flex flex-col overflow-hidden">
      {/* Logo + 头部按钮 */}
      <div className="px-3.5 pt-3.5 pb-2 flex-shrink-0">
        <div className="relative flex items-center justify-between">
          <div className="min-w-0">
            <h1 className="text-sm font-bold text-primary-500 leading-none">FastNote</h1>
            <p className="text-[10px] text-primary-400 mt-0.5">简洁高效</p>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {/* 设置：全局入口（含 AI 设置与备份恢复） */}
            {onOpenSettings && (
              <button
                onClick={onOpenSettings}
                className="sidebar-header-btn"
                title="设置"
                aria-label="设置"
              >
                <Icon name="ai-settings" className="w-4 h-4" />
              </button>
            )}
            {/* 全局 AI 入口：没有打开笔记编辑页时也能打开 AI 窗口 */}
            {onToggleAiPanel && (
              <button
                onClick={onToggleAiPanel}
                className={`sidebar-header-btn ${isAiPanelOpen ? 'is-active' : ''}`}
                title={isAiPanelOpen ? '关闭 AI 对话' : '打开 AI 对话'}
                aria-pressed={isAiPanelOpen}
              >
                <AiSparkleIcon className="w-4 h-4" />
              </button>
            )}
            {onToggleCollapse && (
              <button
                onClick={onToggleCollapse}
                className={`sidebar-header-btn ${isCollapsed ? 'is-collapsed' : ''}`}
                title="隐藏分组侧边栏"
                aria-label="隐藏分组侧边栏"
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
              placeholder="搜索笔记..."
              value={searchQuery}
              onChange={(e) => onSearchQueryChange(e.target.value)}
              className="w-full pl-8 pr-7 py-1.5 text-xs input-modern"
            />
            {isSearching && (
              <button
                onClick={() => onSearchQueryChange('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-faint-soft hover:text-muted hover:bg-surface-alt transition-colors"
                title="清空搜索"
              >
                <Icon name="sidebar-close" className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <button
            onClick={() => onCreateNote(selectedCategoryId)}
            className="btn-primary w-7 h-7 flex items-center justify-center flex-shrink-0"
            title="新建笔记"
          >
            <Icon name="sidebar-plus-bold" className="w-3.5 h-3.5" />
          </button>
          <button onClick={onOpenTrash} className="toolbar-btn !w-7 !h-7 flex-shrink-0" title="回收站">
            <Icon name="sidebar-trash" className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
      {/* 视图切换（分组 / 收藏）+ 排序 */}
      <div className="flex items-center justify-between px-3.5 py-1.5 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0">
          <div className="flex items-center rounded-lg bg-surface/70 border border-line/70 p-0.5">
            <button
              onClick={() => onViewChange('groups')}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                view === 'groups' ? 'bg-primary-500 text-on-accent shadow-sm' : 'text-faint hover:text-body'
              }`}
              title="分组视图"
            >
              <Icon name="sidebar-folder" className="w-3 h-3" />
              分组
            </button>
            <button
              onClick={() => onViewChange('favorites')}
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium transition-all ${
                view === 'favorites' ? 'bg-primary-500 text-on-accent shadow-sm' : 'text-faint hover:text-body'
              }`}
              title="收藏视图"
            >
              <Icon name="sidebar-star-filled" className="w-3 h-3" />
              收藏
            </button>
          </div>
        </div>
        <div className="flex items-center gap-0.5">
          {/* 排序方式：自定义浮层（原生 select 在深/浅主题下样式突兀），fixed 定位避免被滚动容器裁切 */}
          <button
            ref={sortBtnRef}
            className={"sort-trigger" + (sortMenu.open ? " is-open" : "")}
            title="排序方式"
            onClick={() => {
              const r = sortBtnRef.current?.getBoundingClientRect();
              setSortMenu({ open: !sortMenu.open, top: (r?.bottom ?? 0) + 4, left: r?.left ?? 0, width: r?.width ?? 0 });
            }}
          >
            <span className="truncate max-w-[56px]">{SORT_OPTIONS.find(o => o.value === sortBy)?.label || "更新时间"}</span>
            <Icon name="sidebar-chevron-down" className={"w-2.5 h-2.5 flex-shrink-0 transition-transform " + (sortMenu.open ? "rotate-180" : "")} />
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
                  // 与按钮左对齐后往回收 40px 让菜单视觉居中，左右都要夹在视口内（窄窗口右侧不出界）
                  left: Math.min(
                    Math.max(8, sortMenu.left - 40),
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
                    <span>{o.label}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          <button
            onClick={onToggleSortOrder}
            className="w-5 h-5 flex items-center justify-center rounded-md text-faint hover:bg-surface/80 hover:text-primary-500 transition-all"
            title={sortOrder === 'asc' ? '切换为降序' : '切换为升序'}
          >
            <Icon
              name="sidebar-chevron-up"
              className={`w-3 h-3 transition-transform duration-200 ${sortOrder === 'desc' ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            onClick={onCreateCategory}
            className="w-5 h-5 flex items-center justify-center rounded-md text-faint hover:bg-surface/80 hover:text-primary-500 transition-all"
            title="创建分组"
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
              <p className="text-xs text-faint">无匹配笔记</p>
              <p className="text-[10px] text-faint-soft mt-1">换个关键词试试</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {/* 搜索视图：只做结果展示的虚拟分组，不能新建笔记，分组菜单也没有增删改 */}
              <CategoryDrawer
                category={null}
                notes={searchMatches}
                isExpanded={searchGroupOpen.all}
                isAllNotes={true}
                headerTitle="全部搜索结果"
                headerIcon="sidebar-search"
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
                headerTitle="标题命中"
                headerIcon="sidebar-note"
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
                headerTitle="正文命中"
                headerIcon="sidebar-list"
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
            </div>
          )
        ) : view === 'favorites' ? (
          favoriteNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-4">
              <div className="w-10 h-10 rounded-2xl bg-surface-alt flex items-center justify-center mb-3">
                <Icon name="sidebar-star" className="w-5 h-5 text-faint-soft" />
              </div>
              <p className="text-xs text-faint">暂无收藏</p>
              <p className="text-[10px] text-faint-soft mt-1">点击笔记右侧的星标即可收藏</p>
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
                <p className="text-xs text-faint">暂无分组</p>
                <p className="text-[10px] text-faint-soft mt-0.5">点击上方 + 创建分组</p>
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
          <span>{categoryCount} 个分组</span>
          <div className="flex items-center gap-1.5">
            <span>{allNotesCount} 篇笔记</span>
            <button
              onClick={() => window.location.reload()}
              className="p-1 -mr-1 rounded-md text-faint-soft hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-90"
              title="刷新界面"
              aria-label="刷新界面"
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
