import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// 禁用 Ctrl+P 原生打印
window.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "p") {
    e.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// React 挂载后隐藏启动 splash
document.getElementById("splash")?.classList.add("hidden");