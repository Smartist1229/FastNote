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
//! - 工具箱下载可以取消：取消标记在每个数据块之间检查，退出后清理临时文件；
//! - 进度通过回调交给调用方（总进度 + 正在下载的各分片信息），
//!   模型下载发 `semantic-model-progress`，工具箱发 `toolbox-download-progress`。

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::future::join_all;
use futures_util::StreamExt;
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

/// 取消标记：克隆后共享同一个原子位，下载循环在每个数据块之间检查
#[derive(Clone, Default)]
pub struct Cancel(Arc<AtomicBool>);

impl Cancel {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
pub struct DownloadState {
    /// 当前工具箱任务的取消标记：同一时间只跑一个任务
    pub active: Mutex<Option<Cancel>>,
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

/// 没有取消令牌时永远 pending；有令牌时每 100ms 轮询一次
async fn wait_cancel(cancel: Option<&Cancel>) {
    match cancel {
        Some(cancel) => {
            while !cancel.is_cancelled() {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
        None => std::future::pending().await,
    }
}

fn ensure_not_cancelled(cancel: Option<&Cancel>) -> Result<(), String> {
    match cancel {
        Some(cancel) if cancel.is_cancelled() => Err(CANCELLED.to_string()),
        _ => Ok(()),
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
/// 因此共用同一身份，任务之间才会换指纹。
pub fn client() -> Result<Client, String> {
    let fingerprint = crate::fingerprint::BrowserFingerprint::random();
    Client::builder()
        .default_headers(fingerprint.headers())
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

/// 分片临时目录取下载文件名（去扩展名）：既按文件区分任务，又不会和最终文件同名冲突。
/// 文件名本身没有扩展名时追加 `-parts`，避免目录与最终文件同名。
fn staging_name(filename: &str) -> String {
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(filename);
    if stem.is_empty() || stem == filename {
        format!("{filename}-parts")
    } else {
        stem.to_string()
    }
}

/// 准备 `download/<文件名>`：同名文件占位时追加后缀，并清掉上次异常退出留下的分片
async fn prepare_staging(root: &Path, name: &str) -> Result<PathBuf, String> {
    for attempt in 0..100 {
        let candidate = if attempt == 0 {
            root.join(name)
        } else {
            root.join(format!("{name}-{attempt}"))
        };
        match tokio::fs::metadata(&candidate).await {
            Ok(meta) if meta.is_dir() => {
                purge_part_files(&candidate).await;
                return Ok(candidate);
            }
            Ok(_) => continue,
            Err(_) => {
                tokio::fs::create_dir_all(&candidate)
                    .await
                    .map_err(|e| format!("创建分片目录失败：{e}"))?;
                return Ok(candidate);
            }
        }
    }
    Err("无法创建分片目录：同名文件过多".to_string())
}

/// 分片与下载计划都以 `.part` 命名，只清理这类文件，不动目录里的其他内容
async fn purge_part_files(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_file = entry
            .file_type()
            .await
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if !is_file {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.contains(".part") {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// 任务结束后删掉分片目录；目录里还有别的文件时保留，避免误删用户内容
async fn remove_staging(dir: &Path) {
    purge_part_files(dir).await;
    let _ = tokio::fs::remove_dir(dir).await;
}

/// 用户指定的文件名优先；留空或清理后为空时回退到链接推导
fn resolve_filename(url: &str, custom: Option<&str>) -> String {
    let name = custom.map(sanitize_filename).unwrap_or_default();
    if name.is_empty() {
        filename_from_url(url)
    } else {
        name
    }
}

/// 从链接路径最后一段取文件名；路径为空、以 `/` 结尾或只有 `.`/`..` 时返回 None
fn filename_from_path(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    let last = url.path_segments()?.next_back()?;
    let name = sanitize_filename(&percent_decode(last));
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name)
    }
}

/// 从链接最后一段取文件名；取不到时用时间戳兜底。
/// 注意：这里只看原始链接。入口是脚本（`download.php?pro=x`）时，
/// 真实文件名在重定向之后，由 [`suggest_filename`] 负责取。
pub fn filename_from_url(raw: &str) -> String {
    filename_from_path(raw).unwrap_or_else(|| {
        format!(
            "download-{}.bin",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        )
    })
}

/// 从 `Content-Disposition` 取文件名：优先 RFC 5987 的 `filename*`，其次 `filename`。
fn filename_from_disposition(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').skip(1) {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let raw = raw.trim();
        if key == "filename*" {
            // 形如 UTF-8''%E4%B8%AD%E6%96%87.zip：取第二个单引号之后的部分
            let encoded = raw.splitn(3, '\'').nth(2).unwrap_or(raw);
            let name = sanitize_filename(&percent_decode(encoded.trim_matches('"')));
            if !name.is_empty() {
                return Some(name);
            }
        } else if key == "filename" {
            let name = sanitize_filename(raw.trim_matches('"'));
            if !name.is_empty() {
                plain = Some(name);
            }
        }
    }
    plain
}

/// 入口预检结果：实际要下载的地址 + 能拿到的文件名
struct Entry {
    /// 实际发起请求的地址。普通跳转沿用原始链接（保留 Referer 跟随），
    /// 落地页则换成页面里解析出的真实地址。
    url: String,
    /// 建议文件名：优先 `Content-Disposition`，其次跳转后地址的路径名
    filename: Option<String>,
}

/// 预检入口链接：跟随 HTTP 跳转；如果最终拿到的是网页（下载落地页），
/// 就从 HTML 里找真实文件地址（meta refresh / JS 跳转 / 带文件扩展名的链接），
/// 最多跟 [`ENTRY_HOPS`] 跳。
///
/// 两类“看不到文件地址”的链接都在这里解决：
/// - 入口脚本 301/302 到真实文件（`downloadHr60.php?pro=hr60` → `….exe`）：
///   传输本来就会跟随跳转，但文件名要取最终地址，入口脚本名没有意义；
/// - 下载落地页：文件地址由页面里的 JS 拼出来，HTTP 层没有跳转，
///   只能解析页面。解析不到就报错——把网页当文件存下来只会让人困惑。
async fn resolve_entry(
    client: &Client,
    url: &str,
    cancel: Option<&Cancel>,
) -> Result<Entry, String> {
    let no_file = "这个链接返回的是网页，没有找到可下载的文件地址".to_string();
    let mut current = url.to_string();
    for _ in 0..ENTRY_HOPS {
        let response = entry_response(client, &current, cancel).await?;
        let final_url = response.url().clone();
        let disposition = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .and_then(filename_from_disposition);

        if !is_html(&response) {
            return Ok(Entry {
                url: current,
                filename: disposition.or_else(|| filename_from_path(final_url.as_str())),
            });
        }

        // 带 Range 的探测对网页只拿到了 1 字节，得整页重取一次
        let page = if response.status() == StatusCode::PARTIAL_CONTENT {
            send_get(client, final_url.as_str(), cancel).await?
        } else {
            response
        };
        let html = read_limited(page, HTML_LIMIT).await;
        let Some(next) = download_url_from_html(&html, &final_url) else {
            return Err(no_file);
        };
        if next == final_url {
            return Err(no_file);
        }
        current = next.to_string();
    }
    Err("链接经过多次跳转仍未指向文件".to_string())
}

/// 先带 `Range: bytes=0-0` 探测（支持分段的站点只回 1 字节），
/// 被拒时退回普通 GET——有些站对带 Range 的请求直接 400/403。
async fn entry_response(
    client: &Client,
    url: &str,
    cancel: Option<&Cancel>,
) -> Result<Response, String> {
    let response = tokio::select! {
        _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
        result = client.get(url).header(reqwest::header::RANGE, "bytes=0-0").send() => {
            result.map_err(|e| format!("请求失败：{e}"))?
        }
    };
    if response.status().is_success() {
        return Ok(response);
    }
    send_get(client, url, cancel).await
}

async fn send_get(
    client: &Client,
    url: &str,
    cancel: Option<&Cancel>,
) -> Result<Response, String> {
    let response = tokio::select! {
        _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
        result = client.get(url).send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(format!("HTTP {}", response.status()))
    }
}

fn is_html(response: &Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("text/html") || value.contains("application/xhtml")
        })
}

/// 读响应体前 `limit` 字节：落地页解析只需要页面开头的链接，不整页拉下来
async fn read_limited(response: Response, limit: usize) -> String {
    let mut buffer = Vec::with_capacity(8192);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);
        if buffer.len() >= limit {
            break;
        }
    }
    buffer.truncate(limit);
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 页面里只有带这些扩展名的链接才当作下载地址，避免把导航、图标、样式表误认成文件
const DOWNLOAD_EXTS: &[&str] = &[
    "exe", "msi", "msix", "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst",
    "dmg", "pkg", "deb", "rpm", "apk", "iso", "pdf", "whl", "jar", "bin", "appimage",
    "mp4", "mkv", "mp3",
];

/// 从落地页里找真实下载地址，依次看：
/// 1. `<meta http-equiv="refresh" content="0;url=...">`
/// 2. JS 跳转：`location.href =` / `window.location =` / `location.replace(...)` / `assign(...)`
/// 3. `<a href="...">` 里带文件扩展名的链接
fn download_url_from_html(html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    // 只做 ASCII 小写：非 ASCII 字节原样保留，下标与原文一一对应，
    // 定位用小写副本，取值回原文（URL 大小写敏感）
    let lower = html.to_ascii_lowercase();
    meta_refresh_target(&lower, html, base)
        .or_else(|| js_location_target(&lower, html, base))
        .or_else(|| anchor_target(&lower, html, base))
}

fn meta_refresh_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("<meta") {
        let start = cursor + at;
        let Some(close) = lower[start..].find('>') else { break };
        let end = start + close;
        let tag = &lower[start..end];
        if tag.contains("http-equiv") && tag.contains("refresh") {
            if let Some(pos) = tag.find("content") {
                if let Some(value) = attr_value(tag, &html[start..end], pos) {
                    let value_lower = value.to_ascii_lowercase();
                    if let Some(url_pos) = value_lower.find("url") {
                        if let Some((_, raw)) = value[url_pos..].split_once('=') {
                            let raw = raw.trim().trim_matches(|c| c == '\'' || c == '"');
                            if let Some(url) = normalize_url(raw, base) {
                                return Some(url);
                            }
                        }
                    }
                }
            }
        }
        cursor = end + 1;
    }
    None
}

fn js_location_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("location") {
        let start = cursor + at;
        cursor = start + "location".len();
        let tail = &lower[cursor..];
        // 只认 `.href`、`.replace(`、`.assign(`，以及 `location = "..."` 这种直接赋值；
        // `regexp.location` 之类的正文不会被误当成跳转
        let op = if tail.starts_with(".href") {
            cursor + ".href".len()
        } else if tail.starts_with(".replace") {
            cursor + ".replace".len()
        } else if tail.starts_with(".assign") {
            cursor + ".assign".len()
        } else {
            let trimmed = tail.trim_start();
            if !trimmed.starts_with('=') {
                continue;
            }
            cursor + (tail.len() - trimmed.len())
        };
        // 符号前只允许空白，避免把 `location.href.indexOf(` 这类调用当成跳转
        let window = &lower[op..(op + 16).min(lower.len())];
        let Some(sign) = window.find(['=', '(']) else { continue };
        if !window[..sign].trim().is_empty() {
            continue;
        }
        if let Some(raw) = next_quoted(lower, html, op + sign + 1, 256) {
            if let Some(url) = normalize_url(&raw, base) {
                return Some(url);
            }
        }
    }
    None
}

fn anchor_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("<a ") {
        let start = cursor + at;
        let Some(close) = lower[start..].find('>') else { break };
        let end = start + close;
        let (tag_lower, tag) = (&lower[start..end], &html[start..end]);
        if let Some(pos) = tag_lower.find("href") {
            if let Some(raw) = attr_value(tag_lower, tag, pos) {
                if let Some(url) = normalize_url(&raw, base) {
                    if has_download_ext(&url) {
                        return Some(url);
                    }
                }
            }
        }
        cursor = end + 1;
    }
    None
}

/// 取 `pos` 处属性 `key=` 后面的值（`pos` 是属性名起点），支持单/双引号与无引号。
/// `lower` 与 `source` 是同一段文本的大小写两版，返回值保留原文大小写。
fn attr_value(lower: &str, source: &str, pos: usize) -> Option<String> {
    let eq = lower[pos..].find('=')?;
    let rest = &source[pos + eq + 1..];
    let trimmed = rest.trim_start();
    let first = trimmed.chars().next()?;
    if first == '"' || first == '\'' {
        let body = &trimmed[1..];
        let end = body.find(first)?;
        Some(body[..end].to_string())
    } else {
        let end = trimmed
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(trimmed.len());
        Some(trimmed[..end].to_string())
    }
}

/// 从 `from` 开始找第一个引号字符串；超过 `limit` 字节说明不是 URL，放弃
fn next_quoted(lower: &str, html: &str, from: usize, limit: usize) -> Option<String> {
    let window = &lower[from..(from + limit).min(lower.len())];
    let offset = window.find(['"', '\''])?;
    let quote_at = from + offset;
    let quote = html.as_bytes()[quote_at];
    let body = &html[quote_at + 1..];
    let end = body.as_bytes().iter().position(|b| *b == quote)?;
    Some(body[..end].to_string())
}

fn normalize_url(raw: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let raw = raw.trim().trim_matches(|c| c == '\'' || c == '"');
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return None;
    }
    let url = base.join(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

fn has_download_ext(url: &reqwest::Url) -> bool {
    let name = url
        .path()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(ext) = name.rsplit('.').next() else { return false };
    name.contains('.') && DOWNLOAD_EXTS.contains(&ext)
}

/// 重名时追加 ` (1)`、` (2)`…，不覆盖用户已有文件
pub fn unique_dest(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..10_000 {
        let name = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let next = dir.join(name);
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!(
        "{stem}-{}.bin",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ))
}

/// 下载一个文件到 `dest`。`progress` 会被高频调用，节流由本模块负责；
/// 第三个数值参数是并发连接数（1 表示单流），最后一个参数是正在进行的分片列表。
pub async fn fetch(
    client: &Client,
    url: &str,
    dest: &Path,
    threads: usize,
    cancel: Option<&Cancel>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    ensure_not_cancelled(cancel)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
    }

    let probe = probe(client, url, cancel).await?;
    let total = probe.total;
    if probe.ranges && total.unwrap_or(0) >= MIN_SEGMENT * 2 && threads > 1 {
        if let Some(total) = total {
            return download_segmented(client, url, dest, total, threads, cancel, progress).await;
        }
    }

    // 单流路径用不上分段文件，顺手清掉上次可能留下的分段进度
    remove_segment_files(dest).await;
    remove_plan(dest).await;
    download_single(client, url, dest, total, probe.response, cancel, progress).await
}

/// 取消或失败后清理临时文件；保留的分段只对“可重试的网络错误”有意义，取消一律清掉
pub async fn cleanup(dest: &Path) {
    let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
    remove_segment_files(dest).await;
    remove_plan(dest).await;
}

/// 目标是否支持 Range：用 `Range: bytes=0-0` 探测。
/// 返回 206 说明支持；返回 200 时把响应直接留给单流下载，省一次请求。
struct Probe {
    total: Option<u64>,
    ranges: bool,
    response: Option<Response>,
}

async fn probe(client: &Client, url: &str, cancel: Option<&Cancel>) -> Result<Probe, String> {
    let request = client.get(url).header(reqwest::header::RANGE, "bytes=0-0");
    let response = tokio::select! {
        _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
        result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    let status = response.status();
    // 416 或 4xx：有些站直接拒绝带 Range 的请求（403/400），换成普通 GET 再试一次
    if !status.is_success() {
        let fallback = tokio::select! {
            _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
            result = client.get(url).send() => result.map_err(|e| format!("请求失败：{e}"))?,
        };
        if !fallback.status().is_success() {
            return Err(format!("HTTP {}", fallback.status()));
        }
        let total = fallback.content_length();
        return Ok(Probe {
            total,
            ranges: false,
            response: Some(fallback),
        });
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let total = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_total);
        return Ok(Probe {
            total,
            ranges: total.is_some(),
            response: None,
        });
    }
    // 服务器忽略 Range，这个 200 响应就是完整文件
    let total = response.content_length();
    Ok(Probe {
        total,
        ranges: false,
        response: Some(response),
    })
}

fn content_range_total(value: &str) -> Option<u64> {
    // 形如 `bytes 0-0/12345`；`*` 表示总长未知
    value.rsplit('/').next()?.trim().parse().ok()
}

async fn download_segmented(
    client: &Client,
    url: &str,
    dest: &Path,
    total: u64,
    threads: usize,
    cancel: Option<&Cancel>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    ensure_not_cancelled(cancel)?;
    let chunk = chunk_size(total, threads);
    let plan = plan_segments(total, chunk);
    reset_plan_if_changed(dest, total, chunk).await?;

    // 旧版本只留了一个 `<文件>.part`：能塞进第一段就当作第 0 段继续用
    let legacy = dest.with_extension("part");
    let first = segment_path(dest, 0);
    let first_len = plan[0].1 - plan[0].0 + 1;
    if file_len(&legacy) > 0 && !first.exists() {
        if file_len(&legacy) <= first_len {
            let _ = tokio::fs::rename(&legacy, &first).await;
        } else {
            let _ = tokio::fs::remove_file(&legacy).await;
        }
    }

    // 先扫一遍已有分片：能续传的计入总进度，超长的直接作废
    let mut existing = 0u64;
    let mut existing_lens = vec![0u64; plan.len()];
    for (index, (start, end)) in plan.iter().enumerate() {
        let part = segment_path(dest, index);
        let expected = end - start + 1;
        let len = file_len(&part);
        if len > expected {
            let _ = tokio::fs::remove_file(&part).await;
        } else {
            existing_lens[index] = len;
            existing = existing.saturating_add(len);
        }
    }

    let parallelism = threads
        .clamp(1, MAX_THREADS as usize)
        .min(plan.len())
        .max(1);
    let meter = Progress::new(
        &plan,
        &existing_lens,
        existing,
        total,
        parallelism,
        progress,
    );
    meter.emit();

    // 动态调度：所有线程共用一个分片游标，先下完的线程直接取下一片。
    // 单片的下载速度受服务器/线路影响差别很大，谁快谁多干，慢的不会拖住整体。
    let cursor = AtomicUsize::new(0);
    let cursor = &cursor;
    let plan_ref = &plan;
    let lens_ref = &existing_lens;
    let meter_ref: &Progress<'_> = &meter;
    let results = join_all((0..parallelism).map(|_| async move {
        loop {
            ensure_not_cancelled(cancel)?;
            let index = cursor.fetch_add(1, Ordering::Relaxed);
            let Some(&(start, end)) = plan_ref.get(index) else {
                break;
            };
            let expected = end - start + 1;
            if lens_ref[index] >= expected {
                continue;
            }
            let part = segment_path(dest, index);
            meter_ref.begin(index);
            let result =
                download_segment(client, url, &part, start, end, cancel, meter_ref, index).await;
            meter_ref.end(index);
            result?;
        }
        Ok::<(), String>(())
    }))
    .await;
    for result in results {
        result?;
    }
    ensure_not_cancelled(cancel)?;

    let parts: Vec<PathBuf> = plan
        .iter()
        .enumerate()
        .map(|(i, _)| segment_path(dest, i))
        .collect();
    let dest_owned = dest.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || join_parts(&parts, &dest_owned, total))
        .await
        .map_err(|e| format!("合并分段失败：{e}"))??;

