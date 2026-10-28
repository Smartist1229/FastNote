/**
 * AI 写操作的确认气泡。
 *
 * 悬浮在对话输入框上方（`absolute bottom-full`，宽度跟面板走），不盖住整个窗口——
 * 确认的时候还要能看笔记/上下文。一次只显示一条：右上角 `1/N` 标出进度，
 * 不能切换，只能「执行」或「取消」当前这条，多步操作的先后顺序才靠得住。
 *
 * 工具 JSON 默认按原样单行显示（和模型实际发出的内容一致，方便核对参数），
 * 需要看清结构时点左下角的「格式化」再展开成缩进版；每条新操作都回到未格式化。
 *
 * 定位由父级 `.composer-wrap`（position: relative）负责，本组件只管卡片本身。
 */
import { useEffect, useState } from "react";
import type { ToolCall } from "@/interface/aiOutput";
import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";

interface AiConfirmCardProps {
  call: ToolCall;
  /** 当前是第几条（1 基） */
  index: number;
  /** 这一批总共几条 */
  total: number;
  /** 一句话说明（由调用方按工具名生成） */
  summary: string;
  onRun: () => void;
  onCancel: () => void;
}

export const AiConfirmCard: React.FC<AiConfirmCardProps> = ({ call, index, total, summary, onRun, onCancel }) => {
  const { t } = useI18n();
  /** 是否把 JSON 缩进展开：默认关，避免一屏只有参数 */
  const [pretty, setPretty] = useState(false);

  // 换到另一条工具调用时收起格式化，否则下一条一出来就是展开态
  useEffect(() => setPretty(false), [call]);

  const payload = { name: call.name, args: call.args };
  const json = pretty ? JSON.stringify(payload, null, 2) : JSON.stringify(payload);

  return (
    <div className="absolute left-3 right-3 bottom-full mb-2 z-20 rounded-xl border border-line bg-surface shadow-xl p-3 animate-fade-in">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon name="ai-warning" className="w-3.5 h-3.5 flex-shrink-0 text-warning" />
          <span className="text-xs font-medium text-body truncate">{t("AI 要执行的操作")}</span>
        </div>
        <span className="flex-shrink-0 text-[10.5px] tabular-nums text-faint" title={t("第几条 / 共几条（按顺序执行，不能跳）")}>
          {index}/{total}
        </span>
      </div>
      <p className="text-[11.5px] text-muted mb-1.5 truncate" title={summary}>
        {summary}
      </p>
      <pre className="max-h-32 overflow-auto chat-scrollbar rounded-lg border border-line-soft bg-app px-2 py-1.5 text-[10.5px] leading-[1.55] text-body whitespace-pre-wrap break-all">
        {json}
      </pre>
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={() => setPretty((value) => !value)}
          className={`px-2 py-1 text-[11px] font-medium rounded-lg transition-colors ${
            pretty ? "text-primary-600 bg-primary-50 hover:bg-primary-100" : "text-muted bg-surface-alt hover:bg-surface-strong"
          }`}
          title={pretty ? t("收成一行（原始 JSON）") : t("展开成缩进格式，便于核对参数")}
          aria-pressed={pretty}
        >
          {t("格式化")}
        </button>
        <div className="flex-1" />
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium text-muted bg-surface-alt hover:bg-surface-strong rounded-lg transition-colors"
        >
          {t("取消")}
        </button>
        <button
          onClick={onRun}
          className="px-3 py-1.5 text-xs font-medium text-on-accent bg-primary-500 hover:bg-primary-600 rounded-lg transition-colors"
        >
          {t("执行")}
        </button>
      </div>
    </div>
  );
};
