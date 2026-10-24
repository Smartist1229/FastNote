/**
 * 行号槽：只渲染可视区间内的那几十行。
 *
 * 原来每一行都是一个 `<button>`：五千行的文档就是五千个 DOM 节点，
 * 每敲一个字 React 都要把它们全量 reconcile 一遍——这是编辑区最大的固定开销。
 *
 * 现在只渲染可视区间（上下各留一点余量），位置交给绝对定位：
 * - 滚动逐帧只做一次 `translateY` 写入（由 `follow` 直接从滚动事件驱动），合成器吃下，不触发布局；
 * - 只有跨过余量边界才真正重渲染，平摊下来每滚一屏才一两次；
 * - 每行的纵向偏移取自 `LineRuler` 的实测值，折行的续行会把这一格撑高、数字仍钉在首行。
 *
 * 为什么是「绝对定位 + 平移」而不是逐帧改 top：
 * 改几十个 top 会触发几十次布局，平移则是一条合成器指令。
 * 又不能直接平移整个几万像素高的容器——那会逼出一整块同等大小的合成层，
 * 所以这里把容器高度限制在渲染区间内，平移量也就被压在一屏之内。
 */
import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useSyncExternalStore } from "react";
import type { VisibleRange } from "../editor/hooks/useVisibleRange";
import type { LineRuler } from "../editor/lineRows";

export interface GutterHandle {
  /** 逐帧跟随滚动：直接写 transform，不经过 React */
  follow: (scrollTop: number) => void;
  /** 槽的根节点：滚轮转发要挂原生监听（React 的 wheel 是 passive 的），得拿到 DOM */
  getElement: () => HTMLDivElement | null;
}

interface GutterProps {
  ruler: LineRuler;
  range: VisibleRange;
  /** 逐帧的滚动位置（ref，滚动本身不触发重渲染） */
  scroll: React.MutableRefObject<number>;
  /** ruler 还没测出像素行高时的兜底（倍数） */
  lineHeight: number;
  fontSize: number;
  /** 行号最大位数：槽宽要跟着它和字号一起长，否则放大字号后四位数会被裁掉 */
  digits: number;
  /** 光标所在的逻辑行（0 基）；-1 表示不高亮任何一格 */
  activeLine: number;
  /** 大纲跳转后临时高亮的逻辑行（0 基）；-1 表示没有 */
  flashLine: number;
  gutterClickSelectsLine: boolean;
  onSelectLine: (lineIndex: number) => void;
}

export const Gutter = forwardRef<GutterHandle, GutterProps>(
  (
    { ruler, range, scroll, lineHeight, fontSize, digits, activeLine, flashLine, gutterClickSelectsLine, onSelectLine },
    ref,
  ) => {
    // 订阅测量进度：渐进扫描每帧只重渲染行号槽，不带整棵编辑器
    useSyncExternalStore(ruler.subscribe, ruler.getVersion);
    const rootRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    /** 当前渲染区间起点的纵向偏移（px）：平移以它为基准，逐帧不再查表 */
    const baseRef = useRef(0);

    // 行高用实测的行推进（见 LineRuler.advance）：computed line-height 在小数字号下
    // 会和输入框真实的行盒差零点几像素，一格格累加后行号就跟正文对不上了
    const unit = ruler.advance || ruler.unit || fontSize * lineHeight;

    useImperativeHandle(
      ref,
      () => ({
        follow: (scrollTop: number) => {
          const inner = innerRef.current;
          if (inner) inner.style.transform = `translateY(${baseRef.current - scrollTop}px)`;
        },
        getElement: () => rootRef.current,
      }),
      [],
    );

    /** 区间或偏移变过 → 按新基准重算平移（layout 阶段，早于绘制，看不出跳变） */
    useLayoutEffect(() => {
      const inner = innerRef.current;
      if (!inner) return;
      baseRef.current = ruler.offsetOf(range.first);
      inner.style.transform = `translateY(${baseRef.current - scroll.current}px)`;
    });

    return (
      <div
        className="mde-gutter"
        aria-hidden="true"
        ref={rootRef}
        /*
         * 宽度跟着「位数 × 字号」走：46px 是按 3 位数 + 14px 字号定的，
         * 放大字号或写到四位数时（1000 行以上）就装不下了，数字会被切掉一半。
         * 1ch 是等宽字体里一个数字的宽度，再加 12px（右侧 8px 留白 + 行内 2px 两侧）。
         */
        style={{ width: `max(46px, calc(${digits}ch + 12px))` }}
      >
        <div
          className="mde-gutter-inner"
          ref={innerRef}
          style={{ height: ruler.offsetOf(range.last) - ruler.offsetOf(range.first) }}
        >
          {eachLine(range).map((index) => (
            <button
              type="button"
              className={`mde-gutter-line${index === flashLine ? " is-flash" : ""}${
                index === activeLine ? " is-current" : ""
              }`}
              key={index}
              tabIndex={-1}
              style={{
                top: `${ruler.offsetOf(index) - ruler.offsetOf(range.first)}px`,
                height: `${(ruler.rows[index] || 1) * unit}px`,
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={gutterClickSelectsLine ? () => onSelectLine(index) : undefined}
            >
              <span className="mde-gutter-num">{index + 1}</span>
            </button>
          ))}
        </div>
      </div>
    );
  },
);

Gutter.displayName = "Gutter";

/** 区间内的行下标列表；每次渲染就几十个，直接现造比维护缓存省心 */
function eachLine(range: VisibleRange): number[] {
  const list: number[] = [];
  for (let index = range.first; index < range.last; index += 1) list.push(index);
  return list;
}
