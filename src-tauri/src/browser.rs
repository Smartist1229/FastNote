//! 内置浏览器：一个带工具栏的独立窗口，可显示网页，并可按需注入浏览器指纹。
//!
//! 窗口结构是一个原生窗口 + 两个 WebView（Tauri 多 WebView，需 `unstable` 特性）：
//! - 工具栏（label 以 `-toolbar` 结尾）：加载本地的 `browser-toolbar.html`，提供后退 /
//!   前进 / 刷新 / 地址栏 / 加载进度条，通过命令控制同窗口的网页 WebView；
//! - 网页（label 以 `-content` 结尾）：加载真实网址，只显示网页内容，并注入
//!   `browser_link_script.js` 把 `target="_blank"` / `window.open` 改成同窗口导航。
//!
//! 窗口数量由设置 `app.config.general.browserMultiWindow` 决定：关闭（默认）时复用同一个
//! 窗口，每次打开链接只是导航它；开启时每次打开链接都新建一个窗口。
//!
//! 指纹按窗口分配：新窗口在创建时取一份 `BrowserFingerprint`（默认随机，可在设置里关闭），
//! 同时写进 WebView2 的内核身份和初始化脚本——只改脚本会让「请求头 UA / UA-CH」与
//! 「JS 里的 UA」对不上，指纹检测一眼就能看出是伪造的。指纹跟着窗口走，同一个窗口内
//! 跳转不换身份，要换身份先关掉窗口。
//!
//! 网页触发的下载不用内核自带的下载：`on_download` 取消后交给 `download` 模块重新拉取，
//! 复用窗口指纹，并带上浏览器现场的 Cookie / Referer；分片放在 `download/<文件名>/`
//! 暂存目录（与工具箱一致），完成后合并回下载根目录。进度写进窗口状态，由工具栏的
//! 下载气泡显示：点下载按钮弹出面板，逐条列出进度，可暂停 / 继续 / 取消，完成后可以在
//! 文件夹中定位；窗口关闭时该窗口未完成的任务会一并取消。
//! `blob:` / `data:` 这类只有内核能保存的地址仍走原生下载。
//!
//! **面板是一个独立的小弹窗**：工具栏固定 44px，点下载按钮时由 [`browser_toolbar_panel`]
//! 在浏览器窗口右上角（工具栏下方）显示一个无边框、透明的子窗口，里面只放下载卡片。
//! 网页 WebView 的尺寸完全不动，所以面板是真的浮在网页上（与正常浏览器的下载气泡一致）；
//! 浏览器窗口移动 / 缩放时面板跟着走，切到别的窗口时收起。
//!
//! 面板窗口懒创建（第一次展开时才建），懒创建和 `add_child` 都必须在非主线程执行，
//! 因此 [`browser_toolbar_panel`] 是 `async` 命令。
//!
//! **身份写在内核里，不写在页面里**：Windows 的 WebView2 就是 Edge 的内核（Chromium），
//! 软件内打开网页本来就走它，不存在「另外启动一个 Edge 浏览器」。能换掉的是它自带的
//! Edge 品牌身份：CDP `Network.setUserAgentOverride` 负责 UA / UA-CH 元数据 /
//! `Accept-Language`，`WebResourceRequested` 再逐个请求覆盖 `User-Agent`、
//! `Sec-CH-UA*` 等请求头——WebView2 生成的 UA-CH 品牌并不总跟着 CDP 走，只靠 CDP
//! 会让请求头与页面里读到的 UA 对不上，指纹检测一看就知道是伪造的。
//!
//! 指纹里的操作系统固定为本机系统：字体、显卡、屏幕缩放都来自真实系统，
//! 声明成别的系统会对不上（「UA 说 macOS，字体却全是 Segoe UI」）。随机的是同一系统
//! 内的屏幕、显卡型号、平台版本等。
//!
//! 边界：不模拟 TLS / HTTP2 握手指纹，不改 WebRTC 暴露的公网 IP，也不改内核的真实
//! 渲染特征（WebGPU 适配器、Canvas / Audio 的实际输出仍会被检测方比对）；所有窗口共用
//! 同一个 WebView2 数据目录，Cookie 与 localStorage 互通；网页内 JS 的深度检测无法保证
//! 完全隐身。
//!
//! **线程约束**：`#[tauri::command]` 的同步函数默认在**主线程**执行，而创建窗口
//! （`WindowBuilder::build` / `Window::add_child`）会把任务派发给事件循环并阻塞
//! 等待结果——在主线程里等主线程会立刻死锁（表现为窗口不出现、整个软件点不动）。
//! 所以创建浏览器窗口的命令必须是 `async fn`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue, COOKIE, REFERER};
use serde::Serialize;
use serde_json::Value;
use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position,
    Rect, Size, Url, Webview, WebviewBuilder, WebviewUrl, Window, WindowBuilder, WindowEvent,
};

#[cfg(windows)]
use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
#[cfg(windows)]
use webview2_com::{CallDevToolsProtocolMethodCompletedHandler, WebResourceRequestedEventHandler};
#[cfg(windows)]
use windows::core::HSTRING;

use crate::download::Control;
use crate::fingerprint::BrowserFingerprint;

/// 单窗口模式的固定 label
const BROWSER_LABEL: &str = "inapp-browser";
/// 多窗口模式的 label 前缀：`inapp-browser-1`、`inapp-browser-2` …
const BROWSER_LABEL_PREFIX: &str = "inapp-browser-";
/// 是否允许同时打开多个浏览器窗口（默认关闭 = 复用同一个窗口）
const MULTI_WINDOW_SETTING: &str = "app.config.general.browserMultiWindow";
/// 新浏览器窗口是否分配随机指纹（默认开启 = 每个窗口身份不同）
const RANDOM_FINGERPRINT_SETTING: &str = "app.config.general.browserRandomFingerprint";
/// 指纹脚本模板：`__FASTNOTE_FINGERPRINT__` 在注入前替换成指纹 JSON
const FINGERPRINT_SCRIPT: &str = include_str!("browser_script.js");
/// 链接拦截脚本：把 target="_blank" / window.open 改成本窗口导航
const LINK_SCRIPT: &str = include_str!("browser_link_script.js");
/// 网页 WebView 独立的 WebView2 数据目录（放在软件的数据目录下）
const BROWSER_PROFILE_DIR: &str = "inapp-browser-profile";
/// 工具栏 WebView 的独立数据目录
const TOOLBAR_PROFILE_DIR: &str = "inapp-browser-toolbar-profile";
/// 工具栏高度（逻辑像素），必须与 public/browser-toolbar.css 里的 --bar-height 一致
const TOOLBAR_HEIGHT: f64 = 44.0;
/// 下载面板窗口：浮在网页上的小弹窗，宽度固定，高度按条目数算
const PANEL_WIDTH: f64 = 360.0;
const PANEL_MIN_HEIGHT: f64 = 96.0;
const PANEL_MAX_HEIGHT: f64 = 420.0;
/// 面板与窗口右边缘、工具栏下沿的间距（逻辑像素）
const PANEL_MARGIN: f64 = 2.0;
/// 卡片四周留出的透明边距（逻辑像素）：窗口是透明的，留出这一圈阴影才有地方画
const PANEL_SHADOW_PAD: f64 = 10.0;
/// 面板窗口 / WebView 的 label 后缀（完整 label = 浏览器窗口 label + 它）
const PANEL_SUFFIX: &str = "-download-panel";
/// 面板 WebView 的独立数据目录（WebView2 要求共用目录的环境选项完全一致）
const PANEL_PROFILE_DIR: &str = "inapp-browser-panel-profile";
/// 一个窗口最多保留的下载记录条数，超出时优先丢掉最早结束的
const MAX_DOWNLOADS: usize = 8;
/// 网页 WebView 的 label 后缀
const CONTENT_SUFFIX: &str = "-content";
/// 工具栏 WebView 的 label 后缀
const TOOLBAR_SUFFIX: &str = "-toolbar";

/// 一个下载任务的进度快照：工具栏轮询 [`browser_toolbar_state`] 时一起读到。
#[derive(Clone, Serialize)]
pub struct DownloadView {
    pub id: u64,
    pub filename: String,
    pub path: String,
    pub downloaded: u64,
    pub total: u64,
    pub parallel: usize,
    /// 各分片测速之和（字节/秒）
    pub speed: f64,
    /// start / progress / paused / done / error
    pub state: &'static str,
    pub error: Option<String>,
}

/// 工具栏轮询所需的页面状态
#[derive(Clone, Default, Serialize)]
pub struct BrowserState {
    url: String,
    loading: bool,
    /// 该窗口最近的下载任务；结束后仍保留在列表里，由用户手动移除
    downloads: Vec<DownloadView>,
    /// 下载面板是否展开（工具栏据此画按钮上的展开箭头）
    panel_open: bool,
}

/// 任务是否还在进行中：进行中的条目不能被清掉，否则界面就看不到进度了
fn is_active(state: &str) -> bool {
    matches!(state, "start" | "progress" | "paused")
}

