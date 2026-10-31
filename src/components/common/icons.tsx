import { Icon } from "@/components/common/Icon";

/** AI 对话的统一图标（侧边栏、编辑器工具栏、欢迎页共用），只包一层以固定默认尺寸 */
export const AiSparkleIcon: React.FC<{ className?: string }> = ({ className = 'w-4 h-4' }) => (
  <Icon name="shared-sparkle" className={className} />
);
