//! 工具箱下载器：分段并发下载、暂停/续传、HTML 入口页解析。
//!
//! - `naming`：目标文件名推导（Content-Disposition / URL / 去重）
//! - `entry`：入口页（HTML）里找出真正的下载链接
//! - `probe`：探测文件大小与是否支持 Range
//! - `segments`：分片计划、落盘与合并
//! - `mod`：状态、控制句柄与对外的命令

//! 通用下载模块：动态分片多线程下载 + 进度回调。
//!
//! - 线程数来自 `app.config.general.downloadThreads`（1–128，默认 32），
//!   语义模型下载与工具箱下载共用同一个值；
//! - 服务器支持 Range 时把文件切成比线程数略多的大分片（默认每线程 3 片），
//!   所有线程从同一个队列里取：先下完的线程继续取下一片，不会出现“快的闲着”；
//!   分片不能太小——连接刚进入满速就结束，整体吞吐反而比少而大的分片差；
//! - 不支持 Range 或文件很小时退回单流；
//! - 分段进度留在 `<目标>.part.<序号>`，参数不变时重试可续传；分片布局变了就丢弃旧分段；
//! - 工具箱下载的分片放在 `<下载目录>/<文件名>` 临时目录，完成后合并回下载根目录并删除；
//! - 下载可以暂停：暂停只停止传输并保留分段文件，继续时重新调用 `fetch` 从断点续传；
//! - 下载可以取消：取消标记在每个数据块之间检查，退出后清理临时文件；
//! - 进度通过回调交给调用方（总进度 + 正在下载的各分片信息），
//!   模型下载发 `semantic-model-progress`，工具箱发 `toolbox-download-progress`。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use futures_util::StreamExt;
use reqwest::header::HeaderMap;
use reqwest::{Client, Response, StatusCode};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::AppState;

pub const DEFAULT_THREADS: u64 = 32;
pub const MAX_THREADS: u64 = 128;
pub const THREADS_KEY: &str = "app.config.general.downloadThreads";

/// 单段建议下限：分片太小会让每条连接都停在自己刚爬坡的阶段，吞吐反而下降
const MIN_SEGMENT: u64 = 4 * 1024 * 1024;
/// 单段上限：分片总数为硬约束，单片再大也不会撑爆临时目录
const MAX_SEGMENT: u64 = 256 * 1024 * 1024;
/// 每个线程在队列里预置的分片数：先下完的线程接着取下一片，直到文件下完
const SEGMENTS_PER_THREAD: usize = 3;
/// 分片总数上限：超大文件也不至于生成几万个临时文件
const MAX_SEGMENTS: usize = 4096;
const MAX_ATTEMPTS: usize = 3;
const EMIT_INTERVAL_MS: u64 = 250;
const PROGRESS_EVENT: &str = "toolbox-download-progress";
/// 入口预检最多跟几跳：落地页 → 落地页 → 文件
const ENTRY_HOPS: usize = 3;
/// 落地页最多读这么多字节用于找下载地址（正常页面远小于这个值）
const HTML_LIMIT: usize = 512 * 1024;

pub const CANCELLED: &str = "已取消下载";
pub const PAUSED: &str = "已暂停";

/// 下载控制：取消 / 暂停都通过这一份共享标记控制同一批下载线程。
///
/// 暂停不丢弃已下载的数据：当前数据块写完后线程收尾返回 [`PAUSED`]，
/// 调用方保留临时文件 / 分片目录并等待；继续时重新调用 [`fetch`]，
/// 按已有分段长度续传，不会从头开始。
#[derive(Clone, Default)]
pub struct Control(Arc<ControlFlags>);

#[derive(Default)]
pub(crate) struct ControlFlags {
    cancelled: AtomicBool,
    paused: AtomicBool,
}

