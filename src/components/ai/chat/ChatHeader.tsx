import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

/** 用量缩写：小于 1000 显示原值，大于等于 1000 显示一位小数的 k（侧栏很窄，只能这么放） */
const formatTokens = (value: number): string =>
  value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);

export function ChatHeader({
  sessionTitle, hasProvider, providerName, activeModel, providersError, usage, onOpenSessionPicker, onNewSession, onOpenAiMemory, onOpenProviderSettings, onClose,
}: {
  sessionTitle?: string;
  hasProvider: boolean;
  providerName?: string;
  activeModel: string;
  providersError: string;
  /** 本会话累计用量：拿不到服务商 usage 时全是 0，此时不显示 */
  usage?: { prompt: number; completion: number; cached: number };
  onOpenSessionPicker: () => void;
  onNewSession: () => void;
  onOpenAiMemory: () => void;
  onOpenProviderSettings: () => void;
  onClose?: () => void;
}) {
  const { t } = useI18n();
  const usageTotal = usage ? usage.prompt + usage.completion : 0;
  const usageLabel = usageTotal > 0
    ? t(" · {count} tok", { count: formatTokens(usageTotal) })
    : "";
  const usageTitle = usageTotal > 0
    ? t("本会话用量：输入 {prompt} / 输出 {completion}，其中 {cached} 命中缓存", {
        prompt: String(usage!.prompt),
        completion: String(usage!.completion),
        cached: String(usage!.cached),
      })
    : "";
  return (<>
    {/* 头部：左边是"会话卡片"（标题 + 当前模型 + 累计用量），右边是一组图标按钮 */}
    <div className="ai-header flex-shrink-0">
      <button
        className="ai-session-btn"
        onClick={onOpenSessionPicker}
        title={t("切换 / 管理对话")}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12.5px] font-medium text-body">{!sessionTitle || sessionTitle === "新对话" ? t("新对话") : sessionTitle}</span>
          <span className="block truncate text-[10.5px] text-faint" title={usageTitle || undefined}>
            {hasProvider ? `${providerName} · ${activeModel || t("未选模型")}${usageLabel}` : t("未配置服务商")}
          </span>
        </span>
        <Icon name="ai-chevron-down" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
      </button>

      <button className="ai-icon-btn" onClick={onNewSession} title={t("新建对话")}>
        <Icon name="ai-plus-bold" className="w-3.5 h-3.5" />
      </button>
      <button className="ai-icon-btn" onClick={onOpenAiMemory} title={t("AI 记忆 / 前置提示词")}>
        <Icon name="ai-lightbulb-bold" className="w-3.5 h-3.5" />
      </button>
      <button className="ai-icon-btn" onClick={onOpenProviderSettings} title={t("AI 设置")}>
        <Icon name="ai-settings" className="w-3.5 h-3.5" />
      </button>
      {onClose && (
        <button className="ai-icon-btn" title={t("关闭 AI 对话")} onClick={onClose}>
          <Icon name="ai-close" className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
    {providersError && (
      <div className="selectable mx-3 mt-2 px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-[11px] text-danger-strong leading-relaxed break-all">
        {t("读取 AI 服务商失败：{error}", { error: providersError })}
      </div>
    )}
  </>);
}