/// 每个网页 WebView 的加载状态（key = 网页 WebView 的 label）。
/// 工具栏是独立 WebView、不随页面刷新，所以状态放进程内共享，由工具栏轮询读取。
fn states() -> &'static Mutex<HashMap<String, BrowserState>> {
    static STATES: OnceLock<Mutex<HashMap<String, BrowserState>>> = OnceLock::new();
    STATES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_state(label: &str, url: String, loading: bool) {
    if let Ok(mut map) = states().lock() {
        let state = map.entry(label.to_string()).or_default();
        state.url = url;
        state.loading = loading;
    }
}

fn state_of(label: &str) -> BrowserState {
    states()
        .lock()
        .ok()
        .and_then(|map| map.get(label).cloned())
        .unwrap_or_default()
}

/// 新增或更新一个下载任务；同一个 id 原地替换，不同 id 追加。
fn update_download(label: &str, view: DownloadView) {
    if let Ok(mut map) = states().lock() {
        let state = map.entry(label.to_string()).or_default();
        if let Some(slot) = state.downloads.iter_mut().find(|item| item.id == view.id) {
            *slot = view;
            return;
        }
        state.downloads.push(view);
        // 记录会一直留在面板里，超过上限时丢掉最早结束的那条；全在进行中就都留着
        while state.downloads.len() > MAX_DOWNLOADS {
            let Some(index) = state.downloads.iter().position(|item| !is_active(item.state)) else {
                break;
            };
            state.downloads.remove(index);
        }
    }
}

/// 从该窗口的下载列表里移除一条记录（只用于已结束的任务）
fn forget_download(label: &str, id: u64) -> bool {
    if let Ok(mut map) = states().lock() {
        if let Some(state) = map.get_mut(label) {
            let before = state.downloads.len();
            state.downloads.retain(|item| item.id != id);
            return before != state.downloads.len();
        }
    }
    false
}

/// 下载任务 id：工具栏按它区分多个任务，完成清理时也按它定位。
fn next_download_id() -> u64 {
    static NEXT: AtomicU64 = AtomicU64::new(1);
    NEXT.fetch_add(1, Ordering::Relaxed)
}

/* ---------- 下载控制（工具栏的暂停 / 取消按钮） ---------- */

/// 正在进行的浏览器下载控制；任务结束后从表里移除。
fn download_controls() -> &'static Mutex<HashMap<u64, Control>> {
    static CONTROLS: OnceLock<Mutex<HashMap<u64, Control>>> = OnceLock::new();
    CONTROLS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn drop_download_control(id: u64) {
    if let Ok(mut map) = download_controls().lock() {
        map.remove(&id);
    }
}

/// 暂停 / 继续某个浏览器下载；任务已结束时返回 false。
/// 暂停只停传输，临时分片保留在 `download/<文件名>` 暂存目录里，继续后从原位置续传。
#[tauri::command]
pub async fn browser_download_pause(id: u64, paused: bool) -> Result<bool, String> {
    let map = download_controls()
        .lock()
        .map_err(|_| "下载控制锁被占用".to_string())?;
    match map.get(&id) {
        Some(control) => {
            control.set_paused(paused);
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 取消某个浏览器下载（会清理暂存目录）；任务已结束时返回 false。
#[tauri::command]
pub async fn browser_download_cancel(id: u64) -> Result<bool, String> {
    let map = download_controls()
        .lock()
        .map_err(|_| "下载控制锁被占用".to_string())?;
    match map.get(&id) {
        Some(control) => {
            control.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 移除一条已结束的下载记录；任务还在进行中时返回 false（不让界面和真实任务脱节）。
#[tauri::command]
pub async fn browser_download_forget(toolbar: Webview, id: u64) -> Result<bool, String> {
    let running = download_controls()
        .lock()
        .map(|map| map.contains_key(&id))
        .unwrap_or(false);
    if running {
        return Ok(false);
    }
    let label = content_label_of(&toolbar)?;
    Ok(forget_download(&label, id))
}

/// 清掉该窗口里所有已结束的下载记录（进行中的任务保留）。
#[tauri::command]
pub async fn browser_download_clear(toolbar: Webview) -> Result<(), String> {
    let active: Vec<u64> = download_controls()
        .lock()
        .map(|map| map.keys().copied().collect())
        .unwrap_or_default();
    let label = content_label_of(&toolbar)?;
    if let Ok(mut map) = states().lock() {
        if let Some(state) = map.get_mut(&label) {
            state
                .downloads
                .retain(|item| active.contains(&item.id));
        }
    }
    Ok(())
}

/// 面板窗口的 label：一个浏览器窗口配一个下载气泡
fn panel_label(window: &str) -> String {
    format!("{window}{PANEL_SUFFIX}")
}

fn panel_window(app: &AppHandle, window_label: &str) -> Option<Window> {
    app.get_window(&panel_label(window_label))
}

/// 展开 / 收起下载面板。
///
/// 面板是浏览器窗口下挂的一个无边框透明小窗口（懒创建），只盖住页面右上角一块，
/// 网页 WebView 的尺寸不动——不像把工具栏 WebView 加高那样让页面整体往下缩。
#[tauri::command]
pub async fn browser_toolbar_panel(toolbar: Webview, open: bool, height: f64) -> Result<(), String> {
    // 顺带校验调用方确实是浏览器的工具栏 / 面板 WebView
    let _content = content_label_of(&toolbar)?;
    let window = toolbar.window();
    if !open {
        if let Some(panel) = panel_window(window.app_handle(), window.label()) {
            let _ = panel.hide();
        }
        return Ok(());
    }
    let panel = ensure_panel_window(&window)?;
    place_panel(&window, &panel, height)?;
    panel.show().map_err(|e| format!("显示下载面板失败：{e}"))?;
    Ok(())
}

/// 懒创建面板窗口（第一次展开面板时才建）。必须跑在非主线程：
/// `WindowBuilder::build` / `add_child` 在主线程会等事件循环而死锁。
fn ensure_panel_window(parent: &Window) -> Result<Window, String> {
    let app = parent.app_handle();
    if let Some(panel) = panel_window(app, parent.label()) {
        return Ok(panel);
    }
    let label = panel_label(parent.label());
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let panel = WindowBuilder::new(app, &label)
        // 挂在浏览器窗口名下：跟着一起最小化 / 关闭，也不会出现在任务栏
        .parent(parent)
        .map_err(|e| format!("创建下载面板失败：{e}"))?
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .skip_taskbar(true)
        // 不抢焦点：点面板上的按钮时网页那边不会失焦
        .focusable(false)
        .transparent(true)
        .visible(false)
        .inner_size(PANEL_WIDTH, PANEL_MIN_HEIGHT)
        .build()
        .map_err(|e| format!("创建下载面板失败：{e}"))?;
    panel
        .add_child(
            WebviewBuilder::new(
                &label,
                WebviewUrl::App("browser-toolbar.html?panel=1".into()),
            )
            // 独立数据目录：WebView2 要求共用目录的环境选项完全一致，混用会建不起来
            .data_directory(data_dir.join(PANEL_PROFILE_DIR))
            .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
            .transparent(true)
            .focused(false),
            LogicalPosition::new(0.0, 0.0),
            LogicalSize::new(PANEL_WIDTH, PANEL_MIN_HEIGHT),
        )
        .map_err(|e| format!("创建下载面板失败：{e}"))?;
    Ok(panel)
}

/// 把面板摆到浏览器窗口右上角、工具栏下方（贴右边缘）。
/// 窗口比卡片四周多出 [`PANEL_SHADOW_PAD`]，那一圈是透明的，用来画阴影。
fn place_panel(parent: &Window, panel: &Window, height: f64) -> Result<(), String> {
    let scale = parent.scale_factor().unwrap_or(1.0);
    let origin = parent
        .inner_position()
        .map_err(|e| format!("读取窗口位置失败：{e}"))?;
    let size = parent
        .inner_size()
        .map_err(|e| format!("读取窗口尺寸失败：{e}"))?;
    let margin = (PANEL_MARGIN * scale).round() as u32;
    let pad = (PANEL_SHADOW_PAD * scale).round().max(1.0) as u32;
    // 窗口被拖得很窄时卡片跟着变窄，但最小留 200 逻辑像素
    let min_width = (200.0 * scale).round().max(1.0) as u32;
    let max_card = size
        .width
        .saturating_sub(margin * 2)
        .saturating_sub(pad * 2)
        .max(min_width);
    let card = ((PANEL_WIDTH * scale).round() as u32).min(max_card);
    let card_height = (height.clamp(PANEL_MIN_HEIGHT, PANEL_MAX_HEIGHT) * scale)
        .round()
        .max(1.0) as u32;
    let width = card + pad * 2;
    let height = card_height + pad * 2;
    let x = origin.x + size.width as i32 - width as i32 - margin as i32;
    let y = origin.y + (TOOLBAR_HEIGHT * scale).round() as i32 + (4.0 * scale).round() as i32;
    panel
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| format!("移动下载面板失败：{e}"))?;
    panel
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| format!("调整下载面板尺寸失败：{e}"))?;
    // 子 WebView 不会自动铺满窗口，尺寸得跟着窗口走
    if let Some(webview) = panel.app_handle().get_webview(panel.label()) {
        let _ = webview.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, 0)),
            size: Size::Physical(PhysicalSize::new(width, height)),
        });
    }
    Ok(())
}

