/** AI 对话的统一图标（侧边栏、编辑器工具栏、欢迎页共用） */
export const AiSparkleIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M9.75 3.104a.75.75 0 011.5 0l.4 2.395a3.75 3.75 0 003.102 3.102l2.395.4a.75.75 0 010 1.5l-2.395.4a3.75 3.75 0 00-3.102 3.102l-.4 2.395a.75.75 0 01-1.5 0l-.4-2.395A3.75 3.75 0 006.248 10.9l-2.395-.4a.75.75 0 010-1.5l2.395-.4A3.75 3.75 0 009.35 5.5l.4-2.395z"
    />
    <path
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={2}
      d="M18 15l.25 1.5a2.25 2.25 0 001.85 1.85L21.6 18.6l-1.5.25a2.25 2.25 0 00-1.85 1.85L18 22.2l-.25-1.5a2.25 2.25 0 00-1.85-1.85l-1.5-.25 1.5-.25a2.25 2.25 0 001.85-1.85L18 15z"
    />
  </svg>
);
