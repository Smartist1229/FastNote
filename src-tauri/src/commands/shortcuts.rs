//! 系统级全局热键（窗口隐藏 / 托盘里也能按到）。
//!
//! 为什么放在 Rust 而不是前端：
//! - 全局热键是**进程级**注册，窗口隐藏、webview 被节流都不影响；前端监听 keydown 只在有焦点时有效；
//! - 注册冲突（键位被输入法 / 截图工具占用）只有操作系统知道，必须拿到注册返回值才能提示用户。
//!
//! 前端只发一张清单（action id + accelerator），本模块**整体替换**注册：
//! 一次调用就能处理增删改，不会出现「改了键位、旧键还活着」的双绑状态。
//! 按下时把 id 原样 `emit` 回前端，由前端的快捷键运行时决定执行什么。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

/// 一条注册请求
#[derive(Debug, Deserialize)]
pub struct GlobalShortcutItem {
    /// 宿主动作 id（如 `app.toggleWindow`）或 `plugin:<dirName>:<组合键>`
    pub id: String,
    /// Tauri 写法：`CommandOrControl+Shift+Space`
    pub accelerator: String,
}

/// 注册失败项：`reason` 直接来自操作系统 / 解析错误，前端原样展示
#[derive(Debug, Serialize)]
pub struct GlobalShortcutFailure {
    pub id: String,
    pub accelerator: String,
    pub reason: String,
}

/// 全局事件名：前端快捷键运行时监听它并分发到具体动作
pub const GLOBAL_SHORTCUT_EVENT: &str = "fastnote://global-shortcut";

/// 「全局唤起窗口」的动作 id：这类动作在 Rust 侧先把窗口叫出来再通知前端，
/// 否则窗口藏在托盘里时前端收不到焦点，界面上的后续交互也没法进行。
const ACTION_TOGGLE_WINDOW: &str = "app.toggleWindow";
/// 全局速记：同样得先把窗口叫出来，用户才能在新笔记里打字
const ACTION_QUICK_NOTE: &str = "app.quickNote";

/// 显示 / 收回主窗口：已显示且在前台时收回，其余情况一律叫出来并聚焦。
fn toggle_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        if visible && focused {
            let _ = window.hide();
            return;
        }
    }
    crate::tray::show_main_window(app);
}

/// 用给定清单替换全部全局热键（`sync_global_shortcuts`）。
///
/// 先 `unregister_all` 再逐条注册：清单是前端的完整期望状态，
/// 增量维护需要前端记住「上次注册了什么」，一处漏删就是幽灵热键。
#[tauri::command]
pub fn sync_global_shortcuts(
    app: AppHandle,
    items: Vec<GlobalShortcutItem>,
) -> Vec<GlobalShortcutFailure> {
    let shortcuts = app.global_shortcut();
    // 没有任何注册时 unregister_all 会报错，这里忽略
    let _ = shortcuts.unregister_all();

    let mut failures = Vec::new();
    for item in items {
        let accelerator = item.accelerator.trim().to_string();
        // 空键位表示用户关掉了这个动作的快捷键
        if accelerator.is_empty() {
            continue;
        }
        let id = item.id.clone();
        let handle = app.clone();
        let registered = shortcuts.on_shortcut(accelerator.as_str(), move |_app, _shortcut, event| {
            // 只认按下：按住不放会连续触发，松开时再来一次会让动作执行两遍
            if event.state != ShortcutState::Pressed {
                return;
            }
            if id == ACTION_TOGGLE_WINDOW {
                toggle_main_window(&handle);
            } else if id == ACTION_QUICK_NOTE {
                crate::tray::show_main_window(&handle);
            }
            if let Err(error) = handle.emit(GLOBAL_SHORTCUT_EVENT, id.as_str()) {
                eprintln!("[shortcuts] 派发全局热键失败: {error}");
            }
        });
        if let Err(error) = registered {
            failures.push(GlobalShortcutFailure {
                id: item.id,
                accelerator,
                reason: error.to_string(),
            });
        }
    }
    failures
}
