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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// React 挂载后隐藏启动 splash
document.getElementById("splash")?.classList.add("hidden");