impl Control {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.cancelled.load(Ordering::Relaxed)
    }

    /// 暂停 / 继续；暂停期间已经在传输的数据块会写完再停
    pub fn set_paused(&self, paused: bool) {
        self.0.paused.store(paused, Ordering::Relaxed);
    }

    pub fn is_paused(&self) -> bool {
        self.0.paused.load(Ordering::Relaxed)
    }

    /// 当前该停下的原因：取消优先于暂停
    pub fn stop_reason(&self) -> Option<&'static str> {
        if self.is_cancelled() {
            Some(CANCELLED)
        } else if self.is_paused() {
            Some(PAUSED)
        } else {
            None
        }
    }
}

#[derive(Default)]
pub struct DownloadState {
    /// 当前工具箱任务的控制标记：同一时间只跑一个任务
    pub active: Mutex<Option<Control>>,
}

/// 单个分片（= 一个线程正在负责的片段）的实时进度，随总进度一起交给调用方。
/// `downloaded` 是相对整个文件的偏移之外的“本片已下载字节”，界面直接按片展示。
#[derive(Clone, Debug, serde::Serialize)]
pub struct SegmentProgress {
    /// 分片序号，从 0 开始；分片布局在同一个任务内固定
    pub index: usize,
    /// 分片在文件中的起始字节（含）
    pub start: u64,
    /// 分片在文件中的结束字节（含）
    pub end: u64,
    pub downloaded: u64,
    pub total: u64,
    /// 本片当前速度（字节/秒）
    pub speed: f64,
}

/// 进度回调：总已下载、总大小、并发数、正在进行的分片列表（只含未完成的分片）
pub type ProgressSink<'a> = &'a (dyn Fn(u64, u64, usize, &[SegmentProgress]) + Sync);

/// 取消 / 暂停时返回原因；没有控制对象时永远 pending
async fn wait_stop(control: Option<&Control>) -> &'static str {
    match control {
        Some(control) => {
            while control.stop_reason().is_none() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            control.stop_reason().unwrap_or(CANCELLED)
        }
        None => std::future::pending().await,
    }
}

fn ensure_running(control: Option<&Control>) -> Result<(), String> {
    match control.and_then(Control::stop_reason) {
        Some(reason) => Err(reason.to_string()),
        None => Ok(()),
    }
}

/// 读设置里的线程数；越界值直接夹到 1–128，避免手工改库导致开几百个连接
pub fn threads(app: &AppHandle) -> usize {
    crate::read_setting_u64(app, THREADS_KEY, DEFAULT_THREADS).clamp(1, MAX_THREADS) as usize
}

/// 下载客户端：默认头来自浏览器指纹模块（UA、UA-CH、语言、Fetch Metadata），
/// 不少下载站（含 comfy.org）对无 UA 或非浏览器 UA 直接回 400/403；
/// 另外开启 Cookie 与 Referer 跟随，限制连接超时与空闲读超时，连接池按最大线程数预留。
///
/// 每次创建客户端取一份新的随机指纹：同一个任务的各段 Range 请求共用这个 Client，
/// 因此共用同一身份，任务之间才会换指纹。浏览器窗口下载不走这里——它必须复用窗口
/// 已经固定的指纹，见 [`client_with_headers`]。
pub fn client() -> Result<Client, String> {
    client_with_headers(crate::fingerprint::BrowserFingerprint::random().headers())
}

/// 用指定的默认请求头建客户端（内置浏览器把窗口指纹的头传进来，保持 UA / UA-CH 一致）。
pub fn client_with_headers(headers: HeaderMap) -> Result<Client, String> {
    Client::builder()
        .default_headers(headers)
        .cookie_store(true)
        .referer(true)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .pool_max_idle_per_host(MAX_THREADS as usize)
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))
}

/// 工具箱默认下载目录：软件安装目录下的 `download`（不可写时退回应用数据目录）
pub fn default_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let target = dir.join("download");
            if std::fs::create_dir_all(&target).is_ok() {
                return Ok(target);
            }
        }
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let target = base.join("download");
    std::fs::create_dir_all(&target).map_err(|e| format!("创建下载目录失败：{e}"))?;
    Ok(target)
}

