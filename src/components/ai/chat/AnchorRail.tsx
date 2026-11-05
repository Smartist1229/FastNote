import { memo, useState } from "react";
import { useI18n } from "@/i18n";

/** 锚点每条横线的热区高度与最小/最大间距（像素）：条数多时压缩间距，永不溢出 */
export const RAIL_ITEM_H = 7;
export const RAIL_MIN_GAP = 1;
export const RAIL_MAX_GAP = 5;
/**
 * 悬浮波浪：离鼠标越近的横线越长越粗（0 = 鼠标正下方）。
 * 系数刻意保守：放大后仍落在 24px 点击热区内，不会盖到正文；纵向倍率更低，避免线条显粗。
 */
const RAIL_WAVE_SCALE_X = [1.3, 1.16, 1.06, 1.02];
const RAIL_WAVE_SCALE_Y = [1.4, 1.18, 1.06, 1.02];

/**
 * 右侧历史锚点导轨（横线样式），每条横线对应一条用户消息。
 * memo 同样是为了流式性能：父组件每 50ms 刷新一次，不隔离的话几十条横线
 * 会跟着重渲染，滚动与悬停都会顿。
 */
export const AnchorRail = memo(function AnchorRail({
  anchors, activeOriginal, gap, onJump, onHover, onLeave, onScroll,
}: {
  /** 采样后的可见锚点（index 是它在完整列表里的原始序号） */
  anchors: { index: number; preview: string }[];
  /** 当前查看的锚点原始序号 */
  activeOriginal: number;
  /** 横线间距（由父组件按可用高度算好） */
  gap: number;
  onJump: (originalIndex: number) => void;
  onHover: (originalIndex: number, el: HTMLElement) => void;
  onLeave: () => void;
  onScroll: () => void;
}) {
  // hooks 必须在任何早退之前
  const { t } = useI18n();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (anchors.length < 2) return null;
  // 当前活跃的那条：取原始序号不超过 activeOriginal 的最后一个可见条
  let activeBar = 0;
  anchors.forEach((a, i) => { if (a.index <= activeOriginal) activeBar = i; });
  return (
    <nav className="chat-anchor-rail" aria-label={t("对话历史")} onScroll={onScroll}>
      <div className="chat-anchor-list" style={{ gap }}>
        {anchors.map((anchor, i) => {
          const isActive = i === activeBar;
          // 11px 基准线 × 1.35（选中）× 1.3（波浪）= 19.3px，仍在 24px 热区之内
          let sx = isActive ? 1.35 : 1;
          let sy = isActive ? 1.1 : 1;
          if (hoverIdx !== null) {
            const d = Math.abs(i - hoverIdx);
            if (d < RAIL_WAVE_SCALE_X.length) {
              sx *= RAIL_WAVE_SCALE_X[d];
              sy *= RAIL_WAVE_SCALE_Y[d];
            }
          }
          return (
            <button
              key={anchor.index}
              type="button"
              className={"chat-anchor-bar" + (isActive ? " is-active" : "")}
              onClick={() => onJump(anchor.index)}
              onMouseEnter={(e) => { setHoverIdx(i); onHover(anchor.index, e.currentTarget); }}
              onMouseLeave={() => { setHoverIdx(null); onLeave(); }}
              onFocus={(e) => { setHoverIdx(i); onHover(anchor.index, e.currentTarget); }}
              onBlur={() => { setHoverIdx(null); onLeave(); }}
              style={{ height: RAIL_ITEM_H }}
              aria-label={t("跳到第 {message} 条消息（第 {anchor} 个锚点）：{preview}", { message: anchor.index + 1, anchor: i + 1, preview: anchor.preview })}
              aria-current={isActive ? "true" : undefined}
            >
              <span className="chat-anchor-line" style={{ transform: `scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)})` }} />
            </button>
          );
        })}
      </div>
    </nav>
  );
});