    remove_segment_files(dest).await;
    remove_plan(dest).await;
    meter.finish(total);
    Ok(total)
}

async fn download_segment(
    client: &Client,
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    cancel: Option<&Cancel>,
    meter: &Progress<'_>,
    index: usize,
) -> Result<(), String> {
    let expected = end - start + 1;
    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        ensure_not_cancelled(cancel)?;
        match segment_once(
            client, url, part, start, end, expected, cancel, meter, index,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if cancel.is_some_and(Cancel::is_cancelled) {
                    return Err(CANCELLED.to_string());
                }
                last_error = e;
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(format!("分段 {start}–{end} 下载失败：{last_error}"))
}

async fn segment_once(
    client: &Client,
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    expected: u64,
    cancel: Option<&Cancel>,
    meter: &Progress<'_>,
    index: usize,
) -> Result<(), String> {
    ensure_not_cancelled(cancel)?;
    let mut existing = file_len(part);
    if existing > expected {
        let _ = tokio::fs::remove_file(part).await;
        existing = 0;
    }
    if existing == expected {
        return Ok(());
    }

    let from = start + existing;
    let request = client
        .get(url)
        .header(reqwest::header::RANGE, format!("bytes={from}-{end}"));
    let response = tokio::select! {
        _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
        result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    match response.status() {
        StatusCode::PARTIAL_CONTENT => {}
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let _ = tokio::fs::remove_file(part).await;
            return Err("续传位置无效，已清理该分段".to_string());
        }
        status if status.is_success() => return Err("服务器不再支持分段下载".to_string()),
        status => return Err(format!("HTTP {status}")),
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if existing > 0 {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|e| format!("打开分段文件失败：{e}"))?;

    let mut written = existing;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        written += chunk.len() as u64;
        meter.add(index, chunk.len() as u64);
    }
    file.flush().await.map_err(|e| format!("写入失败：{e}"))?;

    if written != expected {
        return Err(format!("分段不完整（{written}/{expected} 字节）"));
    }
    Ok(())
}

async fn download_single(
    client: &Client,
    url: &str,
    dest: &Path,
    known_total: Option<u64>,
    initial: Option<Response>,
    cancel: Option<&Cancel>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    let part = dest.with_extension("part");
    let meter = Progress::single(file_len(&part), known_total.unwrap_or(0), progress);
    // 先把总长与「单线程」模式送给界面，避免长连接建立期间只有「准备下载…」
    meter.emit();
    let mut response = initial;
    let mut last_error = String::new();

    for attempt in 0..MAX_ATTEMPTS {
        ensure_not_cancelled(cancel)?;
        let existing = file_len(&part);
        // 探测得到的 200 响应是最新快照，已有续传数据时不能用它覆盖
        let initial_response = if attempt == 0 && existing == 0 {
            response.take()
        } else {
            None
        };
        match single_once(
            client,
            url,
            &part,
            existing,
            known_total,
            initial_response,
            cancel,
            &meter,
        )
        .await
        {
            Ok(downloaded) => {
                if let Some(total) = known_total {
                    if downloaded < total {
                        let _ = tokio::fs::remove_file(&part).await;
                        return Err(format!("下载不完整（{downloaded}/{total} 字节）"));
                    }
                }
                tokio::fs::rename(&part, dest)
                    .await
                    .map_err(|e| format!("保存文件失败：{e}"))?;
                meter.finish(downloaded);
                return Ok(downloaded);
            }
            Err(e) => {
                if cancel.is_some_and(Cancel::is_cancelled) {
                    return Err(CANCELLED.to_string());
                }
                last_error = e;
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last_error)
}

async fn single_once(
    client: &Client,
    url: &str,
    part: &Path,
    existing: u64,
    known_total: Option<u64>,
    initial: Option<Response>,
    cancel: Option<&Cancel>,
    meter: &Progress<'_>,
) -> Result<u64, String> {
    ensure_not_cancelled(cancel)?;
    let response = match initial {
        Some(response) => response,
        None => {
            let mut request = client.get(url);
            if existing > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
            }
            let response = tokio::select! {
                _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
                result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
            };
            if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
                let _ = tokio::fs::remove_file(part).await;
                return Err("续传位置无效，已清理临时文件".to_string());
            }
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            response
        }
    };

    // 200 表示服务器没理会 Range：从头写，进度也要归零重算
    let resumed = existing > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    let start_at = if resumed { existing } else { 0 };
    let expected = known_total.or_else(|| {
        response
            .content_length()
            .map(|remaining| remaining + start_at)
    });

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if resumed {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|e| format!("打开临时文件失败：{e}"))?;

    meter.set_done(start_at);
    meter.emit();

    let mut downloaded = start_at;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            _ = wait_cancel(cancel) => return Err(CANCELLED.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        downloaded += chunk.len() as u64;
        meter.add_global(chunk.len() as u64);
    }
    file.flush().await.map_err(|e| format!("写入失败：{e}"))?;

    if let Some(total) = expected {
        if downloaded < total {
            return Err(format!("下载中断（{downloaded}/{total} 字节）"));
        }
    }
    Ok(downloaded)
}

/// 单个分片的计数与测速：下载线程写入，emit 时读取快照
struct SegmentSlot {
    start: u64,
    end: u64,
    done: AtomicU64,
    active: AtomicBool,
    last_bytes: AtomicU64,
    last_ms: AtomicU64,
    /// f64 的位模式；原子类型只有整数操作
    speed: AtomicU64,
}

impl SegmentSlot {
    fn new(start: u64, end: u64, done: u64) -> Self {
        Self {
            start,
            end,
            done: AtomicU64::new(done),
            active: AtomicBool::new(false),
            last_bytes: AtomicU64::new(done),
            last_ms: AtomicU64::new(0),
            speed: AtomicU64::new(0f64.to_bits()),
        }
    }

    fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    /// 两次 emit 之间的瞬时速度做指数平滑，避免界面数字乱跳
    fn measure(&self, now_ms: u64) -> f64 {
        let prev = f64::from_bits(self.speed.load(Ordering::Relaxed));
        let last_ms = self.last_ms.load(Ordering::Relaxed);
        if now_ms <= last_ms {
            return prev;
        }
        let last_bytes = self.last_bytes.load(Ordering::Relaxed);
        let done = self.done.load(Ordering::Relaxed);
        if self
            .last_ms
            .compare_exchange(last_ms, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return prev;
        }
        let instant = done.saturating_sub(last_bytes) as f64 * 1000.0 / (now_ms - last_ms) as f64;
        let next = if prev > 0.0 {
            prev * 0.6 + instant * 0.4
        } else {
            instant
        };
        self.last_bytes.store(done, Ordering::Relaxed);
        self.speed.store(next.to_bits(), Ordering::Relaxed);
        next
    }
}

/// 进度汇聚：总计数 + 各分片计数，250ms 最多回调一次，避免事件把前端刷爆
struct Progress<'a> {
    start: Instant,
    last_emit_ms: AtomicU64,
    done: AtomicU64,
    total: u64,
    /// 并发连接数；1 表示单流
    parallelism: usize,
    slots: Vec<SegmentSlot>,
    callback: ProgressSink<'a>,
}

