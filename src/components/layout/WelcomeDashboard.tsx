import { Note } from "@/types";
import { AiSparkleIcon } from "@/components/common/icons";
import { Icon } from "@/components/common/Icon";

interface WelcomeDashboardProps {
  totalNotes: number;
  categoryCount: number;
  trashCount: number;
  recentNotes: Note[];
  onCreateNote: () => void;
  onOpenTrash: () => void;
  /** 打开电脑上的文本文件（拖入规则一致） */
  onOpenTextFile?: () => void;
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
  onOpenTextFile,
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
      <div className="relative overflow-hidden bg-gradient-to-br from-primary-50 via-white to-indigo-50 px-7 pt-7 pb-5 flex-shrink-0">
        {/* 装饰元素 */}
        <div className="absolute top-0 right-0 w-48 h-48 bg-primary-100/30 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4" />
        <div className="absolute bottom-0 left-0 w-40 h-40 bg-indigo-100/20 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4" />

        <div className="relative">
          {/* Logo + 问候 */}
          <div className="flex items-center gap-3 mb-5 animate-slideUp">
            <div>
              <h1 className="text-lg font-semibold text-slate-800 leading-tight">FastNote</h1>
              <p className="text-xs text-slate-400 mt-0.5">{getGreeting()}，开始记录你的想法</p>
            </div>
          </div>

          {/* 统计卡片 */}
          <div className="grid grid-cols-3 gap-2.5 animate-slideUp" style={{ animationDelay: "0.05s" }}>
            <div className="glass-card rounded-xl px-3 py-2.5 text-center hover:shadow-sm transition-shadow duration-300">
              <div className="text-lg font-semibold bg-gradient-to-br from-primary-600 to-primary-700 bg-clip-text text-transparent leading-tight">{totalNotes}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">笔记</div>
            </div>
            <div className="glass-card rounded-xl px-3 py-2.5 text-center hover:shadow-sm transition-shadow duration-300">
              <div className="text-lg font-semibold bg-gradient-to-br from-indigo-600 to-indigo-700 bg-clip-text text-transparent leading-tight">{categoryCount}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">分类</div>
            </div>
            <div className="glass-card rounded-xl px-3 py-2.5 text-center hover:shadow-sm transition-shadow duration-300">
              <div className="text-lg font-semibold bg-gradient-to-br from-violet-600 to-violet-700 bg-clip-text text-transparent leading-tight">{trashCount}</div>
              <div className="text-[11px] text-slate-400 mt-0.5">回收站</div>
            </div>
          </div>
        </div>
      </div>

      {/* 快捷操作 */}
      <div className="px-7 py-4 flex-shrink-0">
        <div className="flex flex-wrap items-center gap-2 animate-slideUp" style={{ animationDelay: "0.1s" }}>
          <button
            onClick={onCreateNote}
            className="btn-primary px-3.5 py-2 text-xs font-medium flex items-center gap-1.5"
          >
            <Icon name="welcome-plus" className="w-3.5 h-3.5" />
            创建新笔记
          </button>
          <button
            onClick={onOpenTrash}
            className="btn-ghost px-3.5 py-2 text-xs font-medium flex items-center gap-1.5 border border-slate-200 hover:border-slate-300"
          >
            <Icon name="welcome-trash" className="w-3.5 h-3.5" />
            回收站
          </button>
          {onOpenTextFile && (
            <button
              onClick={onOpenTextFile}
              className="btn-ghost px-3.5 py-2 text-xs font-medium flex items-center gap-1.5 border border-slate-200 hover:border-slate-300"
              title="打开电脑上的文本文件，编辑会实时保存回原文件"
            >
              <Icon name="ai-file-text" className="w-3.5 h-3.5" />
              打开文本文件
            </button>
          )}
          {onToggleAiPanel && (
            <button
              onClick={onToggleAiPanel}
              className={`px-3.5 py-2 text-xs font-medium flex items-center gap-1.5 rounded-lg border transition-all ${
                isAiPanelOpen
                  ? 'border-primary-200 bg-primary-50 text-primary-600'
                  : 'border-slate-200 text-slate-600 hover:border-primary-300 hover:text-primary-600 hover:bg-primary-50/50'
              }`}
              title={isAiPanelOpen ? '关闭 AI 对话' : '打开 AI 对话'}
              aria-pressed={isAiPanelOpen}
            >
              <AiSparkleIcon className="w-3.5 h-3.5" />
              AI 助手
            </button>
          )}
        </div>
      </div>

      {/* 最近笔记 */}
      {recentNotes.length > 0 && (
        <div className="px-7 flex-1 min-h-0">
          {/* 底部留白必须加在内容上：加在 flex 子项上时，一旦列表比子项高就会溢出子项，
              内边距便不再位于最后一张卡片之后，列表看起来就"贴底"了 */}
          <div className="animate-slideUp pb-8" style={{ animationDelay: "0.15s" }}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">最近更新</h3>
              <span className="text-[11px] text-slate-300">{Math.min(recentNotes.length, 5)} 篇</span>
            </div>
            <div className="space-y-1.5">
              {recentNotes.slice(0, 5).map((note, index) => (
                <button
                  key={note.id}
                  onClick={() => onSelectNote(note)}
                  className="w-full text-left px-3 py-2.5 rounded-lg bg-white hover:bg-slate-50 transition-all duration-200 border border-slate-100 hover:border-slate-200 hover:shadow-sm group"
                  style={{ animationDelay: `${0.15 + index * 0.03}s` }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium text-slate-700 group-hover:text-slate-900 truncate transition-colors">
                        {note.title || "无标题"}
                      </div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <Icon name="welcome-clock" className="w-3 h-3 text-slate-300" />
                        <span className="text-[11px] text-slate-400">{formatDate(note.updated_at)}</span>
                      </div>
                    </div>
                    <Icon name="welcome-chevron-right" className="w-3.5 h-3.5 text-slate-200 group-hover:text-primary-400 transition-colors flex-shrink-0" />
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 空状态 */}
      {totalNotes === 0 && (
        <div className="flex-1 flex flex-col items-center justify-center px-7 pb-10">
          <div className="animate-slideUp text-center" style={{ animationDelay: "0.2s" }}>
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-50 flex items-center justify-center mx-auto mb-3">
              <Icon name="welcome-file-empty" className="w-6 h-6 text-slate-300" />
            </div>
            <p className="text-[13px] text-slate-500 font-medium">还没有笔记</p>
            <p className="text-xs text-slate-400 mt-1">点击「创建新笔记」开始你的创作</p>
          </div>
        </div>
      )}
    </div>
  );
};