#[tauri::command]
pub fn toolbox_download_dir(app: AppHandle) -> Result<String, String> {
    Ok(default_dir(&app)?.to_string_lossy().to_string())
}

/// 启动一个工具箱下载任务：命令立刻返回，进度走 `toolbox-download-progress`。
/// `filename` 为空时按链接自动取名，非空时清理非法字符后直接使用。
#[tauri::command]
pub async fn toolbox_download(
    app: AppHandle,
    url: String,
    filename: Option<String>,
) -> Result<(), String> {
    let url = url.trim().to_string();
    let parsed = reqwest::Url::parse(&url).map_err(|_| "链接格式不正确".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只支持 http / https 链接".to_string());
    }
    let control = Control::new();
    {
        let state = app.state::<AppState>();
        let mut active = state
            .download
            .active
            .lock()
            .map_err(|_| "下载状态锁被占用".to_string())?;
        if active.is_some() {
            return Err("已有下载任务在进行，请等待完成".to_string());
        }
        *active = Some(control.clone());
    }

    let handle = app.clone();
    let task_control = control.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run_toolbox_download(&handle, &url, filename.as_deref(), &task_control).await;
        if let Some(state) = handle.try_state::<AppState>() {
            if let Ok(mut active) = state.download.active.lock() {
                *active = None;
            }
        }
        if let Err(error) = outcome {
            if task_control.is_cancelled() {
                emit_toolbox(&handle, "cancelled", "", "", 0, 0, 0, &[], 0, None);
            } else {
                emit_toolbox(&handle, "error", "", "", 0, 0, 0, &[], 0, Some(&error));
            }
        }
    });
    Ok(())
}

