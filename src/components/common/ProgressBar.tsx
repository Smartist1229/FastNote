/**
 * 通用进度条（软件层共用）：下载、索引等需要展示进度的场景。
 *
 * - `value` 为 0–100；传 null 表示进度未知（准备/校验阶段），避免一直停在 0% 像没反应；
 * - `label` 在左，`detail`（字节数、网速等）与百分比在右，全部可选；
 * - 颜色走语义 token，暗色主题自动跟随。
 */
export interface ProgressBarProps {
  value: number | null;
  label?: React.ReactNode;
  detail?: React.ReactNode;
  showPercent?: boolean;
  tone?: "primary" | "success" | "warning" | "danger";
  className?: string;
}

const TONE: Record<NonNullable<ProgressBarProps["tone"]>, string> = {
  primary: "bg-primary-500",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  label,
  detail,
  showPercent = true,
  tone = "primary",
  className = "",
}) => {
  const percent = value === null ? null : Math.max(0, Math.min(100, value));
  const showTop = label !== undefined || detail !== undefined || showPercent;

  return (
    <div className={className}>
      {showTop && (
        <div className="mb-1.5 flex items-baseline justify-between gap-2 text-[10px]">
          <span className="min-w-0 truncate text-faint">{label}</span>
          <span className="flex flex-shrink-0 items-baseline gap-1.5 tabular-nums text-faint">
            {detail !== undefined && <span>{detail}</span>}
            {showPercent && (
              <span className="text-body">{percent === null ? "…" : `${Math.round(percent)}%`}</span>
            )}
          </span>
        </div>
      )}
      <div
        className="h-1.5 overflow-hidden rounded-full bg-surface-strong"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent === null ? undefined : Math.round(percent)}
      >
        {percent === null ? (
          <div className={`h-full w-1/3 animate-pulse rounded-full ${TONE[tone]}`} />
        ) : (
          <div
            className={`h-full rounded-full transition-[width] duration-300 ${TONE[tone]}`}
            style={{ width: `${percent}%` }}
          />
        )}
      </div>
    </div>
  );
};
