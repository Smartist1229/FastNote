import { Note } from "../types";

interface WelcomeDashboardProps {
  totalNotes: number;
  categoryCount: number;
  trashCount: number;
  recentNotes: Note[];
  onCreateNote: () => void;
  onOpenTrash: () => void;
  onSelectNote: (note: Note) => void;
}

export const WelcomeDashboard: React.FC<WelcomeDashboardProps> = ({
  totalNotes,
  categoryCount,
  trashCount,
  recentNotes,
  onCreateNote,
  onOpenTrash,
  onSelectNote,
}) => {
  const formatDate = (s: string) => {
    try {
      const d = new Date(s);
      const month = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      const hours = String(d.getHours()).padStart(2, "0");
      const minutes = String(d.getMinutes()).padStart(2, "0");
      return `${month}-${day} ${hours}:${minutes}`;
    } catch {
      return s;
    }
  };

  return (
    <div className="h-full flex flex-col items-center justify-center p-8 overflow-y-auto bg-gray-50">
      {/* Logo + 标题 */}
      <div className="flex flex-col items-center mb-8 animate-slideUp">
        <div className="w-16 h-16 bg-gray-800 rounded-2xl flex items-center justify-center shadow-lg mb-4">
          <svg className="w-8 h-8 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-800 mb-1">FastNote</h1>
        <p className="text-sm text-gray-400">简洁高效的笔记应用</p>
      </div>

      {/* 统计卡片 */}
      <div className="grid grid-cols-3 gap-4 w-full max-w-md mb-8">
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center animate-slideUp" style={{ animationDelay: "0.05s" }}>
          <div className="text-2xl font-bold text-gray-800">{totalNotes}</div>
          <div className="text-xs text-gray-400 mt-1">笔记</div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center animate-slideUp" style={{ animationDelay: "0.1s" }}>
          <div className="text-2xl font-bold text-gray-800">{categoryCount}</div>
          <div className="text-xs text-gray-400 mt-1">分类</div>
        </div>
        <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-center animate-slideUp" style={{ animationDelay: "0.15s" }}>
          <div className="text-2xl font-bold text-gray-800">{trashCount}</div>
          <div className="text-xs text-gray-400 mt-1">回收站</div>
        </div>
      </div>

      {/* 快捷操作 */}
      <div className="flex items-center gap-3 mb-8 animate-slideUp" style={{ animationDelay: "0.2s" }}>
        <button
          onClick={onCreateNote}
          className="px-5 py-2.5 bg-gray-800 text-white rounded-xl hover:bg-gray-700 transition-colors shadow-sm text-sm font-medium flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          创建新笔记
        </button>
        <button
          onClick={onOpenTrash}
          className="px-5 py-2.5 bg-white text-gray-600 rounded-xl hover:bg-gray-100 transition-colors shadow-sm border border-gray-200 text-sm font-medium flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
          回收站
        </button>
      </div>

      {/* 最近笔记 */}
      {recentNotes.length > 0 && (
        <div className="w-full max-w-md animate-slideUp" style={{ animationDelay: "0.25s" }}>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">最近更新</h3>
          <div className="space-y-1.5">
            {recentNotes.slice(0, 5).map((note) => (
              <button
                key={note.id}
                onClick={() => onSelectNote(note)}
                className="w-full text-left p-3 rounded-xl bg-white hover:bg-gray-50 transition-colors border border-gray-100 shadow-sm"
              >
                <div className="text-sm font-medium text-gray-800 truncate">{note.title || "无标题"}</div>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-gray-400">{formatDate(note.updated_at)}</span>
                  {note.category_id && (
                    <span className="text-xs text-gray-300">· 已分类</span>
                  )}
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 空状态 */}
      {totalNotes === 0 && (
        <div className="text-center animate-slideUp text-gray-400 text-sm" style={{ animationDelay: "0.3s" }}>
          <p>还没有笔记</p>
          <p className="mt-1">点击上方按钮创建你的第一篇笔记</p>
        </div>
      )}
    </div>
  );
};
