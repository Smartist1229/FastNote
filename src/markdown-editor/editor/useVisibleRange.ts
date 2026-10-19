/**
 * 源码区当前可视的逻辑行区间。
 *
 * 行号槽与查找高亮层都要「只渲染看得见的那几十行」，所以区间计算放在一处共享，
 * 滚动监听也只挂一个。
 *
 * 两遍定位是这里的关键：
 * - 第一遍拿当前偏移（未测行按 1 行参与排版）粗估，并让 ruler 把那段补齐实测；
 * - 第二遍偏移已是真值，再精确定位。
 * 未测行的行数是下界，所以第一遍算出的行号只会偏大——宁可多测几行，
 * 也不能漏掉屏上正在显示的行（漏了偏移就是错的，行号会整体漂）。
 *
 * 滚动本身不触发重渲染：位置存 ref，只有跨过区间边界（上下各留 PAD 行余量）才 setState。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { LineRuler } from "./lineRows";

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

export const useVisibleRange = (target: HTMLTextAreaElement | null, ruler: LineRuler, pad: number): Viewport => {
  const [range, setRange] = useState<VisibleRange>({ first: 0, last: 0 });
  const scroll = useRef(0);
  const frame = useRef(0);
  const latest = useRef(range);
  latest.current = range;

  const measure = useCallback(() => {
    const element = target;
    if (!element) return;
    const top = element.scrollTop;
    scroll.current = top;
    const view = Math.max(1, element.clientHeight);
    const limit = ruler.lines.length;
    ruler.ensureVisible(element, Math.min(limit, ruler.lineAt(top + view) + pad + 1));
    const first = Math.max(0, ruler.lineAt(top) - pad);
    const last = Math.min(limit, ruler.lineAt(top + view) + pad + 1);
    ruler.visibleEnd = last;
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