/// 取消当前工具箱下载；没有任务时返回 false，前端据此提示
#[tauri::command]
pub fn toolbox_download_cancel(app: AppHandle) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let active = state
        .download
        .active
        .lock()
        .map_err(|_| "下载状态锁被占用".to_string())?;
    match active.as_ref() {
        Some(control) => {
            control.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

/// 暂停 / 继续当前工具箱下载；没有任务时返回 false。
/// 暂停只停止传输并保留分片目录，继续后从已下载的位置续传。
#[tauri::command]
pub fn toolbox_download_pause(app: AppHandle, paused: bool) -> Result<bool, String> {
    let state = app.state::<AppState>();
    let active = state
        .download
        .active
        .lock()
        .map_err(|_| "下载状态锁被占用".to_string())?;
    match active.as_ref() {
        Some(control) => {
            control.set_paused(paused);
            Ok(true)
        }
        None => Ok(false),
    }
}

async fn run_toolbox_download(
    app: &AppHandle,
    url: &str,
    filename: Option<&str>,
    control: &Control,
) -> Result<(), String> {
    let dir = default_dir(app)?;
    let client = client()?;
    // 入口可能不是文件本身（脚本跳转 / 下载落地页）；解析出的地址用于实际下载，
    // 避免把网页当文件存下来，顺带拿到真实文件名。
    let entry = resolve_entry(&client, url, Some(control)).await?;
    let mut base_name = resolve_filename(url, filename);
    let custom_blank = filename
        .map(|name| sanitize_filename(name).is_empty())
        .unwrap_or(true);
    if custom_blank {
        if let Some(remote) = entry.filename {
            base_name = remote;
        }
    }

    // 分片放 download/<文件名>，最终文件仍落在 download 根目录
    let dest = unique_dest(&dir, &base_name);
    let temp_name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&base_name);
    let staging = prepare_staging(&dir, &staging_name(temp_name)).await?;
    let temp_dest = staging.join(temp_name);
    // 上次异常退出可能留下已合并完成的临时文件，先清掉，避免最终改名失败
    let _ = tokio::fs::remove_file(&temp_dest).await;

    let filename = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(&base_name)
        .to_string();
    let path = dest.to_string_lossy().to_string();

    // 计时从真正开始传输算起：前面的文件名解析 / 建暂存目录不算下载时间。
    // 进度事件带绝对用时，界面中途关闭再打开也能接上。
    let started = Instant::now();
    emit_toolbox(app, "download", &filename, &path, 0, 0, 0, &[], 0, None);
    let count = threads(app);
    let last_done = AtomicU64::new(0);
    let last_total = AtomicU64::new(0);
    let last_parallel = AtomicUsize::new(0);
    let progress = |done: u64, total: u64, parallel: usize, active: &[SegmentProgress]| {
        last_done.store(done, Ordering::Relaxed);
        last_total.store(total, Ordering::Relaxed);
        last_parallel.store(parallel, Ordering::Relaxed);
        emit_toolbox(
            app,
            "download",
            &filename,
            &path,
            done,
            total,
            parallel,
            active,
            started.elapsed().as_millis() as u64,
            None,
        );
    };
    /*
     * 暂停时 fetch 返回 PAUSED：保留分片目录并等用户点「继续」，
     * 继续后重新调用 fetch，按已有分段长度续传；取消才清理临时文件。
     */
    let size = loop {
        match fetch(
            &client,
            &entry.url,
            &temp_dest,
            count,
            Some(control),
            None,
            &progress,
        )
        .await
        {
            Ok(size) => break size,
            Err(error) => {
                if control.is_cancelled() {
                    cleanup(&temp_dest).await;
                    remove_staging(&staging).await;
                    return Err(CANCELLED.to_string());
                }
                if control.is_paused() || error == PAUSED {
                    // 已经点了「继续」就不用再报一次暂停，直接续传
                    if control.is_paused() {
                        emit_toolbox(
                            app,
                            "paused",
                            &filename,
                            &path,
                            last_done.load(Ordering::Relaxed),
                            last_total.load(Ordering::Relaxed),
                            last_parallel.load(Ordering::Relaxed),
                            &[],
                            started.elapsed().as_millis() as u64,
                            None,
                        );
                    }
                    while control.is_paused() && !control.is_cancelled() {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                    if control.is_cancelled() {
                        cleanup(&temp_dest).await;
                        remove_staging(&staging).await;
                        return Err(CANCELLED.to_string());
                    }
                    continue;
                }
                // 失败的分段不会被续传（工具箱每次选新文件名），直接清掉
                cleanup(&temp_dest).await;
                remove_staging(&staging).await;
                return Err(error);
            }
        }
    };

    // 下载期间目标名可能被其他程序占用，落盘前再确认一次
    let final_dest = unique_dest(&dir, temp_name);
    let final_filename = final_dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(temp_name)
        .to_string();
    let final_path = final_dest.to_string_lossy().to_string();
    if let Err(error) = tokio::fs::rename(&temp_dest, &final_dest).await {
        let _ = tokio::fs::remove_file(&temp_dest).await;
        cleanup(&temp_dest).await;
        remove_staging(&staging).await;
        return Err(format!("保存文件失败：{error}"));
    }
    remove_staging(&staging).await;
    emit_toolbox(
        app,
        "done",
        &final_filename,
        &final_path,
        size,
        size,
        0,
        &[],
        started.elapsed().as_millis() as u64,
        None,
    );
    Ok(())
}

fn emit_toolbox(
    app: &AppHandle,
    stage: &str,
    filename: &str,
    path: &str,
    downloaded: u64,
    total: u64,
    parallel: usize,
    active: &[SegmentProgress],
    elapsed_ms: u64,
    error: Option<&str>,
) {
    let _ = app.emit(
        PROGRESS_EVENT,
        json!({
            "stage": stage,
            "filename": filename,
            "path": path,
            "downloaded": downloaded,
            "total": total,
            "segments": parallel,
            "segment_progress": active,
            "elapsed": elapsed_ms,
            "error": error,
        }),
    );
}


mod naming;
mod entry;
mod probe;
mod segments;
#[cfg(test)]
mod tests;

pub(crate) use naming::*;
pub(crate) use entry::*;
pub(crate) use probe::*;
pub(crate) use segments::*;
