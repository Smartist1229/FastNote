/* ---------------- 插件系统 ----------------
 * 插件包是一个 zip，特征文件是 plugin.json（没有它不算合法插件）。
 * 两种包内布局都认：
 *   1. 根目录直接放 plugin.json + 资源文件；
 *   2. 只有一个顶层文件夹包着 plugin.json（例如 GitHub「Download ZIP」的产物）。
 * 安装 = 解压到 <exe 同级>/plugin/<目录名>/，每个插件一个子目录。
 *
 * 两个标识的语义必须分清（改这里前先看明白）：
 *   - plugin.json 的 `id`：插件的**身份**，由作者声明，不同作者可能撞用同一个 id；
 *   - 目录名 `dirName`：插件的**实例键**，落盘后唯一的目录名。前端所有运行时操作
 *     （启用状态、卸载、读资源、注册贡献）一律用 dirName，绝不拿 id 当主键。
 * 安装时决定目录名：
 *   - 已存在同 id 且 author 相同（trim + 忽略大小写，均为空也算相同）→ 复用该目录整体覆盖，
 *     即升级/降级（不做 semver 比较）；
 *   - 同 id 但 author 不同 → `<id>-<6位十六进制>`，循环避开已有目录（撞名插件互不覆盖）；
 *   - 没有同 id → 用 `id` 作目录名。
 */

mod db;
mod install;
mod manifest;
mod permissions;
mod scheme;
mod seed;
mod storage;
#[cfg(test)]
mod test_support;

pub use manifest::*;
pub use permissions::*;
pub use scheme::handle_plugin_scheme_request;
pub use seed::seed_builtin_plugins;
pub(crate) use scheme::PLUGIN_SCHEME;
pub(crate) use storage::{load_installed_manifest, plugins_root};

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use serde_json::{Map, Value};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::AppState;
use db::PluginColumn;
use install::{install_opened, list_installed_in, open_plugin_zip, resolve_target_dir_name};
use scheme::{build_module_url, plugin_icon_url_in, validate_module_dir_name};
use storage::{read_config_in, read_resource_in, validate_dir_name, write_config_in};

/* ---------------- Tauri 命令 ---------------- */

/// 列出已安装插件：扫描 plugin/ 下每个子目录的 plugin.json，成功解析并校验的
/// 填入 dirName（= 子目录名）；解析失败的目录跳过，不中断整体。
#[tauri::command]
pub fn plugin_list_installed(_app: AppHandle) -> Vec<PluginManifest> {
    let dir = match plugins_root() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("{e}");
            return Vec::new();
        }
    };
    // plugin/ 目录不存在时按需创建（失败也无妨，read_dir 会得到空列表）
    let _ = std::fs::create_dir_all(&dir);
    list_installed_in(&dir)
}

/// 安装插件包（zip）：定位并校验 plugin.json 后按目录规则落盘，返回带 dirName 的清单。
/// skip_confirm=true 时跳过权限白名单校验（供内部可信场景使用）；默认 false 严格校验。
#[tauri::command]
pub fn plugin_install_zip(
    app: AppHandle,
    zip_path: String,
    skip_confirm: Option<bool>,
) -> Result<PluginManifest, String> {
    let dir = plugins_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    // 先走一遍 open_plugin_zip 拿到清单，这样可以先做权限校验再落盘
    let opened = open_plugin_zip(&zip_path)?;
    // 兼容性：apiVersion / minAppVersion 高于当前软件时直接拒绝，别等激活时才炸
    let app_version = app.package_info().version.to_string();
    manifest::validate_compatibility(&opened.manifest, &app_version)?;
    if !skip_confirm.unwrap_or(false) {
        validate_permissions(&opened.manifest.permissions)?;
    }
    let dir_name = resolve_target_dir_name(&dir, &opened.manifest);
    let target = dir.join(&dir_name);
    install_opened(opened, &target, &dir_name)
}

