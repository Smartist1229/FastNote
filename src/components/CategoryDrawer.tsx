import { useEffect, useRef } from 'react';
import { Category, Note } from '../types';

interface CategoryDrawerProps {
  category: Category | null;
  notes: Note[];
  isExpanded: boolean;
  /** 搜索时强制展开（但用户点击仍可收起） */
  isForcedOpen?: boolean;
  isAllNotes: boolean;
  isSearching: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onCreateNote: () => void;
  onContextMenu: (e: React.MouseEvent, category: Category | null) => void;
  onNoteContextMenu: (e: React.MouseEvent, note: Note) => void;
}

export const formatNoteDate = (dateString: string) => {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (hours < 24) return `${hours} 小时前`;
    if (days < 7) return `${days} 天前`;

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${month}-${day}`;
  } catch {
    return dateString;
  }
};

export const getNotePreview = (content: string) => {
  if (!content) return '暂无内容';
  const plain = content
    .replace(/#{1,6}\s/g, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '')
    .replace(/[-*+]\s/g, '')
    .replace(/\n/g, ' ')
    .trim();
  return plain || '暂无内容';
};

/** 笔记卡片：抽屉内的单条笔记 */
const DrawerNoteItem: React.FC<{
  note: Note;
  isSelected: boolean;
  isFocused: boolean;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onContextMenu?: (e: React.MouseEvent, note: Note) => void;
}> = ({ note, isSelected, isFocused, onSelectNote, onDeleteNote, onContextMenu }) => {
  const itemRef = useRef<HTMLDivElement>(null);

  // AI 打开笔记时聚焦高亮：滚动到可视区域
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
      draggable={true}
      onDragStart={(e) => {
        e.dataTransfer.setData('id', note.id.toString());
        e.dataTransfer.effectAllowed = 'move';
      }}
      className={`drawer-note group/note relative pl-3 pr-2 py-2 rounded-lg cursor-pointer border transition-all duration-200 ${
        isSelected
          ? 'bg-gradient-to-r from-primary-500 to-primary-600 border-transparent shadow-sm shadow-primary-500/25'
          : 'bg-white/70 border-slate-100 hover:border-primary-200 hover:bg-white'
      } ${isFocused && !isSelected ? 'note-focus-ring' : ''}`}
    >
      <div className="flex items-start gap-1.5">
        <div className="flex-1 min-w-0">
          <h4
            className={`text-[12.5px] font-medium truncate leading-snug ${
              isSelected ? 'text-white' : 'text-slate-700'
            }`}
          >
            {note.title || '无标题'}
          </h4>
          <p
            className={`text-[11px] mt-1 line-clamp-2 leading-relaxed ${
              isSelected ? 'text-white/70' : 'text-slate-400'
            }`}
          >
            {getNotePreview(note.content)}
          </p>
          <div className="flex items-center gap-1 mt-1.5">
            <svg
              className={`w-3 h-3 ${isSelected ? 'text-white/50' : 'text-slate-300'}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className={`text-[10.5px] ${isSelected ? 'text-white/60' : 'text-slate-300'}`}>
              {formatNoteDate(note.updated_at)}
            </span>
          </div>
        </div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDeleteNote(note);
          }}
          className={`flex-shrink-0 p-1 rounded-md opacity-0 group-hover/note:opacity-100 transition-all ${
            isSelected
              ? 'text-white/70 hover:bg-white/20 hover:text-white'
              : 'text-slate-300 hover:bg-red-50 hover:text-red-500'
          }`}
          title="移到回收站"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
};

