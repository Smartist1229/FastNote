/**
 * 渲染入口：先注册全局输入拦截（禁用原生 Ctrl+P 打印 / Ctrl+F 查找、滚动条拖选防护），
 * 再挂载 React 根节点（StrictMode + ErrorBoundary），最后收起启动 splash。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import App from "@/App";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { applyTheme, readCachedTheme } from "@/lib/theme";
import { setResolvedThemeMode } from "@/lib/themeRuntime";
import { DEFAULT_THEME_SETTINGS } from "@/config/themes";

/**
 * 全局禁用「原生组合键」：WebView2 会把这些键交给宿主浏览器处理，
 * 弹出的打印 / 查找条是系统 UI，CSS 挡不住、React 也拦不住（事件不进组件树），
 * 只能在 window 的**捕获阶段**吃掉。keyup 再兜一次，防止按键松开时才触发。
 *
 * - Ctrl/Cmd + P：原生打印
 * - Ctrl/Cmd + F：WebView2 自带的查找条（应用自身的所有搜索都不依赖它）
 *
 * 用 code 而不是 key：部分输入法 / 键盘布局下 key 会变成非字母（俄语布局的 "а"），
 * code 始终对应物理按键位置。
 */
const BLOCKED_NATIVE_SHORTCUTS = [
  { key: "p", code: "KeyP" },
  { key: "f", code: "KeyF" },
];

const blockNativeShortcut = (e: KeyboardEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const hit = BLOCKED_NATIVE_SHORTCUTS.some(
    (s) => e.code === s.code || e.key.toLowerCase() === s.key,
  );
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
};
window.addEventListener("keydown", blockNativeShortcut, true);
window.addEventListener("keyup", blockNativeShortcut, true);

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

/** 命中判断：从事件目标逐级向上找原生滚动条的几何区域 */
const isOnScrollbar = (target: EventTarget | null, e: MouseEvent) => {
  if (!(target instanceof HTMLElement)) return false;
  // 原生滚动条：往上找最近的可滚动祖先，判断指针是否落在它的滚动条几何区域内
  let el: HTMLElement | null = target;
  while (el && el !== document.body) {
    if (isOnNativeScrollbar(el, e)) return true;
    el = el.parentElement;
  }
  return false;
};

/** 只处理左键；命中后 preventDefault，阻止浏览器从滚动条起建立文字选区 */
const handleScrollbarPointerDown = (e: MouseEvent) => {
  if (e.button !== 0 || !isOnScrollbar(e.target, e)) return;
  scrollbarDragActive = true;
  document.body.classList.add("is-dragging-scrollbar");
  // 阻止浏览器从滚动条开始建立文字选区
  e.preventDefault();
};

/** 松手或窗口失焦时解除标记，避免拖选状态卡住 */
const endScrollbarDrag = () => {
  if (!scrollbarDragActive) return;
  scrollbarDragActive = false;
  document.body.classList.remove("is-dragging-scrollbar");
};

document.addEventListener("mousedown", handleScrollbarPointerDown, true);
document.addEventListener("mouseup", endScrollbarDrag, true);
window.addEventListener("blur", endScrollbarDrag);

// StrictMode 只在开发期额外跑一遍 effect；ErrorBoundary 兜住渲染期异常
/*
 * 首帧前先着色：主题存在数据库里，读库是异步的，赶不上第一帧；
 * 这里用上一轮的 localStorage 快照先刷一遍，深色用户不会看到一瞬白屏。
 * 之后 App 读回真值会再应用一次（applyTheme 幂等）。
 */
setResolvedThemeMode(applyTheme(readCachedTheme() ?? DEFAULT_THEME_SETTINGS));

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// 收起 index.html 里的启动 splash（紧随 render 调用，此时首帧尚未绘制）
document.getElementById("splash")?.classList.add("hidden");