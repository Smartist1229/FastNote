import { Note, Category } from '../types';
import { useRef, useEffect, useState } from 'react';
import { ContextMenu, ContextMenuItem, useContextMenu } from './ContextMenu';

interface NoteListProps {
  notes: Note[];
  categories: Category[];
  onSelectNote: (note: Note) => void;
  selectedNoteId: number | null;
  sortOrder: string;
  isNewNote: boolean;
  onDeleteNote: (note: Note) => void;
  onMoveToCategory: (note: Note, categoryId: number | null) => void;
  onCreateNote: () => void;
}

export const NoteList: React.FC<NoteListProps> = ({
  notes,
  categories,
  onSelectNote,
  selectedNoteId,
  sortOrder,
  isNewNote,
  onDeleteNote,
  onMoveToCategory,
  onCreateNote,
}) => {
  const [contextMenuNote, setContextMenuNote] = useState<Note | null>(null);
  const { menuPos, handleContextMenu, closeMenu } = useContextMenu();

  const formatDate = (dateString: string) => {
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

  const getContentPreview = (content: string) => {
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

  const getNoteMenuItems = (note: Note): ContextMenuItem[] => [
    {
      label: '打开笔记',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </svg>
      ),
      onClick: () => onSelectNote(note),
    },
    {
      label: '新建笔记',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
        </svg>
      ),
      onClick: () => onCreateNote(),
    },
    { divider: true, label: '', onClick: () => {} },
    {
      label: '移动到分类',
      icon: (
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
      ),
      onClick: () => {},
      submenu: [
        {
          label: '未分类',
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
            </svg>
          ),
          onClick: () => onMoveToCategory(note, null),
          disabled: note.category_id === null,
        },
        ...categories.map((cat) => ({
          label: cat.name,
          icon: (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
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
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
        </svg>
      ),
      onClick: () => onDeleteNote(note),
      danger: true,
    },
  ];

  const listRef = useRef<HTMLDivElement>(null);
  const selectedNoteRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const scrollToSelected = () => {
      if (listRef.current) {
        if (isNewNote && sortOrder === 'asc') {
          listRef.current.scrollTo({
            top: listRef.current.scrollHeight,
            behavior: 'smooth',
          });
        } else if (selectedNoteRef.current) {
          selectedNoteRef.current.scrollIntoView({
            behavior: 'smooth',
            block: 'nearest',
          });
        }
      }
    };
    
    scrollToSelected();
  }, [selectedNoteId, notes, sortOrder, isNewNote]);

  return (
    <div ref={listRef} className="h-full overflow-y-auto p-2.5">
      {notes.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mb-3">
            <svg className="w-6 h-6 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <p className="text-sm text-slate-400 text-center">暂无笔记</p>
          <p className="text-xs text-slate-300 mt-1">点击 + 创建新笔记</p>
        </div>
      ) : (
        <div className="space-y-1.5">
          {notes.map((note) => {
            const isSelected = selectedNoteId === note.id;
            return (
              <div
                key={note.id}
                ref={isSelected ? selectedNoteRef : null}
                onClick={() => onSelectNote(note)}
                onContextMenu={(e) => {
                  setContextMenuNote(note);
                  handleContextMenu(e);
                }}
                draggable={true}
                onDragStart={(e) => {
                  e.dataTransfer.setData('id', note.id.toString());
                  e.dataTransfer.effectAllowed = 'move';
                }}
                className={`note-card p-3 rounded-xl cursor-pointer border ${
                  isSelected
                    ? 'note-card-selected'
                    : 'bg-white border-slate-100 hover:border-slate-200'
                }`}
              >
                <h3 className={`font-medium truncate text-[13px] leading-snug ${
                  isSelected ? 'text-white' : 'text-slate-800'
                }`}>
                  {note.title || '无标题'}
                </h3>
                <p className={`text-xs mt-1.5 line-clamp-2 leading-relaxed ${
                  isSelected ? 'text-white/70' : 'text-slate-400'
                }`}>
                  {getContentPreview(note.content)}
                </p>
                <div className="flex items-center gap-1.5 mt-2">
                  <svg className={`w-3 h-3 ${isSelected ? 'text-white/50' : 'text-slate-300'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span className={`text-[11px] ${
                    isSelected ? 'text-white/60' : 'text-slate-300'
                  }`}>
                    {formatDate(note.updated_at)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 笔记右键菜单 */}
      <ContextMenu
        items={contextMenuNote ? getNoteMenuItems(contextMenuNote) : []}
        position={menuPos}
        onClose={closeMenu}
      />
    </div>
  );
};
