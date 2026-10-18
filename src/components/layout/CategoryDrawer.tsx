/**
 * 分组抽屉：标题行（箭头 / 图标 / 名称 / 计数）+ 可折叠的笔记列表。
 * 三种抽屉共用同一套骨架，差别只在数据来源与可用的分组操作：
 * - CategoryDrawer：真实分组、「全部笔记」、搜索视图虚拟分组（用 headerTitle / headerIcon 覆盖文案与图标）
 * - UncategorizedDrawer：category_id === null 的笔记
 * - ChildNotesDrawer：category_id 指向已删除分组的遗留笔记
 * 折叠动画走 .drawer-notes-grid 的 grid-template-rows 0fr → 1fr，所以列表节点始终挂载。
 * DrawerNoteItem 上的 data-note-id 是 Sidebar 指针拖拽的锚点，不能去掉。
 */
import { useEffect, useRef } from 'react';
import type { Note } from "@/interface/note";
import type { CategoryDrawerProps } from "@/interface/sidebar";
import { Icon } from '@/components/common/Icon';

/**
 * 抽屉内的单条笔记卡片；收藏视图也用它渲染扁平列表（此时 showIcon 为 true）。
 * 删除 / 收藏按钮都要 stopPropagation——否则会连带触发整行的"打开笔记"。
 */
export const DrawerNoteItem: React.FC<{
  note: Note;
  isSelected: boolean;
  isFocused: boolean;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  /** 切换收藏（置顶）状态 */
  onTogglePin?: (note: Note) => void;
  /** 收藏聚合视图：在标题前显示星标图标 */
  showIcon?: boolean;
  onContextMenu?: (e: React.MouseEvent, note: Note) => void;
}> = ({ note, isSelected, isFocused, onSelectNote, onDeleteNote, onTogglePin, showIcon = false, onContextMenu }) => {
  const itemRef = useRef<HTMLDivElement>(null);

  // AI 打开笔记时聚焦高亮：延迟 60ms 再滚动，等抽屉展开动画把元素位置定下来，否则会滚偏
  useEffect(() => {
    if (!isFocused) return;
    const timer = window.setTimeout(() => {
      itemRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
    return () => window.clearTimeout(timer);
  }, [isFocused]);

  return (
    <div
      ref={itemRef}
      data-note-id={note.id}
      onClick={() => onSelectNote(note)}
      onContextMenu={(e) => onContextMenu?.(e, note)}
      className={`drawer-note group/note relative pl-3 pr-2 py-1 rounded-lg cursor-pointer border transition-all duration-200 ${
        isSelected
          ? 'bg-gradient-to-r from-primary-500 to-primary-600 note-selected-bg border-transparent'
          : note.is_pinned
            ? 'bg-primary-50/70 hover:bg-primary-50 border-primary-100'
            : 'border-transparent hover:bg-surface/80 hover:border-line/60'
      } ${isFocused && !isSelected ? 'note-focus-ring' : ''}`}
    >
      <div className="flex items-center gap-1.5">
        {showIcon && (
          <Icon
            name="sidebar-note"
            className={`w-3 h-3 flex-shrink-0 ${isSelected ? 'text-on-accent' : 'text-primary-400'}`}
          />
        )}
        <div className="flex-1 min-w-0">
          <h4
            className={`text-[12.5px] font-medium truncate leading-snug ${
              isSelected ? 'text-on-accent' : 'text-body'
            }`}
          >
            {note.title || '无标题'}
          </h4>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDeleteNote(note);
          }}
          className={`flex-shrink-0 w-6 h-6 p-1 rounded-md flex items-center justify-center opacity-0 group-hover/note:opacity-100 transition-all ${
            isSelected
              ? 'text-on-accent/70 hover:bg-surface/20 hover:text-on-accent'
              : 'text-faint-soft hover:bg-danger-soft hover:text-danger'
          }`}
          title="移到回收站"
        >
          <Icon name="sidebar-trash" className="w-3 h-3" />
        </button>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onTogglePin?.(note);
          }}
          className={`flex-shrink-0 w-6 h-6 p-1 rounded-md flex items-center justify-center transition-all ${
            note.is_pinned
              ? isSelected
                ? 'text-on-accent hover:bg-surface/20'
                : 'text-primary-500 hover:bg-primary-100'
              : `opacity-0 group-hover/note:opacity-100 ${
                  isSelected
                    ? 'text-on-accent/70 hover:bg-surface/20 hover:text-on-accent'
                    : 'text-faint-soft hover:bg-primary-50 hover:text-primary-500'
                }`
          }`}
          title={note.is_pinned ? '取消收藏' : '收藏'}
        >
          <Icon name={note.is_pinned ? 'sidebar-star-filled' : 'sidebar-star'} className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
};