/** 抽屉：分组标题 + 展开后的笔记列表 */
export const CategoryDrawer: React.FC<CategoryDrawerProps> = ({
  category,
  notes,
  isExpanded,
  isForcedOpen = false,
  isAllNotes,
  isSearching,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onCreateNote,
  onContextMenu,
  onNoteContextMenu,
}) => {
  const noteListId = `drawer-notes-${category ? category.id : 'all'}`;
  const headerRef = useRef<HTMLButtonElement>(null);
  // 搜索时强制展开；用户点击仍可单独收起
  const open = isExpanded || isForcedOpen;

  const headerBase =
    'relative w-full text-left px-2.5 py-2 rounded-xl transition-all duration-200 flex items-center gap-2 group/drawer border';
  const activeHeader = open
    ? 'bg-gradient-to-r from-primary-500 to-primary-600 text-white shadow-md shadow-primary-500/25 border-transparent'
    : 'text-slate-600 hover:bg-white/80 hover:text-slate-900 border-transparent hover:border-slate-200/60';

  return (
    <div
      className="drawer-item"
      onContextMenu={(e) => {
        if (!isAllNotes) onContextMenu(e, category);
      }}
    >
      <button
        ref={headerRef}
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
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-300 ease-spring ${
            open ? 'rotate-90 text-white/80' : 'text-slate-400'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>

        <svg
          className={`w-4 h-4 flex-shrink-0 ${open ? 'text-white/80' : 'text-slate-400'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          {isAllNotes ? (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          ) : (
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          )}
        </svg>

        <span className="text-[13px] flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 font-medium">
          {isAllNotes ? '全部笔记' : category?.name}
        </span>

        {/* 悬停操作按钮（仅分组） */}
        {!isAllNotes && category && (
          <span
            className={`flex items-center gap-0.5 opacity-0 group-hover/drawer:opacity-100 transition-opacity flex-shrink-0 ${
              open ? 'text-white' : 'text-slate-400'
            }`}
          >
            <span
              data-drawer-action="create-note"
              className={`p-1 rounded-md transition-colors ${
                open ? 'hover:bg-white/20' : 'hover:bg-slate-100'
              }`}
              title="在此分组新建笔记"
            >
              <svg className="w-3 h-3 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" />
              </svg>
            </span>
          </span>
        )}

        <span
          className={`badge text-[10px] flex-shrink-0 ${
            open ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {notes.length}
        </span>
      </button>

      {/* 展开区域 */}
      <div
        id={noteListId}
        className={`drawer-notes-grid ${open ? 'is-open' : ''}`}
        aria-hidden={!open}
      >
        <div className="overflow-hidden">
          <div className="pt-1 pb-1.5 pl-2 pr-0.5 ml-3.5 border-l border-slate-200/70">
            {notes.length === 0 ? (
              <p className="text-[11px] text-slate-300 py-2 pl-2">
                {isSearching ? '无匹配笔记' : '暂无笔记'}
              </p>
            ) : (
              <div className="space-y-1 pl-1.5">
                {notes.map((note) => (
                  <DrawerNoteItem
                    key={note.id}
                    note={note}
                    isSelected={selectedNoteId === note.id}
                    isFocused={focusNoteId === note.id}
                    onSelectNote={onSelectNote}
                    onDeleteNote={onDeleteNote}
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

/** 未分类笔记抽屉（Notes with category_id === null） */
export const UncategorizedDrawer: React.FC<{
  notes: Note[];
  isExpanded: boolean;
  isForcedOpen?: boolean;
  isSearching: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onNoteContextMenu?: (e: React.MouseEvent, note: Note) => void;
}> = ({
  notes,
  isExpanded,
  isForcedOpen = false,
  isSearching,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onNoteContextMenu,
}) => {
  const noteListId = 'drawer-notes-uncategorized';
  const open = isExpanded || isForcedOpen;
  return (
    <div className="drawer-item">
      {/* 不做 disabled：与普通分组行为一致，空时也能展开看到"暂无笔记" */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={noteListId}
        className={`relative w-full text-left px-2.5 py-2 rounded-xl transition-all duration-200 flex items-center gap-2 border border-dashed ${
          open
            ? 'bg-slate-600 text-white shadow-md !border-transparent'
            : 'text-slate-500 hover:bg-white/80 hover:text-slate-800 border-slate-300/70 hover:border-slate-300'
        }`}
        title={open ? '收起' : '展开'}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-300 ease-spring ${
            open ? 'rotate-90 text-white/80' : 'text-slate-400'
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <svg
          className={`w-4 h-4 flex-shrink-0 ${open ? 'text-white/80' : 'text-slate-400'}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
        </svg>
        <span className="text-[13px] flex-1 truncate font-medium">未分类</span>
        <span
          className={`badge text-[10px] flex-shrink-0 ${
            open ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'
          }`}
        >
          {notes.length}
        </span>
      </button>

      <div id={noteListId} className={`drawer-notes-grid ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="overflow-hidden">
          <div className="pt-1 pb-1.5 pl-2 pr-0.5 ml-3.5 border-l border-slate-200/70">
            {notes.length === 0 ? (
              <p className="text-[11px] text-slate-300 py-2 pl-2">
                {isSearching ? '无匹配笔记' : '暂无笔记'}
              </p>
            ) : (
              <div className="space-y-1 pl-1.5">
                {notes.map((note) => (
                  <DrawerNoteItem
                    key={note.id}
                    note={note}
                    isSelected={selectedNoteId === note.id}
                    isFocused={focusNoteId === note.id}
                    onSelectNote={onSelectNote}
                    onDeleteNote={onDeleteNote}
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

/** 历史遗留数据抽屉：category_id 指向已删除分组的笔记 */
export const ChildNotesDrawer: React.FC<{
  notes: Note[];
  isExpanded: boolean;
  isForcedOpen?: boolean;
  selectedNoteId: number | null;
  focusNoteId: number | null;
  onToggle: () => void;
  onSelectNote: (note: Note) => void;
  onDeleteNote: (note: Note) => void;
  onNoteContextMenu?: (e: React.MouseEvent, note: Note) => void;
}> = ({
  notes,
  isExpanded,
  isForcedOpen = false,
  selectedNoteId,
  focusNoteId,
  onToggle,
  onSelectNote,
  onDeleteNote,
  onNoteContextMenu,
}) => {
  const noteListId = 'drawer-notes-children';
  const open = isExpanded || isForcedOpen;
  return (
    <div className="drawer-item mt-0.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={noteListId}
        className={`w-full text-left pl-6 pr-2.5 py-1.5 rounded-lg transition-all duration-200 flex items-center gap-2 border border-dashed ${
          open
            ? 'bg-slate-200/70 text-slate-700 border-slate-300'
            : 'text-slate-400 hover:bg-white/70 hover:text-slate-600 border-slate-200'
        }`}
        title={open ? '收起' : '展开'}
      >
        <svg
          className={`w-3 h-3 flex-shrink-0 transition-transform duration-300 ease-spring ${open ? 'rotate-90' : ''}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
        <span className="text-[11.5px] flex-1 truncate">未归类</span>
        <span className="badge text-[10px] flex-shrink-0 bg-white/70 text-slate-500">{notes.length}</span>
      </button>

      <div id={noteListId} className={`drawer-notes-grid ${open ? 'is-open' : ''}`} aria-hidden={!open}>
        <div className="overflow-hidden">
          <div className="pt-1 pb-1 pl-2 pr-0.5 ml-6 border-l border-slate-200/70">
            <div className="space-y-1 pl-1.5">
              {notes.map((note) => (
                <DrawerNoteItem
                  key={note.id}
                  note={note}
                  isSelected={selectedNoteId === note.id}
                  isFocused={focusNoteId === note.id}
                  onSelectNote={onSelectNote}
                  onDeleteNote={onDeleteNote}
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
