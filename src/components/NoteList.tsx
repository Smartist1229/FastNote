import { Note } from '../types';
import { useRef, useEffect } from 'react';

interface NoteListProps {
  notes: Note[];
  onSelectNote: (note: Note) => void;
  selectedNoteId: number | null;
  sortOrder: string;
  isNewNote: boolean;
}

export const NoteList: React.FC<NoteListProps> = ({ notes, onSelectNote, selectedNoteId, sortOrder, isNewNote }) => {
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      const hours = String(date.getHours()).padStart(2, '0');
      const minutes = String(date.getMinutes()).padStart(2, '0');
      return `${month}-${day} ${hours}:${minutes}`;
    } catch {
      return dateString;
    }
  };

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
    <div ref={listRef} className="h-full overflow-y-auto p-2">
      {notes.length === 0 ? (
        <div className="text-center text-gray-500 py-8 text-sm">
          暂无笔记，点击 + 创建新笔记
        </div>
      ) : (
        <div className="space-y-1.5">
          {notes.map((note) => (
            <div
              key={note.id}
              ref={selectedNoteId === note.id ? selectedNoteRef : null}
              onClick={() => onSelectNote(note)}
              className={`p-2.5 rounded-md cursor-pointer transition-all duration-150 shadow-sm hover:shadow border ${
                selectedNoteId === note.id
                  ? 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white hover:bg-gray-50 border-gray-200'
              }`}
            >
              <h3 className="font-medium truncate mb-0.5 text-sm">{note.title || '无标题'}</h3>
              <p className="text-xs text-gray-500 line-clamp-1 mb-1">
                {note.content || '无内容'}
              </p>
              <div className="text-xs text-gray-400">
                {formatDate(note.updated_at)}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
