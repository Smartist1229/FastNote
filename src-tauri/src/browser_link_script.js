// 内置浏览器的链接拦截脚本：所有"新窗口"链接都改成在当前窗口打开。
//
// 为什么不用 NewWindowRequested 就够了：WebView2 只有在真正发起新窗口请求时才触发该事件，
// 且事件处理里再调 Navigate 依赖引擎内部时序，实测部分页面点了 target="_blank" 毫无反应。
// 脚本在 document-start 注入（initialization_script 对所有 frame 生效），先一步拦住点击：
// - 捕获阶段拦截 target="_blank" 的 <a>，阻止默认行为后在当前窗口导航；
// - 覆盖 window.open，有地址时同样在当前窗口导航（无地址的 window.open() 保持原生）。
//
// 页面自己的脚本已经处理过点击（defaultPrevented）时不插手，避免和 SPA 路由冲突。
(() => {
  if (window.__FASTNOTE_SAME_WINDOW_LINKS__) return;
  window.__FASTNOTE_SAME_WINDOW_LINKS__ = true;

  const openHere = (url) => {
    if (!url) return;
    // 子 frame 里的链接：能导航顶层就导航顶层（点了链接却只在 iframe 里跳很怪）
    try {
      window.top.location.href = url;
      return;
    } catch {
      // 跨域 / sandbox 禁止顶层导航时退回本 frame
    }
    try {
      window.location.href = url;
    } catch {
      // 无法导航的地址（如被 sandbox 禁止）保持原样
    }
  };

  const isBlank = (target) =>
    typeof target === "string" && target.trim().toLowerCase() === "_blank";

  document.addEventListener(
    "click",
    (event) => {
      if (event.defaultPrevented) return;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      let anchor = null;
      for (const node of path) {
        if (node instanceof HTMLAnchorElement) {
          anchor = node;
          break;
        }
      }
      if (!anchor) {
        const node = event.target;
        anchor = node instanceof Element ? node.closest("a[href]") : null;
      }
      if (!anchor || !anchor.href || !isBlank(anchor.getAttribute("target"))) return;
      // 带 download 的链接交给浏览器原生下载，改成当前窗口导航会把下载弄丢
      if (anchor.hasAttribute("download")) return;
      event.preventDefault();
      openHere(anchor.href);
    },
    true
  );

  const nativeOpen = window.open;
  window.open = function (url) {
    if (typeof url === "string" && url !== "") {
      try {
        openHere(new URL(url, document.baseURI).href);
      } catch {
        openHere(url);
      }
      return window;
    }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null;
  };
})();
