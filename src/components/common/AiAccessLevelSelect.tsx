/**
 * AI 访问档位选择器：禁止 / 只读 / 完全，三个档位一组。
 *
 * 属性弹窗和设置页共用，保证两处语义与配色一致。
 * 用分段按钮而不是下拉：「禁止」与「只读」差一个词但后果完全不同，
 * 平铺三个选项能让用户一眼看到当前档位，也少一次点击。
 */
import type { AiAccessLevel } from "@/interface/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/aiAccess";

/** 各档位选中时的配色：禁止红、只读琥珀、完全主题色 */
const ACTIVE_STYLE: Record<AiAccessLevel, string> = {
  0: "bg-danger-soft text-danger-strong border-danger-line",
  1: "bg-warning-soft text-warning-deep border-warning-line",
  2: "bg-primary-50 text-primary-600 border-primary-200",
};

const LEVELS: AiAccessLevel[] = [2, 1, 0];

const HINTS: Record<AiAccessLevel, string> = {
  2: "AI 可以读取和修改",
  1: "AI 只能读取，不能修改",
  0: "AI 完全看不到",
};

export const AiAccessLevelSelect: React.FC<{
  value: AiAccessLevel;
  onChange: (level: AiAccessLevel) => void;
  /** 置灰：例如所属分组已更严格，或用户关闭了 AI 能力 */
  disabled?: boolean;
  /** disabled 时展示的原因 */
  disabledHint?: string;
  /** 紧凑模式：设置页的笔记行用它 */
  size?: "sm" | "xs";
}> = ({ value, onChange, disabled = false, disabledHint, size = "sm" }) => (
  <div
    className={`inline-flex items-center rounded-lg border border-line bg-surface overflow-hidden flex-shrink-0 ${
      disabled ? "opacity-50" : ""
    }`}
    title={disabled ? disabledHint : undefined}
  >
    {LEVELS.map((level, index) => {
      const active = value === level;
      return (
        <button
          key={level}
          type="button"
          disabled={disabled}
          aria-pressed={active}
          title={HINTS[level]}
          onClick={() => !disabled && onChange(level)}
          className={`${size === "xs" ? "px-2 py-[3px] text-[10.5px]" : "px-2.5 py-1 text-[11.5px]"} font-medium transition-colors ${
            index > 0 ? "border-l border-line" : ""
          } ${
            active
              ? ACTIVE_STYLE[level]
              : disabled
                ? "text-faint cursor-not-allowed"
                : "text-faint hover:bg-app hover:text-body"
          }`}
        >
          {AI_ACCESS_LABELS[level]}
        </button>
      );
    })}
  </div>
);