/// 浏览器窗口移动 / 缩放时，把已展开的面板挪到新的右上角。
fn sync_panel(parent: &Window) {
    let Some(panel) = panel_window(parent.app_handle(), parent.label()) else {
        return;
    };
    if !panel.is_visible().unwrap_or(false) {
        return;
    }
    // 最小化时窗口尺寸会变成 0，面板一起收起来
    let hidden = parent
        .inner_size()
        .map(|size| size.width == 0 || size.height == 0)
        .unwrap_or(true);
    if hidden {
        let _ = panel.hide();
        return;
    }
    let scale = parent.scale_factor().unwrap_or(1.0);
    let height = panel
        .inner_size()
        .ok()
        .map(|size| size.to_logical::<f64>(scale).height)
        .unwrap_or(PANEL_MIN_HEIGHT);
    let _ = place_panel(parent, &panel, height);
}

/// 浏览器窗口的「选窗口 + 分配 label + 创建」串行锁，避免并发打开时撞 label。
fn creation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

/// 在软件内的浏览器窗口里打开链接。
#[tauri::command]
pub async fn browser_open(
    app: AppHandle,
    url: String,
    fingerprint: Option<Value>,
) -> Result<(), String> {
    let target = normalize_url(&url)?;
    let multi_window = crate::read_setting_bool(&app, MULTI_WINDOW_SETTING, false);

    /*
     * 串行化「选窗口 / 分配 label / 创建窗口」：两个链接几乎同时打开时，
     * 都会看到「还没有浏览器窗口」并各自分配 label、创建窗口，轻则撞 label，
     * 重则留下没有网页 WebView 的半成品窗口。锁只在同步段持有，不跨 await。
     */
    let _guard = creation_lock()
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());

    // 单窗口模式复用任意已存在的浏览器窗口（包括多窗口模式留下的带序号窗口）
    if !multi_window {
        if let Some(window) = existing_browser_window(&app) {
            let content = content_of_window(&window)
                .ok_or_else(|| "浏览器窗口状态异常，请关闭窗口后重试".to_string())?;
            content
                .navigate(target.clone())
                .map_err(|e| format!("打开链接失败：{e}"))?;
            set_state(content.label(), target.to_string(), true);
            // show() 不会把最小化的窗口还原，必须显式 unminimize
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
            let _ = content.set_focus();
            return Ok(());
        }
    }

    let label = if multi_window || app.get_window(BROWSER_LABEL).is_some() {
        // 多窗口模式每开一个链接就新建；单窗口模式只有在固定 label 被占着却不完整时才换序号
        next_browser_label(&app)
    } else {
        BROWSER_LABEL.to_string()
    };
    create_browser_window(&app, &label, target, fingerprint)
        .map_err(|e| format!("打开浏览器窗口失败：{e}"))
}

/// 工具栏轮询：当前地址与是否正在加载。
///
/// 地址以网页 WebView 的真实 URL 为准：页面内跳转（hash、`pushState`、历史导航）
/// 不触发 `on_page_load`，只读缓存会让地址栏停在上一页。真实地址还是 `about:blank`
/// （装身份时的起始空白页）时才回退到缓存。
#[tauri::command]
pub async fn browser_toolbar_state(
    app: AppHandle,
    toolbar: Webview,
) -> Result<BrowserState, String> {
    let content_label = content_label_of(&toolbar)?;
    let mut state = state_of(&content_label);
    if let Some(content) = app.get_webview(&content_label) {
        if let Ok(url) = content.url() {
            let live = url.to_string();
            if live != "about:blank" {
                state.url = live;
            }
        }
    }
    // 面板窗口是否可见（工具栏据此画按钮上的展开箭头）
    let window_label = content_label
        .strip_suffix(CONTENT_SUFFIX)
        .unwrap_or(&content_label);
    state.panel_open = panel_window(&app, window_label)
        .and_then(|panel| panel.is_visible().ok())
        .unwrap_or(false);
    Ok(state)
}

/// 工具栏按钮：back / forward / reload。
#[tauri::command]
pub async fn browser_toolbar_action(
    app: AppHandle,
    toolbar: Webview,
    action: String,
) -> Result<(), String> {
    let content = content_of_toolbar(&app, &toolbar)?;
    match action.as_str() {
        "back" => history_navigate(&content, false),
        "forward" => history_navigate(&content, true),
        "reload" => content.reload().map_err(|e| format!("刷新失败：{e}")),
        other => return Err(format!("未知操作：{other}")),
    }?;
    let _ = content.set_focus();
    Ok(())
}

/// 后退 / 前进：Windows 上直接用 WebView2 的历史导航，
/// 其他平台退回页面脚本的 `history.back()` / `history.forward()`。
fn history_navigate(content: &Webview, forward: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        content
            .with_webview(move |platform| {
                // COM 调用必须落在主线程；with_webview 会把闭包派发过去
                unsafe {
                    if let Ok(core) = platform.controller().CoreWebView2() {
                        let _ = if forward { core.GoForward() } else { core.GoBack() };
                    }
                }
            })
            .map_err(|e| format!("历史导航失败：{e}"))
    }
    #[cfg(not(windows))]
    {
        content
            .eval(if forward {
                "history.forward()"
            } else {
                "history.back()"
            })
            .map_err(|e| format!("历史导航失败：{e}"))
    }
}

/// 地址栏回车：按 `browser_open` 同一套规则规范化地址后导航。
#[tauri::command]
pub async fn browser_toolbar_navigate(
    app: AppHandle,
    toolbar: Webview,
    url: String,
) -> Result<(), String> {
    let target = normalize_url(&url)?;
    let content = content_of_toolbar(&app, &toolbar)?;
    content
        .navigate(target.clone())
        .map_err(|e| format!("打开链接失败：{e}"))?;
    // 地址栏立即回显新地址，不必等页面真的开始加载
    set_state(content.label(), target.to_string(), true);
    let _ = content.set_focus();
    Ok(())
}