/// 插件目录路径：确保目录存在后返回字符串。
/// 前端拿它调用已有的 open_app_folder 打开（该命令放行 exe 目录，插件目录在其下）。
#[tauri::command]
pub fn plugin_folder_path() -> Result<String, String> {
    let dir = plugins_root()?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建插件目录失败：{e}"))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// 卸载插件：校验目录名（实例键）后删除 <plugin>/<dirName>。
/// 目录本就不存在时视为已卸载，返回成功。
#[tauri::command]
pub fn plugin_uninstall(_app: AppHandle, dir_name: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    let target = plugins_root()?.join(&dir_name);
    if !target.exists() {
        return Ok(());
    }
    std::fs::remove_dir_all(&target).map_err(|e| format!("卸载插件失败：{e}"))
}

/// 读取插件目录内的文本资源（main.js / style.css 等）。
/// 防目录穿越：拒绝含 .. 的路径，并 canonicalize 复核解析结果仍在插件目录内。
#[tauri::command]
pub fn plugin_read_resource(
    _app: AppHandle,
    dir_name: String,
    rel_path: String,
) -> Result<String, String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    read_resource_in(&plugin_dir, &rel_path)
}

/// 读取插件配置（plugin_read_config）：config.json 不存在时按空对象处理，
/// 与 schema 的 defaults 合并（存储值优先），只返回 schema 声明的 key。
#[tauri::command]
pub fn plugin_read_config(_app: AppHandle, dir_name: String) -> Result<Value, String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    let manifest = load_installed_manifest(&plugin_dir)?;
    read_config_in(&plugin_dir, &manifest.config)
}

/// 写入插件配置（plugin_write_config）：必须是 JSON 对象；只写 schema 声明的 key，
/// 类型必须与 kind 对应；pretty JSON 原子落盘，不触发其他副作用。
#[tauri::command]
pub fn plugin_write_config(
    _app: AppHandle,
    dir_name: String,
    config: Value,
) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    let plugin_dir = plugins_root()?.join(&dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    let manifest = load_installed_manifest(&plugin_dir)?;
    write_config_in(&plugin_dir, &manifest.config, &config)
}

/// 生成插件模块的完整协议 URL（前端动态 import 用）：
/// Windows / Android 为 http://fastnote-plugin.localhost/<dirName>/<path>，
/// 其余平台为 fastnote-plugin://localhost/<dirName>/<path>。
#[tauri::command]
pub fn plugin_module_url(
    _app: AppHandle,
    dir_name: String,
    rel_path: String,
    version: Option<u64>,
) -> Result<String, String> {
    build_module_url(&dir_name, &rel_path, version)
}

/// 探测已安装插件的图标并返回完整协议 URL：按 icon.png → icon.svg → icon.webp → icon.jpg
/// 的优先级取第一个存在的文件；都不存在返回 None。只读操作，无需权限校验。
#[tauri::command]
pub fn plugin_icon_url(dir_name: String) -> Option<String> {
    validate_module_dir_name(&dir_name).ok()?;
    let root = plugins_root().ok()?;
    plugin_icon_url_in(&root.join(&dir_name), &dir_name)
}

/* ---------------- 演示插件安装 ---------------- */

/// 安装 / 覆盖内置演示插件（plugin_install_demo）。
/// 设置页的「刷新」与「安装演示插件」都走它：每次都写最新一份，config.json 保留，
/// 这样开发期改完演示插件点一下刷新就能看到，不用重装安装包。
#[tauri::command]
pub fn plugin_install_demo(app: AppHandle) -> Result<(), String> {
    seed::install_demo_plugin(&app)
}

/* ---------------- 权限守卫 ---------------- */

/// 校验插件已安装且声明了某个权限，返回插件目录。
/// Rust 侧做一次复核：前端的 ctx 守卫只管住「正常调用」，越过 ctx 直接 invoke 时还有这一层。
fn ensure_plugin_permission(dir_name: &str, permission: &str) -> Result<std::path::PathBuf, String> {
    validate_dir_name(dir_name)?;
    let plugin_dir = plugins_root()?.join(dir_name);
    if !plugin_dir.is_dir() {
        return Err(format!("插件未安装：{dir_name}"));
    }
    let manifest = load_installed_manifest(&plugin_dir)?;
    if !manifest.permissions.iter().any(|p| p == permission) {
        return Err(format!("插件「{dir_name}」未声明 {permission} 权限"));
    }
    Ok(plugin_dir)
}

/* ---------------- 插件私有表 ---------------- */

/// 建表：表名自动加 `plugin_<目录名>__` 前缀，插件只能建自己的表
#[tauri::command]
pub fn plugin_db_create_table(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    columns: Vec<PluginColumn>,
) -> Result<(), String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::create_table(&conn, &dir_name, &table, &columns)
}

