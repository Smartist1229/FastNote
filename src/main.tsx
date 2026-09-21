import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 禁用 Ctrl+P 原生打印（捕获阶段拦截 + keyup 双重保障）
const preventPrint = (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "p" || e.code === "KeyP")) {
    e.preventDefault();
    e.stopPropagation();
  }
};
window.addEventListener("keydown", preventPrint, true);
window.addEventListener("keyup", preventPrint, true);

/**
 * 拖动滚动条时禁止选中正文。
 * CSS 的 user-select 对"原生滚动条"不可靠（WebView2/Chromium 会从滚动条开始拖选文字），
 * 因此这里在真正点到滚动条时给 body 打标记，让 CSS 兜底规则生效，松手即解除。
 */
let scrollbarDragActive = false;

/** 判断指针是否落在元素的原生垂直/水平滚动条上 */
const isOnNativeScrollbar = (el: HTMLElement, e: MouseEvent) => {
  const rect = el.getBoundingClientRect();
  const gutter = el.offsetWidth - el.clientWidth; // 垂直滚动条占位宽度
  const bottomGutter = el.offsetHeight - el.clientHeight; // 水平滚动条占位高度
  const onVertical =
    gutter > 0 &&
    el.scrollHeight > el.clientHeight &&
    e.clientX >= rect.left + el.clientWidth &&
    e.clientX <= rect.right;
  const onHorizontal =
    bottomGutter > 0 &&
    el.scrollWidth > el.clientWidth &&
    e.clientY >= rect.top + el.clientHeight &&
    e.clientY <= rect.bottom;
  return onVertical || onHorizontal;
};

/** 自绘滚动条：6px 宽、贴着父容器右边缘的细长元素（md-editor-rt / Monaco） */
const isOnCustomScrollbar = (el: HTMLElement) => {
  const rect = el.getBoundingClientRect();
  const parentRect = el.parentElement?.getBoundingClientRect();
  if (!parentRect) return false;
  const isNarrow = rect.width > 0 && rect.width <= 12;
  const isTall = rect.height >= parentRect.height * 0.5;
  const atRightEdge = Math.abs(rect.right - parentRect.right) <= 2;
  return isNarrow && isTall && atRightEdge;
};

const isOnScrollbar = (target: EventTarget | null, e: MouseEvent) => {
  if (!(target instanceof HTMLElement)) return false;
  // 自绘滚动条：md-editor-rt 的 custom-scrollbar、Monaco 的 .scrollbar
  const custom = target.closest<HTMLElement>(
    ".md-editor-custom-scrollbar__track, .monaco-scrollable-element > .scrollbar",
  );
  if (custom || isOnCustomScrollbar(target)) return true;
  // 原生滚动条：往上找最近的可滚动祖先，判断指针是否落在它的滚动条几何区域内
  let el: HTMLElement | null = target;
  while (el && el !== document.body) {
    if (isOnNativeScrollbar(el, e)) return true;
    el = el.parentElement;
  }
  return false;
};

const handleScrollbarPointerDown = (e: MouseEvent) => {
  if (e.button !== 0 || !isOnScrollbar(e.target, e)) return;
  scrollbarDragActive = true;
  document.body.classList.add("is-dragging-scrollbar");
  // 阻止浏览器从滚动条开始建立文字选区
  e.preventDefault();
};

const endScrollbarDrag = () => {
  if (!scrollbarDragActive) return;
  scrollbarDragActive = false;
  document.body.classList.remove("is-dragging-scrollbar");
};

document.addEventListener("mousedown", handleScrollbarPointerDown, true);
document.addEventListener("mouseup", endScrollbarDrag, true);
window.addEventListener("blur", endScrollbarDrag);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// React 挂载后隐藏启动 splash
document.getElementById("splash")?.classList.add("hidden");