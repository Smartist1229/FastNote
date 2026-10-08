import { Note } from "../types";
import { AiSparkleIcon } from "./icons";
import { Icon } from "./Icon";

interface WelcomeDashboardProps {
  totalNotes: number;
  categoryCount: number;
  trashCount: number;
  recentNotes: Note[];
  onCreateNote: () => void;
  onOpenTrash: () => void;
  onSelectNote: (note: Note) => void;
  /** 未打开笔记时也能进入 AI 对话 */
  onToggleAiPanel?: () => void;
  isAiPanelOpen?: boolean;
}

export const WelcomeDashboard: React.FC<WelcomeDashboardProps> = ({
  totalNotes,
  categoryCount,
  trashCount,
  recentNotes,
  onCreateNote,
  onOpenTrash,
  onSelectNote,
  onToggleAiPanel,
  isAiPanelOpen = false,
}) => {
  const formatDate = (s: string) => {
    try {
      const d = new Date(s);
      const now = new Date();
      const diff = now.getTime() - d.getTime();
      const minutes = Math.floor(diff / 60000);
      const hours = Math.floor(diff / 3600000);
      const days = Math.floor(diff / 86400000);

      if (minutes < 1) return '刚刚';
      if (minutes < 60) return `${minutes} 分钟前`;
      if (hours < 24) return `${hours} 小时前`;
      if (days < 7) return `${days} 天前`;

      const month = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${month}-${day}`;
    } catch {
      return s;
    }
  };

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 6) return '夜深了';
    if (hour < 9) return '早上好';
    if (hour < 12) return '上午好';
    if (hour < 14) return '中午好';
    if (hour < 18) return '下午好';
    if (hour < 22) return '晚上好';
    return '夜深了';
  };

  return (
    <div className="h-full w-full min-w-0 flex flex-col overflow-y-auto overflow-x-hidden">
      {/* 顶部渐变区域（overflow-hidden 裁掉装饰光斑，避免撑出横向滚动） */}
      <div className="relative overflow-hidden bg-gradient-to-br from-primary-50 via-white to-indigo-50 px-8 pt-12 pb-8 flex-shrink-0">
        {/* 装饰元素 */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-primary-100/30 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-48 h-48 bg-indigo-100/20 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4" />
        
        <div className="relative">
          {/* Logo + 问候 */}
          <div className="flex items-center gap-4 mb-6 animate-slideUp">
            <div className="w-14 h-14 bg-gradient-to-br from-primary-500 to-primary-700 rounded-2xl flex items-center justify-center shadow-lg shadow-primary-500/30">
              <Icon name="welcome-edit" className="w-7 h-7 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-800">FastNote</h1>
              <p className="text-sm text-slate-500 mt-0.5">{getGreeting()}，开始记录你的想法</p>
            </div>
          </div>

          {/* 统计卡片 */}
          <div className="grid grid-cols-3 gap-3 animate-slideUp" style={{ animationDelay: "0.05s" }}>
            <div className="glass-card rounded-2xl p-4 text-center hover:shadow-md transition-shadow duration-300">
              <div className="text-2xl font-bold bg-gradient-to-br from-primary-600 to-primary-700 bg-clip-text text-transparent">{totalNotes}</div>
              <div className="text-xs text-slate-400 mt-1 font-medium">笔记</div>
            </div>
            <div className="glass-card rounded-2xl p-4 text-center hover:shadow-md transition-shadow duration-300">
              <div className="text-2xl font-bold bg-gradient-to-br from-indigo-600 to-indigo-700 bg-clip-text text-transparent">{categoryCount}</div>
              <div className="text-xs text-slate-400 mt-1 font-medium">分类</div>
            </div>
            <div className="glass-card rounded-2xl p-4 text-center hover:shadow-md transition-shadow duration-300">
              <div className="text-2xl font-bold bg-gradient-to-br from-violet-600 to-violet-700 bg-clip-text text-transparent">{trashCount}</div>
              <div className="text-xs text-slate-400 mt-1 font-medium">回收站</div>
            </div>
          </div>
        </div>
      </div>

      {/* 快捷操作 */}
      <div className="px-8 py-6 flex-shrink-0">
        <div className="flex flex-wrap items-center gap-3 animate-slideUp" style={{ animationDelay: "0.1s" }}>
          <button
            onClick={onCreateNote}
            className="btn-primary px-5 py-2.5 text-sm font-medium flex items-center gap-2"
          >
            <Icon name="welcome-plus" className="w-4 h-4" />
            创建新笔记
          </button>
          <button
            onClick={onOpenTrash}
            className="btn-ghost px-5 py-2.5 text-sm font-medium flex items-center gap-2 border border-slate-200 hover:border-slate-300"
          >
            <Icon name="welcome-trash" className="w-4 h-4" />
            回收站
          </button>
          {onToggleAiPanel && (
            <button
              onClick={onToggleAiPanel}
              className={`px-5 py-2.5 text-sm font-medium flex items-center gap-2 rounded-xl border transition-all ${
                isAiPanelOpen
                  ? 'border-primary-200 bg-primary-50 text-primary-600'
                  : 'border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50/50'
              }`}
              title={isAiPanelOpen ? '关闭 AI 对话' : '打开 AI 对话'}
              aria-pressed={isAiPanelOpen}
            >
              <AiSparkleIcon className="w-4 h-4" />
              AI 助手
            </button>
          )}
        </div>
      </div>

      {/* 最近笔记 */}
      {recentNotes.length > 0 && (
        <div className="px-8 flex-1 min-h-0">
          {/* 底部留白必须加在内容上：加在 flex 子项上时，一旦列表比子项高就会溢出子项，
              内边距便不再位于最后一张卡片之后，列表看起来就"贴底"了 */}
          <div className="animate-slideUp pb-10" style={{ animationDelay: "0.15s" }}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">最近更新</h3>
              <span className="text-[11px] text-slate-300">{Math.min(recentNotes.length, 5)} 篇</span>
            </div>
            <div className="space-y-2">
              {recentNotes.slice(0, 5).map((note, index) => (
                <button
                  key={note.id}
                  onClick={() => onSelectNote(note)}
                  className="w-full text-left p-3.5 rounded-xl bg-white hover:bg-slate-50 transition-all duration-200 border border-slate-100 hover:border-slate-200 hover:shadow-sm group"
                  style={{ animationDelay: `${0.15 + index * 0.03}s` }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-700 group-hover:text-slate-900 truncate transition-colors">
                        {note.title || "无标题"}
                      </div>
                      <div className="flex items-center gap-2 mt-1.5">
                        <Icon name="welcome-clock" className="w-3 h-3 text-slate-300" />
                        <span className="text-xs text-slate-400">{formatDate(note.updated_at)}</span>
                      </div>
                    </div>
                    <Icon name="welcome-chevron-right" className="w-4 h-4 text-slate-200 group-hover:text-primary-400 transition-colors flex-shrink-0 mt-0.5" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {totalNotes === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center px-8 pb-12">
          <div className="animate-slideUp text-center" style={{ animationDelay: "0.2s" }}>
            <div className="w-16 h-16 rounded-3xl bg-gradient-to-br from-slate-100 to-slate-50 flex items-center justify-center mx-auto mb-4">
              <Icon name="welcome-file-empty" className="w-8 h-8 text-slate-300" />
            </div>
            <p className="text-sm text-slate-500 font-medium">还没有笔记</p>
            <p className="text-xs text-slate-400 mt-1.5">点击「创建新笔记」开始你的创作</p>
          </div>
        </div>
      )}
    </div>
  );
};