/// 创建浏览器窗口：原生窗口 + 工具栏 WebView + 网页 WebView。
fn create_browser_window(
    app: &AppHandle,
    label: &str,
    target: Url,
    fingerprint: Option<Value>,
) -> tauri::Result<()> {
    // 没显式指定指纹时按设置生成一份：窗口一建好身份就固定，复用它跳转不会换
    let mut fingerprint = fingerprint.or_else(|| {
        if crate::read_setting_bool(app, RANDOM_FINGERPRINT_SETTING, true) {
            serde_json::to_value(random_fingerprint()).ok()
        } else {
            None
        }
    });
    // 交给内核的身份参数：必须在第一次真实请求之前装好，否则首屏请求仍带真实 UA-CH。
    // 目前只有 Windows 的 WebView2 能装进内核，其他平台不装、直接导航。
    let identity = if cfg!(windows) {
        fingerprint.as_ref().and_then(native_identity)
    } else {
        None
    };
    let title = target.host_str().unwrap_or("浏览器").to_string();
    let window = WindowBuilder::new(app, label)
        .title(title)
        .inner_size(1200.0, 800.0)
        .min_inner_size(480.0, 320.0)
        .visible(false)
        .build()?;

    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?;
    let logical = size.to_logical::<f64>(scale);
    let content_height = (logical.height - TOOLBAR_HEIGHT).max(1.0);

    // 屏幕缩放比必须钉成真实值：`devicePixelRatio` 与内核原生的
    // `matchMedia("(resolution: …)")` 得对得上，随机值一比对就露馅
    if let Some(fingerprint) = fingerprint.as_mut() {
        pin_real_scale(fingerprint, scale);
    }

    // 下载请求必须复用窗口身份：另取一份随机指纹会让 UA / UA-CH 与窗口对不上，
    // 有些站点的下载链接会按 UA 校验会话。
    let download_headers = fingerprint
        .as_ref()
        .map(identity_headers)
        .unwrap_or_default();

    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let toolbar_label = format!("{label}{TOOLBAR_SUFFIX}");
    let content_label = format!("{label}{CONTENT_SUFFIX}");
    // 先写状态再建工具栏：工具栏一开始轮询就能拿到地址，避免地址栏空一下
    set_state(&content_label, target.to_string(), true);

    window.add_child(
        WebviewBuilder::new(toolbar_label, WebviewUrl::App("browser-toolbar.html".into()))
            /*
             * 独立数据目录：主窗口在 tauri.conf.json 里配了自定义 additionalBrowserArgs，
             * 而 WebView2 要求共用同一个 user data folder 的环境使用完全相同的选项，
             * 混用会导致环境创建失败（窗口闪一下就消失）。工具栏与网页各用独立目录。
             */
            .data_directory(data_dir.join(TOOLBAR_PROFILE_DIR))
            // 独立数据目录拿不到 tauri.conf 里的 additionalBrowserArgs，补同一组：
            // 否则窗口最小化久了渲染进程被降频，恢复后工具栏可能一片空白
            .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
            .focused(false),
        LogicalPosition::new(0.0, 0.0),
        LogicalSize::new(logical.width, TOOLBAR_HEIGHT),
    )?;

    /*
     * 要装身份时先停在空白页，等 CDP 命令装好再导航到真实地址；
     * 否则 webview 一创建就开始请求，首屏（往往正是带检测脚本的页面）
     * 拿到的是真实 UA-CH。
     */
    let start_url = if identity.is_some() {
        Url::parse("about:blank").expect("about:blank 是合法地址")
    } else {
        target.clone()
    };

    let mut content_builder = WebviewBuilder::new(
        content_label.clone(),
        WebviewUrl::External(start_url),
    )
    .data_directory(data_dir.join(BROWSER_PROFILE_DIR))
    // 同工具栏：独立数据目录要自己带这组参数，否则最小化久了网页会空白
    .additional_browser_args(crate::BACKGROUND_SAFE_WEBVIEW_ARGS)
    /*
     * 打开网页侧控制台：F12 / Ctrl+Shift+I 与右键菜单里的「检查」都由内核自己提供，
     * 页面脚本 preventDefault 也拦不住（快捷键在内核进程里处理）。
     * release 包默认是关的（wry 只在 debug 下默认开），这里显式开一次，
     * 免得以后有人改 Cargo.toml 的 devtools feature 时又静默丢掉。
     */
    .devtools(true)
    // 每个窗口都注入：不依赖指纹是否传入，否则 target="_blank" 链接会打不开
    .initialization_script(LINK_SCRIPT)
    /*
     * 页面里的 target="_blank" / window.open 链接：脚本负责绝大多数点击，这里是兜底
     * （中键、表单 target、脚本直接请求新窗口等）。在发起请求的这个窗口里导航。
     */
    .on_new_window({
        let app = app.clone();
        let label = content_label.clone();
        move |url, _features| {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.navigate(url.clone());
                set_state(&label, url.to_string(), true);
            }
            NewWindowResponse::Deny
        }
    })
    // 标题跟随网页，避免一直停在域名上
    .on_document_title_changed(|webview, title| {
        let title = title.trim();
        if !title.is_empty() {
            let _ = webview.window().set_title(title);
        }
    })
    // 加载状态给工具栏画进度条用
    .on_page_load(|webview, payload| {
        let url = payload.url().to_string();
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        // 装身份时先建的 about:blank 不是用户要去的地方，别让它盖掉地址栏
        if url == "about:blank" {
            // 但导航失败停在空白页时也要把加载状态收掉，否则进度条一直转
            if !loading {
                let cached = state_of(webview.label());
                set_state(webview.label(), cached.url, false);
            }
            return;
        }
        set_state(webview.label(), url, loading);
    })
    /*
     * 下载：取消内核下载，交给自带的 download 模块（分片多线程 + 进度）。
     * 内核的下载没有进度事件，也没法显示在工具栏里；blob:/data: 这类只有内核
     * 能保存的地址仍返回 true 交给原生下载。
     */
    .on_download({
        let app = app.clone();
        let headers = download_headers.clone();
        move |webview, event| match event {
            DownloadEvent::Requested { url, destination } => {
                if !matches!(url.scheme(), "http" | "https") {
                    return true;
                }
                let suggested = destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .map(str::to_string);
                start_browser_download(
                    app.clone(),
                    webview,
                    url.clone(),
                    suggested,
                    headers.clone(),
                );
                // false = 取消内核下载，改由 download 模块接管
                false
            }
            DownloadEvent::Finished { .. } => true,
            _ => true,
        }
    });
    if let Some(fingerprint) = fingerprint {
        // 原生 UA 与脚本里的 UA 必须同源：只改脚本会让请求头 UA 和 JS 读到的 UA 互相矛盾
        if let Some(user_agent) = fingerprint.get("user_agent").and_then(Value::as_str) {
            content_builder = content_builder.user_agent(user_agent);
        }
        content_builder = content_builder.initialization_script(fingerprint_script(&fingerprint));
    }

    let content = window.add_child(
        content_builder,
        LogicalPosition::new(0.0, TOOLBAR_HEIGHT),
        LogicalSize::new(logical.width, content_height),
    )?;

    if let Some(identity) = identity {
        // 装失败不拦着页面显示：只是网络层身份没换成功，页面里仍有 JS 兜底
        // 返回时 CDP 命令已经在内核里落地（或超时放弃），不必再睡固定时长
        install_native_identity(&content, identity);
        content.navigate(target.clone())?;
    }

    window.show()?;
    let _ = window.set_focus();
    let _ = content.set_focus();
    Ok(())
}

/// 接管一次网页下载。
///
/// 内核下载已经被取消（`on_download` 返回 false），这里用 [`crate::download`] 重新拉取：
/// 分片多线程、失败清理、进度写进窗口状态供工具栏轮询。Cookie 与 Referer 从网页
/// WebView 现场取出，登录态 / 防盗链都不会丢；身份头复用窗口指纹，不另起随机 UA。
fn start_browser_download(
    app: AppHandle,
    content: Webview,
    url: Url,
    suggested: Option<String>,
    headers: HeaderMap,
) {
    let label = content.label().to_string();
    let id = next_download_id();
    let control = Control::new();
    if let Ok(mut map) = download_controls().lock() {
        map.insert(id, control.clone());
    }

    tauri::async_runtime::spawn(async move {
        let dir = match crate::download::default_dir(&app) {
            Ok(dir) => dir,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename: crate::download::filename_from_url(url.as_str()),
                        path: String::new(),
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };

        let name = suggested
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| crate::download::filename_from_url(url.as_str()));
        let dest = crate::download::unique_dest(&dir, &name);
        let temp_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&name)
            .to_string();
        let filename = temp_name.clone();
        let path = dest.to_string_lossy().to_string();

        // 分片放 download/<文件名>/（与工具箱一致），最终文件仍落在下载根目录
        let staging = match crate::download::prepare_staging(
            &dir,
            &crate::download::staging_name(&temp_name),
        )
        .await
        {
            Ok(staging) => staging,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename,
                        path,
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };
        let temp_dest = staging.join(&temp_name);
        // 上次异常退出可能留下已合并完成的临时文件，先清掉，避免最终改名失败
        let _ = tokio::fs::remove_file(&temp_dest).await;

        // 浏览器会话头：登录态靠 Cookie，防盗链靠 Referer
        let mut extra = HeaderMap::new();
        if let Ok(cookies) = content.cookies_for_url(url.clone()) {
            let pairs = cookies
                .iter()
                .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                .collect::<Vec<_>>();
            if !pairs.is_empty() {
                if let Ok(value) = HeaderValue::from_str(&pairs.join("; ")) {
                    extra.insert(COOKIE, value);
                }
            }
        }
        if let Ok(page) = content.url() {
            if matches!(page.scheme(), "http" | "https") {
                if let Ok(value) = HeaderValue::from_str(page.as_str()) {
                    extra.insert(REFERER, value);
                }
            }
        }

        // 设置里关掉随机指纹时窗口用的是内核真实身份，这里没有可复用的头；
        // 退回下载模块自己的浏览器指纹，至少保证请求带一个正常的 UA。
        let client = match if headers.is_empty() {
            crate::download::client()
        } else {
            crate::download::client_with_headers(headers)
        } {
            Ok(client) => client,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename,
                        path,
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };

        update_download(
            &label,
            DownloadView {
                id,
                filename: filename.clone(),
                path: path.clone(),
                downloaded: 0,
                total: 0,
                parallel: 0,
                speed: 0.0,
                state: "start",
                error: None,
            },
        );

        let threads = crate::download::threads(&app);
        let last_done = AtomicU64::new(0);
        let last_total = AtomicU64::new(0);
        let report = |done: u64, total: u64, parallel: usize, active: &[crate::download::SegmentProgress]| {
            last_done.store(done, Ordering::Relaxed);
            last_total.store(total, Ordering::Relaxed);
            let speed = active.iter().map(|segment| segment.speed).sum();
            update_download(
                &label,
                DownloadView {
                    id,
                    filename: filename.clone(),
                    path: path.clone(),
                    downloaded: done,
                    total,
                    parallel,
                    speed,
                    state: "progress",
                    error: None,
                },
            );
        };

        /*
         * 暂停时 fetch 返回 PAUSED：分片留在暂存目录里，用户点「继续」后
         * 重新调用 fetch，从已有分段长度续传；取消才清理临时文件。
         */
        let mut size = None;
        loop {
            match crate::download::fetch(
                &client,
                url.as_str(),
                &temp_dest,
                threads,
                Some(&control),
                Some(&extra),
                &report,
            )
            .await
            {
                Ok(bytes) => {
                    size = Some(bytes);
                    break;
                }
                Err(error) => {
                    if control.is_cancelled() {
                        crate::download::cleanup(&temp_dest).await;
                        crate::download::remove_staging(&staging).await;
                        update_download(
                            &label,
                            cancelled_view(
                                id,
                                &filename,
                                &path,
                                last_done.load(Ordering::Relaxed),
                                last_total.load(Ordering::Relaxed),
                            ),
                        );
                        break;
                    }
                    // 按返回原因判断：用户暂停后马上点「继续」时，标记可能已经清掉，
                    // 但分片仍要留着重新接上，不能当失败清理
                    if control.is_paused() || error == crate::download::PAUSED {
                        // 用户已经点了「继续」时不再回写暂停状态，直接接着下载
                        if control.is_paused() {
                            update_download(
                                &label,
                                paused_view(
                                    id,
                                    &filename,
                                    &path,
                                    last_done.load(Ordering::Relaxed),
                                    last_total.load(Ordering::Relaxed),
                                ),
                            );
                        }
                        while control.is_paused() && !control.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        if control.is_cancelled() {
                            crate::download::cleanup(&temp_dest).await;
                            crate::download::remove_staging(&staging).await;
                            update_download(
                                &label,
                                cancelled_view(
                                    id,
                                    &filename,
                                    &path,
                                    last_done.load(Ordering::Relaxed),
                                    last_total.load(Ordering::Relaxed),
                                ),
                            );
                            break;
                        }
                        continue;
                    }
                    crate::download::cleanup(&temp_dest).await;
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: filename.clone(),
                            path: path.clone(),
                            downloaded: 0,
                            total: 0,
                            parallel: 0,
                            speed: 0.0,
                            state: "error",
                            error: Some(error),
                        },
                    );
                    break;
                }
            }
        }

        if let Some(size) = size {
            // 下载期间目标名可能被其他程序占用，落盘前再确认一次
            let final_dest = crate::download::unique_dest(&dir, &temp_name);
            let final_filename = final_dest
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&temp_name)
                .to_string();
            let final_path = final_dest.to_string_lossy().to_string();
            match tokio::fs::rename(&temp_dest, &final_dest).await {
                Ok(()) => {
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: final_filename,
                            path: final_path,
                            downloaded: size,
                            total: size,
                            parallel: 1,
                            speed: 0.0,
                            state: "done",
                            error: None,
                        },
                    );
                }
                Err(error) => {
                    crate::download::cleanup(&temp_dest).await;
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: final_filename,
                            path: final_path,
                            downloaded: 0,
                            total: 0,
                            parallel: 0,
                            speed: 0.0,
                            state: "error",
                            error: Some(format!("保存文件失败：{error}")),
                        },
                    );
                }
            }
        }

        drop_download_control(id);
    });
}

