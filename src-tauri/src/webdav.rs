//! WebDAV 云备份：连接配置、手动备份 / 恢复、云端列表，以及定时自动备份。
//!
//! 约定：
//! - 服务器、账号、文件夹等非敏感项存在 `app.config.webdav.*`，由前端设置层维护；
//! - 密码单独存 `webdav.password`，用主密钥加密，不进普通备份；
//! - 自动备份只生成 JSON、永不含 API Key；本地默认落在程序目录的 `backup`，
//!   云端文件夹默认 `FastNote`，本地按「最多保留 N 份」清理最早的自动备份，云端不清理。
//!
//! 只实现 Basic Auth + PROPFIND / MKCOL / PUT / GET 这几种最小可用能力，
//! 足以覆盖 Nextcloud、Alist、群晖、坚果云等常见 WebDAV 服务。

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use chrono::{DateTime, Local};
use reqwest::{Client, Method, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::{AppState, BackupSummary};

const PASSWORD_KEY: &str = "webdav.password";
const LAST_BACKUP_KEY: &str = "webdav.lastAutoBackupAt";
const LAST_ATTEMPT_KEY: &str = "webdav.lastAutoAttemptAt";
const LAST_ERROR_KEY: &str = "webdav.lastAutoError";
const LAST_FILE_KEY: &str = "webdav.lastAutoFile";

/// 自动备份失败后的重试间隔：成功后再按用户设定的周期走
const RETRY_SECS: i64 = 600;
/// 自动备份文件名前缀：本地只清理这个前缀，不碰用户自己放进来的文件
const AUTO_PREFIX: &str = "fastnote-auto-";

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>"#;

/// WebDAV 任务锁：同一时间只允许一个备份 / 恢复 / 测试任务，避免并发写坏临时文件
#[derive(Default)]
pub struct WebdavState {
    busy: Mutex<bool>,
}

fn begin(state: &WebdavState) -> Result<(), String> {
    let mut busy = state
        .busy
        .lock()
        .map_err(|_| "WebDAV 状态锁被占用".to_string())?;
    if *busy {
        return Err("已有 WebDAV 任务在进行，请稍候".to_string());
    }
    *busy = true;
    Ok(())
}

fn end(state: &WebdavState) {
    if let Ok(mut busy) = state.busy.lock() {
        *busy = false;
    }
}

/* ---------------- 配置 ---------------- */

#[derive(Clone)]
struct Config {
    server: String,
    username: String,
    password: String,
    folder: String,
    auto_backup: bool,
    interval_hours: u64,
    target: String,
    max_local: u64,
}

fn setting_raw(conn: &rusqlite::Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        rusqlite::params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

fn setting_string(conn: &rusqlite::Connection, key: &str, fallback: &str) -> String {
    setting_raw(conn, key)
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .unwrap_or_else(|| fallback.to_string())
}

fn setting_bool(conn: &rusqlite::Connection, key: &str, fallback: bool) -> bool {
    setting_raw(conn, key)
        .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
        .unwrap_or(fallback)
}

fn setting_u64(conn: &rusqlite::Connection, key: &str, fallback: u64) -> u64 {
    setting_raw(conn, key)
        .and_then(|raw| serde_json::from_str::<u64>(&raw).ok())
        .unwrap_or(fallback)
}

fn meta_set(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        rusqlite::params![key, value, Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_config(app: &AppHandle) -> Result<Config, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "数据库尚未初始化".to_string())?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let stored = setting_raw(&conn, PASSWORD_KEY).unwrap_or_default();
    let password = if stored.is_empty() {
        String::new()
    } else {
        crate::decrypt_secret(&conn, &stored)
            .map_err(|e| format!("读取 WebDAV 密码失败：{e}"))?
    };

    Ok(Config {
        server: setting_string(&conn, "app.config.webdav.server", ""),
        username: setting_string(&conn, "app.config.webdav.username", ""),
        password,
        folder: clean_folder(&setting_string(&conn, "app.config.webdav.folder", "FastNote")),
        auto_backup: setting_bool(&conn, "app.config.webdav.autoBackup", false),
        interval_hours: setting_u64(&conn, "app.config.webdav.autoIntervalHours", 1).clamp(1, 720),
        target: setting_string(&conn, "app.config.webdav.autoTarget", "both"),
        max_local: setting_u64(&conn, "app.config.webdav.autoMaxLocal", 10).clamp(1, 200),
    })
}

/// 文件夹名按路径段清理：去掉空段 / `.` / `..`，防止把备份写到服务器根目录之外
fn clean_folder(raw: &str) -> String {
    let parts: Vec<&str> = raw
        .split('/')
        .map(str::trim)
        .filter(|part| !part.is_empty() && *part != "." && *part != "..")
        .collect();
    if parts.is_empty() {
        "FastNote".to_string()
    } else {
        parts.join("/")
    }
}

/* ---------------- 本地备份目录 ---------------- */

/// 本地自动备份目录：程序目录下的 `backup`，不可写时退回应用数据目录
pub fn backup_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let target = dir.join("backup");
            if std::fs::create_dir_all(&target).is_ok() {
                return Ok(target);
            }
        }
    }
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?;
    let target = base.join("backup");
    std::fs::create_dir_all(&target).map_err(|e| format!("创建备份目录失败：{e}"))?;
    Ok(target)
}

