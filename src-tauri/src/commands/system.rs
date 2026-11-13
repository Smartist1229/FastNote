use tauri::{AppHandle, Manager};
use crate::{AppLocaleState, read_setting_bool};
use crate::i18n;
use crate::tray::{create_tray, tray_menu, TRAY_ID};
use crate::autostart::{launched_from_autostart, startup_shortcut_path, write_autostart_shortcut};

/// 启动时是否应该显示主窗口。
///
/// 窗口以 `visible: false` 创建、由前端在首帧画完后 show()（见 main.tsx），
/// 所以"开机自启 + 开机后最小化 + 托盘已开启"这条规则要让前端也问一次：
/// 否则前端那句 show() 会把本该藏在托盘里的窗口顶出来。
/// 与 setup 里的分支用同一套判定，改规则时两处一起改。
#[tauri::command]
pub fn should_show_on_startup(app: AppHandle) -> bool {
    let tray_on = read_setting_bool(&app, "app.config.general.trayEnabled", true);
    let minimize_to_tray = read_setting_bool(&app, "app.config.general.minimizeToTray", false);
    !(launched_from_autostart() && minimize_to_tray && tray_on)
}

#[tauri::command]
pub fn get_system_locale() -> Option<String> {
    i18n::system_locale()
}

#[tauri::command]
pub fn set_app_locale(app: AppHandle, locale: String) -> Result<(), String> {
    if locale != "zh-CN" && locale != "en-US" {
        return Err("Unsupported application locale".to_string());
    }
    let state = app.state::<AppLocaleState>();
    let mut current = state.0.lock().map_err(|e| e.to_string())?;
    if *current == locale {
        return Ok(());
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = tray_menu(&app, &locale).map_err(|e| e.to_string())?;
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
    }
    *current = locale;
    Ok(())
}

/// 启用/禁用托盘图标（设置项「显示托盘图标」变化时由前端调用）
#[tauri::command]
pub fn set_tray_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        create_tray(&app).map_err(|e| e.to_string())
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
        Ok(())
    }
}

/* ---------------- 开机自启动 (Windows 启动文件夹方式) ---------------- */

/// 启用/禁用开机自启：在启动文件夹里创建/删除快捷方式。
/// 只在「开机自启动」开关真正变化时由前端调用，不做无谓的重写。
#[tauri::command]
pub fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    let shortcut = startup_shortcut_path()?;
    if enabled {
        write_autostart_shortcut(&shortcut)
    } else if shortcut.exists() {
        std::fs::remove_file(&shortcut).map_err(|e| format!("删除开机启动快捷方式失败：{}", e))
    } else {
        Ok(())
    }
}

/* ---------------- 日志目录 ---------------- */

/**
 * 日志目录（安装目录下的 `log`，不可写时在数据目录下）。
 *
 * 前端拿到路径后交给 `open_app_folder` 打开 —— 那个命令的允许范围本来就覆盖
 * exe 同级与数据目录，日志目录一定在里面。
 */
#[tauri::command]
pub fn log_dir() -> String {
    crate::logger::dir().to_string_lossy().to_string()
}

/* ---------------- 前端异常日志 ---------------- */

/**
 * 把前端异常写进同一份日志文件。
 *
 * 渲染崩溃（ErrorBoundary）、未捕获异常、未处理的 Promise 拒绝都走这里。
 * 没有它的话，「白屏 / 点了没反应」在后端日志里一片干净，事后完全无从查起。
 *
 * 只收文本并截断：前端有时会把整棵虚拟 DOM 或超长堆栈塞进 message。
 */
#[tauri::command]
pub fn log_frontend(level: String, message: String) {
    let level = if level.eq_ignore_ascii_case("warn") {
        "WARN"
    } else {
        "ERROR"
    };
    let mut text = String::from("[frontend] ");
    text.extend(message.chars().take(8000));
    crate::logger::emit(level, &text);
}

/* ---------------- 数据库自愈通知 ---------------- */

/**
 * 取走「上次启动从损坏的数据库里重建过」的通知（**取走即清空**，只提示一次）。
 *
 * 返回被隔离的原库文件名；没发生过损坏就返回 None。
 * 用「取走」而不是「读」：用户已经看到过一次提示，下次启动不该再弹。
 */
#[tauri::command]
pub fn take_recovery_notice(state: tauri::State<crate::AppState>) -> Option<String> {
    let conn = state.conn.lock().ok()?;
    let raw: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'app.runtime.recovered'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    let _ = conn.execute(
        "DELETE FROM app_settings WHERE key = 'app.runtime.recovered'",
        [],
    );
    let note: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let name = note
        .get("corruptFile")
        .and_then(|value| value.as_str())
        .unwrap_or("fastnote.db");
    Some(name.to_string())
}

/**
 * 用户动作日志（写入时加 `[action]` 前缀）。
 *
 * 粒度是「一个用户可感知的操作」：新建 / 删除 / 移动 / 改设置 / 发起 AI 请求……
 * 不记按键、滚动、拖拽中间态 —— 那些只会把日志刷成噪音，盖住真正有用的记录。
 * 节流在前端做（`lib/app/actionLog.ts`），这里只负责落盘。
 */
#[tauri::command]
pub fn log_user_action(action: String, detail: Option<String>) {
    let action = action.trim();
    if action.is_empty() {
        return;
    }
    match detail
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
    {
        Some(detail) => crate::log_info!("[action] {action} · {detail}"),
        None => crate::log_info!("[action] {action}"),
    }
}
