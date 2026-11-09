//! 最小化恢复后强制重绘：治「窗口最小化久了，回来整页空白」。
//!
//! 现象：窗口最小化一段时间再恢复，网页内容 / 界面变成一片空白。
//!
//! 原因（WebView2）：最小化时 `WM_SIZE` 给的是 0×0，内核把合成面压成了 0；
//! 恢复时如果窗口尺寸与最小化前完全相同，wry 认为 `bounds` 没变就不再下发新值，
//! 引擎手里仍是那块 0×0 的合成面 —— 于是画面一直停在空白，直到用户拖动窗口、
//! 改变尺寸，或触发一次真正的内容更新。
//!
//! 处理：最小化时（尺寸事件 0×0）记一笔时间戳；恢复时（尺寸事件恢复正常）
//! 若离开超过 `REPAINT_AFTER`，就把该窗口里每个 webview 的宽度 +1px 再写回。
//! 一次真实的 bounds 变化会逼内核重建合成面并重绘，1px 的抖动看不出来。
//!
//! 为什么按「离开时长」而不是「每次都补」：频繁最小化/恢复（比如点任务栏来回切）
//! 本来就不会出问题，多补一次只会多一次 1px 抖动；只在离开够久时动手，动静最小。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalSize, Window};

/// 离开超过这个时长才补重绘。太短会误伤「点任务栏切一下」这类正常操作
const REPAINT_AFTER: Duration = Duration::from_secs(3);

/// 窗口开始最小化的时刻（按窗口标签记）
fn minimized_at() -> &'static Mutex<HashMap<String, Instant>> {
    static MAP: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 尺寸事件入口：`0×0` 视为最小化，恢复正常尺寸时判断要不要补重绘。
///
/// 由 `lib.rs` 的 `on_window_event` 对所有窗口调用（主窗口、内置浏览器、插件窗口都走同一条）。
pub(crate) fn on_resized(window: &Window, size: PhysicalSize<u32>) {
    let label = window.label().to_string();
    if size.width == 0 || size.height == 0 {
        if let Ok(mut map) = minimized_at().lock() {
            map.insert(label, Instant::now());
        }
        return;
    }
    // 取走并清掉：一次最小化只补一次
    let away = minimized_at().lock().ok().and_then(|mut map| map.remove(&label));
    let Some(at) = away else {
        return;
    };
    if at.elapsed() < REPAINT_AFTER {
        return;
    }
    schedule(window.app_handle().clone(), label);
}

/// 后台补重绘：等窗口稳定 → 每个 webview 宽度 +1px → 40ms 后写回原尺寸。
///
/// 放在后台线程里做：事件回调里睡 40ms 会卡住整个 UI 线程（表现为恢复瞬间卡顿）。
fn schedule(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        // 恢复瞬间窗口还在做缩放动画 / DPI 重算，等它落定再量尺寸
        std::thread::sleep(Duration::from_millis(160));
        let Some(window) = app.get_window(&label) else {
            return;
        };
        let Ok(window_size) = window.inner_size() else {
            return;
        };
        if window_size.width == 0 || window_size.height == 0 {
            return;
        }

        // 先记下每个 webview 的原始尺寸：浏览器窗口里工具栏与网页两块尺寸不同，
        // 不能用窗口尺寸统一覆盖，否则会把布局压坏
        let mut originals: Vec<(tauri::Webview, PhysicalSize<u32>)> = Vec::new();
        for webview in window.webviews() {
            let Ok(size) = webview.size() else { continue };
            if size.width == 0 || size.height == 0 {
                continue;
            }
            originals.push((webview, size));
        }
        if originals.is_empty() {
            return;
        }

        for (webview, size) in &originals {
            let _ = webview.set_size(PhysicalSize::new(size.width + 1, size.height));
        }
        std::thread::sleep(Duration::from_millis(40));
        for (webview, size) in originals {
            let _ = webview.set_size(size);
        }
        // 与托盘唤出走同一条前端兜底：改一帧透明度促使合成器提交新帧
        let _ = window.emit("fastnote://window-restored", ());
    });
}