/// 删表
#[tauri::command]
pub fn plugin_db_drop_table(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
) -> Result<(), String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::drop_table(&conn, &dir_name, &table)
}

/// 列出本插件自己的表（返回去掉前缀的裸名）
#[tauri::command]
pub fn plugin_db_tables(state: State<'_, AppState>, dir_name: String) -> Result<Vec<String>, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::list_tables(&conn, &dir_name)
}

/// 插入一行，返回新行 id
#[tauri::command]
pub fn plugin_db_insert(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    values: Map<String, Value>,
) -> Result<i64, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::insert(&conn, &dir_name, &table, &values)
}

/// 查询（等值过滤 + 排序 + 分页）
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn plugin_db_query(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    filter: Option<Map<String, Value>>,
    order_by: Option<String>,
    descending: Option<bool>,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Value>, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::query(
        &conn,
        &dir_name,
        &table,
        filter.as_ref(),
        order_by.as_deref(),
        descending.unwrap_or(true),
        limit,
        offset,
    )
}

/// 更新（必须带过滤条件），返回影响行数
#[tauri::command]
pub fn plugin_db_update(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    filter: Map<String, Value>,
    values: Map<String, Value>,
) -> Result<usize, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::update(&conn, &dir_name, &table, &filter, &values)
}

/// 删除（必须带过滤条件），返回影响行数
#[tauri::command]
pub fn plugin_db_delete(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    filter: Map<String, Value>,
) -> Result<usize, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::delete(&conn, &dir_name, &table, &filter)
}

/* ---------------- 插件自己的窗口 ---------------- */

/// 窗口标签计数器：同一插件可以开多个窗口，标签必须唯一
static WINDOW_SEQ: AtomicU64 = AtomicU64::new(1);

/// 插件窗口的 WebView2 数据目录（与主窗口 / 内置浏览器分开，避免 additionalBrowserArgs 冲突）
const PLUGIN_WINDOW_PROFILE_DIR: &str = "plugin-window-profile";

