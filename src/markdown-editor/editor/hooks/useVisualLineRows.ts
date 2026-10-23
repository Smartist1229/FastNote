/**
 * 软换行下的视觉行数测量（行号槽对齐用）。
 *
 * 数据流：编辑区文本按 `\n` 切成逻辑行 → 塞进隐藏 mirror 排版 → 读回高度 / 单行高 →
 * 得到「这一逻辑行占几个视觉行」。行号槽据此决定每个行号占多高，折出的续行前面就没有数字。
 *
 * 真正的排版交给 `LineRuler`，这里只负责两件事：
 * - 从编辑区容器上读出排版本身依赖的可用宽度与行高（滚动条出现时 clientWidth 会变）；
 * - 在文本/尺寸变化后调用一次 `sync`：只同步改到的那几行或视口附近的一小段，
 *   其余部分等滚到了再由 `LineRuler.measureBand` 补测。
 *
 * 返回的是 ruler 本身：消费方订阅它、按需取偏移，
 * 而不是每次测量都把整棵编辑器拖着重渲染一遍。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { LineRuler } from "../lineRows";

export interface VisualLineRowsInput {
  /** 被测量的元素（虚拟化的 contenteditable 容器）：读它的可用宽度、行高与字体 */
  element: HTMLElement | null;
  text: string;
  /** 行号槽是否显示（关掉就完全不用排版） */
  enabled: boolean;
  wrap: boolean;
  fontFamily: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  /**
   * 字间距（CSS 长度）。它改不了单行高度，但会改变一行能放多少字——
   * 折行结果变了，偏移表就得重测，否则行号与光标会整体偏。
   */
  letterSpacing: string;
  tabSize: number;
  fontLigatures: boolean;
}

export const useVisualLineRows = (input: VisualLineRowsInput): LineRuler => {
  const {
    element,
    text,
    enabled,
    wrap,
    fontFamily,
    fontSize,
    lineHeight,
    letterSpacing,
    tabSize,
    fontLigatures,
  } = input;
  const fallbackUnit = fontSize * lineHeight;
  const rulerRef = useRef<LineRuler | null>(null);
  if (!rulerRef.current) rulerRef.current = new LineRuler();
  const ruler = rulerRef.current;

  /** 容器宽度变化都要重测：窗口缩放、分栏拖拽都会改变一行能放多少字 */
  const [sizeTick, setSizeTick] = useState(0);
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setSizeTick((tick) => tick + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // 用 layout effect：行号高度必须在这一帧里就跟上文本，否则滚动时会看到数字跳一下
  useLayoutEffect(() => {
    const target = element;
    if (!target || !enabled) return;
    const view = target.ownerDocument.defaultView;
    if (!view) return;
    const style = view.getComputedStyle(target);
    const width =
      target.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const unit = parseFloat(style.lineHeight) || fallbackUnit;
    if (width <= 0 || unit <= 0) return;

    ruler.sync(target, text, {
      width,
      unit,
      font: [fontFamily, fontSize, tabSize, fontLigatures, letterSpacing].join("|"),
      wrap,
    });
  }, [
    element,
    text,
    enabled,
    wrap,
    fontFamily,
    fontSize,
    lineHeight,
    letterSpacing,
    tabSize,
    fontLigatures,
    fallbackUnit,
    sizeTick,
    ruler,
  ]);

  return ruler;
};