impl<'a> Progress<'a> {
    fn new(
        plan: &[(u64, u64)],
        existing_lens: &[u64],
        done: u64,
        total: u64,
        parallelism: usize,
        callback: ProgressSink<'a>,
    ) -> Self {
        let slots = plan
            .iter()
            .zip(existing_lens)
            .map(|((start, end), len)| SegmentSlot::new(*start, *end, *len))
            .collect();
        Self {
            start: Instant::now(),
            last_emit_ms: AtomicU64::new(0),
            done: AtomicU64::new(done),
            total,
            parallelism,
            slots,
            callback,
        }
    }

    fn single(done: u64, total: u64, callback: ProgressSink<'a>) -> Self {
        Self {
            start: Instant::now(),
            last_emit_ms: AtomicU64::new(0),
            done: AtomicU64::new(done),
            total,
            parallelism: 1,
            slots: Vec::new(),
            callback,
        }
    }

    /// 分片开始下载：重置测速基准并尽快把新分片送到界面
    fn begin(&self, index: usize) {
        let slot = &self.slots[index];
        let now = self.start.elapsed().as_millis() as u64;
        slot.last_bytes
            .store(slot.done.load(Ordering::Relaxed), Ordering::Relaxed);
        slot.last_ms.store(now, Ordering::Relaxed);
        slot.speed.store(0f64.to_bits(), Ordering::Relaxed);
        slot.active.store(true, Ordering::Relaxed);
        self.maybe_emit();
    }

