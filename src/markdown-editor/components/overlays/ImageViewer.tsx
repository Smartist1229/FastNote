/**
 * 图片放大预览浮层。
 *
 * 交互：
 * - 滚轮缩放（以指针位置为中心，`config.preview.imageZoom.step` 为每格倍率）；
 * - 按住拖动平移；
 * - 双击复位到 100%；
 * - Esc / 点空白 / 右上角关闭按钮退出。
 *
 * 浮层用 `createPortal` 挂到 `document.body`：它是**整个窗口**的预览，
 * 不能被编辑区的边框、滚动容器或祖先的 `transform` 局限在编辑器范围内。
 * 代价是拿不到 `.mde-root` 上的 `--mde-*` 变量，所以由宿主把 `themeVars` 传进来。
 *
 * 缩放与平移全部走 `transform`，不改图片自身尺寸，避免反复布局。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";
import { MdeIcon } from "../../icons";
import type { MarkdownEditorConfig } from "../../types";

export interface ImageViewerProps {
  src: string;
  alt?: string;
  /** 取 preview.imageZoom 的区间与步长 */
  config: MarkdownEditorConfig["preview"]["imageZoom"];
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

export const ImageViewer: React.FC<ImageViewerProps> = ({ src, alt, config, labels, locale, themeVars, onClose }) => {
  const [view, setView] = useState<ViewState>({ scale: 1, x: 0, y: 0 });
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  /* 换图（连续点不同图片）时回到初始视图 */
  useEffect(() => {
    setView({ scale: 1, x: 0, y: 0 });
  }, [src]);

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
    (event: React.PointerEvent<HTMLImageElement>) => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = { px: event.clientX, py: event.clientY, x: view.x, y: view.y };
      setDragging(true);
    },
    [view.x, view.y],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    setView((prev) => ({
      ...prev,
      x: drag.x + (event.clientX - drag.px),
      y: drag.y + (event.clientY - drag.py),
    }));
  }, []);

  const endDrag = useCallback((event: React.PointerEvent<HTMLImageElement>) => {
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
        className="mde-image-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={labels.imagePreview}
        /* 点浮层空白处关闭；图片自身阻止冒泡，拖拽时不会误关 */
        onClick={onClose}
      >
        <div className="mde-image-viewer-stage" ref={stageRef}>
          <img
            className={`mde-image-viewer-img${dragging ? " is-dragging" : ""}`}
            src={src}
            alt={alt}
            onError={() => setFailedSrc(src)}
            onLoad={() => setFailedSrc(null)}
            draggable={false}
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
          <span className="mde-image-viewer-hint" role={failedSrc === src ? "alert" : undefined}>
            {failedSrc === src ? labels.imageLoadFailed : labels.imageZoomHint}
          </span>
        </div>
        <button type="button" className="mde-image-viewer-close" title={labels.imageClose} aria-label={labels.imageClose} onClick={onClose}>
          <MdeIcon name="close" size={16} />
        </button>
      </div>
    </div>,
    document.body,
  );
};
