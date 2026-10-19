/**
 * 软换行下的视觉行数测量（行号槽对齐用）。
 *
 * 数据流：源码按 `\n` 切成逻辑行 → 塞进隐藏 mirror 逐个排版 → 读回高度 / 单行高 →
 * 得到「这一逻辑行占几个视觉行」。行号槽据此决定每个行号占多高，折出来的续行前面就没有数字。
 *
 * 关键约束：
 * - 只有「显示行号 + 开了自动换行」才测：wrap 关闭时一个逻辑行必然占一行，省掉这次排版。
 * - mirror 必须与 textarea 同字体、同行高、同可用宽度，否则折行位置算错，行号就整体偏移。
 *   可用宽度要按 clientWidth 减左右 padding 算，纵向滚动条出现时 clientWidth 会自己变小。
 * - 结果按「行文本 + 可用宽度 + 字体」缓存：打字时通常只有一行脏，只测这一行；
 *   窗口缩放、分隔条拖拽、滚动条出现会改变可用宽度，这时才全量重测。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface VisualLineRows {
  /** 每个逻辑行占的视觉行数，下标 = 逻辑行号 - 1；空数组表示「没测量，按一行处理」 */
  rows: number[];
  /** 单个视觉行的像素高度。行号槽必须用测量时同一个值换算，否则多行累加会漂 */
  unit: number;
}

export interface VisualLineRowsInput {
  element: HTMLTextAreaElement | null;
  text: string;
  /** 行号槽是否显示 */
  enabled: boolean;
  wrap: boolean;
  fontFamily: string;
  fontSize: number;
  /** 行高倍数 */
  lineHeight: number;
  tabSize: number;
  /** 连字开关：改变字符宽度，折行结果也会变，必须参与缓存 key */
  fontLigatures: boolean;
}

interface MeasureCache {
  key: string;
  width: number;
  unit: number;
  lines: string[];
  rows: number[];
}

const EMPTY_ROWS: number[] = [];

/** 空行没有行盒，量不出高度，塞个零宽字符让它撑出一行 */
const FILLER = "\u200b";

const syncMirrorStyle = (mirror: HTMLDivElement, source: CSSStyleDeclaration, width: number): void => {
  mirror.style.fontFamily = source.fontFamily;
  mirror.style.fontSize = source.fontSize;
  mirror.style.lineHeight = source.lineHeight;
  mirror.style.fontWeight = source.fontWeight;
  mirror.style.fontStyle = source.fontStyle;
  mirror.style.fontVariant = source.fontVariant;
  mirror.style.letterSpacing = source.letterSpacing;
  mirror.style.wordSpacing = source.wordSpacing;
  mirror.style.textIndent = source.textIndent;
  mirror.style.textTransform = source.textTransform;
  mirror.style.tabSize = source.tabSize;
  mirror.style.wordBreak = source.wordBreak;
  mirror.style.overflowWrap = source.overflowWrap;
  // 连字会改变字符宽度，mirror 必须跟 textarea 一致，否则同一行折出来的行数不同
  mirror.style.fontVariantLigatures = source.fontVariantLigatures;
  mirror.style.fontFeatureSettings = source.fontFeatureSettings;
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.width = `${width}px`;
};

export const useVisualLineRows = (input: VisualLineRowsInput): VisualLineRows => {
  const { element, text, enabled, wrap, fontFamily, fontSize, lineHeight, tabSize, fontLigatures } = input;
  const fallbackUnit = fontSize * lineHeight;
  const [state, setState] = useState<VisualLineRows>({ rows: EMPTY_ROWS, unit: fallbackUnit });
  const cache = useRef<MeasureCache | null>(null);
  const mirror = useRef<HTMLDivElement | null>(null);
  const [sizeTick, setSizeTick] = useState(0);

  // 容器宽度变化都要重测：窗口缩放、分栏拖拽都会改变一行能放多少字
  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setSizeTick((tick) => tick + 1));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  useEffect(
    () => () => {
      mirror.current?.remove();
      mirror.current = null;
    },
    [],
  );

  // 用 layout effect：行号高度必须在这一帧里就跟上文本，否则滚动时会看到数字跳一下
  useLayoutEffect(() => {
    if (!element || !enabled || !wrap) {
      cache.current = null;
      setState((prev) => (prev.rows.length ? { rows: EMPTY_ROWS, unit: fallbackUnit } : prev));
      return;
    }

    const view = element.ownerDocument.defaultView;
    if (!view) return;
    const style = view.getComputedStyle(element);
    const width = element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
    const unit = parseFloat(style.lineHeight) || fallbackUnit;
    if (width <= 0 || unit <= 0) return;

    const lines = text.split("\n");
    const key = [fontFamily, fontSize, lineHeight, tabSize, fontLigatures, style.letterSpacing, style.textTransform].join(
      "|",
    );
    const previous = cache.current;
    const sameBox =
      !!previous && previous.key === key && previous.unit === unit && Math.abs(previous.width - width) < 0.5;

    const rows = new Array<number>(lines.length);
    const dirty: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const cached = previous && sameBox && previous.lines[i] === lines[i] ? previous.rows[i] : 0;
      if (cached > 0) {
        rows[i] = cached;
        continue;
      }
      rows[i] = 1;
      dirty.push(i);
    }

    if (previous && !dirty.length) {
      // 一行都没脏：沿用旧结果，不必再渲染一次
      cache.current = { key, width, unit, lines, rows: previous.rows };
      return;
    }

    const host = element.parentElement ?? element.ownerDocument.body;
    if (!mirror.current || mirror.current.parentElement !== host) {
      mirror.current?.remove();
      const node = element.ownerDocument.createElement("div");
      node.className = "mde-measure";
      node.setAttribute("aria-hidden", "true");
      host.appendChild(node);
      mirror.current = node;
    }
    const box = mirror.current;
    syncMirrorStyle(box, style, width);

    const owner = element.ownerDocument;
    const nodes: HTMLDivElement[] = [];
    const fragment = owner.createDocumentFragment();
    for (const index of dirty) {
      const line = owner.createElement("div");
      line.className = "mde-measure-line";
      line.textContent = lines[index] || FILLER;
      fragment.appendChild(line);
      nodes.push(line);
    }
    box.textContent = "";
    box.appendChild(fragment);
    // 先写完再统一读，避免读写交替触发多次重排
    const heights = nodes.map((node) => node.getBoundingClientRect().height);
    box.textContent = "";

    heights.forEach((height, order) => {
      rows[dirty[order]] = Math.max(1, Math.round(height / unit));
    });
    cache.current = { key, width, unit, lines, rows };
    setState({ rows, unit });
  }, [
    element,
    text,
    enabled,
    wrap,
    fontFamily,
    fontSize,
    lineHeight,
    tabSize,
    fontLigatures,
    fallbackUnit,
    sizeTick,
  ]);

  return state;
};
