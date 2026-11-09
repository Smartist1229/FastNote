use crate::models::*;
use chrono::Local;
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, State};
use zeroize::{Zeroizing, Zeroize};
use crate::{AppState, encrypt_secret, decrypt_secret, is_encrypted};
use crate::semantic;
use crate::encryption;
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
    app: AppHandle,
) -> Result<BackupSummary, String> {
    export_backup(
        state,
        path,
        include_api_keys,
        include_webdav,
        Some(include_attachments),
        Some(include_root_key),
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

pub(crate) fn backup_import_sqlite_for_webdav(
    app: AppHandle,
    state: State<AppState>,
    path: String,
) -> Result<BackupSummary, String> {
    import_sqlite_backup(app, state, path)
}

/// 备份里的图片条目：只带「被引用到的」（正文 + 历史快照），base64 内联。
///
/// 为什么内联而不是旁边放一个附件包：备份的价值是「一个文件拿去就能完整恢复」。
/// 伴生文件丢一次就变成「笔记还在、图全没了」，而且用户很难第一时间察觉。
fn attachment_backup_entries(
    conn: &Connection,
    app: &AppHandle,
    notes: &[Value],
    history: &[Value],
) -> Vec<Value> {
    /// attachments/xx/<hash>.<ext> → hash
    fn hash_of(path: &str) -> &str {
        path.rsplit('/')
            .next()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default()
    }

    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in notes.iter().chain(history.iter()) {
        let content = json_str(item, "content");
        for path in crate::attachments::collect_attachment_paths(&content) {
            if !seen.insert(path.clone()) {
                continue;
            }
            let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) else {
                continue;
            };
            // 宽高跟着一起备份：恢复后不用重新测，预览能立刻按比例占位
            let (width, height): (i64, i64) = conn
                .query_row(
                    "SELECT width, height FROM attachments WHERE hash = ?1",
                    params![hash_of(&path)],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or((0, 0));
            out.push(json!({
                "path": path,
                "mime": crate::attachments::mime_of_attachment(&path),
                "width": width,
                "height": height,
                "data": crate::attachments::base64_encode(&bytes),
            }));
        }
    }
    out
}

/// 恢复备份里的图片：先落盘（同名已存在就跳过，重复导入是幂等的），再补元数据行
fn restore_backup_attachments(
    app: &AppHandle,
    conn: &Connection,
    items: &[Value],
) -> Result<(), String> {
    let created_at = Local::now().to_rfc3339();
    for item in items {
        let path = json_str(item, "path");
        let encoded = json_str(item, "data");
        let Some(bytes) = crate::attachments::base64_decode(&encoded) else {
            continue;
        };
        crate::attachments::restore_attachment(app, &path, &bytes)?;
        let file_name = path.rsplit('/').next().unwrap_or_default();
        let (hash, ext) = file_name.split_once('.').unwrap_or((file_name, "png"));
        let _ = conn.execute(
            "INSERT INTO attachments (hash, ext, mime, bytes, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(hash) DO NOTHING",
            params![
                hash,
                ext,
                json_str(item, "mime"),
                bytes.len() as i64,
                json_i64(item, "width"),
                json_i64(item, "height"),
                created_at
            ],
        );
    }
    Ok(())
}

/* ---------------- 数据备份与恢复 ----------------
 * 备份文件是一个 JSON：format 标记 + 各表数据，用于换机迁移或整体还原。
 * AI 服务商的 api_key 由导出时的 include_api_keys 决定：
 *   - false（默认）：不写入密钥，换机恢复后需重新填写；
 *   - true：写入**解密后的明文** Key，方便换机直接恢复（明文文件请妥善保管）。
 * 导入时若备份里带明文 Key，会重新加密后入库，数据库里始终不落明文。
 */

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

/// 按行查询并映射成 JSON 数组
pub(crate) fn query_rows<F>(conn: &Connection, sql: &str, mut map: F) -> Result<Vec<Value>, String>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
{
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| map(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub(crate) fn json_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// 取字符串字段，缺失或空串时用默认值（旧备份缺新字段）
pub(crate) fn json_str_or(v: &Value, key: &str, fallback: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(crate) fn json_opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

pub(crate) fn json_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// 笔记 id：新备份是 UUID 字符串，旧备份是数字，统一读成字符串。
/// （数字 id 写进 TEXT 主键时 SQLite 会自动转成文本，引用表也是同样规则，仍能对上）
pub(crate) fn json_id(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 分组 id / 分组引用：新备份是字符串，旧备份是数字，统一读成 Option<String>
pub(crate) fn json_opt_id(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// 备份文件里的 id 列可能是旧版本的 INTEGER，也可能是新版本的 TEXT
fn row_text(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<String> {
    Ok(match row.get_ref(idx)? {
        rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        rusqlite::types::ValueRef::Integer(i) => i.to_string(),
        rusqlite::types::ValueRef::Real(f) => f.to_string(),
        _ => String::new(),
    })
}

/// row_text 的可空版本：NULL 保持 None，数字/文本统一转字符串
fn row_text_opt(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<Option<String>> {
    Ok(match row.get_ref(idx)? {
        rusqlite::types::ValueRef::Null => None,
        rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        rusqlite::types::ValueRef::Integer(i) => Some(i.to_string()),
        rusqlite::types::ValueRef::Real(f) => Some(f.to_string()),
        _ => None,
    })
}

pub(crate) fn json_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// 取布尔字段，缺失时用指定默认值（旧备份缺新字段时保持升级前的行为）
pub(crate) fn json_bool_or(v: &Value, key: &str, fallback: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(fallback)
}

/// 取 AI 访问档位（0/1/2）。
/// 兼容三种历史写法：数字档位、旧的布尔（true=完全 / false=禁止）、字段缺失（用默认值）。
pub(crate) fn json_level(v: &Value, key: &str, fallback: i64) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback).clamp(0, 2),
        Some(Value::Bool(b)) => {
            if *b {
                2
            } else {
                0
            }
        }
        _ => fallback,
    }
}

/// 取数组字段：缺失或类型不对都当空数组，避免一个坏字段让整次恢复失败
pub(crate) fn json_arr<'a>(data: &'a Value, key: &str) -> &'a [Value] {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

/// 时间字段缺失时补当前时间（列上有 NOT NULL 约束）
pub(crate) fn non_empty_or_now(text: String) -> String {
    if text.trim().is_empty() {
        Local::now().to_rfc3339()
    } else {
        text
    }
}

/// 自动备份运行状态：写的是「最近一次成功/尝试」这类只对本机有意义的信息，
/// 无论如何都不进备份；恢复时按本机原值接回，避免恢复完就断掉自动备份。
const WEBDAV_AUTO_STATE_KEYS: [&str; 4] = [
    "webdav.lastAutoBackupAt",
    "webdav.lastAutoAttemptAt",
    "webdav.lastAutoError",
    "webdav.lastAutoFile",
];

/* ---------------- 恢复前快照：保住「本地独有」的内容 ---------------- */

/// 某张表在指定 schema 里的列名（用于按列名对齐地搬数据，兼容旧快照缺列）
fn table_columns(conn: &Connection, schema: &str, table: &str) -> Vec<String> {
    let sql = format!("PRAGMA {schema}.table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let cols = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    };
    cols
}

/// 把 `prev` 库里、`main` 里没有的行原样补回来；同主键的以 `main`（备份）为准。
///
/// 列名取两边交集：备份是旧版本快照时 `main` 可能少几列，直接 `SELECT *` 会对不上。
/// `skip` 排除自增主键（`notes_history.id`、`encrypted_keys.id`）：换库后序号没有意义，重新生成。
fn copy_missing_rows(conn: &Connection, table: &str, skip: &[&str]) -> usize {
    let main_cols = table_columns(conn, "main", table);
    let prev_cols = table_columns(conn, "prev", table);
    let cols: Vec<String> = main_cols
        .into_iter()
        .filter(|c| prev_cols.contains(c) && !skip.contains(&c.as_str()))
        .collect();
    if cols.is_empty() {
        return 0;
    }
    let list = cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT OR IGNORE INTO main.\"{table}\" ({list}) SELECT {list} FROM prev.\"{table}\""
    );
    conn.execute(&sql, []).unwrap_or(0)
}

/// 覆盖式恢复会清库，而**本地独有的内容**（尤其是加密笔记及其密钥）通常不在备份里，
/// 会被一起删掉——这正是过去「有加密内容就不让恢复」的根因。
///
/// 做法：恢复前用 `VACUUM INTO` 给本地库拍一张快照，恢复完把备份里没有的行补回来。
/// 顺序先父表后子表（分类 → 笔记 → 历史），不留悬空引用。
struct LocalPreserve {
    path: std::path::PathBuf,
}

impl LocalPreserve {
    fn capture(conn: &Connection, tag: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "fastnote-preserve-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        conn.execute(
            "VACUUM INTO ?1",
            params![path.to_string_lossy().to_string()],
        )
        .map_err(|e| format!("生成恢复前快照失败：{e}"))?;
        Ok(Self { path })
    }

    /// 把本地独有行补回当前库，返回补回的条数
    fn restore(self, conn: &Connection) -> Result<usize, String> {
        conn.execute(
            "ATTACH DATABASE ?1 AS prev",
            params![self.path.to_string_lossy().to_string()],
        )
        .map_err(|e| format!("挂载恢复前快照失败：{e}"))?;
        let mut preserved = 0usize;
        for (table, skip) in [
            ("categories", &[][..]),
            ("notes", &[][..]),
            ("notes_history", &["id"][..]),
            ("tags", &[][..]),
            ("note_tags", &[][..]),
            // 加密笔记的密钥：丢了就永久解不开，必须补回
            ("encrypted_keys", &["id"][..]),
            // 图片元数据：字节在磁盘上，行丢了会变孤儿
            ("attachments", &[][..]),
            // 本机设置（含 app.security.root.* 根密码材料）：备份通常不带，补回来根密码才不会「消失」
            ("app_settings", &[][..]),
        ] {
            preserved += copy_missing_rows(conn, table, skip);
        }
        let _ = conn.execute("DETACH DATABASE prev", []);
        let _ = std::fs::remove_file(&self.path);
        Ok(preserved)
    }
}

/// 读出本机全部 webdav.* 设置（服务器、账号、密码、自动备份配置与运行状态）。
/// 备份默认不带 WebDAV；恢复时这些键按「备份里有就用备份、没有就保留本机」合并，
/// 避免一次恢复把本机正在用的云端配置抹成默认值。
pub(crate) fn read_local_only_settings(conn: &Connection) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(mut stmt) =
        conn.prepare("SELECT key, value, updated_at FROM app_settings WHERE key LIKE 'webdav.%' ORDER BY key")
    else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return out;
    };
    out.extend(rows.flatten());
    out
}

pub(crate) fn restore_local_only_settings(
    conn: &Connection,
    rows: &[(String, String, String)],
) -> Result<(), String> {
    for (key, value, updated_at) in rows {
        // 备份勾选了 WebDAV 时可能自带密码：以备份为准，本机原值只在该键缺失时补上
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, updated_at],
        )
        .map_err(|e| format!("恢复本机 WebDAV 设置失败：{e}"))?;
    }
    Ok(())
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    // 图片是否内联进 JSON。WebDAV 场景体积敏感，可以关掉（默认带）
    include_attachments: Option<bool>,
    // 根密码材料是否随包走。关掉后这份备份只能在本机恢复（默认带）
    include_root_key: Option<bool>,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let categories = query_rows(
        &conn,
        // 加密分组也导出：备份要完整，能不能读取决于有没有原根密码
        "SELECT id, name, created_at, ai_access, COALESCE(is_encrypted, 0) FROM categories ORDER BY id",
        |row| {
            Ok(json!({
                "id": row_text(row, 0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, String>(2)?,
                "ai_access": row.get::<_, i64>(3)?.clamp(0, 2),
                "is_encrypted": row.get::<_, i64>(4)? != 0,
            }))
        },
    )?;

    let notes = query_rows(
        &conn,
        // 加密笔记以**密文**导出（content 本身就是密文），id 必须原样保留：
        // 密文与 DEK 的 AAD 里都拼了它，换 id 就永久解不开。
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                is_pinned, ai_access, COALESCE(enc_mode, 0), enc_tags
         FROM notes ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "category_id": row.get::<_, Option<String>>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
                "is_deleted": row.get::<_, i64>(6)? != 0,
                "deleted_at": row.get::<_, Option<String>>(7)?,
                "is_pinned": row.get::<_, i64>(8)? != 0,
                "ai_access": row.get::<_, i64>(9)?.clamp(0, 2),
                "enc_mode": row.get::<_, i64>(10)?,
                "enc_tags": row.get::<_, Option<String>>(11)?,
            }))
        },
    )?;

    // 默认不查 api_key 列：备份文件里不含密钥。
    // 勾选「备份 API Key」时再单独取出并解密，合并成明文写进备份。
    let mut providers = query_rows(
        &conn,
        "SELECT id, name, provider_type, api_base_url, api_path, enabled_model, enabled_models,
                created_at, updated_at
         FROM ai_providers ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "provider_type": row.get::<_, String>(2)?,
                "api_base_url": row.get::<_, String>(3)?,
                "api_path": row.get::<_, Option<String>>(4)?,
                "enabled_model": row.get::<_, Option<String>>(5)?,
                "enabled_models": parse_models_json(row.get::<_, Option<String>>(6)?),
                "created_at": row.get::<_, String>(7)?,
                "updated_at": row.get::<_, String>(8)?,
            }))
        },
    )?;

    if include_api_keys {
        let mut stmt = conn
            .prepare("SELECT id, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut plain_keys: std::collections::HashMap<i64, String> =
            std::collections::HashMap::new();
        for (id, stored) in rows.flatten() {
            // 解不开（例如换了机器/用户）就留空，不因一条 Key 让整次导出失败
            let plain = if stored.is_empty() {
                String::new()
            } else {
                decrypt_secret(&conn, &stored).unwrap_or_default()
            };
            plain_keys.insert(id, plain);
        }
        for p in providers.iter_mut() {
            if let Some(obj) = p.as_object_mut() {
                let id = obj.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                obj.insert(
                    "api_key".to_string(),
                    json!(plain_keys.get(&id).cloned().unwrap_or_default()),
                );
            }
        }
    }

    let sessions = query_rows(
        &conn,
        "SELECT id, title, provider_id, model, created_at, updated_at
         FROM ai_chat_sessions ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "title": row.get::<_, String>(1)?,
                "provider_id": row.get::<_, i64>(2)?,
                "model": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
            }))
        },
    )?;

    let messages = query_rows(
        &conn,
        "SELECT id, session_id, role, content, created_at
         FROM ai_chat_messages ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "session_id": row.get::<_, i64>(1)?,
                "role": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
            }))
        },
    )?;

    /*
     * 本机专属设置默认不进备份：未勾选 WebDAV 时整组 webdav.* 都排除；
     * 勾选后仍只排除自动备份运行状态，密码会在下面解密成明文写进 JSON（换机可直接恢复）。
     *
     * app.security.*（根密码材料）由 `include_root_key` 单独控制：
     * 带上它，换机后输入原根密码就能解；不带，包里就没有可离线爆破的 verifier，
     * 但这份备份也只能在本机恢复。
     */
    let settings_sql = {
        let mut sql =
            String::from("SELECT key, value, updated_at FROM app_settings WHERE 1 = 1");
        if include_webdav {
            sql.push_str(
                " AND key NOT IN ('webdav.lastAutoBackupAt', 'webdav.lastAutoAttemptAt',
                                  'webdav.lastAutoError', 'webdav.lastAutoFile')",
            );
        } else {
            sql.push_str(" AND key NOT LIKE 'webdav.%'");
        }
        if !include_root_key.unwrap_or(true) {
            sql.push_str(" AND key NOT LIKE 'app.security.%'");
        }
        sql.push_str(" ORDER BY key");
        sql
    };
    let mut settings = query_rows(&conn, &settings_sql, |row| {
        Ok(json!({
            "key": row.get::<_, String>(0)?,
            "value": row.get::<_, String>(1)?,
            "updated_at": row.get::<_, String>(2)?,
        }))
    })?;

    if include_webdav {
        for setting in settings.iter_mut() {
            if setting.get("key").and_then(|v| v.as_str()) != Some("webdav.password") {
                continue;
            }
            let stored = json_str(setting, "value");
            if stored.is_empty() {
                continue;
            }
            // 解不开（换了机器/用户）就留空，不因一条密码让整次导出失败
            let plain = decrypt_secret(&conn, &stored).unwrap_or_default();
            if let Some(obj) = setting.as_object_mut() {
                obj.insert("value".to_string(), json!(plain));
            }
        }
    }

    // 标签与其关联单独成表导出：笔记是被恢复的，标签如果不在备份里，恢复后就只剩"没打标签的笔记"
    let tags = query_rows(
        &conn,
        "SELECT id, name, source, created_at FROM tags ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "source": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let note_tags = query_rows(
        &conn,
        "SELECT note_id, tag_id, source, created_at FROM note_tags
         ORDER BY note_id, tag_id",
        |row| {
            Ok(json!({
                "note_id": row.get::<_, String>(0)?,
                "tag_id": row.get::<_, i64>(1)?,
                "source": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let notes_history = query_rows(
        &conn,
        "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
         FROM notes_history
         ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "note_id": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "category_id": row.get::<_, Option<String>>(4)?,
                "is_pinned": row.get::<_, i64>(5)? != 0,
                "kind": row.get::<_, String>(6)?,
                "pinned": row.get::<_, i64>(7)? != 0,
                "saved_at": row.get::<_, String>(8)?,
            }))
        },
    )?;

    // 加密单元的密钥（包裹后的 DEK）：随包走，否则加密笔记无法恢复
    let encrypted_keys = query_rows(
        &conn,
        "SELECT scope, ref_id, meta_json, created_at FROM encrypted_keys ORDER BY scope, ref_id",
        |row| {
            Ok(json!({
                "scope": row.get::<_, String>(0)?,
                "ref_id": row.get::<_, String>(1)?,
                "meta_json": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let exported_at = Local::now().to_rfc3339();
    let skipped_encrypted = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;
    let summary = BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
        skipped_encrypted,
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let doc = json!({
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "app_version": app.package_info().version.to_string(),
        "exported_at": exported_at,
        "data": {
            "categories": categories,
            "notes": notes,
            "providers": providers,
            "sessions": sessions,
            "messages": messages,
            "settings": settings,
            "tags": tags,
            "note_tags": note_tags,
            "notes_history": notes_history,
            // 密钥环：包裹后的 DEK（每单元一条）。没有它，带回来的密文就是永远打不开的死壳
            "encrypted_keys": encrypted_keys,
            // 图片以 base64 内联：单个 JSON 就能完整恢复，用户不用手动搬 attachments 目录
            "attachments": if include_attachments.unwrap_or(true) {
                attachment_backup_entries(&conn, &app, &notes, &notes_history)
            } else {
                Vec::new()
            },
        }
    });

    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写入备份文件失败：{e}"))?;
    Ok(summary)
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup(app: AppHandle, state: State<AppState>, path: String) -> Result<BackupSummary, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let doc: Value =
        serde_json::from_str(&text).map_err(|_| "备份文件不是合法的 JSON".to_string())?;
    if doc.get("format").and_then(|v| v.as_str()) != Some(BACKUP_FORMAT) {
        return Err("这不是 FastNote 的备份文件".to_string());
    }
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;

    let categories = json_arr(data, "categories");
    let notes = json_arr(data, "notes");
    let providers = json_arr(data, "providers");
    let sessions = json_arr(data, "sessions");
    let messages = json_arr(data, "messages");
    let settings = json_arr(data, "settings");
    // 老备份没有这两张表 → json_arr 返回空数组，等价于"这次不恢复标签"，不会挂
    let tags = json_arr(data, "tags");
    let note_tags = json_arr(data, "note_tags");
    let notes_history = json_arr(data, "notes_history");
    // 老备份没有这个字段 → 空数组，等价于「这次没有图片要恢复」，不报错
    let attachments = json_arr(data, "attachments");

    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    /*
     * 先给本地库拍一张快照：恢复是「覆盖」语义，备份里没有的本地内容（**尤其是加密笔记与
     * 它们的密钥**）会被清掉。过去为了不丢这些内容，入口干脆拒绝恢复；现在改成恢复完再把
     * 本地独有的行补回来 —— 不再需要「有加密内容就不让恢复」这种一刀切。
     */
    let preserve = LocalPreserve::capture(&conn, "json")?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先记下本机现有的 Key 密文，恢复时按「名称+类型+地址」原样接回去：
    // 备份里没带 Key（未勾选导出）时同机恢复不会丢已填好的 Key；换机匹配不到则留空由用户重填。
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT name, provider_type, api_base_url, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ),
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            local_keys.insert(row.0, row.1);
        }
    }

    // WebDAV 密码与自动备份状态不随备份走：先记下本机值，写完备份数据后再接回
    let local_only_settings = read_local_only_settings(&tx);

    // 覆盖式恢复：先清空，再按备份里的 id 原样写回（先删子表再删主表）
    for sql in [
        "DELETE FROM ai_chat_messages",
        "DELETE FROM ai_chat_sessions",
        "DELETE FROM note_tags",
        "DELETE FROM tags",
        "DELETE FROM notes_history",
        "DELETE FROM notes",
        "DELETE FROM categories",
        "DELETE FROM ai_providers",
        "DELETE FROM app_settings",
        // 向量、索引状态与语义元数据都不随备份走：旧向量与恢复后的笔记已不对应，
        // 残留的 model_id / dim / last_error 会让面板显示备份之前的旧状态与旧错误
        "DELETE FROM note_chunks",
        "DELETE FROM note_index_state",
        "DELETE FROM semantic_meta",
        "DELETE FROM encrypted_keys",
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                json_id(c, "id"),
                json_str(c, "name"),
                non_empty_or_now(json_str(c, "created_at")),
                // 旧备份可能没有这个字段，或是布尔（true=完全 / false=禁止）：统一归一化
                json_level(c, "ai_access", 2),
                // 加密分组同样原样保留（分组名在库里是密文，能不能打开取决于密钥）
                if json_bool_or(c, "is_encrypted", false) { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                                is_pinned, ai_access, enc_mode, enc_tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                json_id(n, "id"),
                json_str(n, "title"),
                json_str(n, "content"),
                json_opt_id(n, "category_id"),
                non_empty_or_now(json_str(n, "created_at")),
                non_empty_or_now(json_str(n, "updated_at")),
                if json_bool(n, "is_deleted") { 1 } else { 0 },
                json_opt_str(n, "deleted_at"),
                // 旧备份没有这两个字段：置顶 / AI 访问都按默认值兜底
                if json_bool_or(n, "is_pinned", false) { 1 } else { 0 },
                json_level(n, "ai_access", 2),
                // 加密笔记保持原样入库（密文 + 加密元数据），能不能读取决于有没有原根密码。
                // 注意 id 必须原样保留：密文与 DEK 的 AAD 里都拼了它。
                json_i64(n, "enc_mode"),
                json_opt_str(n, "enc_tags")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 加密笔记的密钥：备份带就一起入库（按 scope+ref_id 幂等）。
    // 缺了它，带回来的密文就是永久打不开的死壳，所以能带就必须带。
    for k in json_arr(data, "encrypted_keys") {
        tx.execute(
            "INSERT OR IGNORE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                json_str(k, "scope"),
                json_str(k, "ref_id"),
                json_str(k, "meta_json"),
                non_empty_or_now(json_str(k, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 历史版本必须排在笔记之后写；老备份没有这张表时就是空数组
    for h in notes_history {
        tx.execute(
            "INSERT INTO notes_history (id, note_id, title, content, category_id, is_pinned, kind,
                                        pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                json_i64(h, "id"),
                json_id(h, "note_id"),
                json_str(h, "title"),
                json_str(h, "content"),
                json_opt_id(h, "category_id"),
                if json_bool_or(h, "is_pinned", false) { 1 } else { 0 },
                // 旧备份没有来源/固定字段：按自动版本、未固定处理
                normalize_history_kind(&json_str_or(h, "kind", HISTORY_KIND_AUTO)),
                if json_bool_or(h, "pinned", false) { 1 } else { 0 },
                non_empty_or_now(json_str(h, "saved_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for p in providers {
        // 备份里带了明文 api_key（导出时勾选了「备份 API Key」）→ 重新加密后入库；
        // 否则按「名称+类型+地址」沿用本机已有的密文（同机恢复不丢已填好的 Key）。
        let api_key = match json_opt_str(p, "api_key").filter(|k| !k.is_empty()) {
            Some(plain) => encrypt_secret(&tx, &plain)?,
            None => local_keys
                .get(&(
                    json_str(p, "name"),
                    json_str(p, "provider_type"),
                    json_str(p, "api_base_url"),
                ))
                .cloned()
                .unwrap_or_default(),
        };
        let enabled_models = p
            .get("enabled_models")
            .and_then(|v| v.as_array())
            .map(|list| {
                let models: Vec<&str> = list.iter().filter_map(|m| m.as_str()).collect();
                serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
            })
            .unwrap_or_else(|| "[]".to_string());
        tx.execute(
            "INSERT INTO ai_providers (id, name, provider_type, api_base_url, api_key, api_path,
                                       enabled_model, enabled_models, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                json_i64(p, "id"),
                json_str(p, "name"),
                json_str(p, "provider_type"),
                json_str(p, "api_base_url"),
                api_key,
                json_opt_str(p, "api_path"),
                json_opt_str(p, "enabled_model"),
                enabled_models,
                non_empty_or_now(json_str(p, "created_at")),
                non_empty_or_now(json_str(p, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in sessions {
        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, provider_id, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                json_i64(s, "id"),
                json_str(s, "title"),
                json_i64(s, "provider_id"),
                json_str(s, "model"),
                non_empty_or_now(json_str(s, "created_at")),
                non_empty_or_now(json_str(s, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for m in messages {
        tx.execute(
            "INSERT INTO ai_chat_messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                json_i64(m, "id"),
                json_i64(m, "session_id"),
                json_str(m, "role"),
                json_str(m, "content"),
                non_empty_or_now(json_str(m, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in settings {
        let key = json_str(s, "key");
        /*
         * 根密码材料（app.security.*）默认不采纳外来值：本地已有根密码时换掉它，
         * 会让本机原有的加密笔记立刻失效。本地值由恢复前的快照补回来；
         * 换机场景走 `verify_backup_root_password` + `import_backup_root_key` 那条显式通道
         * （用户必须先输对原设备根密码）。
         */
        if key.starts_with("app.security.") {
            continue;
        }
        let mut value = json_str(s, "value");
        // 勾选了「备份 WebDAV」的备份带的是明文密码，入库前重新加密；已是密文则原样保留
        if key == "webdav.password" && !value.is_empty() && !is_encrypted(&value) {
            value = encrypt_secret(&tx, &value)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![
                key,
                value,
                non_empty_or_now(json_str(s, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    restore_local_only_settings(&tx, &local_only_settings)?;

    // 标签必须在 notes 之后写：这里的 INSERT 没有外键检查，
    // 顺序反了也不会报错，但会留下一批指向不存在笔记的孤儿关联。
    for t in tags {
        tx.execute(
            "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                json_i64(t, "id"),
                json_str(t, "name"),
                normalize_source(Some(json_str(t, "source"))),
                non_empty_or_now(json_str(t, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for nt in note_tags {
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                json_id(nt, "note_id"),
                json_i64(nt, "tag_id"),
                normalize_source(Some(json_str(nt, "source"))),
                non_empty_or_now(json_str(nt, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    // 把备份里没有、本地独有的行补回来（加密笔记、密钥、根密码材料、本机设置、图片元数据）
    let preserved = preserve.restore(&conn)?;
    // 图片：备份里内联了被引用到的附件，恢复时直接写回磁盘并补元数据
    restore_backup_attachments(&app, &conn, &attachments)?;

    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
        skipped_encrypted: 0,
        preserved,
        exported_at: doc
            .get("exported_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}


/* ---------------- 预检与选择性恢复 ----------------
 *
 * `import_backup` 是「清表重建」：结果等于备份那一刻。它适合换机、整库回滚，
 * 但用户真正想要的经常是「把备份里的某几样拿回来」——本地多出来的不该被删。
 * 下面这组命令就是那条路：先 `preflight_backup` 只读扫一遍给出清单，
 * 用户勾选之后 `import_backup_selected` 按**合并**语义写库，全程不删任何本地行。
 */

/// 未分组笔记在选择列表里的键（前端「未分组」一项用它表示）
pub(crate) const SELECTION_UNGROUPED: &str = "__none__";

/// 恢复选项：要哪几类数据、冲突怎么处理、只恢复哪些分组。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BackupSelection {
    pub categories: bool,
    pub notes: bool,
    pub tags: bool,
    pub history: bool,
    pub attachments: bool,
    pub providers: bool,
    pub sessions: bool,
    pub settings: bool,
    /// 同 id 冲突时保留本地版本（跳过备份条目）；默认 false = 用备份覆盖
    pub keep_local: bool,
    /// 只恢复这些分组 id（空 = 全部）；未分组用 `__none__` 表示
    pub category_ids: Vec<String>,
    /// 只恢复这些笔记 id（空 = 不限制）。非空时优先于分组范围：
    /// 分组只会带回来「被选中笔记所属的那几个」，避免恢复一堆空分组。
    pub note_ids: Vec<String>,
}

impl Default for BackupSelection {
    fn default() -> Self {
        Self {
            categories: true,
            notes: true,
            tags: true,
            history: true,
            attachments: true,
            providers: true,
            sessions: true,
            settings: true,
            keep_local: false,
            category_ids: Vec::new(),
            note_ids: Vec::new(),
        }
    }
}

impl BackupSelection {
    /// 给了笔记白名单时，只有名单内的笔记算选中
    fn note_selected(&self, note_id: &str) -> bool {
        self.note_ids.is_empty() || self.note_ids.iter().any(|id| id == note_id)
    }

    /// 某条笔记 / 某个分组是否在勾选范围内
    fn in_scope(&self, category_id: Option<&str>) -> bool {
        if self.category_ids.is_empty() {
            return true;
        }
        match category_id {
            Some(id) => self.category_ids.iter().any(|c| c == id),
            None => self.category_ids.iter().any(|c| c == SELECTION_UNGROUPED),
        }
    }
}

/// 预检里的一项分组：id / 名称 / 含多少笔记 / 是否加密
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupGroupInfo {
    pub id: String,
    pub name: String,
    pub notes: usize,
    pub encrypted: bool,
}

/// 预检里的一条笔记：够界面勾选与搜索，不带正文（几千篇正文会把摘要撑爆）
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupNoteInfo {
    pub id: String,
    pub title: String,
    pub category_id: Option<String>,
    pub encrypted: bool,
    pub updated_at: String,
    /// 与本地同 id：会被覆盖（或按「保留本地」跳过）
    pub conflict: bool,
}

/// 预检里最多列出多少条笔记；超过就让用户改用分组筛选
const PREFLIGHT_NOTE_LIMIT: usize = 2000;

/// 恢复前的只读摘要：让用户在写库之前就知道「会发生什么」。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreflight {
    pub format: String,
    pub version: i64,
    pub exported_at: Option<String>,
    pub categories: usize,
    pub notes: usize,
    /// 加密笔记数（换机恢复需要原设备根密码）
    pub encrypted_notes: usize,
    pub encrypted_categories: usize,
    pub history: usize,
    pub tags: usize,
    pub attachments: usize,
    pub providers: usize,
    pub sessions: usize,
    pub messages: usize,
    pub settings: usize,
    /// 备份里带了密钥环（包裹后的 DEK）
    pub has_keyring: bool,
    /// 备份里带了根密码材料（app.security.root.*）
    pub has_root_key: bool,
    /// 与本地同 id 已存在的笔记数：会被覆盖（或按选择跳过）
    pub conflicts_notes: usize,
    pub conflicts_categories: usize,
    /// 本地是否已经设置过根密码：决定能不能直接采纳备份的根密码
    pub local_root_set: bool,
    pub groups: Vec<BackupGroupInfo>,
    /// 笔记清单（用于逐篇勾选）；超过上限时只给前 N 条
    pub note_list: Vec<BackupNoteInfo>,
    /// 笔记清单是否被截断
    pub note_list_truncated: bool,
}

/// 读 JSON 备份并做格式校验
pub(crate) fn load_backup_doc(path: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let doc: Value =
        serde_json::from_str(&text).map_err(|_| "备份文件不是合法的 JSON".to_string())?;
    if doc.get("format").and_then(|v| v.as_str()) != Some(BACKUP_FORMAT) {
        return Err("这不是 FastNote 的备份文件".to_string());
    }
    Ok(doc)
}

/// 只读预检（JSON）：读文件 → 交给 `preflight_from_data` 统计
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn preflight_backup(state: State<AppState>, path: String) -> Result<BackupPreflight, String> {
    let doc = load_backup_doc(&path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    preflight_from_data(
        &state,
        data,
        json_str(&doc, "format"),
        doc.get("version").and_then(|v| v.as_i64()).unwrap_or(0),
        doc.get("exported_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    )
}

/// 预检主体：JSON 备份与 SQLite 快照都转成同一份 `data` 结构后走这里。
fn preflight_from_data(
    state: &AppState,
    data: &Value,
    format: String,
    version: i64,
    exported_at: Option<String>,
) -> Result<BackupPreflight, String> {
    let categories = json_arr(data, "categories");
    let notes = json_arr(data, "notes");
    let settings = json_arr(data, "settings");

    // 本地已有的 id：用于统计「会被覆盖」的条数
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let local_notes: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM notes")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let local_categories: std::collections::HashSet<String> = {
        let mut stmt = conn
            .prepare("SELECT id FROM categories")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.flatten().collect()
    };
    let local_root_set: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'app.security.root.salt'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    drop(conn);

    // 每个分组装了几篇笔记：分组选择页要显示「恢复这个分组会带回来几篇」
    let mut per_group: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut ungrouped = 0usize;
    for n in notes {
        match json_opt_id(n, "category_id") {
            Some(id) => *per_group.entry(id).or_insert(0) += 1,
            None => ungrouped += 1,
        }
    }
    let mut groups: Vec<BackupGroupInfo> = categories
        .iter()
        .map(|c| {
            let id = json_id(c, "id");
            BackupGroupInfo {
                notes: per_group.get(&id).copied().unwrap_or(0),
                encrypted: json_bool_or(c, "is_encrypted", false),
                name: json_str(c, "name"),
                id,
            }
        })
        .collect();
    if ungrouped > 0 {
        groups.push(BackupGroupInfo {
            id: SELECTION_UNGROUPED.to_string(),
            name: String::new(),
            notes: ungrouped,
            encrypted: false,
        });
    }

    // 逐篇清单：界面用它做勾选与搜索，不带正文
    let note_list: Vec<BackupNoteInfo> = notes
        .iter()
        .take(PREFLIGHT_NOTE_LIMIT)
        .map(|n| {
            let id = json_id(n, "id");
            BackupNoteInfo {
                conflict: local_notes.contains(&id),
                category_id: json_opt_id(n, "category_id"),
                encrypted: json_i64(n, "enc_mode") != 0,
                title: json_str(n, "title"),
                updated_at: json_str(n, "updated_at"),
                id,
            }
        })
        .collect();

    let root_keys = ["app.security.root.salt", "app.security.root.verifier"];
    let has_root_key = settings
        .iter()
        .any(|s| root_keys.iter().any(|k| json_str(s, "key") == *k));

    Ok(BackupPreflight {
        format,
        version,
        exported_at,
        categories: categories.len(),
        notes: notes.len(),
        encrypted_notes: notes
            .iter()
            .filter(|n| json_i64(n, "enc_mode") != 0)
            .count(),
        encrypted_categories: categories
            .iter()
            .filter(|c| json_bool_or(c, "is_encrypted", false))
            .count(),
        history: json_arr(data, "notes_history").len(),
        tags: json_arr(data, "tags").len(),
        attachments: json_arr(data, "attachments").len(),
        providers: json_arr(data, "providers").len(),
        sessions: json_arr(data, "sessions").len(),
        messages: json_arr(data, "messages").len(),
        settings: settings.len(),
        has_keyring: !json_arr(data, "encrypted_keys").is_empty(),
        has_root_key,
        conflicts_notes: notes
            .iter()
            .filter(|n| local_notes.contains(&json_id(n, "id")))
            .count(),
        conflicts_categories: categories
            .iter()
            .filter(|c| local_categories.contains(&json_id(c, "id")))
            .count(),
        local_root_set,
        groups,
        note_list_truncated: notes.len() > PREFLIGHT_NOTE_LIMIT,
        note_list,
    })
}

/// 按勾选恢复：**合并**语义，只写选中分区，不删任何本地行。
///
/// 与 `import_backup` 的区别：
/// - `import_backup` = 清表重建（结果等于备份那一刻），本地独有内容靠恢复前快照补回；
/// - 本命令 = 直接 upsert，本地独有内容根本不会被碰，也不需要快照兜底。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup_selected(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    selection: BackupSelection,
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
    apply_backup_merge(&app, &state, &mut conn, data, &selection, exported_at)
}

/// 合并写入的公共实现：**JSON 备份与 SQLite 快照都走这里**。
///
/// 输入统一是与 `export_backup` 同构的 `data` 对象，所以两种备份格式的
/// 选择语义（分区、分组、笔记白名单、冲突策略）天然一致，不用各写一套。
pub(crate) fn apply_backup_merge(
    app: &AppHandle,
    state: &AppState,
    conn: &mut Connection,
    data: &Value,
    selection: &BackupSelection,
    exported_at: Option<String>,
) -> Result<BackupSummary, String> {
    // 本机现有的 Key 密文：按「名称+类型+地址」接回去，同机恢复不丢已填好的 Key
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, provider_type, api_base_url, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ),
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            local_keys.insert(row.0, row.1);
        }
    }

    let mut summary = BackupSummary {
        notes: 0,
        categories: 0,
        providers: 0,
        sessions: 0,
        messages: 0,
        settings: 0,
        skipped_encrypted: 0,
        exported_at,
        preserved: 0,
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // ---- 分组 ----
    /*
     * 勾选了具体笔记时，分组只带回来「这些笔记所属的那几个」：
     * 否则用户只想要 3 篇笔记，恢复完却多出一堆空分组。
     */
    let allowed_categories: Option<std::collections::HashSet<String>> =
        if selection.note_ids.is_empty() {
            None
        } else {
            Some(
                json_arr(data, "notes")
                    .iter()
                    .filter(|n| selection.note_selected(&json_id(n, "id")))
                    .filter_map(|n| json_opt_id(n, "category_id"))
                    .collect(),
            )
        };
    if selection.categories {
        for c in json_arr(data, "categories") {
            let id = json_id(c, "id");
            if !selection.in_scope(Some(&id)) {
                continue;
            }
            if let Some(allowed) = &allowed_categories {
                if !allowed.contains(&id) {
                    continue;
                }
            }
            // keep_local 用 OR IGNORE：本地已有的分组保留，只补缺
            let sql = if selection.keep_local {
                "INSERT OR IGNORE INTO categories (id, name, created_at, ai_access, is_encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5)"
            } else {
                "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET
                     name = excluded.name,
                     ai_access = excluded.ai_access,
                     is_encrypted = excluded.is_encrypted"
            };
            tx.execute(
                sql,
                params![
                    id,
                    json_str(c, "name"),
                    non_empty_or_now(json_str(c, "created_at")),
                    json_level(c, "ai_access", 2),
                    if json_bool_or(c, "is_encrypted", false) { 1 } else { 0 }
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.categories += 1;
        }
    }

    // ---- 笔记 ----
    // 记下备份里每条笔记属于哪个分组，后面历史 / 标签关联要按同一份范围过滤
    let mut note_scope: std::collections::HashSet<String> = std::collections::HashSet::new();
    if selection.notes {
        for n in json_arr(data, "notes") {
            let id = json_id(n, "id");
            let category_id = json_opt_id(n, "category_id");
            if !selection.in_scope(category_id.as_deref()) || !selection.note_selected(&id) {
                continue;
            }
            note_scope.insert(id.clone());
            let sql = if selection.keep_local {
                "INSERT OR IGNORE INTO notes (id, title, content, category_id, created_at, updated_at,
                                              is_deleted, deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
            } else {
                "INSERT INTO notes (id, title, content, category_id, created_at, updated_at,
                                    is_deleted, deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                     title = excluded.title,
                     content = excluded.content,
                     category_id = excluded.category_id,
                     updated_at = excluded.updated_at,
                     is_deleted = excluded.is_deleted,
                     deleted_at = excluded.deleted_at,
                     is_pinned = excluded.is_pinned,
                     ai_access = excluded.ai_access,
                     enc_mode = excluded.enc_mode,
                     enc_tags = excluded.enc_tags"
            };
            tx.execute(
                sql,
                params![
                    id,
                    json_str(n, "title"),
                    json_str(n, "content"),
                    category_id,
                    non_empty_or_now(json_str(n, "created_at")),
                    non_empty_or_now(json_str(n, "updated_at")),
                    if json_bool(n, "is_deleted") { 1 } else { 0 },
                    json_opt_str(n, "deleted_at"),
                    if json_bool_or(n, "is_pinned", false) { 1 } else { 0 },
                    json_level(n, "ai_access", 2),
                    json_i64(n, "enc_mode"),
                    json_opt_str(n, "enc_tags")
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.notes += 1;
        }

        // 密钥环：加密笔记的 DEK。缺了它带回来的密文就是打不开的死壳。
        // keep_local 时用 OR IGNORE，避免把本地已经迁移过的包裹结果顶掉。
        for k in json_arr(data, "encrypted_keys") {
            tx.execute(
                "INSERT OR IGNORE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_str(k, "scope"),
                    json_str(k, "ref_id"),
                    json_str(k, "meta_json"),
                    non_empty_or_now(json_str(k, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- 历史版本 ----
    if selection.history {
        for h in json_arr(data, "notes_history") {
            let note_id = json_id(h, "note_id");
            // 笔记不在本次恢复范围 → 连带历史也不恢复，避免留下孤儿版本
            if !note_scope.contains(&note_id) {
                continue;
            }
            let saved_at = non_empty_or_now(json_str(h, "saved_at"));
            // 历史表的 id 是自增主键：不搬备份里的 id，改按「同一笔记 + 同一时间点」去重，
            // 重复恢复同一份备份不会堆出一串一模一样的版本。
            tx.execute(
                "INSERT INTO notes_history (note_id, title, content, category_id, is_pinned, kind,
                                            pinned, saved_at)
                 SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
                 WHERE NOT EXISTS (
                     SELECT 1 FROM notes_history WHERE note_id = ?1 AND saved_at = ?8
                 )",
                params![
                    note_id,
                    json_str(h, "title"),
                    json_str(h, "content"),
                    json_opt_id(h, "category_id"),
                    if json_bool_or(h, "is_pinned", false) { 1 } else { 0 },
                    normalize_history_kind(&json_str_or(h, "kind", HISTORY_KIND_AUTO)),
                    if json_bool_or(h, "pinned", false) { 1 } else { 0 },
                    saved_at
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- 标签 ----
    if selection.tags {
        for t in json_arr(data, "tags") {
            tx.execute(
                "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_i64(t, "id"),
                    json_str(t, "name"),
                    normalize_source(Some(json_str(t, "source"))),
                    non_empty_or_now(json_str(t, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        for nt in json_arr(data, "note_tags") {
            if !note_scope.contains(&json_id(nt, "note_id")) {
                continue;
            }
            tx.execute(
                "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    json_id(nt, "note_id"),
                    json_i64(nt, "tag_id"),
                    normalize_source(Some(json_str(nt, "source"))),
                    non_empty_or_now(json_str(nt, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
        }
    }

    // ---- AI 服务商 ----
    if selection.providers {
        for p in json_arr(data, "providers") {
            let api_key = match json_opt_str(p, "api_key").filter(|k| !k.is_empty()) {
                Some(plain) => encrypt_secret(&tx, &plain)?,
                None => local_keys
                    .get(&(
                        json_str(p, "name"),
                        json_str(p, "provider_type"),
                        json_str(p, "api_base_url"),
                    ))
                    .cloned()
                    .unwrap_or_default(),
            };
            let enabled_models = p
                .get("enabled_models")
                .and_then(|v| v.as_array())
                .map(|list| {
                    let models: Vec<&str> = list.iter().filter_map(|m| m.as_str()).collect();
                    serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
                })
                .unwrap_or_else(|| "[]".to_string());
            tx.execute(
                "INSERT OR REPLACE INTO ai_providers
                    (id, name, provider_type, api_base_url, api_key, api_path,
                     enabled_model, enabled_models, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![
                    json_i64(p, "id"),
                    json_str(p, "name"),
                    json_str(p, "provider_type"),
                    json_str(p, "api_base_url"),
                    api_key,
                    json_opt_str(p, "api_path"),
                    json_opt_str(p, "enabled_model"),
                    enabled_models,
                    non_empty_or_now(json_str(p, "created_at")),
                    non_empty_or_now(json_str(p, "updated_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.providers += 1;
        }
    }

    // ---- AI 对话 ----
    if selection.sessions {
        for s in json_arr(data, "sessions") {
            tx.execute(
                "INSERT OR REPLACE INTO ai_chat_sessions
                    (id, title, provider_id, model, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    json_i64(s, "id"),
                    json_str(s, "title"),
                    json_i64(s, "provider_id"),
                    json_str(s, "model"),
                    non_empty_or_now(json_str(s, "created_at")),
                    non_empty_or_now(json_str(s, "updated_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.sessions += 1;
        }
        for m in json_arr(data, "messages") {
            tx.execute(
                "INSERT OR REPLACE INTO ai_chat_messages
                    (id, session_id, role, content, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    json_i64(m, "id"),
                    json_i64(m, "session_id"),
                    json_str(m, "role"),
                    json_str(m, "content"),
                    non_empty_or_now(json_str(m, "created_at"))
                ],
            )
            .map_err(|e| e.to_string())?;
            summary.messages += 1;
        }
    }

    // ---- 设置 ----
    if selection.settings {
        for st in json_arr(data, "settings") {
            let key = json_str(st, "key");
            // 根密码材料绝不在这里采纳：换掉它会让本机已有的加密笔记立刻失效。
            // 换机解锁走 verify_backup_root_password + import_backup_root_key 那条显式通道。
            if key.starts_with("app.security.") {
                continue;
            }
            let mut value = json_str(st, "value");
            if key == "webdav.password" && !value.is_empty() && !is_encrypted(&value) {
                value = encrypt_secret(&tx, &value)?;
            }
            tx.execute(
                "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params![key, value, non_empty_or_now(json_str(st, "updated_at"))],
            )
            .map_err(|e| e.to_string())?;
            summary.settings += 1;
        }
    }

    // ---- 图片 ----
    if selection.attachments {
        restore_backup_attachments(app, &tx, json_arr(data, "attachments"))?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    semantic::invalidate(&state.semantic);

    Ok(summary)
}


/* ---------------- SQLite 快照的选择性恢复 ----------------
 *
 * .db 快照本质是一个完整库文件，但它和 JSON 备份描述的是同一件事。
 * 这里把它读成与 `export_backup` 同构的 `data` 对象，然后复用同一套
 * `preflight_from_data` / `apply_backup_merge`——选择语义、冲突策略、
 * 加密处理全部一致，不需要为第二种格式再写一遍。
 */

/// 读快照里的 meta 值（导出时间等）
fn snapshot_meta(conn: &Connection, key: &str) -> Option<String> {
    if !has_table(conn, SQLITE_BACKUP_META) {
        return None;
    }
    conn.query_row(
        &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = ?1"),
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// 拼一个「列存在就取值、不存在就用默认值」的表达式，兼容旧版本快照
fn col_expr(conn: &Connection, table: &str, col: &str, fallback: &str) -> String {
    if table_columns(conn, "main", table).iter().any(|c| c == col) {
        format!("COALESCE({col}, {fallback})")
    } else {
        fallback.to_string()
    }
}

/// 把 SQLite 快照读成与 `export_backup` 完全一致的 `data` 结构。
///
/// api_key 刻意不读：快照里存的是**本机加密值**，换机解不开，
/// 交给 `apply_backup_merge` 按「名称+类型+地址」沿用本机已有的 Key 更正确。
pub(crate) fn sqlite_snapshot_to_data(conn: &Connection) -> Result<Value, String> {
    // 复用原有校验：是不是 FastNote 导出的快照、版本是否过新、必需列是否齐全
    read_sqlite_backup(conn)?;

    let c_ai = col_expr(conn, "categories", "ai_access", "2");
    let c_enc = col_expr(conn, "categories", "is_encrypted", "0");
    let categories = query_rows(
        conn,
        &format!(
            "SELECT id, name, created_at, {c_ai}, {c_enc} FROM categories ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, String>(2)?,
                "ai_access": row.get::<_, i64>(3)?.clamp(0, 2),
                "is_encrypted": row.get::<_, i64>(4)? != 0,
            }))
        },
    )?;

    let n_del = col_expr(conn, "notes", "is_deleted", "0");
    let n_del_at = col_expr(conn, "notes", "deleted_at", "NULL");
    let n_pin = col_expr(conn, "notes", "is_pinned", "0");
    let n_ai = col_expr(conn, "notes", "ai_access", "2");
    let n_enc = col_expr(conn, "notes", "enc_mode", "0");
    let n_tags = col_expr(conn, "notes", "enc_tags", "NULL");
    let notes = query_rows(
        conn,
        &format!(
            "SELECT id, title, content, category_id, created_at, updated_at,
                    {n_del}, {n_del_at}, {n_pin}, {n_ai}, {n_enc}, {n_tags}
             FROM notes ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "category_id": row.get::<_, Option<String>>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
                "is_deleted": row.get::<_, i64>(6)? != 0,
                "deleted_at": row.get::<_, Option<String>>(7)?,
                "is_pinned": row.get::<_, i64>(8)? != 0,
                "ai_access": row.get::<_, i64>(9)?.clamp(0, 2),
                "enc_mode": row.get::<_, i64>(10)?,
                "enc_tags": row.get::<_, Option<String>>(11)?,
            }))
        },
    )?;

    let p_models = col_expr(conn, "ai_providers", "enabled_models", "'[]'");
    let p_model = col_expr(conn, "ai_providers", "enabled_model", "NULL");
    let p_path = col_expr(conn, "ai_providers", "api_path", "NULL");
    let providers = query_rows(
        conn,
        &format!(
            "SELECT id, name, provider_type, api_base_url, {p_path}, {p_model}, {p_models},
                    created_at, updated_at
             FROM ai_providers ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "provider_type": row.get::<_, String>(2)?,
                "api_base_url": row.get::<_, String>(3)?,
                "api_path": row.get::<_, Option<String>>(4)?,
                "enabled_model": row.get::<_, Option<String>>(5)?,
                "enabled_models": parse_models_json(row.get::<_, Option<String>>(6)?),
                "created_at": row.get::<_, String>(7)?,
                "updated_at": row.get::<_, String>(8)?,
            }))
        },
    )?;

    let sessions = query_rows(
        conn,
        "SELECT id, title, provider_id, model, created_at, updated_at
         FROM ai_chat_sessions ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "title": row.get::<_, String>(1)?,
                "provider_id": row.get::<_, i64>(2)?,
                "model": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
            }))
        },
    )?;

    let messages = query_rows(
        conn,
        "SELECT id, session_id, role, content, created_at FROM ai_chat_messages ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "session_id": row.get::<_, i64>(1)?,
                "role": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
            }))
        },
    )?;

    // 根密码材料也读出来：换机恢复要靠它解锁（是否采纳由专用命令决定）
    let settings = query_rows(
        conn,
        "SELECT key, value, updated_at FROM app_settings ORDER BY key",
        |row| {
            Ok(json!({
                "key": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
                "updated_at": row.get::<_, String>(2)?,
            }))
        },
    )?;

    let tags = if has_table(conn, "tags") {
        query_rows(
            conn,
            "SELECT id, name, source, created_at FROM tags ORDER BY id",
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let note_tags = if has_table(conn, "note_tags") {
        query_rows(
            conn,
            "SELECT note_id, tag_id, source, created_at FROM note_tags ORDER BY note_id, tag_id",
            |row| {
                Ok(json!({
                    "note_id": row.get::<_, String>(0)?,
                    "tag_id": row.get::<_, i64>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let history = if has_table(conn, "notes_history") {
        let h_kind = col_expr(conn, "notes_history", "kind", "'auto'");
        let h_pinned = col_expr(conn, "notes_history", "pinned", "0");
        let h_pin = col_expr(conn, "notes_history", "is_pinned", "0");
        query_rows(
            conn,
            &format!(
                "SELECT id, note_id, title, content, category_id, {h_pin}, {h_kind},
                        {h_pinned}, saved_at
                 FROM notes_history ORDER BY id"
            ),
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "note_id": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "category_id": row.get::<_, Option<String>>(4)?,
                    "is_pinned": row.get::<_, i64>(5)? != 0,
                    "kind": row.get::<_, String>(6)?,
                    "pinned": row.get::<_, i64>(7)? != 0,
                    "saved_at": row.get::<_, String>(8)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let encrypted_keys = if has_table(conn, "encrypted_keys") {
        query_rows(
            conn,
            "SELECT scope, ref_id, meta_json, created_at FROM encrypted_keys ORDER BY scope, ref_id",
            |row| {
                Ok(json!({
                    "scope": row.get::<_, String>(0)?,
                    "ref_id": row.get::<_, String>(1)?,
                    "meta_json": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    // 图片：快照里带的是字节（attachments.data），转成 JSON 备份同一套 base64 结构
    let mut attachments = Vec::new();
    if has_table(conn, "attachments") && table_columns(conn, "main", "attachments").iter().any(|c| c == "data") {
        let mut stmt = conn
            .prepare(
                "SELECT hash, ext, mime, COALESCE(width, 0), COALESCE(height, 0), data
                 FROM attachments WHERE data IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for (hash, ext, mime, width, height, bytes) in rows.flatten() {
            // 与附件模块的落盘规则保持一致：attachments/<hash 前 2 位>/<hash>.<ext>
            let bucket = hash.get(..2).unwrap_or("00");
            attachments.push(json!({
                "path": format!("attachments/{bucket}/{hash}.{ext}"),
                "mime": mime,
                "width": width,
                "height": height,
                "data": crate::attachments::base64_encode(&bytes),
            }));
        }
    }

    Ok(json!({
        "categories": categories,
        "notes": notes,
        "providers": providers,
        "sessions": sessions,
        "messages": messages,
        "settings": settings,
        "tags": tags,
        "note_tags": note_tags,
        "notes_history": history,
        "encrypted_keys": encrypted_keys,
        "attachments": attachments,
    }))
}

/// 打开快照文件（只读）：备份文件不在我们手里，任何写操作都不该发生
fn open_snapshot(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开备份文件失败：{e}"))
}

/// SQLite 快照的只读预检：与 JSON 预检返回同一份结构
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn preflight_sqlite_backup(
    state: State<AppState>,
    path: String,
) -> Result<BackupPreflight, String> {
    let snap = open_snapshot(&path)?;
    let data = sqlite_snapshot_to_data(&snap)?;
    let exported_at = snapshot_meta(&snap, "exported_at");
    drop(snap);
    preflight_from_data(
        &state,
        &data,
        SQLITE_BACKUP_FORMAT.to_string(),
        SQLITE_BACKUP_VERSION as i64,
        exported_at,
    )
}

/// SQLite 快照的按勾选恢复：读快照 → 转成 data → 走同一套合并逻辑
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_sqlite_selected(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    selection: BackupSelection,
) -> Result<BackupSummary, String> {
    let snap = open_snapshot(&path)?;
    let data = sqlite_snapshot_to_data(&snap)?;
    let exported_at = snapshot_meta(&snap, "exported_at");
    // 先断开快照文件，避免它和后来的写事务互相占着句柄
    drop(snap);
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    apply_backup_merge(&app, &state, &mut conn, &data, &selection, exported_at)
}

/// 从备份的 settings 里抽出根密码参数（app.security.root.*）
fn backup_root_params(data: &Value) -> std::collections::HashMap<String, String> {
    json_arr(data, "settings")
        .iter()
        .filter_map(|s| {
            let key = json_str(s, "key");
            if key.starts_with("app.security.root.") {
                Some((key, json_str(s, "value")))
            } else {
                None
            }
        })
        .collect()
}

/// 从任意一种备份里抽出根密码参数：JSON 读 data，.db 打开快照读 app_settings。
fn root_params_from_path(path: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".db") || lower.ends_with(".sqlite") {
        let snap = open_snapshot(path)?;
        let data = sqlite_snapshot_to_data(&snap)?;
        return Ok(backup_root_params(&data));
    }
    let doc = load_backup_doc(path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    Ok(backup_root_params(data))
}


/// 把备份里的根密钥迁移到本机根密码（换机 / 改过密码后恢复的关键一步）。
///
/// 场景：备份里的 `wrap_root` 是**原设备根密码**包的，而本机根密码换过，
/// 于是恢复回来的笔记「根密码解不开、只有自己的密码能解」。这里用旧密码解开、
/// 用本机 KEK 重新包回去，之后一把根密码就能全部打开。
///
/// 只改 `wrap_root`，`wrap_item` 与正文密文都不动，出错也能用单元密码打开。
#[tauri::command(async)]
pub fn migrate_backup_root_wrap(
    state: State<AppState>,
    path: String,
    old_password: String,
    new_password: String,
) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let migrated = crate::encryption::migrate_root_from_backup(
        &conn,
        &state.encryption,
        &params,
        &old_password,
        &new_password,
    )?;
    Ok(json!({ "ok": true, "migrated": migrated }))
}

/// 校验「原设备根密码」是否与备份里的根密码材料吻合。
///
/// **只算不写**：换机恢复时先让用户证明自己知道原密码，再决定要不要采纳 keyring。
/// 这里的失败计数沿用本机根密码的冷却机制（同一条通道，避免被拿来反复试密码）。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn verify_backup_root_password(path: String, password: String) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    crate::encryption::verify_root_params(&params, &password)?;
    Ok(json!({ "ok": true }))
}

/// 采纳备份里的根密码材料（换机解锁的最后一步）。
///
/// 只做「把 app.security.root.* 写进本机」，笔记密文与 encrypted_keys 在恢复时已入库，
/// 写完之后本机就能用原设备根密码解开它们。
///
/// `allow_replace` 为 false 时，本地已有根密码就拒绝——替换会让本机原有加密笔记全部失效，
/// 必须由用户在界面上明确确认过才能进来。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup_root_key(
    state: State<AppState>,
    path: String,
    password: String,
    allow_replace: bool,
) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    // 先验密码：错的密码绝不能写进库，否则本机根密码会被一份无效 verifier 顶掉
    let kek = crate::encryption::verify_root_params(&params, &password)?;

    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let local_root_set: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'app.security.root.salt'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if local_root_set && !allow_replace {
        return Err(json!({ "code": "root_already_set" }).to_string());
    }

    let now = chrono::Local::now().to_rfc3339();
    for (key, value) in &params {
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;
    }
    // 库里的根密码材料换了，内存缓存也必须跟着换：否则本次会话还在用旧 KEK 解 wrap_root，
    // 表现是「刚恢复完的加密笔记打不开，重启后却好了」。
    crate::encryption::adopt_root_kek(&state.encryption, kek);
    Ok(json!({ "ok": true, "replaced": local_root_set }))
}

/* ---------------- SQLite 备份与恢复 ----------------
 * 与 JSON 备份互补：SQLite 是整库快照，恢复时直接按表写回，适合本机快速备份；
 * JSON 带字段级兼容逻辑，更适合跨版本 / 换机迁移。
 *
 * 快照用 VACUUM INTO 生成，是独立、一致的 .db 文件（不是正在使用的库文件副本）；
 * 文件内附一张 fastnote_backup_meta 标记表，导入时据此拒绝来路不明的数据库。
 * API Key 的处理：
 *   - 不勾选备份 Key：快照里的 api_key 全部清空；
 *   - 勾选：保留本机加密值（密钥文件不随备份走，换机后无法解密，恢复时会尝试沿用本机同名服务商的 Key）。
 */

const SQLITE_BACKUP_FORMAT: &str = "fastnote-sqlite-backup";

const SQLITE_BACKUP_META: &str = "fastnote_backup_meta";

const SQLITE_BACKUP_VERSION: u32 = 1;

pub(crate) fn count_rows(conn: &Connection, table: &str) -> usize {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(0) as usize
}

/// 把临时文件挪到用户选的目标路径。Windows 的 rename 不会覆盖已有文件，先删旧目标。
pub(crate) fn replace_backup_file(tmp: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        std::fs::remove_file(target).map_err(|e| format!("覆盖已有备份文件失败：{e}"))?;
    }
    std::fs::rename(tmp, target).map_err(|e| format!("保存备份文件失败：{e}"))
}

/// 生成 SQLite 快照到 `tmp`（目标必须不存在）。
/// `include_encrypted` 为 true 时原样保留加密笔记/分组、`encrypted_keys` 与 `app.security.*`：
/// 只在「加密容器备份」里用（外层还有一层口令加密），普通快照一律把加密内容剔除。
pub(crate) fn build_sqlite_snapshot(
    conn: &Connection,
    tmp: &Path,
    app: &AppHandle,
    exported_at: &str,
    include_api_keys: bool,
    include_webdav: bool,
    include_encrypted: bool,
) -> Result<(), String> {
    conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy().to_string()])
        .map_err(|e| format!("生成数据库快照失败：{e}"))?;

    let snap = Connection::open(tmp).map_err(|e| format!("打开数据库快照失败：{e}"))?;
    // 快照必须是单文件：切回 DELETE 日志模式，不把 -wal / -shm 留给用户
    let _ = snap.execute_batch("PRAGMA journal_mode=DELETE;");
    snap.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {SQLITE_BACKUP_META} (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );"
    ))
    .map_err(|e| format!("写入备份标记失败：{e}"))?;

    {
        let mut stmt = snap
            .prepare(&format!(
                "INSERT OR REPLACE INTO {SQLITE_BACKUP_META} (key, value) VALUES (?1, ?2)"
            ))
            .map_err(|e| e.to_string())?;
        let meta = [
            ("format", SQLITE_BACKUP_FORMAT.to_string()),
            ("version", SQLITE_BACKUP_VERSION.to_string()),
            ("exported_at", exported_at.to_string()),
            ("app_version", app.package_info().version.to_string()),
            (
                "api_keys",
                if include_api_keys {
                    "encrypted"
                } else {
                    "none"
                }
                .to_string(),
            ),
            (
                "encrypted_content",
                if include_encrypted { "included" } else { "none" }.to_string(),
            ),
        ];
        for (key, value) in meta {
            stmt.execute(params![key, value])
                .map_err(|e| format!("写入备份标记失败：{e}"))?;
        }
    }

    if !include_api_keys {
        snap.execute("UPDATE ai_providers SET api_key = ''", [])
            .map_err(|e| format!("清除快照中的 API Key 失败：{e}"))?;
    }
    // 自动备份运行状态永远不随快照走；未勾选 WebDAV 时整组配置一起清掉，
    // 勾选后保留服务器/账号/密码密文，恢复后仍可在同机继续使用。
    for key in WEBDAV_AUTO_STATE_KEYS {
        snap.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
            .map_err(|e| format!("清除快照中的本机设置失败：{e}"))?;
    }
    if !include_webdav {
        snap.execute("DELETE FROM app_settings WHERE key LIKE 'webdav.%'", [])
            .map_err(|e| format!("清除快照中的 WebDAV 设置失败：{e}"))?;
    }
    // 语义索引与元数据是纯本机派生物（体积大、换机/换模型无意义）：快照里也不带，
    // 恢复后由后台按当前模型重建。
    for table in ["note_chunks", "note_index_state", "semantic_meta"] {
        snap.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| format!("清除快照中的语义数据失败：{e}"))?;
    }
    if !include_encrypted {
        // 加密内容与根密码元数据不进普通备份：备份文件不假设用户还记得密码。
        // 顺序：先删笔记行，再按"已不存在的 note_id"清历史与标签关联。
        snap.execute("DELETE FROM notes WHERE COALESCE(enc_mode, 0) <> 0", [])
            .map_err(|e| format!("清除快照中的加密笔记失败：{e}"))?;
        for sql in [
            "DELETE FROM notes_history WHERE note_id NOT IN (SELECT id FROM notes)",
            "DELETE FROM note_tags WHERE note_id NOT IN (SELECT id FROM notes)",
            "DELETE FROM categories WHERE COALESCE(is_encrypted, 0) <> 0",
            "DELETE FROM encrypted_keys",
            "DELETE FROM app_settings WHERE key LIKE 'app.security.%'",
        ] {
            snap.execute(sql, [])
                .map_err(|e| format!("清除快照中的加密数据失败：{e}"))?;
        }
    }
    // 图片字节平时只存在磁盘上；快照要能「一个 .db 文件就完整恢复」，
    // 就必须把被引用到的图片写进快照库的 attachments.data 列（运行时那一列始终是 NULL）。
    embed_attachments_into_snapshot(conn, &snap, app)?;

    // 删行只让页面变成空闲页，VACUUM 才能真正把密文/元数据从文件里抹掉
    snap.execute("VACUUM", [])
        .map_err(|e| format!("整理数据库快照失败：{e}"))?;
    Ok(())
}

/// 把图片字节写进快照的 `attachments.data`（恢复时再落地成文件）。
///
/// 只带附件表里登记过的图片，且必须文件真的存在——手工删过数据目录时跳过，
/// 不让「一张丢了的图」把整次备份搞失败。
fn embed_attachments_into_snapshot(
    live: &Connection,
    snap: &Connection,
    app: &AppHandle,
) -> Result<(), String> {
    snap.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            ext TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            data BLOB,
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("准备快照图片表失败：{e}"))?;

    let mut stmt = live
        .prepare("SELECT hash, ext, mime, bytes, width, height, created_at FROM attachments")
        .map_err(|e| format!("读取图片元数据失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| format!("读取图片元数据失败：{e}"))?;

    for row in rows.flatten() {
        let (hash, ext, mime, bytes, width, height, created_at) = row;
        let rel = format!("attachments/{}/{hash}.{ext}", &hash[..2.min(hash.len())]);
        let Some(data) = crate::attachments::read_attachment_bytes(app, &rel) else {
            continue;
        };
        snap.execute(
            "INSERT OR REPLACE INTO attachments (hash, ext, mime, bytes, width, height, data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![hash, ext, mime, bytes, width, height, data, created_at],
        )
        .map_err(|e| format!("写入快照图片失败：{e}"))?;
    }
    Ok(())
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_sqlite_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    // 是否把加密笔记、分组密钥与根密码材料一起打进快照。
    // 缺省 true：备份要完整，能不能读交给根密码决定（与 JSON 备份一致）。
    include_encrypted: Option<bool>,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let exported_at = Local::now().to_rfc3339();
    let count = |sql: &str| -> usize {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0) as usize
    };
    // 摘要按"实际进快照的行数"算：不勾选加密内容时，加密项会在副本里被删掉
    let include_enc = include_encrypted.unwrap_or(true);
    let summary = BackupSummary {
        notes: if include_enc {
            count("SELECT COUNT(*) FROM notes")
        } else {
            count("SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) = 0")
        },
        categories: if include_enc {
            count("SELECT COUNT(*) FROM categories")
        } else {
            count("SELECT COUNT(*) FROM categories WHERE COALESCE(is_encrypted, 0) = 0")
        },
        providers: count_rows(&conn, "ai_providers"),
        sessions: count_rows(&conn, "ai_chat_sessions"),
        messages: count_rows(&conn, "ai_chat_messages"),
        settings: count(
            "SELECT COUNT(*) FROM app_settings WHERE key NOT LIKE 'app.security.%'",
        ),
        // 默认随包导出；用户主动关掉「备份加密内容」时才计入跳过
        skipped_encrypted: if include_enc {
            0
        } else {
            count("SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0")
        },
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let target = std::path::PathBuf::from(&path);
    let parent = target.parent().ok_or("备份路径不可用".to_string())?;
    // 保存对话框给出的目标可能已存在，而 VACUUM INTO 要求目标不存在：
    // 先写同目录临时文件，成功后再替换，避免中途失败留下半个备份。
    let tmp = parent.join(format!(".fastnote-sqlite-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let result = build_sqlite_snapshot(
        &conn,
        &tmp,
        &app,
        &exported_at,
        include_api_keys,
        include_webdav,
        include_encrypted.unwrap_or(true),
    )
    .and_then(|()| replace_backup_file(&tmp, &target));

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    Ok(summary)
}

/** SQLite 快照读出的数据：字段与当前库结构对齐，缺失的列由读取 SQL 补默认值 */
#[derive(Default)]
pub struct SqliteBackupData {
    categories: Vec<SqliteCategoryRow>,
    notes: Vec<SqliteNoteRow>,
    providers: Vec<SqliteProviderRow>,
    sessions: Vec<SqliteSessionRow>,
    messages: Vec<SqliteMessageRow>,
    settings: Vec<SqliteSettingRow>,
    tags: Vec<SqliteTagRow>,
    note_tags: Vec<SqliteNoteTagRow>,
    notes_history: Vec<SqliteNoteHistoryRow>,
    /// 只有加密容器备份里才有；普通快照导不出这行数据
    encrypted_keys: Vec<SqliteEncryptedKeyRow>,
    exported_at: Option<String>,
}

pub struct SqliteCategoryRow {
    id: String,
    name: String,
    created_at: String,
    ai_access: i64,
    is_encrypted: i64,
}

pub struct SqliteNoteRow {
    id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    created_at: String,
    updated_at: String,
    is_deleted: i64,
    deleted_at: Option<String>,
    is_pinned: i64,
    ai_access: i64,
    enc_mode: i64,
    enc_tags: Option<String>,
}

pub struct SqliteEncryptedKeyRow {
    scope: String,
    ref_id: String,
    meta_json: String,
    created_at: String,
}

pub struct SqliteProviderRow {
    id: i64,
    name: String,
    provider_type: String,
    api_base_url: String,
    api_key: String,
    api_path: Option<String>,
    enabled_model: Option<String>,
    enabled_models: Option<String>,
    created_at: String,
    updated_at: String,
}

pub struct SqliteSessionRow {
    id: i64,
    title: String,
    provider_id: i64,
    model: String,
    created_at: String,
    updated_at: String,
}

pub struct SqliteMessageRow {
    id: i64,
    session_id: i64,
    role: String,
    content: String,
    created_at: String,
}

pub struct SqliteSettingRow {
    key: String,
    value: String,
    updated_at: String,
}

pub struct SqliteTagRow {
    id: i64,
    name: String,
    source: String,
    created_at: String,
}

pub struct SqliteNoteTagRow {
    note_id: String,
    tag_id: i64,
    source: String,
    created_at: String,
}

pub struct SqliteNoteHistoryRow {
    id: i64,
    note_id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    is_pinned: i64,
    kind: String,
    pinned: i64,
    saved_at: String,
}

/// 读取并校验 SQLite 备份。表结构必须包含当前版本的核心列；
/// 后加的列（置顶、AI 档位、多选模型等）缺失时用默认值补齐。
pub(crate) fn read_sqlite_backup(conn: &Connection) -> Result<SqliteBackupData, String> {
    if !has_table(conn, SQLITE_BACKUP_META) {
        return Err("这不是 FastNote 导出的 SQLite 备份文件".to_string());
    }
    let format: Option<String> = conn
        .query_row(
            &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'format'"),
            [],
            |row| row.get(0),
        )
        .ok();
    if format.as_deref() != Some(SQLITE_BACKUP_FORMAT) {
        return Err("这不是 FastNote 导出的 SQLite 备份文件".to_string());
    }
    let version: Option<String> = conn
        .query_row(
            &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'version'"),
            [],
            |row| row.get(0),
        )
        .ok();
    if version.and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) > SQLITE_BACKUP_VERSION {
        return Err("备份由更新版本的 FastNote 创建，请先升级软件再恢复".to_string());
    }

    let required: [(&str, &[&str]); 6] = [
        ("categories", &["id", "name", "created_at"]),
        (
            "notes",
            &[
                "id",
                "title",
                "content",
                "category_id",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_providers",
            &[
                "id",
                "name",
                "provider_type",
                "api_base_url",
                "api_key",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_chat_sessions",
            &[
                "id",
                "title",
                "provider_id",
                "model",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_chat_messages",
            &["id", "session_id", "role", "content", "created_at"],
        ),
        ("app_settings", &["key", "value", "updated_at"]),
    ];
    for (table, columns) in required {
        if !has_table(conn, table) {
            return Err(format!("SQLite 备份缺少数据表 {table}"));
        }
        for column in columns {
            if !has_column(conn, table, column) {
                return Err(format!("SQLite 备份的表 {table} 缺少列 {column}"));
            }
        }
    }

    // 后加的列缺失时补默认值，兼容较早导出的快照
    let col = |table: &str, column: &str, fallback: &str| {
        if has_column(conn, table, column) {
            column.to_string()
        } else {
            fallback.to_string()
        }
    };
    let ai_access = |table: &str| col(table, "ai_access", "2");

    let mut out = SqliteBackupData {
        exported_at: conn
            .query_row(
                &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'exported_at'"),
                [],
                |row| row.get(0),
            )
            .ok(),
        ..Default::default()
    };

    {
        let sql = format!(
            "SELECT id, name, created_at, {}, {} FROM categories ORDER BY id",
            ai_access("categories"),
            col("categories", "is_encrypted", "0")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteCategoryRow {
                    id: row_text(row, 0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    ai_access: row.get::<_, i64>(3)?.clamp(0, 2),
                    is_encrypted: row.get::<_, i64>(4)?.min(1),
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.categories.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let sql = format!(
            "SELECT id, title, content, category_id, created_at, updated_at, {}, {}, {}, {},
                    {}, {}
             FROM notes ORDER BY id",
            col("notes", "is_deleted", "0"),
            col("notes", "deleted_at", "NULL"),
            col("notes", "is_pinned", "0"),
            ai_access("notes"),
            col("notes", "enc_mode", "0"),
            col("notes", "enc_tags", "NULL")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteRow {
                    id: row_text(row, 0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    category_id: row_text_opt(row, 3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_deleted: row.get(6)?,
                    deleted_at: row.get(7)?,
                    is_pinned: row.get(8)?,
                    ai_access: row.get::<_, i64>(9)?.clamp(0, 2),
                    enc_mode: row.get::<_, i64>(10)?.clamp(0, 2),
                    enc_tags: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.notes.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 历史版本同样是后加的表：老快照没有时按空数组处理
    if has_table(conn, "notes_history")
        && [
            "id",
            "note_id",
            "title",
            "content",
            "category_id",
            "is_pinned",
            "saved_at",
        ]
        .iter()
        .all(|column| has_column(conn, "notes_history", column))
    {
        let sql = format!(
            "SELECT id, note_id, title, content, category_id, is_pinned, {}, {}, saved_at
             FROM notes_history ORDER BY id",
            col("notes_history", "kind", "'auto'"),
            col("notes_history", "pinned", "0")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteHistoryRow {
                    id: row.get(0)?,
                    note_id: row_text(row, 1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    category_id: row_text_opt(row, 4)?,
                    is_pinned: row.get(5)?,
                    kind: normalize_history_kind(&row.get::<_, String>(6)?),
                    pinned: row.get(7)?,
                    saved_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.notes_history.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let sql = format!(
            "SELECT id, name, provider_type, api_base_url, api_key, {}, {}, {},
                    created_at, updated_at
             FROM ai_providers ORDER BY id",
            col("ai_providers", "api_path", "NULL"),
            col("ai_providers", "enabled_model", "NULL"),
            col("ai_providers", "enabled_models", "NULL")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteProviderRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: row.get(2)?,
                    api_base_url: row.get(3)?,
                    api_key: row.get(4)?,
                    api_path: row.get(5)?,
                    enabled_model: row.get(6)?,
                    enabled_models: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.providers.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, provider_id, model, created_at, updated_at
                 FROM ai_chat_sessions ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteSessionRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    provider_id: row.get(2)?,
                    model: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.sessions.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, created_at
                 FROM ai_chat_messages ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteMessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.messages.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare("SELECT key, value, updated_at FROM app_settings ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteSettingRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.settings.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 标签是后加的功能：老快照没有这两张表时按空数组处理
    if has_table(conn, "tags")
        && ["id", "name", "source", "created_at"]
            .iter()
            .all(|column| has_column(conn, "tags", column))
    {
        let mut stmt = conn
            .prepare("SELECT id, name, source, created_at FROM tags ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteTagRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.tags.push(row.map_err(|e| e.to_string())?);
        }
    }
    if has_table(conn, "note_tags")
        && ["note_id", "tag_id", "source", "created_at"]
            .iter()
            .all(|column| has_column(conn, "note_tags", column))
    {
        let mut stmt = conn
            .prepare(
                "SELECT note_id, tag_id, source, created_at
                 FROM note_tags ORDER BY note_id, tag_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteTagRow {
                    note_id: row_text(row, 0)?,
                    tag_id: row.get(1)?,
                    source: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.note_tags.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 加密容器备份才有的密钥包裹元数据；普通快照里这张表是空的
    if has_table(conn, "encrypted_keys")
        && ["scope", "ref_id", "meta_json", "created_at"]
            .iter()
            .all(|column| has_column(conn, "encrypted_keys", column))
    {
        let mut stmt = conn
            .prepare(
                "SELECT scope, ref_id, meta_json, created_at
                 FROM encrypted_keys ORDER BY scope, ref_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteEncryptedKeyRow {
                    scope: row.get(0)?,
                    ref_id: row_text(row, 1)?,
                    meta_json: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.encrypted_keys.push(row.map_err(|e| e.to_string())?);
        }
    }

    Ok(out)
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_sqlite_backup(app: AppHandle, state: State<AppState>, path: String) -> Result<BackupSummary, String> {
    /*
     * 整库替换会丢掉备份里没有的本地内容（加密笔记、密钥、根密码材料…）。
     * 所以先拍一张本地快照，恢复完再把缺的行补回来 —— 与 JSON 恢复同一套策略。
     */
    let preserve = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        LocalPreserve::capture(&conn, "sqlite")?
    };
    // 先把快照里的图片落地成文件，再覆盖数据库：这样「一个 .db 就完整恢复」成立
    restore_attachments_from_snapshot(&app, &std::path::PathBuf::from(&path))?;
    let mut summary = restore_sqlite_snapshot(&state, &std::path::PathBuf::from(&path), false)?;
    {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        summary.preserved = preserve.restore(&conn)?;
    }
    Ok(summary)
}

/// 从 .db 快照里取出图片字节并写到附件目录（`attachments.data` 有值才处理）。
///
/// 老快照没有 attachments 表或 data 列，直接返回 Ok：等价于「这次备份没有图片」。
fn restore_attachments_from_snapshot(app: &AppHandle, source: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    let snap = match Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(snap) => snap,
        Err(_) => return Ok(()),
    };
    if !has_table(&snap, "attachments") || !has_column(&snap, "attachments", "data") {
        return Ok(());
    }
    let mut stmt = snap
        .prepare("SELECT hash, ext, data FROM attachments WHERE data IS NOT NULL")
        .map_err(|e| format!("读取快照图片失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| format!("读取快照图片失败：{e}"))?;
    for row in rows.flatten() {
        let (hash, ext, data) = row;
        // 哈希格式异常的跳过，别让坏数据打断整次恢复
        if hash.len() < 3 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let rel = format!("attachments/{}/{hash}.{ext}", &hash[..2]);
        crate::attachments::restore_attachment(app, &rel, &data)?;
    }
    Ok(())
}

/// 用 SQLite 快照覆盖当前库。
/// `allow_encrypted` 只给加密容器恢复用：跳过「本地/备份含加密内容」两道拦截，
/// 并把 `enc_mode` / `enc_tags` / `encrypted_keys` / 根密码元数据一并写回。
pub(crate) fn restore_sqlite_snapshot(
    state: &State<AppState>,
    source: &Path,
    allow_encrypted: bool,
) -> Result<BackupSummary, String> {
    if !source.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let source_canonical =
        std::fs::canonicalize(source).map_err(|e| format!("读取备份文件失败：{e}"))?;

    let bak = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开 SQLite 备份文件：{e}"))?;
    // 先做完整性检查，再读表结构；坏文件不进入覆盖流程
    let quick_check: String = bak
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("无法校验 SQLite 备份文件：{e}"))?;
    if quick_check != "ok" {
        return Err("SQLite 备份文件已损坏，无法恢复".to_string());
    }
    let data = read_sqlite_backup(&bak)?;
    // 旧快照可能没有这两列，缺列即视为没有加密内容；密钥表有行同样说明是加密备份
    let backup_encrypted = {
        let count_where = |table: &str, column: &str| -> i64 {
            if !has_column(&bak, table, column) {
                return 0;
            }
            bak.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE COALESCE({column}, 0) <> 0"),
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        };
        let has_keys = has_table(&bak, "encrypted_keys")
            && bak
                .query_row("SELECT COUNT(*) FROM encrypted_keys", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0)
                > 0;
        count_where("notes", "enc_mode") + count_where("categories", "is_encrypted") > 0
            || has_keys
    };
    drop(bak);

    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    if conn
        .path()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .map(|p| p == source_canonical)
        .unwrap_or(false)
    {
        return Err("不能用当前正在使用的数据库文件恢复".to_string());
    }

    // 覆盖式恢复会整体替换数据库：本地已有的加密项会连同密钥一起丢失，必须先拦住
    let local_encrypted: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0)
                  + (SELECT COUNT(*) FROM categories WHERE COALESCE(is_encrypted, 0) <> 0)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    /*
     * 过去这里会拒绝「本地有加密内容」或「备份含加密内容」的恢复。现在不再拒绝：
     * 调用方（import_sqlite_backup / import_encrypted_backup）会在恢复前后做本地内容保全，
     * 把备份里没有的本地行（含加密笔记与密钥）补回来。`local_encrypted` / `backup_encrypted`
     * 仍保留计算，用于调试与将来的预检统计。
     */
    let _ = (local_encrypted, backup_encrypted, allow_encrypted);

    // 先记下本机现有的 Key 密文，供备份里没有可用 Key 时按「名称+类型+地址」接回
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, provider_type, api_base_url, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ),
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            local_keys.insert(row.0, row.1);
        }
    }

    // 快照里不含 WebDAV 密码与自动备份状态；先记下本机值，恢复完再接回去
    let local_only_settings = read_local_only_settings(&conn);

    // 加密操作需要不可变的 &Connection，必须在开启事务前算好最终密文
    let mut provider_keys: Vec<String> = Vec::with_capacity(data.providers.len());
    for p in &data.providers {
        let fallback = || {
            local_keys
                .get(&(
                    p.name.clone(),
                    p.provider_type.clone(),
                    p.api_base_url.clone(),
                ))
                .cloned()
                .unwrap_or_default()
        };
        if p.api_key.is_empty() {
            provider_keys.push(fallback());
        } else if is_encrypted(&p.api_key) {
            // 同机备份能用当前密钥解开：原样保留；解不开（换机/换用户）则沿用本机同名服务商的 Key
            if decrypt_secret(&conn, &p.api_key).is_ok() {
                provider_keys.push(p.api_key.clone());
            } else {
                provider_keys.push(fallback());
            }
        } else {
            provider_keys.push(encrypt_secret(&conn, &p.api_key)?);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for sql in [
        "DELETE FROM ai_chat_messages",
        "DELETE FROM ai_chat_sessions",
        "DELETE FROM note_tags",
        "DELETE FROM tags",
        "DELETE FROM notes_history",
        "DELETE FROM notes",
        "DELETE FROM categories",
        "DELETE FROM ai_providers",
        "DELETE FROM app_settings",
        // 备份里的向量可能来自另一台机器/另一个模型，一律不用；恢复后交给 worker 重建。
        // 语义元数据同样清空，否则快照里的 model_id / dim / last_error 会盖住恢复后的真实状态
        "DELETE FROM note_chunks",
        "DELETE FROM note_index_state",
        "DELETE FROM semantic_meta",
        "DELETE FROM encrypted_keys",
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in &data.categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                c.id,
                c.name,
                non_empty_or_now(c.created_at.clone()),
                c.ai_access,
                if c.is_encrypted != 0 { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in &data.notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted,
                                deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                &n.id,
                n.title,
                n.content,
                n.category_id,
                non_empty_or_now(n.created_at.clone()),
                non_empty_or_now(n.updated_at.clone()),
                if n.is_deleted != 0 { 1 } else { 0 },
                n.deleted_at,
                if n.is_pinned != 0 { 1 } else { 0 },
                n.ai_access,
                n.enc_mode,
                n.enc_tags
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for h in &data.notes_history {
        tx.execute(
            "INSERT INTO notes_history (id, note_id, title, content, category_id, is_pinned, kind,
                                        pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                h.id,
                &h.note_id,
                &h.title,
                &h.content,
                h.category_id,
                if h.is_pinned != 0 { 1 } else { 0 },
                normalize_history_kind(&h.kind),
                if h.pinned != 0 { 1 } else { 0 },
                non_empty_or_now(h.saved_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for (i, p) in data.providers.iter().enumerate() {
        let enabled_models = p
            .enabled_models
            .clone()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "[]".to_string());
        tx.execute(
            "INSERT INTO ai_providers (id, name, provider_type, api_base_url, api_key, api_path,
                                       enabled_model, enabled_models, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                p.id,
                p.name,
                p.provider_type,
                p.api_base_url,
                provider_keys[i],
                p.api_path,
                p.enabled_model,
                enabled_models,
                non_empty_or_now(p.created_at.clone()),
                non_empty_or_now(p.updated_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in &data.sessions {
        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, provider_id, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                s.id,
                s.title,
                s.provider_id,
                s.model,
                non_empty_or_now(s.created_at.clone()),
                non_empty_or_now(s.updated_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for m in &data.messages {
        tx.execute(
            "INSERT INTO ai_chat_messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                m.id,
                m.session_id,
                m.role,
                m.content,
                non_empty_or_now(m.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in &data.settings {
        // 普通快照不导入外来的根密码元数据，避免覆盖本机 verifier；
        // 加密容器恢复是整库替换，根密码元数据必须一起回来，否则加密内容再也解不开
        if !allow_encrypted && s.key.starts_with("app.security.") {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![s.key, s.value, non_empty_or_now(s.updated_at.clone())],
        )
        .map_err(|e| e.to_string())?;
    }

    restore_local_only_settings(&tx, &local_only_settings)?;

    for t in &data.tags {
        tx.execute(
            "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                t.id,
                t.name,
                normalize_source(Some(t.source.clone())),
                non_empty_or_now(t.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for nt in &data.note_tags {
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &nt.note_id,
                nt.tag_id,
                normalize_source(Some(nt.source.clone())),
                non_empty_or_now(nt.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for k in &data.encrypted_keys {
        tx.execute(
            "INSERT OR REPLACE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                k.scope,
                &k.ref_id,
                k.meta_json,
                non_empty_or_now(k.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);
    // 库里的密钥元数据整个换了一批，内存里缓存的旧 DEK/KEK 全部作废
    if allow_encrypted {
        state.encryption.clear_all();
    }
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: data.notes.len(),
        categories: data.categories.len(),
        providers: data.providers.len(),
        sessions: data.sessions.len(),
        messages: data.messages.len(),
        settings: data.settings.len(),
        skipped_encrypted: 0,
        preserved: 0,
        exported_at: data.exported_at,
    })
}

/* ---------------- 加密容器备份 ----------------
 * 整库 SQLite 快照（含加密笔记、encrypted_keys、根密码元数据）用**独立的备份口令**
 * 再包一层 Argon2id + AES-256-GCM，容器文件本身就是密文：
 *   FNBK1\n<json 头>\n<nonce‖密文‖tag>
 * 头部（含 KDF 参数与盐）同时作为 AAD，改一个字节都解不开。
 * 恢复时先解容器，再走 allow_encrypted 的整库替换；条目内容仍需各自的密码/根密码解锁。
 */

const ENCRYPTED_BACKUP_MAGIC: &[u8] = b"FNBK1\n";

const ENCRYPTED_BACKUP_FORMAT: &str = "fastnote-encrypted-backup";

const ENCRYPTED_BACKUP_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct EncryptedBackupHeader {
    format: String,
    version: u32,
    kdf: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    created_at: String,
}

pub(crate) fn validate_backup_passphrase(passphrase: &str) -> Result<(), String> {
    let len = passphrase.chars().count();
    if len < 8 {
        return Err(json!({ "code": "backup_passphrase_too_short" }).to_string());
    }
    if len > 128 {
        return Err(json!({ "code": "backup_passphrase_too_long" }).to_string());
    }
    Ok(())
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_encrypted_backup(
    state: State<AppState>,
    path: String,
    passphrase: String,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    validate_backup_passphrase(&passphrase)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let exported_at = Local::now().to_rfc3339();
    let count = |sql: &str| -> usize {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0) as usize
    };
    // 加密备份是整库快照：加密笔记也算在摘要里
    let summary = BackupSummary {
        notes: count("SELECT COUNT(*) FROM notes"),
        categories: count("SELECT COUNT(*) FROM categories"),
        providers: count_rows(&conn, "ai_providers"),
        sessions: count_rows(&conn, "ai_chat_sessions"),
        messages: count_rows(&conn, "ai_chat_messages"),
        settings: count("SELECT COUNT(*) FROM app_settings"),
        skipped_encrypted: 0,
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let target = std::path::PathBuf::from(&path);
    let parent = target.parent().ok_or("备份路径不可用".to_string())?;
    let tmp_db = parent.join(format!(".fastnote-encdb-{}.tmp", std::process::id()));
    let tmp_out = parent.join(format!(".fastnote-encout-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp_db);
    let _ = std::fs::remove_file(&tmp_out);

    let result = (|| -> Result<(), String> {
        // 容器里保留 API Key / WebDAV 密文：文件本身已有口令保护，不额外裁剪
        build_sqlite_snapshot(&conn, &tmp_db, &app, &exported_at, true, true, true)?;
        let mut plain = std::fs::read(&tmp_db).map_err(|e| format!("读取数据库快照失败：{e}"))?;
        let _ = std::fs::remove_file(&tmp_db);

        let salt = crypto::random_salt();
        let header = EncryptedBackupHeader {
            format: ENCRYPTED_BACKUP_FORMAT.to_string(),
            version: ENCRYPTED_BACKUP_VERSION,
            kdf: crypto::KDF_ARGON2ID.to_string(),
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
            salt: crypto::hex_encode(&salt),
            created_at: exported_at.clone(),
        };
        let header_line = serde_json::to_string(&header).map_err(|e| e.to_string())?;
        let key = Zeroizing::new(crypto::derive_argon2id(
            &passphrase,
            &salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )?);
        // 头部当 AAD：盐或 KDF 参数被改过就解不开，避免降参数重算
        let sealed = crypto::seal_bytes(&key, header_line.as_bytes(), &plain)?;
        plain.zeroize();

        let mut out = Vec::with_capacity(ENCRYPTED_BACKUP_MAGIC.len() + header_line.len() + 1 + sealed.len());
        out.extend_from_slice(ENCRYPTED_BACKUP_MAGIC);
        out.extend_from_slice(header_line.as_bytes());
        out.push(b'\n');
        out.extend_from_slice(&sealed);
        std::fs::write(&tmp_out, &out).map_err(|e| format!("保存加密备份失败：{e}"))?;
        replace_backup_file(&tmp_out, &target)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_db);
        let _ = std::fs::remove_file(&tmp_out);
    }
    result?;
    Ok(summary)
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_encrypted_backup(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    passphrase: String,
) -> Result<BackupSummary, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let raw = std::fs::read(&source).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let rest = raw
        .strip_prefix(ENCRYPTED_BACKUP_MAGIC)
        .ok_or_else(|| json!({ "code": "not_encrypted_backup" }).to_string())?;
    let split = rest
        .iter()
        .position(|b| *b == b'\n')
        .ok_or_else(|| "备份文件头已损坏".to_string())?;
    let header_bytes = &rest[..split];
    let body = &rest[split + 1..];
    let header: EncryptedBackupHeader =
        serde_json::from_slice(header_bytes).map_err(|_| "备份文件头已损坏".to_string())?;
    if header.format != ENCRYPTED_BACKUP_FORMAT {
        return Err(json!({ "code": "not_encrypted_backup" }).to_string());
    }
    if header.version > ENCRYPTED_BACKUP_VERSION {
        return Err("备份由更新版本的 FastNote 创建，请先升级软件再恢复".to_string());
    }
    if header.kdf != crypto::KDF_ARGON2ID {
        return Err("不支持的备份加密算法".to_string());
    }
    let salt = crypto::hex_decode(&header.salt)?;
    let key = Zeroizing::new(crypto::derive_argon2id(
        &passphrase,
        &salt,
        header.m_cost,
        header.t_cost,
        header.p_cost,
    )?);
    // 口令错和文件被截断在这里是同一种失败：AES-GCM 校验不过
    let mut plain = crypto::open_bytes(&key, header_bytes, body)
        .map_err(|_| json!({ "code": "bad_backup_passphrase" }).to_string())?;

    let tmp = std::env::temp_dir().join(format!("fastnote-restore-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let write = std::fs::write(&tmp, &plain);
    plain.zeroize();
    write.map_err(|e| format!("写入临时文件失败：{e}"))?;

    // 加密备份同样带着图片字节（快照的 attachments.data），先落地成文件再覆盖数据库
    restore_attachments_from_snapshot(&app, &tmp)?;
    let result = restore_sqlite_snapshot(&state, &tmp, true);
    let _ = std::fs::remove_file(&tmp);
    result
}

/* ---------------- 分组导出（ZIP / 电子书） ----------------
 * 笔记正文是 Markdown 原文，导出 HTML / EPUB 时用 pulldown-cmark 渲染成网页。
 * 章节顺序统一为「按创建时间正序」：最早创建的笔记在前；章节名直接用笔记标题。
 */

#[derive(Debug)]
pub struct ZipEntry {
    name: String,
    /// 二进制：分组导出要把图片原样打进包，文本只是其中一种
    content: Vec<u8>,
}

/// 压缩包「其他文件格式」下，单篇笔记自选的后缀
#[derive(Debug, Deserialize)]
pub struct NoteFormatSpec {
    id: String,
    ext: String,
}

/// 按顺序写进 zip；EPUB 要求 mimetype 必须是第一个条目且不压缩，这里按名字特殊处理
pub(crate) fn write_zip_file(path: &str, entries: &[ZipEntry]) -> Result<(), String> {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;
    use zip::CompressionMethod;

    let file = std::fs::File::create(path).map_err(|e| format!("创建压缩包失败：{e}"))?;
    let mut zip = zip::ZipWriter::new(file);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);

    for entry in entries {
        let options = if entry.name == "mimetype" {
            stored
        } else {
            deflated
        };
        zip.start_file(entry.name.as_str(), options)
            .map_err(|e| format!("写入 {0} 失败：{1}", entry.name, e))?;
        zip.write_all(&entry.content)
            .map_err(|e| format!("写入 {0} 失败：{1}", entry.name, e))?;
    }

    zip.finish().map_err(|e| format!("生成压缩包失败：{e}"))?;
    Ok(())
}

/// Markdown → HTML 片段
pub(crate) fn md_to_html(text: &str) -> String {
    use pulldown_cmark::{html, Options, Parser};
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_FOOTNOTES);
    let mut out = String::new();
    html::push_html(&mut out, Parser::new_ext(text, options));
    out
}

pub(crate) fn esc_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 文件名清洗：去掉 Windows 不允许的字符，截断长度，空标题用兜底名
pub(crate) fn safe_filename(name: &str, fallback: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"\/:*?"<>|"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows 下结尾的点和空格会被截掉，这里主动去掉
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

/// 清洗用户自选的后缀：只留字母数字，避免路径穿越与非法文件名；空值退回 txt。
/// 白名单在前端维护（src/config/textFileFormats.ts），这里只做文件名安全兜底。
pub(crate) fn sanitize_ext(ext: &str) -> String {
    let cleaned: String = ext
        .trim()
        .trim_start_matches('.')
        .to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if cleaned.is_empty() {
        "txt".to_string()
    } else {
        cleaned
    }
}

/// 分组下未删除的笔记，按创建时间正序（最早在前）
pub(crate) fn load_category_notes(conn: &Connection, category_id: &str) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND category_id = ?1 AND COALESCE(enc_mode, 0) = 0
             ORDER BY created_at ASC, id ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![category_id], map_row_to_note)
        .map_err(|e| e.to_string())?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(row.map_err(|e| e.to_string())?);
    }
    Ok(notes)
}

/// 按指定 ID 列表加载未删除的笔记，保持传入顺序
pub(crate) fn load_notes_by_ids(conn: &Connection, note_ids: &[String]) -> Result<Vec<Note>, String> {
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND id = ?1 AND COALESCE(enc_mode, 0) = 0",
        )
        .map_err(|e| e.to_string())?;
    let mut notes = Vec::with_capacity(note_ids.len());
    for id in note_ids {
        let mut rows = stmt
            .query_map(params![id], map_row_to_note)
            .map_err(|e| e.to_string())?;
        if let Some(row) = rows.next() {
            notes.push(row.map_err(|e| e.to_string())?);
        }
    }
    Ok(notes)
}

pub(crate) fn load_category_name(conn: &Connection, category_id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT name FROM categories WHERE id = ?1",
        params![category_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| "分组不存在".to_string())
}

/// 单篇笔记的完整 HTML 页面
pub(crate) fn note_html_page(title: &str, content: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nimg{{display:block;max-width:100%;max-height:80vh;width:auto;height:auto;margin:1.2em auto;border-radius:6px}}\nh1{{border-bottom:1px solid #e2e8f0;padding-bottom:8px}}\n</style>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
        esc_html(title),
        esc_html(title),
        md_to_html(content)
    )
}

/// 把笔记引用到的图片打进压缩包（放在 zip 根目录的 `attachments/` 下）。
///
/// 正文里写的就是相对路径 `attachments/xx/hash.ext`，落进压缩包后位置不变，
/// 所以 Markdown **一个字都不用改**，解压后 Typora / Obsidian / VS Code 直接能看。
/// 只打包本次导出范围内笔记引用到的图，不多带一张。
fn push_attachment_entries(app: &AppHandle, notes: &[Note], entries: &mut Vec<ZipEntry>) {
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for note in notes {
        for path in crate::attachments::collect_attachment_paths(&note.content) {
            if !seen.insert(path.clone()) {
                continue;
            }
            if let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) {
                entries.push(ZipEntry {
                    name: path,
                    content: bytes,
                });
            }
        }
    }
}

/// 导出分组为压缩包：一篇笔记一个文件，格式可选
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_category_zip(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    if encryption::category_is_encrypted(&conn, &category_id)? {
        return Err(json!({ "code": "category_encrypted" }).to_string());
    }
    let notes = load_category_notes(&conn, &category_id)?;
    if notes.is_empty() {
        return Err("这个分组下还没有笔记，没什么可导出的".to_string());
    }

    let ext = match format.as_str() {
        "txt" => "txt",
        "html" => "html",
        "json" => "json",
        _ => "md",
    };

    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut entries = Vec::with_capacity(notes.len());
    for (i, note) in notes.iter().enumerate() {
        let base = safe_filename(&note.title, &format!("未命名笔记-{}", i + 1));
        let count = used.entry(base.to_lowercase()).or_insert(0);
        *count += 1;
        let name = if *count > 1 {
            format!("{base}-{count}.{ext}")
        } else {
            format!("{base}.{ext}")
        };

        let content = match ext {
            "html" => note_html_page(&note.title, &note.content),
            "json" => serde_json::to_string_pretty(&json!({
                "title": note.title,
                "content": note.content,
                "created_at": note.created_at,
                "updated_at": note.updated_at,
            }))
            .unwrap_or_default(),
            // md / txt 都是 Markdown 原文，txt 不带 md 语法高亮能力但内容一致
            _ => note.content.clone(),
        };

        entries.push(ZipEntry { name, content: content.into_bytes() });
    }

    // 把引用到的图片一并打进包（正文里的相对路径与 zip 根目录下的 attachments/ 对齐）
    push_attachment_entries(&app, &notes, &mut entries);
    let total = notes.len();
    write_zip_file(&path, &entries)?;
    Ok(total)
}

/// 导出分组为电子书
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_category_ebook(
    app: AppHandle,
    state: State<AppState>,
    category_id: String,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    if encryption::category_is_encrypted(&conn, &category_id)? {
        return Err(json!({ "code": "category_encrypted" }).to_string());
    }
    let title = load_category_name(&conn, &category_id)?;
    let notes = load_category_notes(&conn, &category_id)?;
    if notes.is_empty() {
        return Err("这个分组下还没有笔记，没什么可导出的".to_string());
    }

    match format.as_str() {
        "html" => {
            let text = ebook_single_html(&app, &notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
        "epub" => {
            let entries = ebook_epub_entries(&app, &title, &notes);
            write_zip_file(&path, &entries)?;
            Ok(notes.len())
        }
        _ => {
            // txt：章节之间用分隔线断开，正文是 Markdown 原文
            let text = ebook_plain_text(&notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
    }
}

/// 导出指定笔记 ID 列表为压缩包：一篇笔记一个文件。
/// format 是预设格式；note_formats 非空时表示「其他文件格式」逐篇自选后缀，此时以逐篇后缀为准。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_notes_zip(
    app: AppHandle,
    state: State<AppState>,
    note_ids: Vec<String>,
    path: String,
    format: String,
    note_formats: Option<Vec<NoteFormatSpec>>,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let notes = load_notes_by_ids(&conn, &note_ids)?;
    if notes.is_empty() {
        return Err("没有选定笔记，没什么可导出的".to_string());
    }

    let global_ext = match format.as_str() {
        "txt" => "txt",
        "html" => "html",
        "json" => "json",
        _ => "md",
    }
    .to_string();
    let per_note: std::collections::HashMap<String, String> = note_formats
        .unwrap_or_default()
        .into_iter()
        .map(|spec| (spec.id, sanitize_ext(&spec.ext)))
        .collect();

    let mut used: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut entries = Vec::with_capacity(notes.len());
    for (i, note) in notes.iter().enumerate() {
        // 逐篇自选的后缀优先，没有就用预设格式
        let ext = per_note
            .get(&note.id)
            .cloned()
            .unwrap_or_else(|| global_ext.clone());
        let base = safe_filename(&note.title, &format!("未命名笔记-{}", i + 1));
        let count = used.entry(base.to_lowercase()).or_insert(0);
        *count += 1;
        let name = if *count > 1 {
            format!("{base}-{count}.{ext}")
        } else {
            format!("{base}.{ext}")
        };

        // 后缀决定落盘内容：html / json 有专门形态，其余（含逐篇自选的后缀）都是原文直出
        let content = match ext.as_str() {
            "html" => note_html_page(&note.title, &note.content),
            "json" => serde_json::to_string_pretty(&json!({
                "title": note.title,
                "content": note.content,
                "created_at": note.created_at,
                "updated_at": note.updated_at,
            }))
            .unwrap_or_default(),
            _ => note.content.clone(),
        };

        entries.push(ZipEntry { name, content: content.into_bytes() });
    }

    // 把引用到的图片一并打进包（正文里的相对路径与 zip 根目录下的 attachments/ 对齐）
    push_attachment_entries(&app, &notes, &mut entries);
    let total = notes.len();
    write_zip_file(&path, &entries)?;
    Ok(total)
}

/// 导出指定笔记 ID 列表为电子书
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_notes_ebook(
    app: AppHandle,
    state: State<AppState>,
    note_ids: Vec<String>,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let notes = load_notes_by_ids(&conn, &note_ids)?;
    if notes.is_empty() {
        return Err("没有选定笔记，没什么可导出的".to_string());
    }

    // EPUB 的书名走文件元数据：直接用用户填的文件名，不再出现程序生成的标题
    let title = std::path::Path::new(&path)
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("笔记")
        .to_string();

    match format.as_str() {
        "html" => {
            let text = ebook_single_html(&app, &notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
        "epub" => {
            let entries = ebook_epub_entries(&app, &title, &notes);
            write_zip_file(&path, &entries)?;
            Ok(notes.len())
        }
        _ => {
            // txt：章节之间用分隔线断开，正文是 Markdown 原文
            let text = ebook_plain_text(&notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
    }
}

/// 单文件 HTML 电子书：目录 + 各章锚点，可直接用浏览器看
pub(crate) fn ebook_single_html(app: &AppHandle, notes: &[Note]) -> String {
    let mut toc = String::new();
    let mut body = String::new();
    for (i, note) in notes.iter().enumerate() {
        let anchor = format!("chapter-{}", i + 1);
        toc.push_str(&format!(
            "<li><a href=\"#{anchor}\">{}</a></li>\n",
            esc_html(&note.title)
        ));
        /*
         * 单文件 HTML 要能「发给谁都能打开」，图片直接内联成 data URI：
         * 不依赖附件目录、不联网。先改写 Markdown 再渲染，正文其余部分保持原样。
         */
        let inlined = crate::attachments::map_attachment_paths(&note.content, &|path| {
            let bytes = crate::attachments::read_attachment_bytes(app, path)?;
            Some(format!(
                "data:{};base64,{}",
                crate::attachments::mime_of_attachment(path),
                crate::attachments::base64_encode(&bytes)
            ))
        });
        body.push_str(&format!(
            "<section id=\"{anchor}\">\n<h2>{}</h2>\n{}\n</section>\n",
            esc_html(&note.title),
            md_to_html(&inlined)
        ));
    }
    // 沉浸式正文：不出现书名大标题，页面标题取第一章标题
    let page_title = notes
        .first()
        .map(|note| note.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or("笔记");
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nimg{{display:block;max-width:100%;max-height:80vh;width:auto;height:auto;margin:1.2em auto;border-radius:6px}}\nsection{{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0}}\n.toc{{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 24px}}\n</style>\n</head>\n<body>\n<nav class=\"toc\">\n<h3>目录</h3>\n<ol>\n{}</ol>\n</nav>\n{}\n</body>\n</html>\n",
        esc_html(page_title),
        toc,
        body
    )
}

/// 纯文本电子书：只按章节拼接，不出现书名与章节数，正文是 Markdown 原文
pub(crate) fn ebook_plain_text(notes: &[Note]) -> String {
    let mut text = String::new();
    for (i, note) in notes.iter().enumerate() {
        if i > 0 {
            text.push('\n');
        }
        text.push_str(&format!(
            "{}\n{}\n\n{}\n",
            note.title,
            "-".repeat(40),
            note.content
        ));
    }
    text
}

/// EPUB（EPUB 3）：本质是特定结构的 zip
///
/// 图片作为包内资源放 `OEBPS/images/<hash>.<ext>`，章节里把
/// `attachments/xx/hash.ext` 改写成 `images/<hash>.<ext>`，
/// 并在 `content.opf` 的 manifest 里补上对应 `<item>`——否则阅读器不认这些资源。
pub(crate) fn ebook_epub_entries(app: &AppHandle, title: &str, notes: &[Note]) -> Vec<ZipEntry> {
    use std::collections::HashMap;

    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let book_id = format!("urn:fastnote:{}", chrono::Utc::now().timestamp());

    let mut manifest = String::new();
    let mut spine = String::new();
    let mut nav = String::new();

    let mut entries = Vec::with_capacity(notes.len() + 4);

    // mimetype 必须是第一个条目且不压缩（write_zip_file 按名字处理）
    entries.push(ZipEntry {
        name: "mimetype".to_string(),
        content: b"application/epub+zip".to_vec(),
    });
    entries.push(ZipEntry {
        name: "META-INF/container.xml".to_string(),
        content: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n  <rootfiles>\n    <rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n  </rootfiles>\n</container>\n".as_bytes().to_vec(),
    });

    // 先把整本书引用到的图片收进来：同一张图在多个章节里只打一份
    let mut image_map: HashMap<String, String> = HashMap::new();
    let mut image_index = 0usize;
    for note in notes {
        for path in crate::attachments::collect_attachment_paths(&note.content) {
            if image_map.contains_key(&path) {
                continue;
            }
            let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) else {
                continue;
            };
            let file_name = path.rsplit('/').next().unwrap_or("image.png").to_string();
            image_index += 1;
            let media_type = crate::attachments::mime_of_attachment(&path);
            manifest.push_str(&format!(
                "    <item id=\"img{image_index}\" href=\"images/{file_name}\" media-type=\"{media_type}\"/>\n"
            ));
            entries.push(ZipEntry {
                name: format!("OEBPS/images/{file_name}"),
                content: bytes,
            });
            image_map.insert(path, format!("images/{file_name}"));
        }
    }

    for (i, note) in notes.iter().enumerate() {
        let index = i + 1;
        let href = format!("chapter-{index}.xhtml");
        manifest.push_str(&format!(
            "    <item id=\"chap{index}\" href=\"{href}\" media-type=\"application/xhtml+xml\"/>\n"
        ));
        spine.push_str(&format!("    <itemref idref=\"chap{index}\"/>\n"));
        nav.push_str(&format!(
            "      <li><a href=\"{href}\">{}</a></li>\n",
            esc_html(&note.title)
        ));

        // 图片路径改写成包内相对路径；找不到文件的引号原样留下（阅读器显示破图，但正文不丢）
        let content = crate::attachments::map_attachment_paths(&note.content, &|path| {
            image_map.get(path).cloned()
        });

        entries.push(ZipEntry {
            name: format!("OEBPS/{href}"),
            content: format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\" lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>{}</title>\n<style>img{{max-width:100%;height:auto}}</style>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
                esc_html(&note.title),
                esc_html(&note.title),
                md_to_html(&content)
            )
            .into_bytes(),
        });
    }

    let nav_doc = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"zh-CN\" lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>目录</title>\n</head>\n<body>\n<nav epub:type=\"toc\" id=\"toc\">\n<h1>目录</h1>\n<ol>\n{nav}</ol>\n</nav>\n</body>\n</html>\n"
    );

    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\">\n  <metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n    <dc:identifier id=\"bookid\">{book_id}</dc:identifier>\n    <dc:title>{title}</dc:title>\n    <dc:language>zh-CN</dc:language>\n    <meta property=\"dcterms:modified\">{modified}</meta>\n  </metadata>\n  <manifest>\n    <item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n{manifest}  </manifest>\n  <spine>\n{spine}  </spine>\n</package>\n",
        title = esc_html(title)
    );

    entries.push(ZipEntry {
        name: "OEBPS/nav.xhtml".to_string(),
        content: nav_doc.into_bytes(),
    });
    entries.push(ZipEntry {
        name: "OEBPS/content.opf".to_string(),
        content: opf.into_bytes(),
    });

    entries
}

/* ---------------- 电脑文本文件读写 ----------------
 * 「拖入/打开电脑文件」功能用：读取时做文本检测（NUL 字节 / UTF-8），
 * 写入时用同目录临时文件原子替换，避免写一半把原文件写坏。
 */

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TextFileInfo {
    pub path: String,
    pub name: String,
    pub content: String,
}

/// 单文件大小上限：超过就不允许打开，避免把超大文件塞进编辑器
const TEXT_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 非文本检测的取样长度：只看开头这一段的 NUL 字节
const TEXT_FILE_SNIFF_BYTES: usize = 8 * 1024;

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn read_text_file(path: String) -> Result<TextFileInfo, String> {
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err("不是可打开的文件".to_string());
    }
    let meta = std::fs::metadata(p).map_err(|e| format!("读取文件失败：{}", e))?;
    if meta.len() > TEXT_FILE_MAX_BYTES {
        return Err("文件过大，暂不支持打开".to_string());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("读取文件失败：{}", e))?;
    let sniff_len = bytes.len().min(TEXT_FILE_SNIFF_BYTES);
    if bytes[..sniff_len].contains(&0u8) {
        return Err("这不是文本文件".to_string());
    }
    // 去掉 UTF-8 BOM，避免编辑器里出现多余字符
    let text_bytes: &[u8] = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &bytes[3..]
    } else {
        &bytes
    };
    let content =
        String::from_utf8(text_bytes.to_vec()).map_err(|_| "不是 UTF-8 文本文件".to_string())?;
    // 展示用文件名去掉扩展名（如 note.md → note），避免分组/编辑页标题带后缀
    let name = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| path.clone());
    Ok(TextFileInfo {
        path,
        name,
        content,
    })
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let dir = p.parent().ok_or_else(|| "无效的文件路径".to_string())?;
    let file_name = p
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or_else(|| "无效的文件路径".to_string())?;
    let tmp = dir.join(format!(".{}.fastnote.tmp", file_name));
    std::fs::write(&tmp, content.as_bytes()).map_err(|e| format!("写入失败：{}", e))?;
    std::fs::rename(&tmp, p).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("写入失败：{}", e)
    })?;
    Ok(())
}



#[cfg(test)]
mod sqlite_selection_tests {
    use super::*;

    fn snapshot_conn(extra_notes_cols: bool) -> Connection {
        let conn = Connection::open_in_memory().expect("内存库");
        let enc_cols = if extra_notes_cols {
            ", enc_mode INTEGER NOT NULL DEFAULT 0, enc_tags TEXT"
        } else {
            ""
        };
        conn.execute_batch(&format!(
            "CREATE TABLE {SQLITE_BACKUP_META} (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
             CREATE TABLE notes (
                 id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL,
                 category_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL{enc_cols}
             );
             CREATE TABLE ai_providers (
                 id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider_type TEXT NOT NULL,
                 api_base_url TEXT NOT NULL, api_key TEXT NOT NULL,
                 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE ai_chat_sessions (
                 id INTEGER PRIMARY KEY, title TEXT NOT NULL, provider_id INTEGER NOT NULL,
                 model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
             );
             CREATE TABLE ai_chat_messages (
                 id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL, role TEXT NOT NULL,
                 content TEXT NOT NULL, created_at TEXT NOT NULL
             );
             CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
             INSERT INTO {SQLITE_BACKUP_META} (key, value) VALUES
                 ('format', '{SQLITE_BACKUP_FORMAT}'), ('version', '1');
             INSERT INTO categories (id, name, created_at) VALUES ('c1', '默认', '2026-01-01');
             INSERT INTO notes (id, title, content, category_id, created_at, updated_at)
                 VALUES ('n1', '标题', '正文', 'c1', '2026-01-01', '2026-01-02');
             INSERT INTO app_settings (key, value, updated_at)
                 VALUES ('app.security.root.salt', 'abcd', '2026-01-01');",
        ))
        .expect("建表");
        conn
    }

    /// 快照要能被读成与 JSON 备份同构的 data：缺列用默认值补，根密码材料也要读到
    #[test]
    fn snapshot_converts_to_backup_data() {
        let conn = snapshot_conn(false);
        let data = sqlite_snapshot_to_data(&conn).expect("转换失败");
        let notes = json_arr(&data, "notes");
        assert_eq!(notes.len(), 1);
        assert_eq!(json_str(&notes[0], "title"), "标题");
        // 旧快照没有 enc_mode 列：按 0 兜底，不能被当成加密笔记
        assert_eq!(json_i64(&notes[0], "enc_mode"), 0);
        assert_eq!(json_arr(&data, "categories").len(), 1);
        // app.security.* 必须一起读出来，换机解锁全靠它
        let settings = json_arr(&data, "settings");
        assert!(settings
            .iter()
            .any(|s| json_str(s, "key") == "app.security.root.salt"));
    }

    /// 有 enc_mode 列时如实读出，选择逻辑才知道哪些是加密笔记
    #[test]
    fn snapshot_reads_enc_mode_when_present() {
        let conn = snapshot_conn(true);
        conn.execute("UPDATE notes SET enc_mode = 1", []).expect("置加密");
        let data = sqlite_snapshot_to_data(&conn).expect("转换失败");
        assert_eq!(json_i64(&json_arr(&data, "notes")[0], "enc_mode"), 1);
    }
}

#[cfg(test)]
mod selection_tests {
    use super::*;

    /// 分组过滤：空列表 = 全部；给了白名单就只认白名单里的；
    /// 未分组笔记只有在显式勾了 `__none__` 时才算在范围内。
    #[test]
    fn in_scope_filters_by_category() {
        let all = BackupSelection::default();
        assert!(all.in_scope(None), "空列表应包含未分组");
        assert!(all.in_scope(Some("any")), "空列表应包含任意分组");

        let picked = BackupSelection {
            category_ids: vec!["a".to_string()],
            ..Default::default()
        };
        assert!(picked.in_scope(Some("a")));
        assert!(!picked.in_scope(Some("b")));
        assert!(!picked.in_scope(None), "没勾未分组时不应带回来");

        let ungrouped = BackupSelection {
            category_ids: vec![SELECTION_UNGROUPED.to_string()],
            ..Default::default()
        };
        assert!(ungrouped.in_scope(None));
        assert!(!ungrouped.in_scope(Some("a")));
    }
}

#[cfg(test)]
mod preserve_tests {
    use super::*;

    /// 恢复前后「本地独有内容」的保全：备份里有的以备份为准，备份里没有的补回来。
    #[test]
    fn copy_missing_rows_keeps_local_only_rows() {
        let main = Connection::open_in_memory().expect("内存库");
        main.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             INSERT INTO notes VALUES ('1', 'backup-version');",
        )
        .expect("准备 main");

        let prev_path = std::env::temp_dir().join(format!(
            "fastnote-preserve-test-{}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&prev_path);
        {
            let prev = Connection::open(&prev_path).expect("prev 库");
            prev.execute_batch(
                "CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL);
                 INSERT INTO notes VALUES ('1', 'local-version');
                 INSERT INTO notes VALUES ('2', 'local-only');",
            )
            .expect("准备 prev");
        }

        main.execute(
            "ATTACH DATABASE ?1 AS prev",
            params![prev_path.to_string_lossy().to_string()],
        )
        .expect("挂载");

        let preserved = copy_missing_rows(&main, "notes", &[]);
        assert_eq!(preserved, 1, "只有本地独有的 id=2 应该被补回");
        let first: String = main
            .query_row("SELECT title FROM notes WHERE id = '1'", [], |r| r.get(0))
            .expect("读 id=1");
        assert_eq!(first, "backup-version", "同 id 冲突时以备份为准");
        let second: String = main
            .query_row("SELECT title FROM notes WHERE id = '2'", [], |r| r.get(0))
            .expect("读 id=2");
        assert_eq!(second, "local-only");

        let _ = main.execute("DETACH DATABASE prev", []);
        let _ = std::fs::remove_file(&prev_path);
    }
}

#[cfg(test)]
mod export_css_tests {
    use super::*;

    /// 导出的 HTML 必须给图片兜底尺寸限制：不限制的话原图按像素铺开，
    /// 一张 3000px 宽的截图会把整篇挤成横向滚动。
    #[test]
    fn note_html_page_limits_image_size() {
        let page = note_html_page("标题", "![a](attachments/3f/3f9c2a8e1d4b6c7a.png)");
        assert!(page.contains("<img"), "Markdown 里的图片应被渲染成 <img>");
        assert!(
            page.contains("img{display:block;max-width:100%"),
            "导出页缺少图片样式：{page}"
        );
    }
}