/// 暂停中的任务快照：保留已下载字节数，进度条停在原地
fn paused_view(id: u64, filename: &str, path: &str, downloaded: u64, total: u64) -> DownloadView {
    DownloadView {
        id,
        filename: filename.to_string(),
        path: path.to_string(),
        downloaded,
        total,
        parallel: 0,
        speed: 0.0,
        state: "paused",
        error: None,
    }
}

fn cancelled_view(id: u64, filename: &str, path: &str, downloaded: u64, total: u64) -> DownloadView {
    DownloadView {
        id,
        filename: filename.to_string(),
        path: path.to_string(),
        downloaded,
        total,
        parallel: 0,
        speed: 0.0,
        state: "cancelled",
        error: None,
    }
}

/// 窗口尺寸变化时同步两个子 WebView 的边界（工具栏固定高度，网页占满剩余区域）。
/// 窗口销毁时清掉它的状态缓存，避免序号窗口反复开关后残留旧地址。
pub(crate) fn handle_window_event(window: &Window, event: &WindowEvent) {
    if !is_browser_window(window.label()) {
        return;
    }
    match event {
        WindowEvent::Destroyed => {
            let content_label = format!("{}{CONTENT_SUFFIX}", window.label());
            let ids = if let Ok(mut map) = states().lock() {
                map.remove(&content_label)
                    .map(|state| state.downloads.into_iter().map(|item| item.id).collect::<Vec<_>>())
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            // 窗口关了就没有界面能暂停 / 取消：把该窗口的任务全部取消并清理暂存目录
            if let Ok(mut controls) = download_controls().lock() {
                for id in ids {
                    if let Some(control) = controls.remove(&id) {
                        control.cancel();
                    }
                }
            }
            // 下载气泡是挂在浏览器窗口下的小窗口，一起关掉
            if let Some(panel) = panel_window(window.app_handle(), window.label()) {
                let _ = panel.close();
            }
        }
        WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            sync_layout(window);
            sync_panel(window);
        }
        WindowEvent::Moved(_) => sync_panel(window),
        _ => {}
    }
}

fn sync_layout(window: &Window) {
    let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) else {
        return;
    };
    // 最小化时窗口尺寸可能是 0，WebView2 不接受 0 尺寸，至少留 1px
    let toolbar_px = ((TOOLBAR_HEIGHT * scale).round() as u32).max(1);
    let width = size.width.max(1);
    let content_height = size.height.saturating_sub(toolbar_px).max(1);
    let app = window.app_handle();

    if let Some(toolbar) = app.get_webview(&format!("{}{TOOLBAR_SUFFIX}", window.label())) {
        let _ = toolbar.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, 0)),
            size: Size::Physical(PhysicalSize::new(width, toolbar_px)),
        });
    }
    if let Some(content) = app.get_webview(&format!("{}{CONTENT_SUFFIX}", window.label())) {
        let _ = content.set_bounds(Rect {
            position: Position::Physical(PhysicalPosition::new(0, toolbar_px as i32)),
            size: Size::Physical(PhysicalSize::new(width, content_height)),
        });
    }
}

fn is_browser_window(label: &str) -> bool {
    // 下载面板也是挂在浏览器窗口下的小窗，走同一套窗口事件，但不能当成浏览器窗口本身
    !label.ends_with(PANEL_SUFFIX)
        && (label == BROWSER_LABEL || label.starts_with(BROWSER_LABEL_PREFIX))
}

/// 找任意一个可用的浏览器窗口：先找单窗口模式的固定 label，
/// 再找多窗口模式留下的带序号窗口；没有网页 WebView 的（正在关闭）跳过。
fn existing_browser_window(app: &AppHandle) -> Option<Window> {
    let fixed = app.get_window(BROWSER_LABEL);
    let numbered = app
        .windows()
        .into_iter()
        .filter(|(label, _)| label.starts_with(BROWSER_LABEL_PREFIX))
        .map(|(_, window)| window);
    fixed
        .into_iter()
        .chain(numbered)
        .find(|window| content_of_window(window).is_some())
}

/// 分配一个当前没被占用的窗口 label（窗口关掉后序号会被重新使用）
fn next_browser_label(app: &AppHandle) -> String {
    let existing = app.windows();
    let mut n = 1;
    loop {
        let label = format!("{BROWSER_LABEL_PREFIX}{n}");
        if !existing.contains_key(&label) {
            return label;
        }
        n += 1;
    }
}

/// 窗口里的网页 WebView
fn content_of_window(window: &Window) -> Option<Webview> {
    window
        .app_handle()
        .get_webview(&format!("{}{CONTENT_SUFFIX}", window.label()))
}

/// 工具栏 / 下载面板 WebView 对应的网页 WebView label
fn content_label_of(webview: &Webview) -> Result<String, String> {
    let label = webview.label();
    label
        .strip_suffix(TOOLBAR_SUFFIX)
        .or_else(|| label.strip_suffix(PANEL_SUFFIX))
        .map(|window| format!("{window}{CONTENT_SUFFIX}"))
        .ok_or_else(|| "不是浏览器工具栏窗口".to_string())
}

fn content_of_toolbar(app: &AppHandle, toolbar: &Webview) -> Result<Webview, String> {
    let label = content_label_of(toolbar)?;
    app.get_webview(&label)
        .ok_or_else(|| "浏览器窗口已关闭".to_string())
}

/// 生成一份随机指纹（JSON），可直接作为 `browser_open` 的 `fingerprint` 参数。
#[tauri::command]
pub fn browser_random_fingerprint() -> Result<Value, String> {
    serde_json::to_value(random_fingerprint()).map_err(|e| e.to_string())
}

/// 新窗口的身份：Chrome 版本跟运行中的内核对齐，其余字段随机。
///
/// 页面能按 API 探测出引擎真实版本（Chromium vXXX），UA 里声明得比它旧 / 新都会被判
/// 「内核版本特性与 UA 不一致」，所以版本不能从固定表里抽。
fn random_fingerprint() -> BrowserFingerprint {
    #[cfg(windows)]
    if let Some((major, full)) = engine_version() {
        return BrowserFingerprint::for_browser(&major, &full);
    }
    BrowserFingerprint::random()
}

/// 运行中的 WebView2 内核版本，形如 `156.0.3456.78`；取一次缓存住。
#[cfg(windows)]
fn engine_version() -> Option<(String, String)> {
    use windows::core::PCWSTR;
    static CACHE: OnceLock<Option<(String, String)>> = OnceLock::new();
    CACHE
        .get_or_init(|| unsafe {
            let mut raw = windows::core::PWSTR::null();
            webview2_com::Microsoft::Web::WebView2::Win32::GetAvailableCoreWebView2BrowserVersionString(
                PCWSTR::null(),
                &mut raw,
            )
            .ok()?;
            parse_engine_version(&webview2_com::take_pwstr(raw))
        })
        .clone()
}

