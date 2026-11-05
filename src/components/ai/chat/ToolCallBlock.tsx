import { Icon } from "@/components/common/Icon";
import { useI18n } from "@/i18n";
import { TOOL_LABELS } from "@/lib/ai/tools";
import type { ToolTrace } from "@/interface/ai/aiOutput";

export function ToolCallBlock({ tool, open, onToggle }: {
  tool: ToolTrace;
  open: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const running = tool.ok === null || tool.ok === undefined;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={`flex w-full items-center gap-1.5 text-left text-[11.5px] transition-colors py-0.5 ${
          tool.ok === false ? 'text-danger hover:text-danger-strong' : 'text-faint hover:text-body'
        }`}
        title={t("展开查看调用参数与结果")}
      >
        {running ? (
          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" />
          </span>
        ) : tool.ok ? (
          <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
        ) : (
          <Icon name="ai-alert-triangle" className="w-3 h-3 flex-shrink-0" />
        )}
        <span className="flex-shrink-0">{TOOL_LABELS[tool.name] ? t(TOOL_LABELS[tool.name]) : tool.name}</span>
        {tool.detail ? (<><span className="text-faint-soft flex-shrink-0">·</span><span className="truncate" title={tool.detail}>{tool.detail}</span></>) : null}
        {running ? <span className="flex-shrink-0 text-faint-soft">{t("执行中…")}</span> : null}
        <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 text-faint-soft transition-transform " + (open ? "rotate-90" : "")} />
      </button>
      {open && (
        <pre className="mt-0.5 mb-1 ml-[18px] px-2 py-1.5 rounded-lg bg-app border border-line-soft text-[10.5px] leading-relaxed text-muted whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{t("调用 {call}　结果 {result}", {
          call: JSON.stringify({ name: tool.name, args: tool.args }),
          result: running ? t("（执行中）") : JSON.stringify(tool.result ?? null).slice(0, 400),
        })}</pre>
      )}
    </div>
  );
}