    fn end(&self, index: usize) {
        self.slots[index].active.store(false, Ordering::Relaxed);
    }

    fn add(&self, index: usize, bytes: u64) {
        self.slots[index].done.fetch_add(bytes, Ordering::Relaxed);
        self.add_global(bytes);
    }

    fn add_global(&self, bytes: u64) {
        self.done.fetch_add(bytes, Ordering::Relaxed);
        self.maybe_emit();
    }

    fn maybe_emit(&self) {
        let now = self.start.elapsed().as_millis() as u64;
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= EMIT_INTERVAL_MS
            && self
                .last_emit_ms
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            (self.callback)(
                self.done.load(Ordering::Relaxed),
                self.total,
                self.parallelism,
                &self.snapshot(now),
            );
        }
    }

    fn set_done(&self, done: u64) {
        self.done.store(done, Ordering::Relaxed);
    }

    fn emit(&self) {
        let now = self.start.elapsed().as_millis() as u64;
        (self.callback)(
            self.done.load(Ordering::Relaxed),
            self.total,
            self.parallelism,
            &self.snapshot(now),
        );
    }

    fn finish(&self, done: u64) {
        self.set_done(done);
        self.emit();
    }

    /// 只输出仍在下载的分片：下完的立刻从列表里消失，接替它的新分片自然出现
    fn snapshot(&self, now_ms: u64) -> Vec<SegmentProgress> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                if !slot.active.load(Ordering::Relaxed) {
                    return None;
                }
                Some(SegmentProgress {
                    index,
                    start: slot.start,
                    end: slot.end,
                    downloaded: slot.done.load(Ordering::Relaxed).min(slot.len()),
                    total: slot.len(),
                    speed: slot.measure(now_ms),
                })
            })
            .collect()
    }
}

