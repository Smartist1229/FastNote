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