/// query 值编码：只留 RFC 3986 unreserved，其余按 UTF-8 编 %XX（目录名/文件名/标题都可能带中文）
fn encode_query(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 用插件目录里的一个文件打开独立窗口（plugin_open_window），返回窗口标签。
/// 页面走 fastnote-plugin 协议加载，和主界面同源策略无关，插件可以带自己的 HTML / CSS / JS。
#[tauri::command]
pub async fn plugin_open_window(
    app: AppHandle,
    dir_name: String,
    rel_path: String,
    title: Option<String>,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let plugin_dir = ensure_plugin_permission(&dir_name, "window.open")?;
    let raw = rel_path.trim();
    if raw.is_empty() {
        return Err("插件窗口要加载的文件不能为空".into());
    }
    // 允许插件给页面带 query（例如把配置项传进去），校验只针对路径部分
    let (rel, file_query) = match raw.split_once('?') {
        Some((path, query)) if !query.is_empty() => (path.trim(), Some(query)),
        Some((path, _)) => (path.trim(), None),
        None => (raw, None),
    };
    if rel.is_empty() {
        return Err("插件窗口要加载的文件不能为空".into());
    }
    // 防目录穿越：能 canonicalize 就说明文件真实存在，再复核仍在插件目录内
    let dir_canonical = plugin_dir
        .canonicalize()
        .map_err(|e| format!("插件目录不可用：{e}"))?;
    let file_canonical = plugin_dir
        .join(rel)
        .canonicalize()
        .map_err(|_| format!("插件窗口文件不存在：{rel_path}"))?;
    if !file_canonical.starts_with(&dir_canonical) || !file_canonical.is_file() {
        return Err(format!("非法的插件窗口路径：{rel_path}"));
    }

    let seq = WINDOW_SEQ.fetch_add(1, Ordering::Relaxed);
    let label = format!("plugin-{dir_name}-{seq}");
    let width = width.unwrap_or(760.0).clamp(260.0, 3200.0);
    let height = height.unwrap_or(580.0).clamp(220.0, 2000.0);
    let title = title.unwrap_or_else(|| dir_name.clone());
    /*
     * 窗口里加载的是宿主的「插件窗口外壳」（public/plugin-window.html），插件页面放它里面的
     * iframe —— 直接加载插件 html 的话页面不在应用源，拿不到 IPC，连关闭都做不到。
     * 参数走 query：Url::join 会把它当相对 URL 解析，query 原样保留（dev 下也成立）。
     *
     * 独立 user data folder：主窗口在 tauri.conf.json 里配了 additionalBrowserArgs，
     * WebView2 要求共用同一个目录的环境使用完全相同的选项，混用会建环境失败——
     * 表现就是窗口开出来一片空白（连标题栏都正常，很容易误判成页面问题）。
     * 内置浏览器踩过同一个坑，这里照抄它的做法。
     */
    // file 参数可能自带 query（原样带给 iframe 里的插件页面）
    let file_param = match file_query {
        Some(query) => format!("{rel}?{query}"),
        None => rel.to_string(),
    };
    let app_url = format!(
        "plugin-window.html?dir={}&file={}&title={}",
        encode_query(&dir_name),
        encode_query(&file_param),
        encode_query(&title)
    );
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    /*
     * 建窗口必须走 async 命令 + 先不可见、build 完再 show：
     *   - 同步命令里 build() 会阻塞等主线程，事件循环被卡住 → 窗口一直不绘制（一片黑），
     *     连标题栏按钮都点不动；内置浏览器的 browser_open 也是 async 的，同一个道理；
     *   - visible(true) 时窗口在 webview 就绪前就显示，也可能停在未绘制的黑底上。
     * 先 visible(false)，等 build 返回（webview 已就绪）再 show + 聚焦，照抄 browser.rs。
     */
    let window = WebviewWindowBuilder::new(&app, label.clone(), WebviewUrl::App(app_url.into()))
        .data_directory(data_dir.join(PLUGIN_WINDOW_PROFILE_DIR))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(320.0, 240.0)
        // 底色跟主窗口一致：万一 webview 还没画出来，看到的是浅色而不是纯黑（也便于分辨
        // 「页面没加载」和「页面画不出来」——纯黑基本就是后者）
        .background_color(tauri::window::Color(0xF8, 0xFA, 0xFC, 0xFF))
        .visible(false)
        // 窗口白屏 / 黑屏时，dev 终端能看出到底是哪条 URL 没加载出来
        .on_page_load(|_webview, payload| {
            if cfg!(debug_assertions) {
                let mark = if matches!(payload.event(), PageLoadEvent::Started) { "→" } else { "✓" };
                eprintln!("[plugin-window] {mark} {}", payload.url());
            }
        })
        .build()
        .map_err(|e| format!("打开插件窗口失败：{e}"))?;
    if cfg!(debug_assertions) {
        eprintln!(
            "[plugin-window] built label={label} url={:?} webview={}",
            window.url(),
            // WebviewWindow 的 webview 标签就是窗口标签，同名才是「webview 真的建出来了」
            app.get_webview(&label).is_some()
        );
    }

    /*
     * 显示与重绘都放到后台线程里做，顺序是「先让内核把首帧合成好，再显示」：
     *   1. 等 80ms（此时 webview 还藏着，内核已经在准备首帧）；
     *   2. show + 聚焦；
     *   3. 再在 350ms / 1200ms 用 ±1px 的 Physical 尺寸写回逼一次重合成 ——
     *      这台机器上主窗口就踩过「显示了却从不绘制」的黑屏，同一套兜底照抄过来。
     * 命令本身立即返回窗口标签，不阻塞调用方。
     */
    let nudge_app = app.clone();
    let nudge_label = label.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if let Some(window) = nudge_app.get_webview_window(&nudge_label) {
            let _ = window.show();
            let _ = window.set_focus();
        } else {
            return;
        }
        for delay in [350u64, 1200] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            let Some(window) = nudge_app.get_webview_window(&nudge_label) else {
                return; // 窗口已经关掉了
            };
            /*
             * 只在「用户没动过窗口」时才补这一次重绘：
             * set_size 会把最大化 / 全屏状态顶掉——用户点了最大化后，兜底的 ±1px 写回
             * 会立刻把它还原（窗口尺寸却停在最大化那一档），再点一次才能真的最大化。
             */
            if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
                continue;
            }
            let Ok(size) = window.inner_size() else { continue };
            let _ = window.set_size(tauri::PhysicalSize::new(size.width + 1, size.height));
            std::thread::sleep(std::time::Duration::from_millis(40));
            // 改尺寸的这 40ms 里用户也可能点了最大化，落回去之前再看一眼
            if window.is_maximized().unwrap_or(false) {
                continue;
            }
            let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
        }
    });
    Ok(label)
}