/// 分片大小：并发越多分片越多，队列里始终有可抢的份数；
/// 夹在 4 MiB–256 MiB 之间——大分片让连接有足够时间跑满带宽，小分片只留作兜底。
fn chunk_size(total: u64, threads: usize) -> u64 {
    let threads = threads.clamp(1, MAX_THREADS as usize) as u64;
    (total / (threads * SEGMENTS_PER_THREAD as u64)).clamp(MIN_SEGMENT, MAX_SEGMENT)
}

/// 分片范围（闭区间）；个数有上限，超大文件按上限反推单片长度
fn plan_segments(total: u64, chunk: u64) -> Vec<(u64, u64)> {
    let chunk = chunk.max(1);
    let count = total.div_ceil(chunk).clamp(1, MAX_SEGMENTS as u64);
    let chunk = total.div_ceil(count).max(1);
    let last = total.saturating_sub(1);
    let mut out = Vec::with_capacity(count as usize);
    let mut begin = 0u64;
    for _ in 0..count {
        let end = begin.saturating_add(chunk - 1).min(last);
        out.push((begin, end));
        if end >= last {
            break;
        }
        begin = end + 1;
    }
    out
}

fn segment_path(dest: &Path, index: usize) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!("{name}.part.{index}"))
}

fn plan_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!("{name}.part.plan"))
}

