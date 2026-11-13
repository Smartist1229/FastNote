use rusqlite::{params, Connection, OpenFlags};
use tauri::AppHandle;

use crate::{read_setting_bool, resolve_data_dir, DB_FILE_NAME};

/**
 * 在 Builder 之前读一次「单例模式」开关。
 *
 * 只读、且库文件不存在时直接返回默认（true）：绝不能在这里新建数据库——
 * 真正的建库在 setup() 里做，那时才确定最终路径。
 * 读不到（键缺失 / 脏值 / 库被占用）一律按默认「开启」处理，多开的风险远大于误挡一次启动。
 */
pub(crate) fn read_single_instance_enabled(app_data_dir: Option<std::path::PathBuf>) -> bool {
    let db_path = resolve_data_dir(app_data_dir).join(DB_FILE_NAME);
    if !db_path.exists() {
        return true;
    }
    let Ok(conn) = Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) else {
        return true;
    };
    // 另一个进程可能正在写库（单例模式下它才是主实例），等它写完再读
    let _ = conn.busy_timeout(std::time::Duration::from_millis(1500));
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params!["app.config.general.singleInstance"],
        |row| row.get::<_, String>(0),
    )
    .ok()
    .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
    .unwrap_or(true)
}

/* ---------------- 开机自启动 (Windows 启动文件夹方式) ---------------- */

/// 开机自启动快捷方式路径：
/// %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FastNote.lnk
pub(crate) fn startup_shortcut_path() -> Result<std::path::PathBuf, String> {
    let appdata = std::env::var("APPDATA").map_err(|_| "无法获取 APPDATA 路径".to_string())?;
    Ok(std::path::PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup")
        .join("FastNote.lnk"))
}

/// PowerShell 单引号字符串转义：内容里出现 ' 时写成 ''
fn ps_escape(s: &str) -> String {
    s.replace('\'', "''")
}

/// 本次进程是否由开机自启动拉起：快捷方式固定带 --autostart 参数。
/// （--minimized 是早期版本的写法，兼容识别，避免老快捷方式失效）
pub(crate) fn launched_from_autostart() -> bool {
    std::env::args().any(|arg| arg == "--autostart" || arg == "--minimized")
}

/// 写入开机启动快捷方式：用 WScript.Shell 生成 .lnk，无需额外依赖。
/// 参数固定为 --autostart，只负责标记「这次是开机拉起的」；
/// 拉起后是否隐藏到托盘由库里的「开机后最小化到托盘」设置决定，因此切换该设置不需要动快捷方式。
pub(crate) fn write_autostart_shortcut(shortcut: &std::path::Path) -> Result<(), String> {
    if let Some(dir) = shortcut.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建启动文件夹失败：{}", e))?;
    }

    let exe_path = std::env::current_exe().map_err(|e| format!("获取程序路径失败：{}", e))?;
    let work_dir = exe_path
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let exe = exe_path.to_string_lossy().to_string();
    let lnk = shortcut.to_string_lossy().to_string();

    // 路径统一用单引号包裹（内部单引号已转义），避免双引号被 PowerShell 提前闭合导致脚本解析失败。
    let script = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $lnk = $ws.CreateShortcut('{}'); \
         $lnk.TargetPath = '{}'; \
         $lnk.WorkingDirectory = '{}'; \
         $lnk.Arguments = '--autostart'; \
         $lnk.Save()",
        ps_escape(&lnk),
        ps_escape(&exe),
        ps_escape(&work_dir),
    );

    let output = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            &script,
        ])
        .output()
        .map_err(|e| format!("调用 PowerShell 失败：{}", e))?;

    if !output.status.success() {
        return Err(format!(
            "创建开机启动快捷方式失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if !shortcut.exists() {
        return Err("创建开机启动快捷方式失败：快捷方式未生成".to_string());
    }

    Ok(())
}

/// 启动时对齐一次：只有快捷方式「该在却不在 / 不该在却在」时才动手。
/// 正常情况下（设置已开启且快捷方式已存在）这里什么都不做，不会每次都跑一遍 PowerShell。
pub(crate) fn sync_autostart_shortcut(app: &AppHandle) {
    let Ok(shortcut) = startup_shortcut_path() else {
        return;
    };
    if read_setting_bool(app, "app.config.general.autostart", false) {
        if !shortcut.exists() {
            if let Err(e) = write_autostart_shortcut(&shortcut) {
                crate::log_error!("创建开机启动快捷方式失败：{e}");
            }
        }
    } else if shortcut.exists() {
        let _ = std::fs::remove_file(&shortcut);
    }
}
