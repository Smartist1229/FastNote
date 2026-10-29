//! 双线自动更新：CNB（国内）与 GitHub（海外备用）。
//!
//! Tauri 的 JS updater 只读取编译期配置里的 endpoints，无法在运行时换线；
//! 这里直接用 Rust 侧的 updater API 按线路构造 Updater，检查时并发探测两条线，
//! 安装时只用用户选中的那条。签名校验仍由 updater 插件完成。

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// 两条线路的更新清单。CNB 清单放在固定的 latest 发布里，
/// 里面的安装包地址指向对应的版本化发布。
const CNB_ENDPOINT: &str =
    "https://cnb.cool/Yiygc/FastNote/-/releases/download/latest/latest.json";
const GITHUB_ENDPOINT: &str =
    "https://github.com/Smartist1229/FastNote/releases/latest/download/latest.json";

/// 单条线路的探测超时：GitHub 在国内经常连不上，不能让检查一直转。
const LINE_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateLineProbe {
    pub id: String,
    pub endpoint: String,
    /// 清单请求耗时；不可达时为 null
    pub latency_ms: Option<u64>,
    /// 该线路可提供的新版本；已是最新或不可达时为 null
    pub version: Option<String>,
    pub notes: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadProgress {
    pub downloaded: u64,
    pub total: Option<u64>,
}

/// 已下载并验签、等待安装的安装包。
///
/// 下载与安装拆成两步：下载完成后先留在内存里，由用户决定何时安装。
/// 只缓存当前会话，软件退出后需要重新下载（版本对不上时也会丢弃）。
struct PendingUpdate {
    version: String,
    update: Update,
    bytes: Vec<u8>,
}

#[derive(Default)]
pub struct UpdateState {
    pending: Mutex<Option<PendingUpdate>>,
}

/// 错误用 `code|detail` 形式传回前端翻译，Rust 侧不绑定界面语言。
fn endpoint_for(line: &str) -> Result<&'static str, String> {
    match line {
        "cnb" => Ok(CNB_ENDPOINT),
        "github" => Ok(GITHUB_ENDPOINT),
        other => Err(format!("unknown_line|{other}")),
    }
}

async fn probe_line(app: &AppHandle, id: &str, endpoint: &'static str) -> UpdateLineProbe {
    let started = Instant::now();
    let result = async {
        let url = Url::parse(endpoint).map_err(|e| e.to_string())?;
        let updater = app
            .updater_builder()
            .endpoints(vec![url])
            .map_err(|e| e.to_string())?
            .timeout(LINE_TIMEOUT)
            .build()
            .map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;

    match result {
        Ok(Some(update)) => UpdateLineProbe {
            id: id.to_string(),
            endpoint: endpoint.to_string(),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            version: Some(update.version.clone()),
            notes: update.body.clone(),
            error: None,
        },
        Ok(None) => UpdateLineProbe {
            id: id.to_string(),
            endpoint: endpoint.to_string(),
            latency_ms: Some(started.elapsed().as_millis() as u64),
            version: None,
            notes: None,
            error: None,
        },
        Err(error) => UpdateLineProbe {
            id: id.to_string(),
            endpoint: endpoint.to_string(),
            latency_ms: None,
            version: None,
            notes: None,
            error: Some(error),
        },
    }
}

/// 并发探测两条线路，返回各自的延迟、版本与错误。
/// 前端据此默认选最快的一条，也允许用户手动切换。
#[tauri::command]
pub async fn probe_update_lines(app: AppHandle) -> Vec<UpdateLineProbe> {
    let (cnb, github) = tokio::join!(
        probe_line(&app, "cnb", CNB_ENDPOINT),
        probe_line(&app, "github", GITHUB_ENDPOINT),
    );
    vec![cnb, github]
}

/// 从指定线路下载安装包并验签，成功后暂存在内存里等待安装。
/// 下载进度通过 Channel 推送；失败不会替换上一次已下载的包。
#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    line: String,
    expected_version: String,
    on_event: Channel<UpdateDownloadProgress>,
) -> Result<(), String> {
    let endpoint = endpoint_for(&line)?;
    let url = Url::parse(endpoint).map_err(|e| format!("check_failed|{e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("check_failed|{e}"))?
        .timeout(LINE_TIMEOUT)
        .build()
        .map_err(|e| format!("check_failed|{e}"))?;

    let Some(update) = updater
        .check()
        .await
        .map_err(|e| format!("check_failed|{e}"))?
    else {
        return Err("no_update".to_string());
    };
    // 检查到下载之间线路上的版本可能已经变了，避免下到和弹窗里不一样的版本
    if update.version != expected_version {
        return Err(format!("version_changed|{}", update.version));
    }

    let mut downloaded = 0u64;
    let bytes = update
        .download(
            move |chunk_len, total| {
                downloaded += chunk_len as u64;
                let _ = on_event.send(UpdateDownloadProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| format!("download_failed|{e}"))?;

    let state = app.state::<crate::AppState>();
    let mut pending = state
        .updater
        .pending
        .lock()
        .map_err(|_| "download_failed|更新状态锁被占用".to_string())?;
    *pending = Some(PendingUpdate {
        version: expected_version,
        update,
        bytes,
    });
    Ok(())
}

/// 安装上一次下载好的安装包：安装器会重新验签再启动。
/// Windows 上安装器启动后会结束本进程；macOS / Linux 由前端负责重启。
#[tauri::command]
pub async fn install_downloaded_update(
    app: AppHandle,
    expected_version: String,
) -> Result<(), String> {
    let pending = {
        let state = app.state::<crate::AppState>();
        let mut guard = state
            .updater
            .pending
            .lock()
            .map_err(|_| "download_failed|更新状态锁被占用".to_string())?;
        guard.take()
    };
    let Some(pending) = pending else {
        return Err("not_downloaded".to_string());
    };
    if pending.version != expected_version {
        return Err(format!("version_changed|{}", pending.version));
    }
    pending
        .update
        .install(&pending.bytes)
        .map_err(|e| format!("download_failed|{e}"))?;
    Ok(())
}