/// 只保留最近 `max` 份自动备份；用户手动放进目录的其他文件不动
fn prune_local(dir: &Path, max: u64) {
    let mut files: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(AUTO_PREFIX) || !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            files.push((entry.path(), meta.modified().unwrap_or(std::time::UNIX_EPOCH)));
        }
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    for (path, _) in files.into_iter().skip(max as usize) {
        let _ = std::fs::remove_file(path);
    }
}

/* ---------------- HTTP / WebDAV ---------------- */

fn http_client() -> Result<Client, String> {
    crate::download::client()
}

fn request(client: &Client, method: Method, url: reqwest::Url, cfg: &Config) -> reqwest::RequestBuilder {
    client
        .request(method, url)
        .basic_auth(cfg.username.clone(), Some(cfg.password.clone()))
}

fn status_error(action: &str, status: StatusCode) -> String {
    match status.as_u16() {
        401 => format!("{action}失败：账号或密码不正确"),
        403 => format!("{action}失败：账号没有写入权限"),
        404 => format!("{action}失败：服务器路径不存在"),
        507 => format!("{action}失败：云端空间不足"),
        _ => format!("{action}失败：HTTP {status}"),
    }
}

fn folder_url(cfg: &Config) -> Result<reqwest::Url, String> {
    let server = cfg.server.trim();
    if server.is_empty() {
        return Err("尚未填写 WebDAV 服务器地址".to_string());
    }
    let mut url =
        reqwest::Url::parse(server).map_err(|_| "WebDAV 地址格式不正确".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("WebDAV 地址只支持 http / https".to_string());
    }
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "WebDAV 地址不能作为目录".to_string())?;
        segments.pop_if_empty();
        for segment in clean_folder(&cfg.folder).split('/') {
            segments.push(segment);
        }
        segments.push("");
    }
    Ok(url)
}

fn file_url(cfg: &Config, name: &str) -> Result<reqwest::Url, String> {
    let mut url = folder_url(cfg)?;
    url.path_segments_mut()
        .map_err(|_| "WebDAV 地址不能作为目录".to_string())?
        .pop_if_empty()
        .push(name);
    Ok(url)
}

fn mkcol_method() -> Method {
    Method::from_bytes(b"MKCOL").unwrap_or(Method::POST)
}

fn propfind_method() -> Method {
    Method::from_bytes(b"PROPFIND").unwrap_or(Method::GET)
}

/// 确保云端文件夹存在：MKCOL 已存在会返回 405，按成功处理；随后 PROPFIND 验证可读
async fn ensure_folder(client: &Client, cfg: &Config) -> Result<reqwest::Url, String> {
    let url = folder_url(cfg)?;
    let response = request(client, mkcol_method(), url.clone(), cfg)
        .send()
        .await
        .map_err(|e| format!("连接 WebDAV 失败：{e}"))?;
    match response.status().as_u16() {
        200 | 201 | 204 | 405 => {}
        status => return Err(status_error("创建云端文件夹", StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST))),
    }

    let response = request(client, propfind_method(), url.clone(), cfg)
        .header("Depth", "0")
        .header(reqwest::header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await
        .map_err(|e| format!("连接 WebDAV 失败：{e}"))?;
    match response.status().as_u16() {
        200 | 207 => Ok(url),
        status => Err(status_error(
            "读取云端文件夹",
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        )),
    }
}