/// 分片布局（总长或单片长度）变了，旧分段的位置就不能复用：清掉重下
async fn reset_plan_if_changed(dest: &Path, total: u64, chunk: u64) -> Result<(), String> {
    let path = plan_path(dest);
    let expected = json!({ "total": total, "chunk": chunk }).to_string();
    if let Ok(raw) = tokio::fs::read_to_string(&path).await {
        if raw.trim() == expected {
            return Ok(());
        }
    }
    remove_segment_files(dest).await;
    tokio::fs::write(&path, expected)
        .await
        .map_err(|e| format!("写入下载计划失败：{e}"))
}

async fn remove_segment_files(dest: &Path) {
    let Some(parent) = dest.parent() else { return };
    let Some(name) = dest.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefix = format!("{name}.part.");
    if let Ok(mut entries) = tokio::fs::read_dir(parent).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if file_name.starts_with(&prefix) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

async fn remove_plan(dest: &Path) {
    let _ = tokio::fs::remove_file(plan_path(dest)).await;
}

fn join_parts(parts: &[PathBuf], dest: &Path, total: u64) -> Result<(), String> {
    let temp = dest.with_extension("part");
    let _ = std::fs::remove_file(&temp);
    let mut output = std::fs::File::create(&temp).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut buffer = vec![0u8; 256 * 1024];
    for part in parts {
        let mut input = std::fs::File::open(part).map_err(|e| format!("打开分段失败：{e}"))?;
        loop {
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
        }
    }
    output.flush().map_err(|e| e.to_string())?;
    drop(output);

    let size = file_len(&temp);
    if size != total {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("合并后大小不符（{size}/{total} 字节）"));
    }
    std::fs::rename(&temp, dest).map_err(|e| format!("保存文件失败：{e}"))?;
    Ok(())
}

fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Windows 不允许的字符统一换成下划线，避免下载完才发现存不下来
fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.chars().count() > 120 {
        trimmed.chars().take(120).collect()
    } else {
        trimmed
    }
}

/* ---------- 工具箱命令 ---------- */

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
    let cancel = Cancel::new();
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
        *active = Some(cancel.clone());
    }

    let handle = app.clone();
    let task_cancel = cancel.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = run_toolbox_download(&handle, &url, filename.as_deref(), &task_cancel).await;
        if let Some(state) = handle.try_state::<AppState>() {
            if let Ok(mut active) = state.download.active.lock() {
                *active = None;
            }
        }
        if let Err(error) = outcome {
            if task_cancel.is_cancelled() {
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
        Some(cancel) => {
            cancel.cancel();
            Ok(true)
        }
        None => Ok(false),
    }
}

