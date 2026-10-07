import { useMemo, useRef, useState } from 'react';
import { Category, Note } from '../types';
import * as api from '../api';
import { useToast } from './Toast';
import { ContextMenu, ContextMenuItem, useContextMenu } from './ContextMenu';
import { CategoryDrawer, UncategorizedDrawer, ChildNotesDrawer, DrawerNoteItem } from './CategoryDrawer';
import { AiSparkleIcon } from './icons';
import { Icon } from './Icon';

/** 虚拟分组 ID：用于承载 category_id 指向已删除分组的笔记 */
const SORT_OPTIONS = [ { value: 'updated_at', label: '更新时间' }, { value: 'created_at', label: '创建时间' }, { value: 'title', label: '标题' } ];
const ORPHAN_GROUP_ID = -1;

interface SidebarProps {
  categories: Category[];
  notes: Note[];
  allNotesCount: number;
  selectedCategoryId: number | null;
  selectedNoteId: number | null;
  /** 抽屉展开状态：'all' | 分组ID | 'uncategorized' | null（全部收起） */
  expandedDrawer: number | 'all' | 'uncategorized' | null;
  /** 需要聚焦高亮的笔记（AI 打开笔记时触发） */
  focusNoteId: number | null;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  sortBy: string;
  onSortByChange: (value: string) => void;
  sortOrder: string;
  onToggleSortOrder: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onToggleDrawer: (key: number | 'all' | 'uncategorized') => void;
  /** 折叠侧边栏（折叠后依靠左边缘把手唤出） */
  onToggleCollapse?: () => void;
  isCollapsed?: boolean;
  /** 打开/关闭 AI 对话面板（全局入口，未打开笔记时也可用） */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
  /** 打开「数据备份与恢复」窗口 */
  onOpenBackup?: () => void;
  /** 右键菜单「导出分组」：把整个分组导出为压缩包或电子书 */
  onExportCategory: (category: Category) => void;
  /** 右键菜单「保存笔记」：等价于编辑器里的 Ctrl+S（导出到文件） */
  onSaveNote: (note: Note) => void;
  onCreateCategory: () => void;
  onEditCategory: (category: Category) => void;
  onDeleteCategory: (category: Category) => void;
  onCreateNote: (categoryId: number | null) => void;
  onMoveToCategory: (note: Note, categoryId: number | null) => void;
  onOpenTrash: () => void;
  onNotesUpdated: () => void;
}

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
  onToggleDrawer,
  onToggleCollapse,
  isCollapsed = false,
  onToggleAiPanel,
  isAiPanelOpen = false,
  onOpenBackup,
  onExportCategory,
  onSaveNote,
  onCreateCategory,
  onEditCategory,
  onDeleteCategory,
  onCreateNote,
  onMoveToCategory,
  onOpenTrash,
  onNotesUpdated,
}) => {
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();
  const { showToast } = useToast();

  const categoryContextMenuRef = useRef<Category | null>(null);
  /** 排序下拉浮层：open + 位置（用 fixed 定位，避免被列表滚动容器裁掉） */
  const sortBtnRef = useRef<HTMLButtonElement>(null);
  const [sortMenu, setSortMenu] = useState<{ open: boolean; top: number; left: number; width: number }>({ open: false, top: 0, left: 0, width: 0 });
  const noteContextMenuRef = useRef<Note | null>(null);
  /** 侧边栏滚动容器 ref：拖动笔记时自动滚动 */
  const sidebarScrollRef = useRef<HTMLDivElement>(null);
  /** 自动滚动的动画帧 id，用于清理 */
  const autoScrollRafRef = useRef<number | null>(null);
  /** 当前拖动的 Y 坐标，由 onDragOver 更新，由 RAF 循环读取 */
  const dragYRef = useRef<number | null>(null);

  const isSearching = searchQuery.trim().length > 0;

  /** 启动 / 停止自动滚动循环 */
  const stopAutoScroll = () => {
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = null;
    }
    dragYRef.current = null;
  };

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

  /** 搜索命中判断；搜索模式下结果扁平化展示，不再按分组归类 */
  const matches = (note: Note) =>
    !query ||
    note.title.toLowerCase().includes(query) ||
    note.content.toLowerCase().includes(query);

  const categorized = useMemo(() => {
    const map = new Map<number, Note[]>();
    for (const category of categories) {
      map.set(
        category.id,
        notes.filter((n) => n.category_id === category.id && matches(n))
      );
    }
    const categoryIds = new Set(categories.map((c) => c.id));
    // 分组已被删除但笔记的 category_id 仍指向它的历史遗留数据
    map.set(
      ORPHAN_GROUP_ID,
      notes.filter((n) => n.category_id !== null && !categoryIds.has(n.category_id as number) && matches(n))
    );
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categories, notes, query]);

  const uncategorizedNotes = useMemo(
    () => notes.filter((n) => n.category_id === null && matches(n)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, query]
  );

  const sortedAllNotes = useMemo(
    () => notes.filter((n) => matches(n)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notes, query]
  );

  const totalMatches = useMemo(
    () =>
      sortedAllNotes.length,
    [sortedAllNotes]
  );

  const getCategoryMenuItems = (category: Category): ContextMenuItem[] => [
    {
      label: expandedDrawer === category.id ? '折叠分组' : '展开分组',
      icon: <Icon name="sidebar-chevron-right" className="w-4 h-4" />,
      onClick: () => onToggleDrawer(category.id),
    },
    {
      label: '在此分组新建笔记',
      icon: (
        <Icon name="sidebar-plus" className="w-4 h-4" />
      ),
      onClick: () => onCreateNote(category.id),
    },
    {
      label: '导出分组',
      icon: (
        <Icon name="editor-export" className="w-4 h-4" />
      ),
      onClick: () => onExportCategory(category),
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '编辑分组',
      icon: (
        <Icon name="sidebar-edit" className="w-4 h-4" />
      ),
      onClick: () => onEditCategory(category),
    },
    {
      label: '新建分组',
      icon: (
        <Icon name="sidebar-plus" className="w-4 h-4" />
      ),
      onClick: onCreateCategory,
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '删除分组',
      icon: (
        <Icon name="sidebar-trash" className="w-4 h-4" />
      ),
      onClick: () => onDeleteCategory(category),
      danger: true,
    },
  ];

  const getNoteMenuItems = (note: Note): ContextMenuItem[] => [
    {
      label: '打开笔记',
      icon: (
        <Icon name="sidebar-eye" className="w-4 h-4" />
      ),
      onClick: () => onSelectNote(note),
    },
    {
      label: '保存笔记',
      icon: (
        <Icon name="editor-export" className="w-4 h-4" />
      ),
      onClick: () => onSaveNote(note),
    },
    {
      label: '移动分组',
      icon: (
        <Icon name="sidebar-folder" className="w-4 h-4" />
      ),
      onClick: () => {},
      submenu: [
        {
          label: '未分类',
          icon: (
            <Icon name="sidebar-list" className="w-4 h-4" />
          ),
          onClick: () => onMoveToCategory(note, null),
          disabled: note.category_id === null,
        },
        ...categories.map((cat) => ({
          label: cat.name,
          icon: (
            <Icon name="sidebar-folder" className="w-4 h-4" />
          ),
          onClick: () => onMoveToCategory(note, cat.id),
          disabled: note.category_id === cat.id,
        })),
      ],
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '删除笔记',
      icon: (
        <Icon name="sidebar-trash" className="w-4 h-4" />
      ),
      onClick: () => onDeleteNote(note),
      danger: true,
    },
  ];

  const handleDropToCategory = async (noteIdStr: string, categoryId: number | null) => {
    const noteId = parseInt(noteIdStr, 10);
    if (isNaN(noteId)) return;
    const note = notes.find((n) => n.id === noteId);
    if (!note || note.category_id === categoryId) return;
    try {
      await api.updateNote(note.id, note.title, note.content, categoryId);
      showToast('笔记分组已更新', 'success');
      await onNotesUpdated();
    } catch {
      showToast('更新笔记分组失败', 'error');
    }
  };

  const categoryCount = categories.length;

  return (
    <div className="h-full sidebar-bg border-r border-slate-200/80 flex flex-col overflow-hidden">
      {/* Logo */}
      <div className="px-3.5 pt-3.5 pb-2 flex-shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 bg-gradient-to-br from-primary-500 to-primary-700 rounded-lg flex items-center justify-center shadow-sm">
            <Icon name="sidebar-edit-square" className="w-4 h-4 text-white" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-sm font-bold text-slate-800 leading-none">FastNote</h1>
            <p className="text-[10px] text-slate-400 mt-0.5">简洁高效</p>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0">
            {/* 数据备份与恢复：全局入口 */}
            {onOpenBackup && (
              <button
                onClick={onOpenBackup}
                className="sidebar-header-btn"
                title="数据备份与恢复"
                aria-label="数据备份与恢复"
              >
                <Icon name="app-backup" className="w-4 h-4" />
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
              className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-300 pointer-events-none"
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
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-md text-slate-300 hover:text-slate-500 hover:bg-slate-100 transition-colors"
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

      {/* 分组标题 + 排序 */}
      <div className="flex items-center justify-between px-3.5 py-1.5 flex-shrink-0">
        <h2 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
          {isSearching ? '搜索结果' : '分组'}
          {isSearching && (
            <span className="ml-1.5 normal-case tracking-normal text-primary-500 font-medium">
              {totalMatches} 条
            </span>
          )}
        </h2>
        <div className="flex items-center gap-0.5">
          {/* 排序方式：自定义浮层，替代原生 select（原生下拉在深色/浅色主题下都很突兀） */}
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
              <div className="fixed inset-0 z-50" />
              <div
                className="pop-menu"
                style={{ position: "fixed", top: sortMenu.top, left: Math.max(8, sortMenu.left - 40), minWidth: 132 }}
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
            className="w-5 h-5 flex items-center justify-center rounded-md text-slate-400 hover:bg-white/80 hover:text-primary-500 transition-all"
            title={sortOrder === 'asc' ? '切换为降序' : '切换为升序'}
          >
            <Icon
              name="sidebar-chevron-up"
              className={`w-3 h-3 transition-transform duration-200 ${sortOrder === 'desc' ? 'rotate-180' : ''}`}
            />
          </button>
          <button
            onClick={onCreateCategory}
            className="w-5 h-5 flex items-center justify-center rounded-md text-slate-400 hover:bg-white/80 hover:text-primary-500 transition-all"
            title="创建分组"
          >
            <Icon name="sidebar-plus-bold" className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* 搜索模式：忽略分组，扁平展示全部命中笔记；否则展示分组抽屉列表 */}
      <div
        ref={sidebarScrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-2.5 pb-3 min-h-0 drawer-scroll"
        onDragOver={(e) => {
          // 允许放置在容器上
          e.preventDefault();
          // 记录 Y 坐标用于自动滚动（无论鼠标在容器还是子元素上）
          dragYRef.current = e.clientY;
          startAutoScroll(sidebarScrollRef.current!);
        }}
        onDragLeave={() => stopAutoScroll()}
        onDrop={() => stopAutoScroll()}
        onDragEnd={() => stopAutoScroll()}
      >
        {isSearching ? (
          sortedAllNotes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-14 px-4">
              <div className="w-10 h-10 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
                <Icon name="sidebar-search" className="w-5 h-5 text-slate-300" />
              </div>
              <p className="text-xs text-slate-400">无匹配笔记</p>
              <p className="text-[10px] text-slate-300 mt-1">换个关键词试试</p>
            </div>
          ) : (
            <div className="space-y-1">
              {sortedAllNotes.map((note) => (
                <DrawerNoteItem
                  key={note.id}
                  note={note}
                  isSelected={selectedNoteId === note.id}
                  isFocused={focusNoteId === note.id}
                  onSelectNote={onSelectNote}
                  onDeleteNote={onDeleteNote}
                  onContextMenu={(e, target) => {
                    noteContextMenuRef.current = target;
                    handleContextMenu(e);
                  }}
                />
              ))}
            </div>
          )
        ) : (
        <div className="space-y-0.5">
          {/* 全部笔记 */}
          <CategoryDrawer
            category={null}
            notes={sortedAllNotes}
            isExpanded={expandedDrawer === 'all'}
            isAllNotes={true}
            selectedNoteId={selectedNoteId}
            focusNoteId={focusNoteId}
            onToggle={() => onToggleDrawer('all')}
            onSelectNote={onSelectNote}
            onDeleteNote={onDeleteNote}
            onCreateNote={() => onCreateNote(null)}
            onContextMenu={() => {}}
            onNoteContextMenu={(e, note) => {
              noteContextMenuRef.current = note;
              handleContextMenu(e);
            }}
          />

          {/* 未分类：固定排在「全部笔记」下方 */}
          <UncategorizedDrawer
            notes={uncategorizedNotes}
            isExpanded={expandedDrawer === 'uncategorized'}
            selectedNoteId={selectedNoteId}
            focusNoteId={focusNoteId}
            onToggle={() => onToggleDrawer('uncategorized')}
            onSelectNote={onSelectNote}
            onDeleteNote={onDeleteNote}
            onNoteContextMenu={(e, note) => {
              noteContextMenuRef.current = note;
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
              onNoteContextMenu={(e, note) => {
                noteContextMenuRef.current = note;
                handleContextMenu(e);
              }}
            />
          )}

          <div className="h-1" />

          {categories.length === 0 && (
            <div className="px-3 py-5 text-center">
              <Icon name="sidebar-folder-thin" className="w-8 h-8 text-slate-200 mx-auto mb-2" />
              <p className="text-xs text-slate-400">暂无分组</p>
              <p className="text-[10px] text-slate-300 mt-0.5">点击上方 + 创建分组</p>
            </div>
          )}

          {categories.map((category) => {
            const ownNotes = categorized.get(category.id) || [];
            return (
              <div
                key={category.id}
                onDragOver={(e) => {
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const el = e.currentTarget as HTMLElement;
                  el.style.background = 'linear-gradient(135deg, var(--color-accent-light) 0%, var(--color-accent-soft) 100%)';
                  el.style.borderRadius = '12px';
                }}
                onDragLeave={(e) => {
                  // 只有当拖动真正离开该分组（而非进入子元素时）才清除高亮
                  const el = e.currentTarget as HTMLElement;
                  const related = e.relatedTarget as HTMLElement | null;
                  if (related && el.contains(related)) return;
                  el.style.background = '';
                }}
                onDrop={async (e) => {
                  const el = e.currentTarget as HTMLElement;
                  el.style.background = '';
                  e.preventDefault();
                  await handleDropToCategory(e.dataTransfer.getData('id') || '', category.id);
                }}
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
                  onContextMenu={(e, cat) => {
                    categoryContextMenuRef.current = cat;
                    handleContextMenu(e);
                  }}
                  onNoteContextMenu={(e, note) => {
                    noteContextMenuRef.current = note;
                    handleContextMenu(e);
                  }}
                />
              </div>
            );
          })}
        </div>
        )}
      </div>

      {/* 底部统计 + 刷新界面：打包后没有浏览器的右键"刷新"，这里给一个常驻入口 */}
      <div className="px-4 py-2 border-t border-slate-200/60 flex-shrink-0">
        <div className="flex items-center justify-between text-[11px] text-slate-400">
          <span>{categoryCount} 个分组</span>
          <div className="flex items-center gap-1.5">
            <span>{allNotesCount} 篇笔记</span>
            <button
              onClick={() => window.location.reload()}
              className="p-1 -mr-1 rounded-md text-slate-300 hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-90"
              title="刷新界面"
              aria-label="刷新界面"
            >
              <Icon name="sidebar-refresh" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>

      {/* 右键菜单 */}
      <ContextMenu
        items={
          categoryContextMenuRef.current
            ? getCategoryMenuItems(categoryContextMenuRef.current)
            : noteContextMenuRef.current
            ? getNoteMenuItems(noteContextMenuRef.current)
            : []
        }
        position={menuPos}
        onClose={() => {
          categoryContextMenuRef.current = null;
          noteContextMenuRef.current = null;
          closeMenu();
        }}
      />
    </div>
  );
};



