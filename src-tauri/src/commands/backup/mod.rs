//! 备份与恢复。
//!
//! 一个概念、六种产物，按**职责**而不是按「写起来顺手」分文件：
//! - `json_export` / `json_import`：JSON 明文备份（gzip 压缩 + 原子写）
//! - `selection`：预检、勾选范围与**合并**写入（JSON 与 SQLite 共用这一套）
//! - `sqlite`：整库快照（.db）的读、写、恢复
//! - `encrypted`：`.fnbk` 密文容器（独立口令）
//! - `files`：按分组导出（zip / EPUB）、文本文件与诊断包
//! - `common`：JSON 取值辅助与 `LocalPreserve`（恢复时保留本地独有内容）
//!
//! 对外路径不变：`crate::export_backup` 等仍从本模块 re-export 出去。

use crate::models::*;
use chrono::Local;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager, State};
use zeroize::{Zeroizing, Zeroize};
use crate::{AppState, encrypt_secret, decrypt_secret, is_encrypted};
use crate::semantic;
use crate::crypto;
use crate::db::{has_column, has_table};
use crate::parse_models_json;
use crate::map_row_to_note;
use super::tags::normalize_source;
use super::history::normalize_history_kind;
use super::history::HISTORY_KIND_AUTO;

/// 给 webdav 模块用的内部入口：命令函数本身不能被其他模块直接调用
/// （`#[tauri::command]` 生成的宏名会与跨模块引用冲突），这里只做一层转发。
pub(crate) fn backup_export_for_webdav(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    include_attachments: bool,
    include_root_key: bool,
    notes_only: bool,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    export_backup(
        state,
        path,
        include_api_keys,
        include_webdav,
        Some(include_attachments),
        Some(include_root_key),
        Some(notes_only),
        app,
    )
}

/// 给 webdav 用的「合并式恢复」：与本地文件恢复走同一条 `apply_backup_merge`。
///
/// 不再清表——云端备份恢复后，本地在备份之后新建的内容不会消失（备份里有同 id 的才覆盖）。
/// 这也顺手消除了「WebDAV 恢复会清库、本地文件恢复不会」这种两套语义。
pub(crate) fn backup_restore_merge_for_webdav(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<BackupSummary, String> {
    let doc = load_backup_doc(&path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    let exported_at = doc
        .get("exported_at")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    apply_backup_merge(
        &app,
        &state,
        &mut conn,
        data,
        &BackupSelection::default(),
        exported_at,
    )
}

/// SQLite 版「合并恢复」：与 `webdav_restore_local` 的 JSON 分支同一套语义（不清表）。
///
/// 列表里一个 `.gz` 合并、一个 `.db` 整库替换，是过去最容易踩的语义分叉；
/// 现在两条都收口到 `apply_backup_merge`，格式只决定怎么读文件。
pub(crate) fn backup_import_sqlite_merge_for_webdav(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<BackupSummary, String> {
    import_sqlite_selected(app, state, path, BackupSelection::default())
}

const BACKUP_FORMAT: &str = "fastnote-backup";

const BACKUP_VERSION: u32 = 2;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct BackupSummary {
    pub notes: usize,
    pub categories: usize,
    pub providers: usize,
    pub sessions: usize,
    pub messages: usize,
    pub settings: usize,
    /// 因加密而跳过的笔记数（含分组整体加密的笔记）；备份里不会有它们
    #[serde(default)]
    pub skipped_encrypted: usize,
    /// 备份文件的导出时间（恢复时从文件里带回，便于界面展示）
    pub exported_at: Option<String>,
    /// 本次恢复保留下来的「本地独有内容」行数（备份里没有、原本会被覆盖删掉的）。
    /// 老前端读不到这个字段也不影响（serde default）。
    #[serde(default)]
    pub preserved: usize,
}


mod common;
mod json_export;
mod json_import;
mod selection;
mod sqlite;
mod encrypted;
mod files;
#[cfg(test)]
mod tests;

pub(crate) use common::*;
pub(crate) use json_export::*;
pub(crate) use json_import::*;
pub(crate) use selection::*;
pub(crate) use sqlite::*;
pub(crate) use encrypted::*;
pub(crate) use files::*;
