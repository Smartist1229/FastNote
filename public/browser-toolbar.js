// 内置浏览器工具栏：后退 / 前进 / 刷新 / 地址栏 / 加载进度条。
//
// 这是一个独立的本地 WebView（与网页 WebView 同属一个原生窗口），
// 通过 Tauri 命令控制同窗口的网页 WebView，不随网页刷新而重建。
(() => {
  const invoke = (cmd, args) =>
    window.__TAURI_INTERNALS__.invoke(cmd, args ?? {});

  const address = document.getElementById("address");
  const form = document.getElementById("address-form");
  const progress = document.getElementById("progress");
  const fill = document.getElementById("progress-fill");
  const download = document.getElementById("download");
  const downloadFill = document.getElementById("download-fill");
  const downloadName = document.getElementById("download-name");
  const downloadPercent = document.getElementById("download-percent");
  const downloadPanel = document.getElementById("download-panel");
  const downloadList = document.getElementById("download-list");
  const downloadClear = document.getElementById("download-clear");
  const downloadClose = document.getElementById("download-close");

  /*
   * 同一个页面同时服务两个窗口：
   * - 工具栏窗口（默认）：只有顶部那条 bar，下载按钮带摘要；
   * - 下载面板窗口（?panel=1）：只有下载卡片，窗口是透明、无边框的小弹窗，
   *   由 Rust 摆在浏览器窗口的右上角，浮在网页上（网页不会被挤下去）。
   */
  const panelMode = new URLSearchParams(window.location.search).has("panel");
  const bar = document.querySelector(".bar");

  let loading = false;
  let addressFocused = false;
  let failures = 0;
  let polling = true;
  /** 最近一次轮询到的下载列表（新的在后），面板与气泡都按它渲染 */
  let downloads = [];
  /** 面板是否展开；以 Rust 侧的面板窗口可见状态为准 */
  let panelOpen = false;
  /** 已请求的面板高度（逻辑像素） */
  let panelHeight = 0;

  if (panelMode) {
    document.documentElement.classList.add("panel-mode");
    document.body.classList.add("panel-mode");
    bar.hidden = true;
    downloadPanel.hidden = false;
  }

  address.addEventListener("focus", () => {
    addressFocused = true;
    address.select();
  });
  address.addEventListener("blur", () => {
    addressFocused = false;
  });
  address.addEventListener("keydown", (event) => {
    if (event.key === "Escape") address.blur();
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const value = address.value.trim();
    if (!value) return;
    address.blur();
    invoke("browser_toolbar_navigate", { url: value }).catch((err) => {
      console.error("打开地址失败：", err);
      // 打不开时把地址栏恢复成当前页，避免停留在无效输入上
      void refreshOnce();
    });
  });

  const actions = { back: "后退", forward: "前进", reload: "刷新" };
  for (const [action, label] of Object.entries(actions)) {
    document.getElementById(action).addEventListener("click", () => {
      if (action === "reload") setLoading(true);
      invoke("browser_toolbar_action", { action }).catch((err) => {
        console.error(`${label}失败：`, err);
        // 刷新失败时页面不会重新加载，进度条得自己收回来
        if (action === "reload") setLoading(false);
      });
    });
  }

  const setLoading = (next) => {
    if (next === loading) return;
    loading = next;
    if (next) {
      progress.classList.add("active");
      fill.style.transition = "none";
      fill.style.width = "8%";
      // 先画到 8%，再用长时间过渡逼近 90%，页面加载完成时再补到 100%
      requestAnimationFrame(() => {
        fill.style.transition = "width 9s cubic-bezier(0.1, 0.7, 0.3, 1)";
        fill.style.width = "90%";
      });
    } else {
      fill.style.transition = "width 160ms ease-out";
      fill.style.width = "100%";
      window.setTimeout(() => {
        if (loading) return;
        progress.classList.remove("active");
        fill.style.transition = "none";
        fill.style.width = "0";
      }, 220);
    }
  };

  /*
   * 下载气泡：点工具栏上的按钮展开 / 收起面板窗口。面板是独立的透明小窗，
   * 展开时只盖住网页右上角一块，网页 WebView 的尺寸不变——是浮层，不是把页面挤下去。
   */
  const wantedPanelHeight = () => {
    // 卡片标题栏 + 每条 66 逻辑像素（最多先按 4 条算，更多就列表内部滚动）
    const rows = Math.min(downloads.length, 4);
    return Math.max(96, 30 + rows * 66);
  };

  // 面板开着、条目数又变了：把新高度带给 Rust，面板窗口跟着长高 / 缩回去
  const requestPanelHeight = () => {
    if (panelMode || !panelOpen) return;
    const height = wantedPanelHeight();
    if (height === panelHeight) return;
    panelHeight = height;
    invoke("browser_toolbar_panel", { open: true, height }).catch((err) => {
      console.error("展开下载面板失败：", err);
    });
  };

  const closePanel = () => {
    if (!panelOpen) return;
    panelOpen = false;
    panelHeight = 0;
    if (!panelMode) download.setAttribute("aria-expanded", "false");
    invoke("browser_toolbar_panel", { open: false, height: 0 }).catch((err) => {
      console.error("收起下载面板失败：", err);
    });
  };

  if (!panelMode) {
    download.addEventListener("click", () => {
      const open = !panelOpen;
      const height = open ? wantedPanelHeight() : 0;
      panelHeight = height;
      // 箭头先即时翻转，真正的展开状态以轮询回来的状态为准
      download.setAttribute("aria-expanded", open ? "true" : "false");
      invoke("browser_toolbar_panel", { open, height }).catch((err) => {
        console.error("展开下载面板失败：", err);
        download.setAttribute("aria-expanded", panelOpen ? "true" : "false");
      });
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closePanel();
    });
  }
  downloadClose.addEventListener("click", closePanel);

  downloadClear.addEventListener("click", () => {
    invoke("browser_download_clear").catch((err) => {
      console.error("清除下载记录失败：", err);
    });
  });

  // 行为按行内按钮的 data-action 分发，避免每次轮询都重新绑定闭包
  downloadList.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-action]");
    const row = button && button.closest(".download-item");
    if (!button || !row) return;
    const id = Number(row.dataset.id) || 0;
    switch (button.dataset.action) {
      case "pause":
        invoke("browser_download_pause", { id, paused: true }).catch((err) =>
          console.error("暂停下载失败：", err)
        );
        break;
      case "resume":
        invoke("browser_download_pause", { id, paused: false }).catch((err) =>
          console.error("继续下载失败：", err)
        );
        break;
      case "cancel":
        invoke("browser_download_cancel", { id }).catch((err) =>
          console.error("取消下载失败：", err)
        );
        break;
      case "reveal":
        invoke("reveal_app_file", { path: row.dataset.path || "" }).catch((err) =>
          console.error("打开下载文件夹失败：", err)
        );
        break;
      case "forget":
        invoke("browser_download_forget", { id }).catch((err) =>
          console.error("移除下载记录失败：", err)
        );
        break;
    }
  });

  const sizeText = (bytes) => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = Number(bytes) || 0;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
      value /= 1024;
      index += 1;
    }
    const digits = value >= 100 || index === 0 ? 0 : 1;
    return `${value.toFixed(digits)} ${units[index]}`;
  };

  /*
   * 下载状态由 Rust 写在浏览器状态里（下载模块没有事件通道，工具栏本来就每 200ms
   * 轮询一次）。正在下载的优先显示在气泡上，结束的条目留在面板里等用户移除。
   */
  const ACTIVE_STATES = ["start", "progress", "paused"];

  const isActive = (item) => ACTIVE_STATES.includes(item.state);

  const ratioPercent = (item) => {
    if (item.state === "done") return 100;
    const done = Number(item.downloaded) || 0;
    const total = Number(item.total) || 0;
    if (total <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  };

  const describe = (item) => {
    const done = Number(item.downloaded) || 0;
    const total = Number(item.total) || 0;
    const percent = ratioPercent(item);
    const size = total > 0 ? `${sizeText(done)} / ${sizeText(total)}` : sizeText(done);
    switch (item.state) {
      case "done":
        return `已完成 · ${sizeText(total || done)}`;
      case "cancelled":
        return "已取消";
      case "error":
        return item.error ? `失败：${item.error}` : "失败";
      case "paused":
        return `已暂停 · ${percent}% · ${size}`;
      case "start":
        return "准备下载…";
      default:
        return total > 0
          ? `${percent}% · ${size}${item.speed > 0 ? ` · ${sizeText(item.speed)}/s` : ""}`
          : sizeText(done);
    }
  };

  const actionsFor = (item) => {
    if (item.state === "paused") return [["resume", "继续"], ["cancel", "取消"]];
    if (isActive(item)) return [["pause", "暂停"], ["cancel", "取消"]];
    if (item.state === "done") return [["reveal", "打开文件夹"], ["forget", "移除"]];
    return [["forget", "移除"]];
  };

  /*
   * 面板里的行按 id 原地更新，不整表重建：每 200ms 重建一次会把正在按下的
   * 按钮换掉，点击就丢了。
   */
  const rows = new Map();

  const createRow = () => {
    const row = document.createElement("div");
    row.className = "download-item";
    const main = document.createElement("div");
    main.className = "download-item-main";
    const name = document.createElement("span");
    name.className = "download-item-name";
    const status = document.createElement("span");
    status.className = "download-item-status";
    const bar = document.createElement("div");
    bar.className = "download-item-bar";
    const barFill = document.createElement("span");
    bar.appendChild(barFill);
    main.append(name, status, bar);
    const actions = document.createElement("div");
    actions.className = "download-item-actions";
    row.append(main, actions);
    return { row, name, status, barFill, actions, actionKey: "" };
  };

  const updateRow = (entry, item) => {
    entry.row.dataset.id = String(item.id);
    entry.row.dataset.path = item.path || "";
    entry.name.textContent = item.filename || "下载";
    entry.name.title = item.path || item.filename || "";
    entry.status.textContent = describe(item);
    entry.barFill.style.width = `${ratioPercent(item)}%`;

    // 只有按钮组合变了才重建按钮（暂停 ↔ 继续、结束时换成打开文件夹）
    const actions = actionsFor(item);
    const key = actions.map(([action]) => action).join(",");
    if (entry.actionKey === key) return;
    entry.actionKey = key;
    entry.actions.textContent = "";
    for (const [action, label] of actions) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.action = action;
      button.textContent = label;
      entry.actions.appendChild(button);
    }
  };

  const syncList = () => {
    // 新任务排在最上面
    const ordered = [...downloads].reverse();
    const alive = new Set(ordered.map((item) => item.id));
    for (const [id, entry] of rows) {
      if (alive.has(id)) continue;
      entry.row.remove();
      rows.delete(id);
    }
    let cursor = downloadList.firstChild;
    for (const item of ordered) {
      let entry = rows.get(item.id);
      if (!entry) {
        entry = createRow();
        rows.set(item.id, entry);
      }
      updateRow(entry, item);
      if (entry.row === cursor) {
        cursor = cursor.nextSibling;
      } else {
        downloadList.insertBefore(entry.row, cursor);
      }
    }
  };

  const renderDownload = (list) => {
    downloads = Array.isArray(list) ? list : [];
    if (!downloads.length) {
      download.hidden = true;
      // 一条都不剩（比如刚点了「清除已结束」）：气泡跟着收起来
      if (panelOpen) closePanel();
      syncList();
      return;
    }

    const active = downloads.filter(isActive);
    const latest = active.length ? active[active.length - 1] : downloads[downloads.length - 1];
    const done = Number(latest.downloaded) || 0;
    const total = Number(latest.total) || 0;

    download.hidden = false;
    // 全部结束时收成一个图标，面板入口还在，但不占地址栏宽度
    download.classList.toggle("compact", !active.length);
    downloadFill.style.width = active.length ? `${ratioPercent(latest)}%` : "0";
    downloadName.textContent = latest.filename || "下载";
    download.title = [
      latest.path || latest.filename || "下载",
      `${sizeText(done)}${total > 0 ? ` / ${sizeText(total)}` : ""}`,
      latest.speed > 0 ? `${sizeText(latest.speed)}/s` : "",
      latest.error || "",
    ]
      .filter(Boolean)
      .join("\n");

    if (latest.state === "done") {
      downloadPercent.textContent = "已保存";
    } else if (latest.state === "cancelled") {
      downloadPercent.textContent = "已取消";
    } else if (latest.state === "error") {
      downloadPercent.textContent = "失败";
    } else if (latest.state === "paused") {
      downloadPercent.textContent = "已暂停";
    } else if (latest.state === "start") {
      downloadPercent.textContent = "准备…";
    } else if (total > 0) {
      downloadPercent.textContent = `${ratioPercent(latest)}%`;
    } else {
      downloadPercent.textContent = sizeText(done);
    }

    downloadClear.hidden = downloads.every(isActive);
    syncList();
    requestPanelHeight();
  };

  const applyState = (state) => {
    if (!state) return;
    if (!addressFocused && typeof state.url === "string" && state.url) {
      if (address.value !== state.url) address.value = state.url;
    }
    setLoading(Boolean(state.loading));
    panelOpen = Boolean(state.panel_open);
    // 展开箭头跟着真实的窗口状态走（面板窗口自己也能关掉它）
    if (!panelMode) {
      download.setAttribute("aria-expanded", panelOpen ? "true" : "false");
    }
    renderDownload(state.downloads);
  };

  /*
   * 只读一次状态。地址栏提交失败时用它恢复地址，不能直接调用 poll：
   * poll 自己会持续调度，额外调用会多出一条永不停止的轮询链。
   */
  const refreshOnce = async () => {
    try {
      const state = await invoke("browser_toolbar_state");
      failures = 0;
      applyState(state);
    } catch (err) {
      failures += 1;
      console.error("读取浏览器状态失败：", err);
    }
  };

  const poll = async () => {
    await refreshOnce();
    // 窗口正在关闭时命令会连续失败，别无限刷日志
    if (!polling || failures > 10) {
      polling = false;
      return;
    }
    window.setTimeout(poll, 200);
  };

  // 工具栏重新加载时收起可能残留的气泡窗口（面板窗口自己不能被这条关掉）
  if (!panelMode) {
    invoke("browser_toolbar_panel", { open: false, height: 0 }).catch(() => {});
  }

  void poll();
})();
