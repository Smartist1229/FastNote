//! 打开应用自己的目录（下载目录、模型目录）。
//!
//! 不走前端 `openPath`：opener 的 ACL 作用域在 Windows 上没法用 `$EXE` 表达——
//! tauri 的 `$EXE` 取 `dirs::executable_dir()`，而它在 Windows 恒为 `None`，
//! 作用域条目会被解析成空路径，任何 open_path 调用都会被拒绝。
//! 这里改由后端校验路径归属后直接调用 opener 的 Rust API，不经过 IPC 作用域。

use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 只允许打开安装目录与应用数据目录下的内容（下载目录、data/models 都在其中）。
#[tauri::command]
pub fn open_app_folder(app: AppHandle, path: String) -> Result<(), String> {
    let target = PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| format!("目录不存在：{path}"))?;
    if !target.is_dir() {
        return Err(format!("不是目录：{path}"));
    }

    if !roots(&app).iter().any(|root| target.starts_with(root)) {
        return Err("只能打开应用自己的目录".to_string());
    }

    // 用原始字符串打开，避免把 canonicalize 得到的 `\\?\` 前缀交给 shell
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("打开目录失败：{e}"))
}

fn roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(dir) = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .and_then(|dir| dir.canonicalize().ok())
    {
        roots.push(dir);
    }
    if let Some(dir) = app
        .path()
        .app_data_dir()
        .ok()
        .and_then(|dir| dir.canonicalize().ok())
    {
        roots.push(dir);
    }
    roots
}
