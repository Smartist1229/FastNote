/**
 * 渲染入口：先注册全局输入拦截（禁用原生 Ctrl+P 打印 / Ctrl+F 查找、滚动条拖选防护），
 * 再挂载 React 根节点（StrictMode + ErrorBoundary），首帧画完之后唤出窗口、收起启动 splash。
 */
import React from "react";
import ReactDOM from "react-dom/client";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "@/App";
import { ErrorBoundary } from "@/components/common/ErrorBoundary";
import { applyTheme, readCachedTheme } from "@/lib/theme";
import { setResolvedThemeMode } from "@/lib/themeRuntime";
import { DEFAULT_THEME_SETTINGS } from "@/config/themes";

/**
 * 全局禁用「原生组合键」：WebView2 会把这些键交给宿主浏览器处理，
 * 弹出的打印 / 查找条是系统 UI，CSS 挡不住、React 也拦不住（事件不进组件树），
 * 只能在 window 的**捕获阶段** preventDefault。keyup 再兜一次，防止按键松开时才触发。
 *
 * - Ctrl/Cmd + P：原生打印
 * - Ctrl/Cmd + F / G：WebView2 自带的查找条（含"查找下一个"）；
 *   应用里的查找/跳转由编辑器组件自己处理（Ctrl+F 查找、Ctrl+G 下一个、Ctrl+H 替换）
 * - Ctrl/Cmd + H：浏览器历史
 *
 * 注意只能 preventDefault、绝不能 stopPropagation：
 * React 的事件都委托在 #root 上，window 捕获阶段把传播掐断的话，
 * 编辑器自己的 Ctrl+F/G/H 处理器就一个事件都收不到了（这就拦死了应用功能）。
 *
 * 用 code 而不是 key：部分输入法 / 键盘布局下 key 会变成非字母（俄语布局的 "а"），
 * code 始终对应物理按键位置。
 */
const BLOCKED_NATIVE_SHORTCUTS = [
  { key: "p", code: "KeyP" },
  { key: "f", code: "KeyF" },
  { key: "g", code: "KeyG" },
  { key: "h", code: "KeyH" },
  /*
   * 字号缩放（Ctrl/⌘ + `=` / `-` / `0`）由编辑器自己处理。
   * 不完全挡掉的话，焦点不在编辑器里时 WebView2 会拿去做**整页缩放**——
   * 工具栏、侧边栏一起变大，比不改还难受。这里只 preventDefault，
   * 编辑器根节点照样收得到事件（它自己再拦一次并改字号）。
   */
  { key: "=", code: "Equal" },
  { key: "+", code: "NumpadAdd" },
  { key: "-", code: "Minus" },
  { key: "_", code: "NumpadSubtract" },
  { key: "0", code: "Digit0" },
];

const blockNativeShortcut = (e: KeyboardEvent) => {
  if (!e.ctrlKey && !e.metaKey) return;
  const hit = BLOCKED_NATIVE_SHORTCUTS.some(
    (s) => e.code === s.code || e.key.toLowerCase() === s.key,
  );
  if (!hit) return;
  e.preventDefault();
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

/**
 * 唤出窗口 + 收起启动 splash。
 *
 * 窗口是用 `visible: false` 创建的（见 tauri.conf.json），显示时机交给这里而不是 Rust：
 * 窗口一显示，系统会先把 webview 的**空白帧**画出来——深色主题是黑屏、浅色是白屏，
 * 之后才轮到 index.html 里的加载页，也就是"先白一下才出现 loading"。
 * 等 React 首帧提交 + 一帧绘制之后再 show()，窗口出现时屏幕上已经是加载页。
 *
 * 两条触发并行，先到先得：
 * - 两帧 rAF：正常情况下这一帧已经进了合成器，最稳；
 * - 定时器兜底：窗口还不可见时 WebView2 会把页面当后台页，rAF 可能被节流甚至暂停，
 *   只靠 rAF 会死锁（窗口不显示 → rAF 不来 → 永远不显示），最后由 Rust 的 3 秒兜底收场。
 *
 * Rust 侧另有一个 3 秒定时器（前端脚本整个崩了也不会永远没有窗口），
 * 这里的 splash 收起放在 show() 之后——显示失败也不能把界面永远停在加载页。
 */
const splash = document.getElementById("splash");
const appWindow = isTauri() ? getCurrentWindow() : null;

const revealWindow = () => {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    const done = () => splash?.classList.add("hidden");
    if (!appWindow) {
      done();
      return;
    }
    /*
     * 先问一句该不该显示：开机自启 + 「开机后最小化到托盘」时窗口应该藏在托盘里，
     * 无条件 show() 会把用户特意藏起来的窗口顶出来。问不到就按显示处理。
     */
    void invoke<boolean>("should_show_on_startup")
      .catch(() => true)
      .then(async (shouldShow) => {
        try {
          if (shouldShow) {
            await appWindow.show();
            await appWindow.setFocus();
          }
        } catch (error) {
          console.error("显示主窗口失败:", error);
        } finally {
          done();
        }
      });
  };
  requestAnimationFrame(() => requestAnimationFrame(reveal));
  window.setTimeout(reveal, 200);
};

revealWindow();