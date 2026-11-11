import { Icon } from "@/components/common/Icon";
import { t as translate, useI18n } from "@/i18n";
import type { AiChatSession } from "@/interface/ai/ai";

/** 对话列表里的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD */
const relativeTime = (iso: string | undefined, t: typeof translate): string => {
  if (!iso) return "";
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return t("刚刚");
  if (diff < 3_600_000) return t("{count} 分钟前", { count: Math.floor(diff / 60_000) });
  const d = new Date(timestamp);
  const today = new Date();
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (dayDiff === 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayDiff === 1) return t("昨天");
  if (dayDiff < 7) return t("{count} 天前", { count: dayDiff });
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function SessionPicker({
  sessions, activeSessionId, editingSessionId, editTitle, sessionQuery, sessionGroups,
  onClose, onNewSession, onQueryChange, onQueryEscape, onSwitch, onStartEdit, onEditTitleChange,
  onRename, onCancelEdit, onDelete,
}: {
  sessions: AiChatSession[];
  activeSessionId: number;
  editingSessionId: number | null;
  editTitle: string;
  sessionQuery: string;
  sessionGroups: { label: string; items: AiChatSession[] }[];
  onClose: () => void;
  onNewSession: () => void;
  onQueryChange: (value: string) => void;
  onQueryEscape: () => void;
  onSwitch: (sid: number) => void;
  onStartEdit: (session: AiChatSession) => void;
  onEditTitleChange: (value: string) => void;
  onRename: (sid: number) => void;
  onCancelEdit: () => void;
  onDelete: (session: AiChatSession) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="ai-modal-overlay">
      <div className="ai-modal">
        <div className="ai-modal-head">
          <span className="ai-modal-title">{t("对话记录")}</span>
          <div className="flex items-center gap-1">
            <button
              className="ai-icon-btn"
              title={t("新建对话")}
              onClick={onNewSession}
            >
              <Icon name="ai-plus-bold" className="w-3.5 h-3.5" />
            </button>
            <button className="ai-icon-btn" title={t("关闭")} onClick={onClose}>
              <Icon name="ai-close" className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        <div className="ai-modal-search">
          <div className="relative">
            <Icon name="ai-search" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-faint-soft" />
            <input
              autoFocus
              value={sessionQuery}
              onChange={(e) => onQueryChange(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Escape") onQueryEscape(); }}
              placeholder={t("搜索对话标题…")}
              className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-lg border border-line bg-app/60 focus:bg-surface focus:border-primary-300 outline-none transition-colors"
            />
          </div>
        </div>

        <div className="ai-modal-list chat-scrollbar">
          {sessionGroups.length === 0 ? (
            <div className="py-8 text-center text-[11.5px] text-faint">
              {sessions.length === 0 ? t("还没有对话，开始聊一句就有了") : t("没有匹配的对话")}
            </div>
          ) : sessionGroups.map((group) => (
            <div key={group.label}>
              <div className="ai-group-label">{t(group.label)}</div>
              {group.items.map((s) => (
                <div
                  key={s.id}
                  className={"ai-session-item group/sess" + (s.id === activeSessionId ? " is-active" : "")}
                  onClick={() => onSwitch(s.id)}
                >
                  <div className="min-w-0 flex-1">
                    {editingSessionId === s.id ? (
                      <input
                        autoFocus
                        className="w-full border border-primary-300 rounded px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-primary-500/20"
                        value={editTitle}
                        onChange={(e) => onEditTitleChange(e.target.value)}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") onRename(s.id);
                          if (e.key === "Escape") onCancelEdit();
                        }}
                        onBlur={onCancelEdit}
                      />
                    ) : (
                      <>
                        <div className="ai-session-name truncate">{!s.title || s.title === "新对话" ? t("新对话") : s.title}</div>
                        <div className="ai-session-meta truncate">{relativeTime(s.updated_at || s.created_at, t)}</div>
                      </>
                    )}
                  </div>
                  <div className="ai-session-actions">
                    <button
                      className="ai-icon-btn !w-6 !h-6"
                      title={t("重命名")}
                      onClick={(e) => { e.stopPropagation(); onStartEdit(s); }}
                    >
                      <Icon name="ai-edit" className="w-3 h-3" />
                    </button>
                    <button
                      className="ai-icon-btn is-danger !w-6 !h-6"
                      title={t("删除这个对话")}
                      onClick={(e) => { e.stopPropagation(); onDelete(s); }}
                    >
                      <Icon name="ai-trash" className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