/// `156.0.3456.78` → (`156`, `156.0.3456.78`)；带后缀的版本串只取第一段。
fn parse_engine_version(raw: &str) -> Option<(String, String)> {
    let version = raw.split_whitespace().next()?;
    let parts = version.split('.').collect::<Vec<_>>();
    let numeric = parts.len() >= 2
        && parts
            .iter()
            .all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    numeric.then(|| (parts[0].to_string(), version.to_string()))
}

/// 把指纹里的缩放比钉成窗口的真实缩放比。
///
/// `devicePixelRatio` 会被拿来和原生 `matchMedia("(resolution: …)")`、
/// 屏幕 CSS 像素换算互相比对；随机值必然对不上真实缩放，直接改成真实值。
fn pin_real_scale(fingerprint: &mut Value, scale: f64) {
    let Some(fingerprint) = fingerprint.as_object_mut() else {
        return;
    };
    let ratio = serde_json::json!(scale);
    for section in ["screen", "window"] {
        if let Some(inner) = fingerprint.get_mut(section).and_then(Value::as_object_mut) {
            inner.insert("device_pixel_ratio".to_string(), ratio.clone());
        }
    }
}

/// 把指纹灌进初始化脚本。
///
/// 脚本要多替换一次 Worker 插槽：Worker 线程里先跑同一份脚本，Worker 才能读到与主线程
/// 一致的 platform / languages / 时区。Worker 里那份还带最内层脚本，因此 Worker 里再建
/// 的嵌套 Worker 也能注入；最内层不再往后嵌套，避免脚本无限套娃。
fn fingerprint_script(fingerprint: &Value) -> String {
    let payload = serde_json::to_string(fingerprint).unwrap_or_else(|_| "null".to_string());
    let with_payload = FINGERPRINT_SCRIPT.replace("__FASTNOTE_FINGERPRINT__", &payload);
    // 最内层：Worker 里的 Worker 不再包装，递归到此为止
    let leaf = with_payload.replace("__FASTNOTE_WORKER_SCRIPT__", "null");
    // 中间层：Worker 里预载 leaf，所以嵌套 Worker 也能被包装
    let worker = with_payload.replace(
        "__FASTNOTE_WORKER_SCRIPT__",
        &serde_json::to_string(&leaf).unwrap_or_else(|_| "null".to_string()),
    );
    // JSON 字符串字面量在 JS 里同样合法（转义规则一致）
    let worker_literal = serde_json::to_string(&worker).unwrap_or_else(|_| "null".to_string());
    with_payload.replace("__FASTNOTE_WORKER_SCRIPT__", &worker_literal)
}

/// 一份要装进内核的浏览器身份。
///
/// 两条腿都要有：CDP 命令让内核按伪造身份生成 UA-CH、返回原生的 `navigator.userAgentData`；
/// 请求头再逐条兜底——不同 WebView2 版本对 `Network.setUserAgentOverride` 的 UA-CH
/// 支持并不一致，实测仍会带出真实的 Edge 品牌，检测方拿请求头与 JS 里的 UA 一比就露馅。
struct NativeIdentity {
    commands: Vec<(String, String)>,
    headers: Vec<(String, String)>,
}

fn native_identity(fingerprint: &Value) -> Option<NativeIdentity> {
    Some(NativeIdentity {
        commands: identity_override_commands(fingerprint)?,
        headers: request_headers(fingerprint),
    })
}

/// 把指纹翻译成 CDP 命令（方法名 + 参数 JSON）。
///
/// 用 `Network.setUserAgentOverride` 而不是只改 UA 字符串：内核会按 `userAgentMetadata`
/// 自己生成 `Sec-CH-UA` / `Sec-CH-UA-Platform` / `Sec-CH-UA-Full-Version-List` 等请求头，
/// `navigator.userAgentData` 与 `navigator.language(s)` 也由内核原生返回，
/// 与页面读到的 UA 一致。
///
/// 注意 `acceptLanguage` 只能给语言标签（`zh-CN,zh,en`），不能给带 q 值的请求头格式：
/// 内核把这一整串按逗号拆进 `navigator.languages`，`zh;q=0.9` 会原样留在数组里，
/// 检测脚本一看就知道是伪造的。请求头由 `WebResourceRequested` 另行写成带 q 值的格式。
fn identity_override_commands(fingerprint: &Value) -> Option<Vec<(String, String)>> {
    let user_agent = fingerprint.get("user_agent")?.as_str()?;

    let mut params = serde_json::Map::new();
    params.insert(
        "userAgent".to_string(),
        Value::String(user_agent.to_string()),
    );
    let brands = brand_list(fingerprint.get("brands"));
    if brands.as_array().is_some_and(|items| !items.is_empty()) {
        let mut metadata = serde_json::Map::new();
        metadata.insert("brands".to_string(), brands);
        metadata.insert(
            "fullVersionList".to_string(),
            brand_list(fingerprint.get("full_version_list")),
        );
        for (key, field) in [
            ("fullVersion", "chrome_version"),
            ("platform", "ua_platform"),
            ("platformVersion", "ua_platform_version"),
            ("architecture", "ua_architecture"),
            ("model", "ua_model"),
            ("bitness", "ua_bitness"),
        ] {
            if let Some(value) = fingerprint.get(field) {
                metadata.insert(key.to_string(), value.clone());
            }
        }
        for (key, field) in [("mobile", "ua_mobile"), ("wow64", "ua_wow64")] {
            if let Some(value) = fingerprint.get(field).and_then(Value::as_bool) {
                metadata.insert(key.to_string(), Value::Bool(value));
            }
        }
        params.insert(
            "userAgentMetadata".to_string(),
            Value::Object(metadata),
        );
    }
    if let Some(platform) = fingerprint.get("platform") {
        params.insert("platform".to_string(), platform.clone());
    }
    if let Some(languages) = language_tags(fingerprint) {
        params.insert("acceptLanguage".to_string(), Value::String(languages));
    }

    let mut commands = vec![(
        "Network.setUserAgentOverride".to_string(),
        Value::Object(params).to_string(),
    )];
    // DNT 不在 UA 元数据里，单独当额外请求头发送
    if let Some(dnt) = fingerprint.get("do_not_track").and_then(Value::as_str) {
        commands.push((
            "Network.setExtraHTTPHeaders".to_string(),
            serde_json::json!({ "headers": { "DNT": dnt } }).to_string(),
        ));
    }
    Some(commands)
}

/// 每个请求都要改写的身份头（UA / UA-CH / Accept-Language / DNT）。
/// 值必须与初始化脚本里的 `navigator`、`userAgentData` 同源，否则检测方一对就露馅。
fn request_headers(fingerprint: &Value) -> Vec<(String, String)> {
    let mut headers: Vec<(String, String)> = Vec::new();
    let mut set = |name: &str, value: String| {
        if !value.is_empty() {
            headers.push((name.to_string(), value));
        }
    };

    if let Some(user_agent) = fingerprint.get("user_agent").and_then(Value::as_str) {
        set("User-Agent", user_agent.to_string());
    }
    if let Some(language) = accept_language(fingerprint) {
        set("Accept-Language", language);
    }
    if let Some(brands) = brands_header(fingerprint.get("brands")) {
        set("Sec-CH-UA", brands);
    }
    if let Some(full_versions) = brands_header(fingerprint.get("full_version_list")) {
        set("Sec-CH-UA-Full-Version-List", full_versions);
    }
    for (header, field) in [
        ("Sec-CH-UA-Platform", "ua_platform"),
        ("Sec-CH-UA-Platform-Version", "ua_platform_version"),
        ("Sec-CH-UA-Arch", "ua_architecture"),
        ("Sec-CH-UA-Bitness", "ua_bitness"),
        ("Sec-CH-UA-Model", "ua_model"),
    ] {
        if let Some(value) = quoted_field(fingerprint, field) {
            set(header, value);
        }
    }
    if let Some(full_version) = fingerprint.get("chrome_version").and_then(Value::as_str) {
        set("Sec-CH-UA-Full-Version", full_version.to_string());
    }
    for (header, field) in [("Sec-CH-UA-Mobile", "ua_mobile"), ("Sec-CH-UA-WoW64", "ua_wow64")] {
        if let Some(value) = fingerprint.get(field).and_then(Value::as_bool) {
            set(header, if value { "?1" } else { "?0" }.to_string());
        }
    }
    if let Some(factors) = fingerprint.get("ua_form_factors").and_then(Value::as_array) {
        let list = factors
            .iter()
            .filter_map(Value::as_str)
            .map(|factor| format!("\"{factor}\""))
            .collect::<Vec<_>>()
            .join(", ");
        set("Sec-CH-UA-Form-Factors", list);
    }
    if let Some(dnt) = fingerprint.get("do_not_track").and_then(Value::as_str) {
        set("DNT", dnt.to_string());
    }

    headers
}