/**
 * 分组抽屉：真实分组、全部笔记、搜索视图虚拟分组共用。
 * category 为 null 时是虚拟分组，标题与图标必须由 headerTitle / headerIcon 指定。
 */
export const CategoryDrawer: React.FC<CategoryDrawerProps> = ({
  category,
  notes,
  isExpanded,
  isAllNotes,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  onCreateNote,
  onContextMenu,
  onNoteContextMenu,
  headerTitle,
  headerIcon,
}) => {
  // 搜索视图存在多个 category 为 null 的虚拟分组，用 headerIcon 保证 list id 唯一
  const noteListId = `drawer-notes-${category ? category.id : headerIcon ?? 'all'}`;
  const open = isExpanded;

  const headerBase =
    `drawer-header relative w-full text-left px-2.5 rounded-lg transition-all duration-200 flex items-center gap-2 group/drawer border ${
      isAllNotes ? 'py-1' : 'py-0'
    }`;
  const activeHeader =
    'text-body hover:bg-surface/80 hover:text-ink border-transparent hover:border-line/60';

  return (
    <div
      className="drawer-item"
      onContextMenu={(e) => onContextMenu(e, category)}
    >
      {/* 分组右键：笔记自己的右键会先 stopPropagation，冒泡到这里的只有标题区与空白处 */}
      <button
        type="button"
        onClick={(e) => {
          // 点击"新建笔记"图标时只创建笔记，不切换展开状态
          if ((e.target as HTMLElement).closest('[data-drawer-action="create-note"]')) {
            e.stopPropagation();
            onCreateNote();
            return;
          }
          onToggle();
        }}
        aria-expanded={open}
        aria-controls={noteListId}
        className={`${headerBase} ${activeHeader}`}
        title={open ? '收起' : '展开'}
      >
        {/* 展开箭头 */}
        <Icon
          name="sidebar-chevron-right-bold"
          className={`w-3 h-3 flex-shrink-0 text-faint transition-transform duration-300 ease-spring ${
            open ? 'rotate-90' : ''
          }`}
        />

        <Icon
          name={headerIcon ?? (isAllNotes ? "sidebar-archive" : "sidebar-folder")}
          className="w-4 h-4 flex-shrink-0 text-faint"
        />

        <span className="text-[13px] leading-tight flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 font-medium">
          {headerTitle ?? (isAllNotes ? '全部笔记' : category?.name)}
        </span>

        {/* 悬停操作按钮（仅分组） */}
        {!isAllNotes && category && (
          <span className="flex items-center gap-0.5 opacity-0 group-hover/drawer:opacity-100 transition-opacity flex-shrink-0 text-faint">
            <span
              data-drawer-action="create-note"
              className="p-1 rounded-md transition-colors hover:bg-surface-alt"
              title="在此分组新建笔记"
            >
              <Icon name="sidebar-plus-bold" className="w-3 h-3 pointer-events-none" />
            </span>
          </span>
        )}

        <span className="badge text-[10px] flex-shrink-0 bg-surface-alt text-muted">
          {notes.length}
        </span>
      </button>

      {/* 展开区域 */}
      <div
        id={noteListId}
        className={`drawer-notes-grid ${open ? 'is-open' : ''} mt-0.5`}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="pt-0 pb-0.5 pl-2 pr-0.5 ml-3.5 border-l border-line/70">
            {notes.length === 0 ? (
              <p className="text-[11px] text-faint-soft py-0.5 pl-2">暂无笔记</p>
            ) : (
              <div className="space-y-0.5 pl-1.5">
                {notes.map((note) => (
                  <DrawerNoteItem
                    key={note.id}
                    note={note}
                    isSelected={selectedNoteId === note.id}
                    isFocused={focusNoteId === note.id}
                    onSelectNote={onSelectNote}
                    onDeleteNote={onDeleteNote}
                    onTogglePin={onTogglePin}
                    onContextMenu={onNoteContextMenu}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/** 「未分类」抽屉：只收纳 category_id === null 的笔记，用虚线边框与真实分组区分 */
export const UncategorizedDrawer: React.FC<{
  notes: Note[];
  isExpanded: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onTogglePin?: (note: Note) => void;
  onNoteContextMenu?: (e: React.MouseEvent, note: Note) => void;
  /** 分组右键菜单（未分类属于默认分组，同样有菜单） */
  onContextMenu?: (e: React.MouseEvent) => void;
}> = ({
  notes,
  isExpanded,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  onNoteContextMenu,
  onContextMenu,
}) => {
  const noteListId = 'drawer-notes-uncategorized';
  const open = isExpanded;
  return (
    <div className="drawer-item" onContextMenu={(e) => onContextMenu?.(e)}>
      {/* 不做 disabled：与普通分组行为一致，空时也能展开看到"暂无笔记" */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={noteListId}
        className={`drawer-header relative w-full text-left px-2.5 py-1 rounded-lg transition-all duration-200 flex items-center gap-2 border border-dashed text-muted hover:bg-surface/80 hover:text-ink border-line-strong/70 hover:border-line-strong`}
        title={open ? '收起' : '展开'}
      >
        <Icon
          name="sidebar-chevron-right-bold"
          className={`w-3 h-3 flex-shrink-0 text-faint transition-transform duration-300 ease-spring ${
            open ? 'rotate-90' : ''
          }`}
        />
        <Icon
          name="sidebar-list"
          className="w-4 h-4 flex-shrink-0 text-faint"
        />
        <span className="text-[13px] leading-tight flex-1 truncate font-medium">未分类</span>
        <span className="badge text-[10px] flex-shrink-0 bg-surface-alt text-muted">
          {notes.length}
        </span>
      </button>

      <div id={noteListId} className={`drawer-notes-grid ${open ? 'is-open' : ''} mt-0.5`} aria-hidden={!open}>
        <div className="overflow-hidden">
          <div className="pt-0 pb-0.5 pl-2 pr-0.5 ml-3.5 border-l border-line/70">
            {notes.length === 0 ? (
              <p className="text-[11px] text-faint-soft py-0.5 pl-2">暂无笔记</p>
            ) : (
              <div className="space-y-0.5 pl-1.5">
                {notes.map((note) => (
                  <DrawerNoteItem
                    key={note.id}
                    note={note}
                    isSelected={selectedNoteId === note.id}
                    isFocused={focusNoteId === note.id}
                    onSelectNote={onSelectNote}
                    onDeleteNote={onDeleteNote}
                    onTogglePin={onTogglePin}
                    onContextMenu={onNoteContextMenu}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * 「未归类」抽屉：收纳 category_id 指向已删除分组的遗留笔记，
 * 仅在确有此类数据时才由 Sidebar 渲染；它没有分组右键菜单（无处可挂）。
 */
export const ChildNotesDrawer: React.FC<{
  notes: Note[];
  isExpanded: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onTogglePin?: (note: Note) => void;
  onNoteContextMenu?: (e: React.MouseEvent, note: Note) => void;
}> = ({
  notes,
  isExpanded,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onTogglePin,
  onNoteContextMenu,
}) => {
  const noteListId = 'drawer-notes-children';
  const open = isExpanded;
  return (
    <div className="drawer-item mt-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={noteListId}
        className="drawer-header w-full text-left pl-6 pr-2.5 py-1 rounded-lg transition-all duration-200 flex items-center gap-2 border border-dashed text-faint hover:bg-surface/70 hover:text-body border-line"
        title={open ? '收起' : '展开'}
      >
        <Icon
          name="sidebar-chevron-right-bold"
          className={`w-3 h-3 flex-shrink-0 text-faint transition-transform duration-300 ease-spring ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-[11.5px] flex-1 truncate">未归类</span>
        <span className="badge text-[10px] flex-shrink-0 bg-surface/70 text-muted">{notes.length}</span>
      </button>

      <div id={noteListId} className={`drawer-notes-grid ${open ? 'is-open' : ''} mt-0.5`} aria-hidden={!open}>
        <div className="overflow-hidden">
          <div className="pt-0.5 pb-0.5 pl-2 pr-0.5 ml-6 border-l border-line/70">
            <div className="space-y-0.5 pl-1.5">
              {notes.map((note) => (
                <DrawerNoteItem
                  key={note.id}
                  note={note}
                  isSelected={selectedNoteId === note.id}
                  isFocused={focusNoteId === note.id}
                  onSelectNote={onSelectNote}
                  onDeleteNote={onDeleteNote}
                  onTogglePin={onTogglePin}
                  onContextMenu={onNoteContextMenu}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
