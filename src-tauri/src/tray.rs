use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

use crate::AppLocaleState;

/// 托盘图标 ID
pub(crate) const TRAY_ID: &str = "fastnote-tray";

/// 从托盘 / 单实例唤出窗口。
///
/// WebView2 在窗口隐藏或最小化期间会暂停合成，直接 show() 有概率只呈现一帧空白。
/// 处理顺序：先解除最小化 → 显示 → 聚焦；确实是从隐藏/最小化恢复时，
/// 再在后台做一次「1px 尺寸抖动」，逼 WebView2 重新分配渲染表面。
pub(crate) fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let was_hidden = !window.is_visible().unwrap_or(true);
        let was_minimized = window.is_minimized().unwrap_or(false);

        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();

        if was_hidden || was_minimized {
            nudge_webview_repaint(window);
        }
    }
}

/// 延迟重绘兜底：只在窗口仍然可见时执行，避免用户又把它藏起来后被强行唤出。
fn nudge_webview_repaint(window: tauri::WebviewWindow) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(80));
        if !window.is_visible().unwrap_or(false) {
            return;
        }

        // 最小化/隐藏后偶发失去焦点，再补一次
        let _ = window.show();
        let _ = window.unminimize();

        // 1px 尺寸变化是让 WebView2 重建渲染表面最可靠的方式；
        // 最大化/全屏时尺寸由系统托管，跳过尺寸抖动，交给前端的强制重排兜底。
        if !window.is_maximized().unwrap_or(false) && !window.is_fullscreen().unwrap_or(false) {
            if let Ok(size) = window.outer_size() {
                if size.width > 1 && size.height > 1 {
                    let _ =
                        window.set_size(tauri::PhysicalSize::new(size.width + 1, size.height + 1));
                    std::thread::sleep(std::time::Duration::from_millis(40));
                    let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
                }
            }
        }

        let _ = window.set_focus();
        // 通知前端做一次强制重排（最大化窗口尤其依赖这一层）
        let _ = window.emit("fastnote://window-restored", ());
    });
}

pub(crate) fn tray_menu(app: &AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let (show, quit) = if locale == "zh-CN" {
        ("显示 FastNote", "退出")
    } else {
        ("Show FastNote", "Quit")
    };
    let show_item = MenuItem::with_id(app, "show", show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", quit, true, None::<&str>)?;
    Menu::with_items(app, &[&show_item, &quit_item])
}

/// 创建托盘图标（已存在则跳过）
pub(crate) fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let locale = app.state::<AppLocaleState>().0.lock().unwrap().clone();
    let menu = tray_menu(app, &locale)?;

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("FastNote")
        .menu(&menu)
        // 左键只负责呼出窗口，右键才弹菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    // 用应用自带窗口图标：编译期已内嵌为 RGBA，无需 image-png 解码
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
