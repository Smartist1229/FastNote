//! 内置浏览器：多 WebView 窗口、工具栏、下载面板与指纹伪装。
//!
//! - `window`：创建 / 布局 / 内容与工具栏的对应关系、打开关闭命令
//! - `download`：网页触发的下载与下载面板
//! - `identity`：伪造 UA-CH 与原生身份（脚本 + 请求头）
//! - `nav`：地址归一化（补协议、循环地址判断）
//! - `mod`：全局状态与窗口事件入口

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
const FINGERPRINT_SCRIPT: &str = include_str!("../browser_script.js");
/// 链接拦截脚本：把 target="_blank" / window.open 改成本窗口导航
const LINK_SCRIPT: &str = include_str!("../browser_link_script.js");
/// 网页 WebView 独立的 WebView2 数据目录（放在软件的数据目录下）。
/// 清理模块要按它定位缓存，所以对 crate 内可见。
pub(crate) const BROWSER_PROFILE_DIR: &str = "inapp-browser-profile";
/// 工具栏 WebView 的独立数据目录
pub(crate) const TOOLBAR_PROFILE_DIR: &str = "inapp-browser-toolbar-profile";
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
pub(crate) const PANEL_PROFILE_DIR: &str = "inapp-browser-panel-profile";
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


mod window;
mod download;
mod identity;
mod nav;
#[cfg(test)]
mod tests;

pub(crate) use window::*;
pub(crate) use download::*;
pub(crate) use identity::*;
pub(crate) use nav::*;