/// 窗口指纹 → 下载客户端的默认请求头。
/// 直接复用 [`request_headers`]，下载请求与窗口内的请求因此是同一个 UA / UA-CH / 语言。
fn identity_headers(fingerprint: &Value) -> HeaderMap {
    let mut headers = HeaderMap::new();
    for (name, value) in request_headers(fingerprint) {
        let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(&value),
        ) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

/// `brands` / `full_version_list` → CDP 要的 `[{brand, version}]`
fn brand_list(value: Option<&Value>) -> Value {
    let items = value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(serde_json::json!({
                        "brand": item.get("brand")?.as_str()?,
                        "version": item.get("version")?.as_str()?,
                    }))
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Value::Array(items)
}

/// `brands` / `full_version_list` → `Sec-CH-UA` 头的值：`"Chromium";v="142", …`
fn brands_header(value: Option<&Value>) -> Option<String> {
    let items = value?.as_array()?;
    let parts = items
        .iter()
        .filter_map(|item| {
            Some(format!(
                "\"{}\";v=\"{}\"",
                item.get("brand")?.as_str()?,
                item.get("version")?.as_str()?
            ))
        })
        .collect::<Vec<_>>();
    (!parts.is_empty()).then(|| parts.join(", "))
}

/// UA-CH 的字符串值要求带引号（空字符串就是 `""`）
fn quoted_field(fingerprint: &Value, field: &str) -> Option<String> {
    let value = fingerprint.get(field)?.as_str()?;
    Some(format!("\"{value}\""))
}

/// CDP `acceptLanguage` 的值：只给语言标签（`zh-CN,zh,en`）。
///
/// 内核会把这一整串按逗号拆进 `navigator.languages`，`zh;q=0.9` 这种带 q 值的条目
/// 会原样留在数组里（`["zh-CN", "zh;q=0.9", "en;q=0.8"]`）——真实 Chrome 不会这样，
/// 指纹检测直接判「语言异常」。q 值只出现在请求头里，由 `request_headers` 负责。
fn language_tags(fingerprint: &Value) -> Option<String> {
    let languages = fingerprint.get("languages")?.as_array()?;
    let tags = languages
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>();
    (!tags.is_empty()).then(|| tags.join(","))
}

/// Accept-Language 头的值：第一条不带 q，其余按顺序递减
fn accept_language(fingerprint: &Value) -> Option<String> {
    let languages = fingerprint.get("languages")?.as_array()?;
    let values = languages
        .iter()
        .filter_map(Value::as_str)
        .enumerate()
        .map(|(index, language)| {
            if index == 0 {
                language.to_string()
            } else {
                format!("{language};q=0.{}", 10usize.saturating_sub(index).max(1))
            }
        })
        .collect::<Vec<_>>();
    (!values.is_empty()).then(|| values.join(","))
}

/// 浏览器对每个请求都会发的头：无条件改写
const ALWAYS_SENT_HEADERS: &[&str] = &[
    "User-Agent",
    "Accept-Language",
    "Sec-CH-UA",
    "Sec-CH-UA-Mobile",
    "Sec-CH-UA-Platform",
    "DNT",
];

/// 在网页 WebView 上装身份：CDP 命令 + 逐请求改写请求头。COM 调用必须落在主线程，
/// `with_webview` 负责派发。
///
/// CDP 命令是异步执行的：函数会等内核回完所有命令（最多 1 秒）再返回，调用方随后就能
/// 导航。等不到回调也不会卡住页面，只是首屏请求可能仍带真实 UA-CH。
#[cfg(windows)]
fn install_native_identity(content: &Webview, identity: NativeIdentity) {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    /// 一条命令落地（或失败）后计数；最后一条完成时通知等待线程
    fn release(pending: &AtomicUsize, done: &Mutex<mpsc::Sender<()>>) {
        if pending.fetch_sub(1, Ordering::SeqCst) == 1 {
            if let Ok(done) = done.lock() {
                let _ = done.send(());
            }
        }
    }

    let NativeIdentity { commands, headers } = identity;
    let total = commands.len();
    let (done, finished) = mpsc::channel::<()>();
    let pending = std::sync::Arc::new(AtomicUsize::new(total));
    let done = std::sync::Arc::new(Mutex::new(done));
    let groups = std::sync::Arc::new(
        headers
            .into_iter()
            .map(|(name, value)| {
                let always = ALWAYS_SENT_HEADERS.contains(&name.as_str());
                (HSTRING::from(name), HSTRING::from(value), always)
            })
            .collect::<Vec<_>>(),
    );

    let started = content.with_webview({
        let pending = pending.clone();
        let done = done.clone();
        move |platform| {
            let controller = platform.controller();
            unsafe {
                let Ok(core) = controller.CoreWebView2() else {
                    // 拿不到内核：命令不会执行，也就不会有回调，直接放行
                    for _ in 0..total {
                        release(&pending, &done);
                    }
                    return;
                };
                for (method, params) in commands {
                    let callback_pending = pending.clone();
                    let callback_done = done.clone();
                    let handler = CallDevToolsProtocolMethodCompletedHandler::create(Box::new(
                        move |_result, _message| {
                            release(&callback_pending, &callback_done);
                            Ok(())
                        },
                    ));
                    let called = core.CallDevToolsProtocolMethod(
                        &HSTRING::from(method),
                        &HSTRING::from(params),
                        &handler,
                    );
                    if called.is_err() {
                        // 没排进内核就不会有回调，自己把这一条记成完成
                        release(&pending, &done);
                    }
                }

                /*
                 * UA-CH 是内核按自己的品牌表拼的，CDP 改不掉（WebView2 仍报 Edge），
                 * 所以每个请求发出去之前再把身份头覆盖一遍。文档、脚本、XHR、Worker
                 * 的请求都会经过这里，页面读到的 UA 与请求头因此始终一致。
                 *
                 * 高熵客户端提示（架构 / 位数 / 完整版本等）只在请求本来就有的时候改：
                 * 网页没通过 Accept-CH 索要却收到一堆高熵值，是真实 Chrome 不会做的事。
                 */
                let request_handler = WebResourceRequestedEventHandler::create(Box::new(
                    move |_sender, args| {
                        if let Some(args) = args {
                            if let Ok(request) = args.Request() {
                                if let Ok(request_headers) = request.Headers() {
                                    for (name, value, always) in groups.iter() {
                                        if !always {
                                            let mut present = windows::core::BOOL(0);
                                            let exists = request_headers
                                                .Contains(name, &mut present)
                                                .is_ok()
                                                && present.as_bool();
                                            if !exists {
                                                continue;
                                            }
                                        }
                                        let _ = request_headers.SetHeader(name, value);
                                    }
                                }
                            }
                        }
                        Ok(())
                    },
                ));
                let _ = core.AddWebResourceRequestedFilter(
                    &HSTRING::from("*"),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                );
                let _ = core.add_WebResourceRequested(&request_handler, &mut 0i64);
            }
        }
    });

    if started.is_err() {
        // 闭包没派发出去：不会有回调，别在这里干等
        return;
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(1);
    while pending.load(Ordering::SeqCst) > 0 {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        if left.is_zero() || finished.recv_timeout(left).is_err() {
            break;
        }
    }
}

#[cfg(not(windows))]
fn install_native_identity(_content: &Webview, _identity: NativeIdentity) {}

/// 地址规范化：完整 URL 直接使用，裸域名补 https（本机地址补 http），搜索词走 Bing。
/// 非 http / https 的协议（mailto:、obsidian:、javascript: 等）一律拒绝，
/// 由调用方回退到系统浏览器。
fn normalize_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("链接为空".to_string());
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Url::parse(raw).map_err(|e| format!("地址无效：{e}"));
    }
    if let Some(scheme) = explicit_scheme(raw) {
        return Err(format!("不在软件内打开 {scheme}: 链接"));
    }
    let host_like = !raw.chars().any(char::is_whitespace)
        && (raw.contains('.')
            || lower.starts_with("localhost")
            || raw.starts_with("127.")
            || raw.starts_with("[::1]"));
    if host_like {
        /*
         * 本机地址用 http：localhost / 127.x / [::1] 的开发服务器默认没有 TLS，
         * 补成 https 会因证书或协议不匹配直接打不开。
         */
        let scheme = if is_loopback(raw) { "http" } else { "https" };
        return Url::parse(&format!("{scheme}://{}", raw))
            .map_err(|e| format!("地址无效：{e}"));
    }
    Url::parse(&format!(
        "https://www.bing.com/search?q={}",
        encode_query(raw)
    ))
    .map_err(|e| e.to_string())
}

/// 本机地址（`localhost` / `127.x` / `[::1]`）：这类开发服务器默认只监听 http。
fn is_loopback(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let host = lower.split(['/', '?', '#']).next().unwrap_or_default();
    host == "localhost"
        || host.starts_with("localhost:")
        || host.starts_with("127.")
        || host.starts_with("[::1]")
}

/// 提取「协议:」里的协议名；`host:port` 不算协议（端口是数字）。
fn explicit_scheme(raw: &str) -> Option<&str> {
    let (head, rest) = raw.split_once(':')?;
    if rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut chars = head.chars();
    if !chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if head.contains('.')
        || !head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-'))
    {
        return None;
    }
    Some(head)
}