/// 上传一个本地文件到云端文件夹
async fn put_file(
    client: &Client,
    cfg: &Config,
    name: &str,
    body: Vec<u8>,
) -> Result<(), String> {
    ensure_folder(client, cfg).await?;
    let url = file_url(cfg, name)?;
    let response = request(client, Method::PUT, url, cfg)
        .header(reqwest::header::CONTENT_TYPE, "application/json; charset=utf-8")
        .body(body)
        .send()
        .await
        .map_err(|e| format!("上传备份失败：{e}"))?;
    match response.status().as_u16() {
        200 | 201 | 204 => Ok(()),
        status => Err(status_error(
            "上传备份",
            StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST),
        )),
    }
}

/* ---------------- 备份 / 恢复 ---------------- */

#[derive(Serialize)]
pub struct CloudBackupResult {
    pub file: String,
    pub summary: BackupSummary,
}

fn new_local_backup(app: &AppHandle, prefix: &str) -> Result<(PathBuf, BackupSummary), String> {
    let dir = backup_dir(app)?;
    let path = dir.join(format!(
        "{prefix}{}.json",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    let summary = crate::backup_export_for_webdav(
        app.state::<AppState>(),
        path.to_string_lossy().to_string(),
        false,
        false,
        app.clone(),
    )?;
    Ok((path, summary))
}

async fn cloud_backup(
    app: &AppHandle,
    client: &Client,
    cfg: &Config,
    include_api_keys: bool,
    include_webdav: bool,
) -> Result<CloudBackupResult, String> {
    ensure_folder(client, cfg).await?;

    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let name = format!("fastnote-{stamp}.json");
    let temp = std::env::temp_dir().join(format!(
        "fastnote-webdav-{}-{stamp}.json",
        std::process::id()
    ));

    let summary = crate::backup_export_for_webdav(
        app.state::<AppState>(),
        temp.to_string_lossy().to_string(),
        include_api_keys,
        include_webdav,
        app.clone(),
    );

    let result = match summary {
        Ok(summary) => match tokio::fs::read(&temp).await {
            Ok(bytes) => match put_file(client, cfg, &name, bytes).await {
                Ok(()) => Ok(CloudBackupResult { file: name, summary }),
                Err(e) => Err(e),
            },
            Err(e) => Err(format!("读取临时备份文件失败：{e}")),
        },
        Err(e) => Err(e),
    };

    let _ = tokio::fs::remove_file(&temp).await;
    result
}

#[derive(Serialize)]
pub struct LocalBackupFile {
    pub name: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Serialize)]
pub struct RemoteBackupFile {
    pub name: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Serialize)]
pub struct WebdavStatus {
    pub has_password: bool,
    pub last_backup_at: Option<String>,
    pub last_error: Option<String>,
    pub last_file: Option<String>,
    pub backup_dir: String,
}

#[tauri::command]
pub fn webdav_status(app: AppHandle) -> Result<WebdavStatus, String> {
    let state = app
        .try_state::<AppState>()
        .ok_or_else(|| "数据库尚未初始化".to_string())?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let meta = |key: &str| {
        setting_raw(&conn, key).filter(|value| !value.is_empty())
    };
    Ok(WebdavStatus {
        has_password: meta(PASSWORD_KEY).is_some(),
        last_backup_at: meta(LAST_BACKUP_KEY),
        last_error: meta(LAST_ERROR_KEY),
        last_file: meta(LAST_FILE_KEY),
        backup_dir: backup_dir(&app)?.to_string_lossy().to_string(),
    })
}

/// 保存密码（空串表示清除）；明文绝不落库
#[tauri::command]
pub fn webdav_set_password(password: String, state: State<AppState>) -> Result<(), String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let stored = if password.is_empty() {
        String::new()
    } else {
        crate::encrypt_secret(&conn, &password)?
    };
    meta_set(&conn, PASSWORD_KEY, &stored)
}

/// 测试连接：参数有值就覆盖库里的配置（用于「还没保存就直接测」），
/// 成功后云端文件夹已创建并验证可读。
#[tauri::command]
pub async fn webdav_test(
    app: AppHandle,
    server: Option<String>,
    username: Option<String>,
    password: Option<String>,
    folder: Option<String>,
) -> Result<String, String> {
    let mut cfg = load_config(&app)?;
    if let Some(value) = server {
        cfg.server = value;
    }
    if let Some(value) = username {
        cfg.username = value;
    }
    if let Some(value) = password {
        cfg.password = value;
    }
    if let Some(value) = folder {
        cfg.folder = clean_folder(&value);
    }
    let client = http_client()?;
    let url = ensure_folder(&client, &cfg).await?;
    Ok(format!("连接成功：{}", url.path()))
}

