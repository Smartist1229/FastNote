/**
 * 流程图放大浮层。
 *
 * 与图片放大（`ImageViewer`）同一套交互与外观：滚轮以指针为中心缩放、按住拖动平移、
 * 双击复位、Esc / 点空白 / 右上角按钮关闭；差别只在内容是 SVG，不是 `<img>`。
 *
 * 图标型节点的 `<marker>` / `<pattern>` 都靠 id 互相引用，所以这里刻意**不重画 id**：
 * 克隆体带着原图的 id，SVG 内联样式（`#mde-mermaid-N …`）与 marker 引用都能直接命中，
 * 不需要再把整段 CSS 注入一遍。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { MdeIcon } from "../../icons";
import type { MarkdownEditorConfig } from "../../types";

export interface MermaidViewerProps {
  /** 从正文里克隆下来的 SVG 节点 */
  svg: SVGSVGElement;
  /** 取 preview.mermaidZoom 的区间与步长 */
  config: MarkdownEditorConfig["preview"]["mermaidZoom"];
  labels: Record<string, string>;
  locale?: MarkdownEditorConfig["locale"];
  /** 主题变量（`--mde-*`）：portal 到 body 后不再继承 `.mde-root` */
  themeVars?: Record<string, string>;
  onClose: () => void;
}

interface ViewState {
  scale: number;
  x: number;
  y: number;
}

const clampScale = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), Math.max(min, max));

export const MermaidViewer: React.FC<MermaidViewerProps> = ({ svg, config, labels, locale, themeVars, onClose }) => {
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  /*
   * 这里**不**因为换 svg 就复位视图：换主题时正文会重画，浮动层拿到的克隆图跟着换一份，
   * 若在这里复位，用户放大到一半切主题就被打回 100%。组件每次打开都是新挂载，
   * 初始 state 本来就是 1:1，不需要额外复位。
   */

  /* Esc 关闭：捕获阶段拦下，避免编辑器自己也处理一次 Esc */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  /*
   * 把克隆的 SVG 放进浮层。
   *
   * mermaid 给根节点写了 `width="100%"` 和 `style="max-width: <图宽>px"`：那套尺寸是为
   * 正文流式布局算的，放进浮层会让图缩成一条。这里清掉内联宽度、把宽高交给 CSS
   * （`.mde-mermaid-zoom svg`），图按 viewBox 比例铺满浮层再整体缩放。
   */
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    svg.removeAttribute("style");
    svg.removeAttribute("height");
    svg.setAttribute("width", "100%");
    host.replaceChildren(svg);
  }, [svg]);

  /*
   * 滚轮缩放：必须用原生监听器。
   * React 的 onWheel 由根容器统一代理，在 Chromium 上注册为 passive，
   * 里面调 preventDefault() 无效，滚动还会透过浮层传给底下的预览区。
   */
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = stage.getBoundingClientRect();
      // 指针相对浮层中心的坐标：缩放以它为中心，鼠标下的那一点不会跑
      const px = event.clientX - rect.left - rect.width / 2;
      const py = event.clientY - rect.top - rect.height / 2;
      const factor = event.deltaY < 0 ? config.step : 1 / config.step;
      setView((prev) => {
        const next = clampScale(prev.scale * factor, config.min, config.max);
        const ratio = next / prev.scale;
        return {
          scale: next,
          x: px - (px - prev.x) * ratio,
          y: py - (py - prev.y) * ratio,
        };
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [config.step, config.min, config.max]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
      setDragging(true);
    },
    [view.x, view.y],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView((prev) => ({
      ...prev,
      x: drag.x + (event.clientX - drag.px),
      y: drag.y + (event.clientY - drag.py),
    }));
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return createPortal(
    <div className="mde-image-viewer-portal" style={themeVars as CSSProperties} lang={locale}>
      <div
        className="mde-image-viewer mde-mermaid-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={labels.mermaidPreview}
        /* 点浮层空白处关闭；图自身阻止冒泡，拖拽时不会误关 */
        onClick={onClose}
      >
        <div className="mde-image-viewer-stage" ref={stageRef}>
          <div
            ref={contentRef}
            className={`mde-mermaid-zoom${dragging ? " is-dragging" : ""}`}
            style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})` }}
            onClick={(event) => event.stopPropagation()}
            onDoubleClick={() => setView({ scale: 1, x: 0, y: 0 })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          />
        </div>
        <div className="mde-image-viewer-bar">
          <span className="mde-image-viewer-scale">{Math.round(view.scale * 100)}%</span>
          <span className="mde-image-viewer-hint">{labels.mermaidZoomHint}</span>
        </div>
        <button type="button" className="mde-image-viewer-close" title={labels.imageClose} aria-label={labels.imageClose} onClick={onClose}>
          <MdeIcon name="close" size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
};
