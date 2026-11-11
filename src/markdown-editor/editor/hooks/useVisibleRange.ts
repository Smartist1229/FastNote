/**
 * 编辑区当前可视的逻辑行区间。
 *
 * 行号槽与查找高亮层都要「只渲染看得见的那几十行」，所以区间计算放在一处共享，
 * 滚动监听也只挂一个。
 *
 * ruler 只实测视口附近的带（`measureBand`），未测行按 1 视觉行参与偏移计算。
 * 实测会改动偏移表，所以量完要把锚点行钉回原来的位置：先记下锚点行与行内偏移，
 * 等这一轮重渲染（`notify` 触发，padding 已换成新表）完成后再落 scrollTop，
 * 否则向上滚进未测区时画面会跳一下。
 *
 * 滚动本身不触发重渲染：位置存 ref，只有跨过区间边界（上下各留 PAD 行余量）才 setState。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LineRuler } from "../lineRows";

export interface VisibleRange {
  first: number;
  last: number;
}

export interface Viewport {
  range: VisibleRange;
  /** 逐帧的滚动位置（放 ref 里，滚动不触发重渲染） */
  scroll: React.MutableRefObject<number>;
  /** 请求在下一帧重算区间 */
  schedule: () => void;
  /** 立刻重算一次（文本/尺寸变化时用，避免慢一帧） */
  sync: () => void;
}

export const useVisibleRange = (target: HTMLElement | null, ruler: LineRuler, pad: number): Viewport => {
  const [range, setRange] = useState<VisibleRange>({ first: 0, last: 0 });
  const scroll = useRef(0);
  const frame = useRef(0);
  const latest = useRef(range);
  latest.current = range;

  const measure = useCallback(() => {
    const element = target;
    if (!element) return;

    // 排版条件刚变过：消费方已按新表重渲染，现在把锚点行落回去
    const anchor = ruler.takeAnchor();
    if (anchor) {
      const max = Math.max(0, element.scrollHeight - element.clientHeight);
      element.scrollTop = Math.min(Math.max(0, ruler.offsetOf(anchor.line) + anchor.intra), max);
    }

    const top = element.scrollTop;
    scroll.current = top;
    const view = Math.max(1, element.clientHeight);
    const limit = ruler.lines.length;
    if (!limit) return;
    const unit = Math.max(1, ruler.advance || ruler.unit || 1);
    const visibleRows = Math.ceil(view / unit);
    const before = pad + 2;
    const anchorLine = Math.min(limit - 1, ruler.lineAt(top));
    const intra = Math.max(0, top - ruler.offsetOf(anchorLine));
    const from = Math.max(0, anchorLine - before);
    const to = Math.min(limit, anchorLine + visibleRows + before + 4);

    if (ruler.measureBand(element, from, to, true, true)) {
      // 实测改了几个折行行数：偏移表变了，下一趟渲染后重新对准锚点
      ruler.requestAnchor(anchorLine, intra);
    }

    const settled = element.scrollTop;
    const first = Math.max(0, ruler.lineAt(settled) - pad);
    const last = Math.min(limit, ruler.lineAt(settled + view) + pad + 1);
    const current = latest.current;
    if (current.first === first && current.last === last) return;
    latest.current = { first, last };
    setRange({ first, last });
  }, [pad, ruler, target]);

  /** 滚动逐帧最多算一次：rAF 合并，快速滚动不会堆积 */
  const schedule = useCallback(() => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      measure();
    });
  }, [measure]);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );

  return { range, scroll, schedule, sync: measure };
};