/// 关掉一个插件窗口（label 必填，且必须属于 dir_name 这个插件）。
/// 插件窗口外壳从 `__TAURI_INTERNALS__.metadata.currentWindow.label` 取自己的标签传进来——
/// 这里刻意不用注入式参数（`tauri::Webview`）：async 命令里注入的句柄要求 Send，
/// 而标签本来就够用，少一层依赖。
#[tauri::command]
pub async fn plugin_close_window(app: AppHandle, dir_name: String, label: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    if !window_label_belongs_to(&label, &dir_name) {
        return Err("只能关闭插件自己打开的窗口".into());
    }
    if let Some(window) = app.get_webview_window(&label) {
        // 同步版 close：async 命令里 await 它没意义，关窗只需要投递到主线程
        window.close().map_err(|e| format!("关闭窗口失败：{e}"))?;
    }
    Ok(())
}

/// 通知宿主「某个插件需要重新激活」：插件在自己的窗口里改了数据（比如快捷键）后调用，
/// 宿主收到事件会把该插件重跑一遍 activate，注册类副作用（快捷键 / 菜单…）随之更新。
#[tauri::command]
pub fn plugin_reactivate(app: AppHandle, dir_name: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    app.emit("plugin:reactivate", dir_name)
        .map_err(|e| format!("通知宿主失败：{e}"))
}

/// 删除某个插件的全部私有表（卸载时用户选择「删除表」才调用）。
/// 宿主操作，不要求插件声明 db.read_write；返回删掉的表数量。
#[tauri::command]
pub fn plugin_db_drop_all(state: State<'_, AppState>, dir_name: String) -> Result<usize, String> {
    validate_dir_name(&dir_name)?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::drop_all(&conn, &dir_name)
}

/// 关掉某个插件打开的所有窗口：插件停用 / 卸载时由宿主调用，保证「关掉插件就恢复原样」
#[tauri::command]
pub async fn plugin_close_windows(app: AppHandle, dir_name: String) -> Result<(), String> {
    validate_dir_name(&dir_name)?;
    for (label, window) in app.webview_windows() {
        if window_label_belongs_to(&label, &dir_name) {
            let _ = window.close();
        }
    }
    Ok(())
}

/// 窗口标签是否属于 dir_name 这个插件：`plugin-<目录名>-<数字>`。
/// 不能只判 `starts_with("plugin-<dir>-")`——目录名互为前缀时（a 与 a-b）会把别人的窗口一起关掉。
fn window_label_belongs_to(label: &str, dir_name: &str) -> bool {
    let prefix = format!("plugin-{dir_name}-");
    match label.strip_prefix(&prefix) {
        Some(seq) => !seq.is_empty() && seq.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/* ---------------- 插件私有表：扩展操作 ---------------- */

/// 统计行数（不把数据拉回前端）
#[tauri::command]
pub fn plugin_db_count(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    filter: Option<Map<String, Value>>,
) -> Result<i64, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::count(&conn, &dir_name, &table, filter.as_ref())
}

/// 加一列（迁移）：已存在时返回 false
#[tauri::command]
pub fn plugin_db_add_column(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    column: PluginColumn,
) -> Result<bool, String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::add_column(&conn, &dir_name, &table, &column)
}

/// 建索引（幂等）
#[tauri::command]
pub fn plugin_db_create_index(
    state: State<'_, AppState>,
    dir_name: String,
    table: String,
    name: String,
    columns: Vec<String>,
    unique: Option<bool>,
) -> Result<(), String> {
    ensure_plugin_permission(&dir_name, "db.read_write")?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::create_index(
        &conn,
        &dir_name,
        &table,
        &name,
        &columns,
        unique.unwrap_or(false),
    )
}