#[tauri::command]
pub async fn webdav_backup(
    app: AppHandle,
    include_api_keys: bool,
    include_webdav: bool,
) -> Result<CloudBackupResult, String> {
    let state = app.state::<AppState>();
    begin(&state.webdav)?;
    let result = async {
        let cfg = load_config(&app)?;
        let client = http_client()?;
        cloud_backup(&app, &client, &cfg, include_api_keys, include_webdav).await
    }
    .await;
    end(&state.webdav);
    result
}

/// 云端备份列表：只列 JSON 备份，按修改时间倒序
#[tauri::command]
pub async fn webdav_list_remote(app: AppHandle) -> Result<Vec<RemoteBackupFile>, String> {
    let cfg = load_config(&app)?;
    let client = http_client()?;
    let url = ensure_folder(&client, &cfg).await?;

    let response = request(&client, propfind_method(), url, &cfg)
        .header("Depth", "1")
        .header(reqwest::header::CONTENT_TYPE, "application/xml; charset=utf-8")
        .body(PROPFIND_BODY)
        .send()
        .await
        .map_err(|e| format!("读取云端备份列表失败：{e}"))?;
    if response.status().as_u16() != 207 {
        return Err(status_error("读取云端备份列表", response.status()));
    }
    let xml = response
        .text()
        .await
        .map_err(|e| format!("读取云端备份列表失败：{e}"))?;

    let mut out = Vec::new();
    for block in response_blocks(&xml) {
        // 文件夹本身（href 以 / 结尾或 resourcetype 是 collection）跳过
        if is_collection(block) {
            continue;
        }
        let Some(href) = xml_text(block, "href") else {
            continue;
        };
        let raw = href.trim_end_matches('/').rsplit('/').next().unwrap_or("");
        let name = percent_decode(raw);
        if !name.starts_with("fastnote-") || !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        out.push(RemoteBackupFile {
            size: xml_text(block, "getcontentlength")
                .and_then(|value| value.parse().ok())
                .unwrap_or(0),
            modified: xml_text(block, "getlastmodified")
                .and_then(|value| DateTime::parse_from_rfc2822(&value).ok())
                .map(|time| time.with_timezone(&Local).to_rfc3339())
                .unwrap_or_default(),
            name,
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

/// 从云端下载指定备份并覆盖恢复
#[tauri::command]
pub async fn webdav_restore_remote(app: AppHandle, name: String) -> Result<BackupSummary, String> {
    validate_name(&name)?;
    let state = app.state::<AppState>();
    begin(&state.webdav)?;

    let result = async {
        let cfg = load_config(&app)?;
        let client = http_client()?;
        let url = file_url(&cfg, &name)?;
        let response = request(&client, Method::GET, url, &cfg)
            .send()
            .await
            .map_err(|e| format!("下载云端备份失败：{e}"))?;
        if !response.status().is_success() {
            return Err(status_error("下载云端备份", response.status()));
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|e| format!("下载云端备份失败：{e}"))?;

        let temp = std::env::temp_dir().join(format!(
            "fastnote-restore-{}-{}.json",
            std::process::id(),
            Local::now().format("%Y%m%d-%H%M%S")
        ));
        tokio::fs::write(&temp, &bytes)
            .await
            .map_err(|e| format!("写入临时文件失败：{e}"))?;
        let outcome = crate::backup_import_for_webdav(app.state::<AppState>(), temp.to_string_lossy().to_string());
        let _ = tokio::fs::remove_file(&temp).await;
        outcome
    }
    .await;

    end(&state.webdav);
    result
}

/// 本地备份列表：自动备份目录里的 JSON / SQLite 文件
#[tauri::command]
pub fn webdav_list_local(app: AppHandle) -> Result<Vec<LocalBackupFile>, String> {
    let dir = backup_dir(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(out);
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let lower = name.to_ascii_lowercase();
        if !name.starts_with("fastnote-")
            || !(lower.ends_with(".json") || lower.ends_with(".db") || lower.ends_with(".sqlite"))
        {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(LocalBackupFile {
            name,
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .map(|time| DateTime::<Local>::from(time).to_rfc3339())
                .unwrap_or_default(),
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

/// 从本地备份目录恢复：按扩展名分派 JSON / SQLite
#[tauri::command]
pub fn webdav_restore_local(app: AppHandle, name: String) -> Result<BackupSummary, String> {
    validate_name(&name)?;
    let dir = backup_dir(&app)?;
    let path = dir.join(&name);
    if !path.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".json") {
        crate::backup_import_for_webdav(app.state::<AppState>(), path.to_string_lossy().to_string())
    } else if lower.ends_with(".db") || lower.ends_with(".sqlite") {
        crate::backup_import_sqlite_for_webdav(app.state::<AppState>(), path.to_string_lossy().to_string())
    } else {
        Err("只支持 .json / .db / .sqlite 备份".to_string())
    }
}

#[tauri::command]
pub fn webdav_backup_dir(app: AppHandle) -> Result<String, String> {
    Ok(backup_dir(&app)?.to_string_lossy().to_string())
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name.contains("..")
        || name.starts_with('.')
    {
        return Err("备份文件名不合法".to_string());
    }
    Ok(())
}

/* ---------------- 自动备份 ---------------- */

/// 每 60 秒检查一次；成功或失败都写回状态，界面里能直接看到最近一次结果
pub fn spawn_auto_backup(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // 首屏加载与启动任务先跑，避免抢占数据库锁
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            if let Err(error) = auto_backup_tick(&app).await {
                eprintln!("[fastnote] 自动备份失败：{error}");
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}

async fn auto_backup_tick(app: &AppHandle) -> Result<(), String> {
    let cfg = match load_config(app) {
        Ok(cfg) => cfg,
        Err(error) => {
            record_auto_error(app, &error);
            return Ok(());
        }
    };
    if !cfg.auto_backup {
        return Ok(());
    }

    let now = Local::now();
    let (last_success, last_attempt) = {
        let state = app
            .try_state::<AppState>()
            .ok_or_else(|| "数据库尚未初始化".to_string())?;
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        (
            setting_raw(&conn, LAST_BACKUP_KEY).and_then(|value| parse_time(&value)),
            setting_raw(&conn, LAST_ATTEMPT_KEY).and_then(|value| parse_time(&value)),
        )
    };

    // 失败后 10 分钟内不再重试；成功则按用户设定的间隔走
    if last_attempt.is_some_and(|time| now.signed_duration_since(time).num_seconds() < RETRY_SECS) {
        return Ok(());
    }
    let interval = (cfg.interval_hours.max(1) * 3600) as i64;
    if last_success.is_some_and(|time| now.signed_duration_since(time).num_seconds() < interval) {
        return Ok(());
    }

    let state = app.state::<AppState>();
    if begin(&state.webdav).is_err() {
        // 用户正在手动操作，下一轮再说
        return Ok(());
    }
    record_meta(app, LAST_ATTEMPT_KEY, &now.to_rfc3339());

    let result = async {
        let mut done: Vec<String> = Vec::new();
        if cfg.target == "local" || cfg.target == "both" {
            let (path, _) = new_local_backup(app, AUTO_PREFIX)?;
            prune_local(&backup_dir(app)?, cfg.max_local);
            done.push(
                path.file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("本地备份")
                    .to_string(),
            );
        }
        if cfg.target == "cloud" || cfg.target == "both" {
            let client = http_client()?;
            let name = format!("{AUTO_PREFIX}{}.json", now.format("%Y%m%d-%H%M%S"));
            let temp = std::env::temp_dir().join(format!(
                "fastnote-auto-{}-{}.json",
                std::process::id(),
                now.format("%Y%m%d-%H%M%S")
            ));
            let exported = crate::backup_export_for_webdav(
                app.state::<AppState>(),
                temp.to_string_lossy().to_string(),
                false,
                false,
                app.clone(),
            );
            let upload = match exported {
                Ok(_) => match tokio::fs::read(&temp).await {
                    Ok(bytes) => put_file(&client, &cfg, &name, bytes).await,
                    Err(e) => Err(format!("读取临时备份文件失败：{e}")),
                },
                Err(e) => Err(e),
            };
            let _ = tokio::fs::remove_file(&temp).await;
            upload?;
            done.push(name);
        }
        Ok::<_, String>(done.join("、"))
    }
    .await;

    end(&state.webdav);

    match result {
        Ok(files) => {
            let stamp = Local::now().to_rfc3339();
            record_meta(app, LAST_BACKUP_KEY, &stamp);
            record_meta(app, LAST_FILE_KEY, &files);
            record_meta(app, LAST_ERROR_KEY, "");
        }
        Err(error) => record_auto_error(app, &error),
    }
    Ok(())
}

fn parse_time(raw: &str) -> Option<DateTime<Local>> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|time| time.with_timezone(&Local))
}

fn record_meta(app: &AppHandle, key: &str, value: &str) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(conn) = state.conn.lock() {
            let _ = meta_set(&conn, key, value);
        }
    }
}

fn record_auto_error(app: &AppHandle, error: &str) {
    record_meta(app, LAST_ERROR_KEY, error);
}

/* ---------------- XML 解析（不引第三方依赖） ---------------- */

/// 找出指定局部名的元素，返回（开始标记起点, 内容起点, 内容终点）。
/// 命名空间前缀不参与匹配：`<d:href>`、`<D:href>`、`<href>` 都能认。
fn find_element(xml: &str, name: &str, from: usize) -> Option<(usize, usize, usize)> {
    let bytes = xml.as_bytes();
    let mut pos = from.min(bytes.len());
    while let Some(offset) = xml[pos..].find('<') {
        let open = pos + offset;
        let closing = xml[open..].starts_with("</");
        let mut cursor = open + 1;
        if closing {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && (bytes[cursor].is_ascii_alphanumeric()
                || matches!(bytes[cursor], b'_' | b'-' | b':' | b'.'))
        {
            cursor += 1;
        }
        let raw_name = &xml[name_start..cursor];
        let local = raw_name.rsplit(':').next().unwrap_or(raw_name);
        if closing || !local.eq_ignore_ascii_case(name) {
            pos = cursor.max(open + 1);
            continue;
        }

        let open_end = xml[cursor..].find('>')? + cursor + 1;
        if xml[cursor..open_end.saturating_sub(1)].trim_end().ends_with('/') {
            return Some((open, open_end, open_end));
        }

        let mut scan = open_end;
        while let Some(close_offset) = xml[scan..].find("</") {
            let close = scan + close_offset;
            let close_start = close + 2;
            let Some(close_end_offset) = xml[close_start..].find('>') else {
                break;
            };
            let close_end = close_start + close_end_offset;
            let close_raw = xml[close_start..close_end].trim();
            let close_local = close_raw.rsplit(':').next().unwrap_or(close_raw);
            if close_local.eq_ignore_ascii_case(local) {
                return Some((open, open_end, close));
            }
            scan = close_end + 1;
        }
        return None;
    }
    None
}

fn xml_text(xml: &str, name: &str) -> Option<String> {
    let (_, start, end) = find_element(xml, name, 0)?;
    Some(decode_entities(xml.get(start..end)?.trim()))
}

fn response_blocks(xml: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some((open, _, end)) = find_element(xml, "response", from) {
        out.push(&xml[open..end]);
        from = end + 1;
    }
    out
}

fn is_collection(block: &str) -> bool {
    xml_text(block, "resourcetype")
        .map(|value| value.to_ascii_lowercase().contains("collection"))
        .unwrap_or(false)
        || xml_text(block, "href")
            .map(|value| value.trim_end().ends_with('/'))
            .unwrap_or(false)
}

fn decode_entities(raw: &str) -> String {
    raw.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_is_normalized() {
        assert_eq!(clean_folder(""), "FastNote");
        assert_eq!(clean_folder(" / ../ "), "FastNote");
        assert_eq!(clean_folder("/a//b/../c/"), "a/b/c");
    }

    #[test]
    fn parses_propfind_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/dav/FastNote/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/dav/FastNote/fastnote-auto-20261025-120000.json</D:href>
    <D:propstat><D:prop>
      <D:getcontentlength>2048</D:getcontentlength>
      <D:getlastmodified>Sat, 25 Oct 2026 12:00:00 GMT</D:getlastmodified>
      <D:resourcetype/>
    </D:prop></D:propstat>
  </D:response>
</D:multistatus>"#;
        let blocks = response_blocks(xml);
        assert_eq!(blocks.len(), 2);
        assert!(is_collection(blocks[0]));
        assert!(!is_collection(blocks[1]));
        assert_eq!(
            xml_text(blocks[1], "href").as_deref(),
            Some("/dav/FastNote/fastnote-auto-20261025-120000.json")
        );
        assert_eq!(xml_text(blocks[1], "getcontentlength").as_deref(), Some("2048"));
    }

    #[test]
    fn decodes_percent_encoded_name() {
        assert_eq!(percent_decode("fastnote-%E6%8A%A5%E5%91%8A.json"), "fastnote-报告.json");
    }
}
