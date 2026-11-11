/**
 * 非模态浮窗的拖动（设置窗用；笔记/分组属性已改回模态，不再拖动）。
 *
 * 位置用「相对居中位置的偏移」表示：外层仍是 `fixed inset-0 flex items-center justify-center`，
 * 这里只叠一个 transform。好处是不用管尺寸变化（改大小、窗口缩放后重新居中还是这个基点），
 * 也不需要在挂载时量一次再反推 left/top。
 *
 * 约定：
 * - 偏移只存在组件内，不落库（关掉再开回到居中，符合"临时挪开看看"的用法）；
 * - 拖动时按 MARGIN 夹住：矩形四边都不许出视口，窗口变小后再夹一次；
 * - 标题栏里的按钮/输入框不触发拖动——点关闭、点开关要真的点下去。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from "react";

/** 离视口边缘至少留这么多像素，避免拖到贴边后圆角被裁 */
const MARGIN = 8;

/** 这些元素上的按下不当作拖动 */
const NO_DRAG = "button, a, input, textarea, select, [data-no-drag]";

export interface DraggableApi {
  /** 挂到被移动的那个节点上（必须是真正参与布局的盒子，量矩形才对） */
  panelRef: RefObject<HTMLDivElement | null>;
  /** 同一节点上的 style：只含 transform */
  style: CSSProperties;
  /** 挂到标题栏的 onPointerDown */
  startDrag: (event: ReactPointerEvent<HTMLElement>) => void;
}

/** 复位用的常量：同一个对象引用，避免每次 setState 都触发一次无意义的重渲染 */
const ZERO = { x: 0, y: 0 };

export const useDraggable = (enabled: boolean): DraggableApi => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [offset, setOffset] = useState(ZERO);
  /** 与 offset 同步的镜像：pointermove 里要读最新值，又不该把它塞进依赖 */
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  /**
   * 把偏移夹进视口。
   *
   * 只用 offsetWidth / offsetHeight 量尺寸，**不读 getBoundingClientRect**：
   * 卡片上有一条入场动画（scaleIn）和这里的 transform 抢同一个属性，
   * 动画播放期间量到的矩形是"未位移"的，减掉当前偏移就会算出错误的基准，
   * 表现是一打开就被推到左上角。盒子本身始终居中，所以基准位置就是
   * 「(视口 - 尺寸) / 2」，偏移的上下限天然对称。
   */
  const clamp = useCallback((next: { x: number; y: number }) => {
    const panel = panelRef.current;
    if (!panel) return next;
    const maxX = Math.max(0, (window.innerWidth - panel.offsetWidth) / 2 - MARGIN);
    const maxY = Math.max(0, (window.innerHeight - panel.offsetHeight) / 2 - MARGIN);
    return {
      x: Math.max(-maxX, Math.min(maxX, next.x)),
      y: Math.max(-maxY, Math.min(maxY, next.y)),
    };
  }, []);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (!enabled || event.button !== 0) return;
      if ((event.target as HTMLElement).closest(NO_DRAG)) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const start = offsetRef.current;
      document.body.classList.add("is-dragging-panel");

      const onMove = (move: PointerEvent) => {
        setOffset(clamp({ x: start.x + move.clientX - startX, y: start.y + move.clientY - startY }));
      };
      const stop = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", stop);
        window.removeEventListener("pointercancel", stop);
        document.body.classList.remove("is-dragging-panel");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", stop);
      window.addEventListener("pointercancel", stop);
    },
    [clamp, enabled],
  );

  /**
   * 关闭即复位（位置不记录，每次打开都在正中央）；
   * 打开时、窗口变小后各夹一次：尺寸变了（缩放）原先的偏移可能已经越界。
   */
  useEffect(() => {
    if (!enabled) {
      setOffset(ZERO);
      return;
    }
    setOffset((prev) => clamp(prev));
    const onResize = () => setOffset((prev) => clamp(prev));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [clamp, enabled]);

  return {
    panelRef,
    style: { transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` },
    startDrag,
  };
};