/// 列出某个插件建过的全部表（不看它是否还有 db.read_write 权限）。
/// 宿主在卸载时用它问「要不要一起删」——老版本插件留下的表也得能列出来。
#[tauri::command]
pub fn plugin_db_list_all_tables(
    state: State<'_, AppState>,
    dir_name: String,
) -> Result<Vec<String>, String> {
    validate_dir_name(&dir_name)?;
    let conn = state
        .conn
        .lock()
        .map_err(|e| format!("数据库连接不可用：{e}"))?;
    db::list_tables(&conn, &dir_name)
}

/* ---------------- 插件文件存储（ctx.fs） ----------------
 * 只能碰自己的数据目录：<数据目录>/plugin-data/<目录名>/。
 * 为什么不给插件目录：插件目录会被升级整目录覆盖，往里写文件等于随时会丢。
 */

/// 单个文件上限：读写都按这个卡（文本场景够用，也防插件把磁盘写爆）
const PLUGIN_FS_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// 不允许写入的扩展名：数据目录不该出现可执行文件（用户双击就运行的那种）
const PLUGIN_FS_BLOCKED_EXT: &[&str] = &[
    "exe", "dll", "bat", "cmd", "ps1", "sh", "msi", "com", "scr", "vbs", "lnk", "jar", "reg",
];

/// 插件数据目录（不存在则创建）
fn plugin_data_root(app: &AppHandle, dir_name: &str) -> Result<PathBuf, String> {
    validate_dir_name(dir_name)?;
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let root = data_dir.join("plugin-data").join(dir_name);
    std::fs::create_dir_all(&root).map_err(|e| format!("创建插件数据目录失败：{e}"))?;
    // 复核：真实路径必须仍在 plugin-data 下（防符号链接指到别处）
    let canonical = root
        .canonicalize()
        .map_err(|e| format!("插件数据目录不可用：{e}"))?;
    let base = data_dir
        .join("plugin-data")
        .canonicalize()
        .map_err(|e| format!("插件数据目录不可用：{e}"))?;
    if !canonical.starts_with(&base) {
        return Err("插件数据目录越界".into());
    }
    Ok(canonical)
}

/// 相对路径 → 绝对路径：只允许普通路径段，任何 `..` / 绝对路径 / 反斜杠一律拒绝
fn plugin_fs_path(app: &AppHandle, dir_name: &str, rel_path: &str) -> Result<PathBuf, String> {
    let root = plugin_data_root(app, dir_name)?;
    let rel = rel_path.trim().replace('\\', "/");
    if rel.is_empty() {
        return Ok(root);
    }
    let path = Path::new(&rel);
    if path.is_absolute()
        || rel.len() > 512
        || !path
            .components()
            .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(format!("非法的插件文件路径：「{rel_path}」"));
    }
    Ok(root.join(path))
}

/// 文件条目（目录列表用）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginFsEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
}

/// 数据目录的绝对路径（插件想展示给用户时用）
#[tauri::command]
pub fn plugin_fs_root(app: AppHandle, dir_name: String) -> Result<String, String> {
    ensure_plugin_permission(&dir_name, "fs.read_write")?;
    Ok(plugin_data_root(&app, &dir_name)?
        .to_string_lossy()
        .into_owned())
}