async fn run_toolbox_download(
    app: &AppHandle,
    url: &str,
    filename: Option<&str>,
    cancel: &Cancel,
) -> Result<(), String> {
    let dir = default_dir(app)?;
    let client = client()?;
    // 入口可能不是文件本身（脚本跳转 / 下载落地页）；解析出的地址用于实际下载，
    // 避免把网页当文件存下来，顺带拿到真实文件名。
    let entry = resolve_entry(&client, url, Some(cancel)).await?;
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
    let progress = |done: u64, total: u64, parallel: usize, active: &[SegmentProgress]| {
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
    let size = match fetch(&client, &entry.url, &temp_dest, count, Some(cancel), &progress).await {
        Ok(size) => size,
        Err(error) => {
            // 工具箱每次都选新的文件名，残留分段不会再被续传，失败或取消都清掉
            cleanup(&temp_dest).await;
            remove_staging(&staging).await;
            if cancel.is_cancelled() {
                return Err(CANCELLED.to_string());
            }
            return Err(error);
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_comes_from_url_path() {
        assert_eq!(
            filename_from_url("https://example.com/a/b/report.pdf?x=1"),
            "report.pdf"
        );
        assert_eq!(
            filename_from_url("https://example.com/%E6%8A%A5%E5%91%8A%20v2.zip"),
            "报告 v2.zip"
        );
        assert!(filename_from_url("https://example.com/").starts_with("download-"));
    }

    #[test]
    fn custom_filename_overrides_url_and_falls_back_when_blank() {
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("我的报告.zip")),
            "我的报告.zip"
        );
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("x/y")),
            "x_y"
        );
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("   ")),
            "a.zip"
        );
        assert_eq!(resolve_filename("https://example.com/a.zip", None), "a.zip");
    }

    #[test]
    fn filename_is_sanitized() {
        assert_eq!(sanitize_filename("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_filename("  ..name..txt.. "), "name..txt");
    }

    #[test]
    fn filename_comes_from_content_disposition() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"Comfy-Desktop-Setup.exe\""),
            Some("Comfy-Desktop-Setup.exe".to_string())
        );
        assert_eq!(
            filename_from_disposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip; filename=fallback.zip"),
            Some("报告.zip".to_string())
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=plain.zip"),
            Some("plain.zip".to_string())
        );
        assert_eq!(filename_from_disposition("inline"), None);
    }

    #[test]
    fn segments_cover_whole_file_without_overlap() {
        let total = 10 * 1024 * 1024u64;
        let chunk = chunk_size(total, 32);
        assert_eq!(
            chunk, MIN_SEGMENT,
            "10 MiB / (32 × 3) 低于下限，按 4 MiB 切"
        );
        let parts = plan_segments(total, chunk);
        assert_eq!(parts[0].0, 0);
        assert_eq!(parts.last().unwrap().1, total - 1);
        for pair in parts.windows(2) {
            assert_eq!(pair[0].1 + 1, pair[1].0);
        }
        assert_eq!(parts.len(), 3, "10 MiB 按 4 MiB 切，得到 3 片");
    }

    #[test]
    fn chunk_plan_keeps_extra_work_queued_for_fast_threads() {
        let total = 1024 * 1024 * 1024u64; // 1 GiB
        let parts = plan_segments(total, chunk_size(total, 8));
        assert!(
            parts.len() >= 8 * 2,
            "分片数要明显多于线程数，先下完的线程才有片段可抢"
        );
        assert_eq!(parts[0].0, 0);
        assert_eq!(parts.last().unwrap().1, total - 1);

        // 超大文件受分片总数上限约束，不会生成海量临时文件
        let huge = u64::MAX / 2;
        assert!(plan_segments(huge, chunk_size(huge, 128)).len() <= MAX_SEGMENTS);

        // 小文件只切一颗
        assert_eq!(plan_segments(1024, chunk_size(1024, 32)).len(), 1);
    }

    #[test]
    fn content_range_total_parses() {
        assert_eq!(content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(content_range_total("bytes 0-0/*"), None);
    }

    #[test]
    fn unique_dest_appends_counter() {
        let dir = std::env::temp_dir().join(format!("fastnote-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_dest(&dir, "a.txt");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_dest(&dir, "a.txt");
        assert_eq!(second.file_name().unwrap(), "a (1).txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_folder_follows_download_filename() {
        assert_eq!(staging_name("FastNote_2.5.6.exe"), "FastNote_2.5.6");
        assert_eq!(staging_name("archive.tar.gz"), "archive.tar");
        assert_eq!(staging_name("installer"), "installer-parts");
        assert_eq!(staging_name("说明文档.pdf"), "说明文档");
    }

    #[test]
    fn staging_folder_keeps_unrelated_files() {
        let root = std::env::temp_dir().join(format!("fastnote-staging-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("FastNote"), b"x").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let staging = prepare_staging(&root, "FastNote").await.unwrap();
            assert_eq!(staging.file_name().unwrap(), "FastNote-1");

            tokio::fs::write(staging.join("file.bin.part.0"), b"x")
                .await
                .unwrap();
            tokio::fs::write(staging.join("keep.txt"), b"x").await.unwrap();
            remove_staging(&staging).await;
            assert!(staging.exists(), "目录里还有其他文件时不能整个删掉");
            assert!(!staging.join("file.bin.part.0").exists());

            tokio::fs::remove_file(staging.join("keep.txt")).await.unwrap();
            remove_staging(&staging).await;
            assert!(!staging.exists(), "分片清空后临时目录应删除");
        });
        let _ = std::fs::remove_dir_all(&root);
    }

    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// 本地 Range 服务器：支持 206 分片，也提供忽略 Range 的 200 路径。
    /// 返回值里的计数器记录“真正的分段请求”数量（不含 `bytes=0-0` 探测）。
    fn spawn_server(payload: Arc<Vec<u8>>, ranges: bool) -> (String, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let segment_requests = Arc::new(AtomicUsize::new(0));
        let counter = segment_requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let payload = payload.clone();
                let counter = counter.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        request.push_str(&line);
                    }
                    let range = request.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("range")
                            .then(|| value.trim().to_string())
                    });
                    if range.as_deref().is_some_and(|spec| spec != "bytes=0-0") {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    let total = payload.len();
                    let (status, start, end, body): (&str, usize, usize, &[u8]) = match range {
                        Some(spec) if ranges => {
                            let spec = spec.strip_prefix("bytes=").unwrap_or("");
                            let (from, to) = spec.split_once('-').unwrap_or(("0", ""));
                            let start: usize = from.trim().parse().unwrap_or(0);
                            let end = if to.trim().is_empty() {
                                total - 1
                            } else {
                                to.trim()
                                    .parse::<usize>()
                                    .unwrap_or(total - 1)
                                    .min(total - 1)
                            };
                            ("206 Partial Content", start, end, &payload[start..=end])
                        }
                        _ => ("200 OK", 0, total - 1, payload.as_slice()),
                    };
                    let mut head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nAccept-Ranges: bytes\r\n",
                        body.len()
                    );
                    if status.starts_with("206") {
                        head.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
                    }
                    head.push_str("\r\n");
                    stream.write_all(head.as_bytes()).unwrap();
                    stream.write_all(body).unwrap();
                    let _ = stream.flush();
                });
            }
        });
        (format!("http://{addr}/file.bin"), segment_requests)
    }

    #[test]
    fn downloads_segmented_and_single_from_local_server() {
        let payload: Arc<Vec<u8>> = Arc::new((0..20_000_000).map(|i| (i % 251) as u8).collect());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        for ranges in [true, false] {
            let (url, segment_requests) = spawn_server(payload.clone(), ranges);
            let dir = std::env::temp_dir()
                .join(format!("fastnote-dl-it-{}-{ranges}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("file.bin");
            let seen_segments = AtomicUsize::new(0);
            runtime.block_on(async {
                let client = client().unwrap();
                let progress = |_done: u64, _total: u64, segments: usize, _: &[SegmentProgress]| {
                    seen_segments.fetch_max(segments, Ordering::Relaxed);
                };
                let size = fetch(&client, &url, &dest, 8, None, &progress)
                    .await
                    .unwrap();
                assert_eq!(size, payload.len() as u64);
            });
            assert_eq!(std::fs::read(&dest).unwrap(), *payload);
            if ranges {
                assert!(
                    segment_requests.load(Ordering::Relaxed) >= 2,
                    "支持 Range 的服务器应发出多个分段请求"
                );
                assert!(seen_segments.load(Ordering::Relaxed) > 1);
                let leftovers: Vec<String> = std::fs::read_dir(&dir)
                    .unwrap()
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| name != "file.bin")
                    .collect();
                assert!(leftovers.is_empty(), "分段文件未清理：{leftovers:?}");
            } else {
                assert_eq!(segment_requests.load(Ordering::Relaxed), 0);
                assert_eq!(seen_segments.load(Ordering::Relaxed), 1);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// 入口脚本服务器：任何请求都 301 到 `location`，模拟 `download.php?pro=x` 这类入口
    fn spawn_redirect_server(location: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let head = format!(
                    "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/product/download.php?pro=x")
    }

    /// 落地页服务器：任何请求都返回一段 HTML，模拟文件地址写在页面里的下载页
    fn spawn_html_server(html: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    html.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(html.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/downloads/app")
    }

    #[test]
    fn redirected_entry_takes_filename_from_final_url() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![9u8; 4096]);
        let (target, _) = spawn_server(payload, true);
        let entry = spawn_redirect_server(target.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = client().unwrap();
            let found = resolve_entry(&client, &entry, None).await.unwrap();
            assert_eq!(
                found.filename.as_deref(),
                Some("file.bin"),
                "入口是 download.php 时，文件名要取重定向后的最终地址"
            );
            assert_eq!(found.url, entry, "普通跳转沿用原始链接，保留 Referer 跟随");
        });
    }

    #[test]
    fn landing_page_urls_are_extracted() {
        let base = reqwest::Url::parse("https://example.com/download/page.html").unwrap();
        let meta = r#"<meta http-equiv="refresh" content="0;URL='/files/app.exe'">"#;
        assert_eq!(
            download_url_from_html(meta, &base).unwrap().as_str(),
            "https://example.com/files/app.exe"
        );
        let js = r#"<script>window.location.href = "/files/app.zip";</script>"#;
        assert_eq!(
            download_url_from_html(js, &base).unwrap().as_str(),
            "https://example.com/files/app.zip"
        );
        let assign = r#"<script>location.assign('/files/setup.msi')</script>"#;
        assert_eq!(
            download_url_from_html(assign, &base).unwrap().as_str(),
            "https://example.com/files/setup.msi"
        );
        let anchor = r#"<a class="btn" href="/files/tool-1.2.dmg">下载</a>"#;
        assert_eq!(
            download_url_from_html(anchor, &base).unwrap().as_str(),
            "https://example.com/files/tool-1.2.dmg"
        );
        // 普通导航链接、JS 取值调用都不算下载地址
        assert!(download_url_from_html(r#"<a href="/about">关于</a>"#, &base).is_none());
        assert!(
            download_url_from_html(r#"<script>if (location.href.indexOf("x") > 0) {}</script>"#, &base)
                .is_none()
        );
    }

    #[test]
    fn landing_page_resolves_to_real_file() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![3u8; 4096]);
        let (target, _) = spawn_server(payload, true);
        for template in [
            r#"<html><head><meta http-equiv="refresh" content="0; url=TARGET"></head></html>"#,
            r#"<html><script>window.location = "TARGET";</script></html>"#,
        ] {
            let entry_url = spawn_html_server(template.replace("TARGET", &target));
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let client = client().unwrap();
                let found = resolve_entry(&client, &entry_url, None).await.unwrap();
                assert_eq!(found.url, target);
                assert_eq!(found.filename.as_deref(), Some("file.bin"));
            });
        }
    }

    #[test]
    fn landing_page_without_file_link_errors() {
        let entry_url = spawn_html_server("<html><body>没有下载链接</body></html>".to_string());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = client().unwrap();
            assert!(resolve_entry(&client, &entry_url, None).await.is_err());
        });
    }

    #[test]
    fn cancelled_download_returns_without_touching_disk() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![7u8; 100_000]);
        let (url, _) = spawn_server(payload, true);
        let dir = std::env::temp_dir().join(format!("fastnote-dl-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("file.bin");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let cancel = Cancel::new();
        cancel.cancel();
        runtime.block_on(async {
            let client = client().unwrap();
            let progress = |_done: u64, _total: u64, _segments: usize, _: &[SegmentProgress]| {};
            let error = fetch(&client, &url, &dest, 4, Some(&cancel), &progress)
                .await
                .unwrap_err();
            assert_eq!(error, CANCELLED);
        });
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