fn encode_query(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_inputs_are_normalized() {
        assert_eq!(
            normalize_url("https://example.com/a").unwrap().as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            normalize_url("example.com/a").unwrap().as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            normalize_url("localhost:3000").unwrap().as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_url("127.0.0.1:8080/a").unwrap().as_str(),
            "http://127.0.0.1:8080/a"
        );
        assert_eq!(
            normalize_url("example.com:8080/a").unwrap().as_str(),
            "https://example.com:8080/a"
        );
        assert!(normalize_url("tauri://localhost").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn non_web_schemes_are_rejected() {
        assert!(normalize_url("mailto:me@example.com").is_err());
        assert!(normalize_url("obsidian://open?vault=x").is_err());
        assert!(normalize_url("file:///C:/a.txt").is_err());
    }

    #[test]
    fn search_terms_go_to_bing() {
        let url = normalize_url("指纹 浏览器").unwrap();
        assert_eq!(url.host_str(), Some("www.bing.com"));
        assert_eq!(
            url.query(),
            Some("q=%E6%8C%87%E7%BA%B9+%E6%B5%8F%E8%A7%88%E5%99%A8")
        );
    }

    #[test]
    fn fingerprint_scripts_embed_the_payload() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let user_agent = fingerprint["user_agent"].as_str().unwrap();
        let script = fingerprint_script(&fingerprint);
        assert!(!script.contains("__FASTNOTE_FINGERPRINT__"));
        assert!(!script.contains("__FASTNOTE_WORKER_SCRIPT__"));
        assert!(script.contains(user_agent));
        // Worker 预载脚本里也有同一份指纹，且不再嵌套包装 Worker
        assert!(script.contains("const WORKER_SOURCE = \""));
        assert!(script.contains("importScripts("));
    }

    #[test]
    fn identity_commands_carry_the_spoofed_identity() {
        let fingerprint = serde_json::json!({
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "chrome_version": "142.0.7444.175",
            "brands": [{ "brand": "Chromium", "version": "142" }],
            "full_version_list": [{ "brand": "Chromium", "version": "142.0.7444.175" }],
            "ua_platform": "Windows",
            "ua_platform_version": "19.0.0",
            "ua_architecture": "x86",
            "ua_bitness": "64",
            "ua_model": "",
            "ua_mobile": false,
            "ua_wow64": false,
            "platform": "Win32",
            "languages": ["zh-CN", "zh", "en"],
            "do_not_track": "1",
        });
        let commands = identity_override_commands(&fingerprint).unwrap();
        assert_eq!(commands[0].0, "Network.setUserAgentOverride");
        let params: Value = serde_json::from_str(&commands[0].1).unwrap();
        assert_eq!(params["userAgent"], fingerprint["user_agent"]);
        assert_eq!(params["platform"], "Win32");
        // 只能给标签：内核会把它拆进 navigator.languages，q 值留在数组里就是硬伤
        assert_eq!(params["acceptLanguage"], "zh-CN,zh,en");
        assert!(!params["acceptLanguage"].as_str().unwrap().contains(';'));
        assert_eq!(params["userAgentMetadata"]["brands"][0]["brand"], "Chromium");
        assert_eq!(
            params["userAgentMetadata"]["fullVersionList"][0]["version"],
            "142.0.7444.175"
        );
        assert_eq!(commands[1].0, "Network.setExtraHTTPHeaders");
        assert!(commands[1].1.contains("\"DNT\":\"1\""));
    }

    #[test]
    fn random_fingerprints_produce_identity_commands() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let commands = identity_override_commands(&fingerprint).unwrap();
        let params: Value = serde_json::from_str(&commands[0].1).unwrap();
        assert_eq!(params["userAgent"], fingerprint["user_agent"]);
        assert_eq!(params["userAgentMetadata"]["brands"], fingerprint["brands"]);
        assert_eq!(
            params["userAgentMetadata"]["fullVersionList"],
            fingerprint["full_version_list"]
        );
        assert!(params["acceptLanguage"]
            .as_str()
            .unwrap()
            .starts_with(fingerprint["languages"][0].as_str().unwrap()));
    }

    #[test]
    fn identity_commands_need_a_user_agent() {
        assert!(identity_override_commands(&serde_json::json!({})).is_none());
    }

    #[test]
    fn cdp_languages_are_bare_tags_but_the_header_keeps_quality_values() {
        for _ in 0..32 {
            let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
            let commands = identity_override_commands(&fingerprint).unwrap();
            let params: Value = serde_json::from_str(&commands[0].1).unwrap();
            let cdp_languages = params["acceptLanguage"].as_str().unwrap();
            assert!(!cdp_languages.contains(';'), "CDP 语言里不能带 q 值：{cdp_languages}");
            let expected = fingerprint["languages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|language| language.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(cdp_languages, expected);
            // 请求头仍要是浏览器正常的 q 值格式
            let header = request_headers(&fingerprint)
                .into_iter()
                .find(|(name, _)| name == "Accept-Language")
                .map(|(_, value)| value)
                .unwrap();
            assert_eq!(header, accept_language(&fingerprint).unwrap());
            assert!(header.starts_with(fingerprint["languages"][0].as_str().unwrap()));
        }
    }

    #[test]
    fn engine_versions_are_parsed() {
        assert_eq!(
            parse_engine_version("156.0.3456.78"),
            Some(("156".to_string(), "156.0.3456.78".to_string()))
        );
        assert_eq!(
            parse_engine_version("156.0.3456.78 (Official build) stable"),
            Some(("156".to_string(), "156.0.3456.78".to_string()))
        );
        assert_eq!(parse_engine_version(""), None);
        assert_eq!(parse_engine_version("156"), None);
        assert_eq!(parse_engine_version("unknown"), None);
    }

    #[test]
    fn request_headers_match_the_fingerprint() {
        let fingerprint = serde_json::json!({
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36",
            "chrome_version": "142.0.7444.175",
            "brands": [
                { "brand": "Chromium", "version": "142" },
                { "brand": "Google Chrome", "version": "142" },
                { "brand": "Not_A Brand", "version": "24" },
            ],
            "full_version_list": [
                { "brand": "Chromium", "version": "142.0.7444.175" },
                { "brand": "Google Chrome", "version": "142.0.7444.175" },
            ],
            "ua_platform": "Windows",
            "ua_platform_version": "15.0.0",
            "ua_architecture": "x86",
            "ua_bitness": "64",
            "ua_model": "",
            "ua_mobile": false,
            "ua_wow64": false,
            "ua_form_factors": ["Desktop"],
            "languages": ["zh-CN", "zh", "en"],
            "do_not_track": "1",
        });
        let headers = request_headers(&fingerprint);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("User-Agent"), fingerprint["user_agent"].as_str());
        assert_eq!(get("Accept-Language"), Some("zh-CN,zh;q=0.9,en;q=0.8"));
        assert_eq!(
            get("Sec-CH-UA"),
            Some("\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"24\"")
        );
        assert_eq!(get("Sec-CH-UA-Mobile"), Some("?0"));
        assert_eq!(get("Sec-CH-UA-Platform"), Some("\"Windows\""));
        assert_eq!(get("Sec-CH-UA-Platform-Version"), Some("\"15.0.0\""));
        assert_eq!(get("Sec-CH-UA-Arch"), Some("\"x86\""));
        assert_eq!(get("Sec-CH-UA-Bitness"), Some("\"64\""));
        assert_eq!(get("Sec-CH-UA-Model"), Some("\"\""));
        assert_eq!(get("Sec-CH-UA-Full-Version"), Some("142.0.7444.175"));
        assert_eq!(get("Sec-CH-UA-WoW64"), Some("?0"));
        assert_eq!(get("Sec-CH-UA-Form-Factors"), Some("\"Desktop\""));
        assert_eq!(get("DNT"), Some("1"));
        // 不带 Edge 品牌：内核自带的 Edge 身份必须被整组替换
        assert!(!get("Sec-CH-UA").unwrap().contains("Edge"));
    }

    #[test]
    fn random_fingerprints_produce_request_headers() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let headers = request_headers(&fingerprint);
        let names = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>();
        for required in [
            "User-Agent",
            "Accept-Language",
            "Sec-CH-UA",
            "Sec-CH-UA-Platform",
            "Sec-CH-UA-Full-Version-List",
        ] {
            assert!(names.contains(&required), "缺少请求头 {required}");
        }
        let user_agent = headers
            .iter()
            .find(|(name, _)| name == "User-Agent")
            .map(|(_, value)| value.as_str());
        assert_eq!(user_agent, fingerprint["user_agent"].as_str());
    }

    #[test]
    fn toolbar_labels_map_to_content_labels() {
        let window = "inapp-browser-2";
        assert_eq!(
            format!("{window}{CONTENT_SUFFIX}"),
            "inapp-browser-2-content"
        );
        assert_eq!(panel_label(window), "inapp-browser-2-download-panel");
        assert!(is_browser_window(window));
        assert!(is_browser_window(BROWSER_LABEL));
        // 下载气泡也是挂在浏览器窗口下的小窗，不能被当成浏览器窗口（否则会去重排它的子 WebView）
        assert!(!is_browser_window(&panel_label(window)));
        assert!(!is_browser_window(&panel_label(BROWSER_LABEL)));
        assert!(!is_browser_window("main"));
    }
}