/// 列目录（按名字排序，默认根目录）
#[tauri::command]
pub fn plugin_fs_list(
    app: AppHandle,
    dir_name: String,
    rel_dir: Option<String>,
) -> Result<Vec<PluginFsEntry>, String> {
    ensure_plugin_permission(&dir_name, "fs.read_write")?;
    let dir = plugin_fs_path(&app, &dir_name, rel_dir.as_deref().unwrap_or(""))?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
        let meta = match entry.metadata() {
            Ok(meta) => meta,
            Err(_) => continue,
        };
        out.push(PluginFsEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(out)
}

/// 读文本文件（UTF-8，超过上限报错）
#[tauri::command]
pub fn plugin_fs_read(app: AppHandle, dir_name: String, rel_path: String) -> Result<String, String> {
    ensure_plugin_permission(&dir_name, "fs.read_write")?;
    let path = plugin_fs_path(&app, &dir_name, &rel_path)?;
    if !path.is_file() {
        return Err(format!("文件不存在：{rel_path}"));
    }
    let size = std::fs::metadata(&path)
        .map_err(|e| format!("读取文件失败：{e}"))?
        .len();
    if size > PLUGIN_FS_MAX_BYTES {
        return Err(format!(
            "文件过大：{size} 字节（上限 {PLUGIN_FS_MAX_BYTES} 字节）"
        ));
    }
    std::fs::read_to_string(&path).map_err(|e| format!("读取文件失败：{e}"))
}

/// 写文本文件（自动创建父目录），返回写入字节数
#[tauri::command]
pub fn plugin_fs_write(
    app: AppHandle,
    dir_name: String,
    rel_path: String,
    content: String,
) -> Result<u64, String> {
    ensure_plugin_permission(&dir_name, "fs.read_write")?;
    let path = plugin_fs_path(&app, &dir_name, &rel_path)?;
    if path == plugin_data_root(&app, &dir_name)? {
        return Err("要写文件，不是目录".into());
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if PLUGIN_FS_BLOCKED_EXT.contains(&ext.as_str()) {
        return Err(format!("不允许写入 .{ext} 文件（插件数据目录不放可执行文件）"));
    }
    let bytes = content.as_bytes();
    if bytes.len() as u64 > PLUGIN_FS_MAX_BYTES {
        return Err(format!(
            "内容过大：{} 字节（上限 {PLUGIN_FS_MAX_BYTES} 字节）",
            bytes.len()
        ));
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(bytes.len() as u64)
}

/// 删除文件或空目录
#[tauri::command]
pub fn plugin_fs_remove(app: AppHandle, dir_name: String, rel_path: String) -> Result<(), String> {
    ensure_plugin_permission(&dir_name, "fs.read_write")?;
    let path = plugin_fs_path(&app, &dir_name, &rel_path)?;
    if path == plugin_data_root(&app, &dir_name)? {
        return Err("不能删除插件数据目录本身".into());
    }
    if path.is_dir() {
        std::fs::remove_dir(&path).map_err(|e| format!("删除目录失败（需先清空）：{e}"))
    } else if path.is_file() {
        std::fs::remove_file(&path).map_err(|e| format!("删除文件失败：{e}"))
    } else {
        Ok(())
    }
}

/* ---------------- 插件联网（ctx.net） ----------------
 * 不放宽 CSP 的 connect-src，改由 Rust 代发：插件声明 net.fetch 权限 +
 * manifest.netDomains 白名单，宿主只替它访问白名单内的主机。
 */

/// 响应体上限：结果要过 IPC 进前端，别让一个下载把内存吃光
const PLUGIN_NET_MAX_BODY: usize = 1024 * 1024;

/// 联网请求（GET / POST），返回 { status, body }
#[tauri::command]
pub async fn plugin_net_fetch(
    app: AppHandle,
    dir_name: String,
    url: String,
    method: Option<String>,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
) -> Result<Value, String> {
    let plugin_dir = ensure_plugin_permission(&dir_name, "net.fetch")?;
    let manifest = load_installed_manifest(&plugin_dir)?;
    let parsed = reqwest::Url::parse(url.trim()).map_err(|e| format!("URL 不合法：{e}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 http / https".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL 缺少主机名".to_string())?
        .to_ascii_lowercase();
    let allowed = manifest.net_domains.iter().any(|raw| {
        let rule = raw.trim().trim_start_matches('.').to_ascii_lowercase();
        !rule.is_empty() && (host == rule || host.ends_with(&format!(".{rule}")))
    });
    if !allowed {
        return Err(format!(
            "这个插件没有联网到 {host} 的权限（在 plugin.json 的 netDomains 里声明）"
        ));
    }

    let method = method.unwrap_or_else(|| "GET".into()).to_uppercase();
    if method != "GET" && method != "POST" {
        return Err("只支持 GET / POST".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| format!("创建请求失败：{e}"))?;
    let mut request = client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::GET),
        parsed,
    );
    for (key, value) in headers.unwrap_or_default() {
        request = request.header(key, value);
    }
    if let Some(body) = body {
        request = request.body(body);
    }
    let response = request.send().await.map_err(|e| format!("请求失败：{e}"))?;
    let status = response.status().as_u16();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    let (text, truncated) = if text.len() > PLUGIN_NET_MAX_BODY {
        (text.chars().take(PLUGIN_NET_MAX_BODY).collect::<String>(), true)
    } else {
        (text, false)
    };
    let _ = app;
    Ok(serde_json::json!({ "status": status, "body": text, "truncated": truncated }))
}
