/**
 * 插件窗口外壳的逻辑：加载插件页面 + 代理宿主能力 + 关闭按钮。
 *
 * 这个文件跑在「应用源」里（tauri.localhost / 开发时的 localhost:1420），
 * 所以能直接调宿主命令；插件页面在 iframe 里（fastnote-plugin 源），调不到，
 * 需要什么就 postMessage 给外壳，由外壳代调、再把结果发回去。
 *
 * 代理范围只有「本次窗口自己的那个插件」：dir 来自 query，插件页面无法改；
 * 而且回消息前会校验 event.origin 必须是这个插件页面的源。
 */

const invoke = (cmd, args) => {
  const internals = window.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== "function") {
    return Promise.reject(new Error("宿主 IPC 不可用，请重启软件后再试"));
  }
  return internals.invoke(cmd, args ?? {});
};

const params = new URLSearchParams(location.search);
const dirName = params.get("dir") ?? "";
const file = params.get("file") ?? "";
const title = params.get("title") || dirName;

const titleEl = document.getElementById("title");
const closeEl = document.getElementById("close");
const frame = document.getElementById("content");
document.title = title;
titleEl.textContent = title;

/**
 * 本窗口自己的标签（plugin-<目录名>-<序号>）：
 * 关闭命令按标签关窗，标签从宿主注入的 metadata 里取，免得页面自己拼。
 */
const ownLabel =
  window.__TAURI_INTERNALS__?.metadata?.currentWebview?.label ||
  window.__TAURI_INTERNALS__?.metadata?.currentWindow?.label ||
  "";

/** 插件页面的源（加载后才知道精确值，用于校验 postMessage 来源） */
let pluginOrigin = "";

const closeWindow = () => {
  if (!ownLabel) {
    window.close();
    return;
  }
  invoke("plugin_close_window", { dirName, label: ownLabel }).catch(() => {
    // 命令不可用时退到浏览器原生关闭（有些环境只认这条）
    window.close();
  });
};

closeEl.addEventListener("click", closeWindow);
// Esc 关窗：焦点在外壳（标题栏 / 空白处）时按 Esc 直接关掉窗口
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeWindow();
});

/** 允许插件页面调用的宿主能力：一律限定在本次窗口的 dirName，插件传什么都不看 */
const HOST_OPS = {
  "db.tables": () => invoke("plugin_db_tables", { dirName }),
  "db.createTable": (p) =>
    invoke("plugin_db_create_table", { dirName, table: p.table, columns: p.columns }),
  "db.dropTable": (p) => invoke("plugin_db_drop_table", { dirName, table: p.table }),
  "db.insert": (p) => invoke("plugin_db_insert", { dirName, table: p.table, values: p.values }),
  "db.query": (p) =>
    invoke("plugin_db_query", {
      dirName,
      table: p.table,
      filter: p.filter ?? null,
      orderBy: p.orderBy ?? null,
      descending: p.descending ?? null,
      limit: p.limit ?? null,
      offset: p.offset ?? null,
    }),
  "db.update": (p) =>
    invoke("plugin_db_update", { dirName, table: p.table, filter: p.filter, values: p.values }),
  "db.remove": (p) => invoke("plugin_db_delete", { dirName, table: p.table, filter: p.filter }),
  "plugin.reactivate": () => invoke("plugin_reactivate", { dirName }),
  /* 插件数据目录（ctx.fs 的窗口侧等价物）：页面里没有 ctx，只能让外壳代调 */
  "fs.root": () => invoke("plugin_fs_root", { dirName }),
  "fs.list": (p) => invoke("plugin_fs_list", { dirName, relDir: p.relDir ?? null }),
  "fs.read": (p) => invoke("plugin_fs_read", { dirName, relPath: p.relPath }),
  "fs.write": (p) =>
    invoke("plugin_fs_write", { dirName, relPath: p.relPath, content: p.content }),
  "fs.remove": (p) => invoke("plugin_fs_remove", { dirName, relPath: p.relPath }),
  "window.close": () => {
    if (!ownLabel) throw new Error("拿不到窗口标签");
    return invoke("plugin_close_window", { dirName, label: ownLabel });
  },
};

window.addEventListener("message", async (event) => {
  // 只认自己那个插件的页面，别的源一概不理
  if (!pluginOrigin || event.origin !== pluginOrigin) return;
  const data = event.data;
  if (!data || typeof data.__fastnoteCall !== "string") return;

  const reply = (payload) => {
    const source = event.source;
    if (source && typeof source.postMessage === "function") {
      source.postMessage({ __fastnoteReply: data.__fastnoteCall, ...payload }, pluginOrigin);
    }
  };

  try {
    const handler = HOST_OPS[data.op];
    if (!handler) throw new Error(`窗口外壳不支持这个能力：${data.op}`);
    reply({ result: await handler(data.payload ?? {}) });
  } catch (error) {
    reply({ error: error && error.message ? error.message : String(error) });
  }
});

/** 加载插件页面：URL 由宿主命令生成（跨平台协议前缀不用插件操心） */
const loadContent = async () => {
  if (!dirName || !file) {
    titleEl.textContent = "插件窗口参数不完整";
    return;
  }
  titleEl.textContent = `${title} · 加载中…`;
  try {
    // file 可能带 query（插件通过 ctx.window.open("x.html?a=1") 传参）
    const [filePath, fileQuery] = file.split("?");
    const url = await invoke("plugin_module_url", {
      dirName,
      relPath: filePath,
      version: null,
    });
    pluginOrigin = new URL(url).origin;
    frame.addEventListener(
      "load",
      () => {
        titleEl.textContent = title;
      },
      { once: true },
    );
    frame.src = fileQuery ? `${url}?${fileQuery}` : url;
  } catch (error) {
    titleEl.textContent = `插件页面加载失败：${error && error.message ? error.message : error}`;
  }
};

void loadContent();
