use chrono::{DateTime, Duration, Local};
use futures_util::StreamExt;
use ring::rand::{SecureRandom, SystemRandom};
use rusqlite::{params, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State};

mod download;
mod fingerprint;
mod opener;
mod semantic;
mod webdav;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    pub id: i64,
    pub title: String,
    pub content: String,
    pub category_id: Option<i64>,
    pub created_at: String,
    pub updated_at: String,
    pub is_deleted: bool,
    pub deleted_at: Option<String>,
    pub is_pinned: bool,
    /// AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
    /// 笔记与所属分组各存一档，生效值取更严格的那个（见前端 lib/aiAccess.ts）。
    pub ai_access: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub note_count: i32,
    /// AI 访问档位（0=禁止 / 1=只读 / 2=完全），作为组内笔记的上限
    pub ai_access: i64,
}

/// 标签。
///
/// `source` 区分是谁加的：`user` 是用户在属性窗里加的，`ai` 是 AI 通过工具生成的。
/// 前端据此分样式，并且只允许删除自己那一类 —— AI 生成的标签用户动不了（反过来也一样）。
/// 名称用 NOCASE 唯一：大写/小写写法不同但语义相同的标签不该共存两条。
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Tag {
    pub id: i64,
    pub name: String,
    /// "user" / "ai"
    pub source: String,
    pub created_at: String,
    /// 关联了多少篇**未删除**的笔记（列表里展示 "3" 这种计数）
    pub note_count: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiProvider {
    pub id: i64,
    pub name: String,
    pub provider_type: String,
    pub api_base_url: String,
    pub api_key: String,
    pub api_path: Option<String>,
    /// 当前对话使用的模型（聊天面板下拉的当前值）
    pub enabled_model: Option<String>,
    /// 设置里勾选的可用模型列表（JSON 数组，存 TEXT）
    #[serde(default)]
    pub enabled_models: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiChatMessage {
    pub role: String,
    pub content: String,
    /// 模型原生思维链（如 DeepSeek reasoning_content），随消息一起回传以保持上下文
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiChatSession {
    pub id: i64,
    pub title: String,
    pub provider_id: i64,
    pub model: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AiChatDbMessage {
    pub id: i64,
    pub session_id: i64,
    pub role: String,
    pub content: String,
    pub created_at: String,
}

struct AppState {
    conn: Mutex<Connection>,
    semantic: semantic::SemanticState,
    download: download::DownloadState,
    webdav: webdav::WebdavState,
}

/// 判断某张表是否存在（用于读取可选的数据表）
fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

/// 判断某张表是否已有指定列（用于幂等迁移）
fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    for name in rows.flatten() {
        if name == column {
            return true;
        }
    }
    false
}

/// 解析数据库中的模型列表（JSON 数组 TEXT）
fn parse_models_json(raw: Option<String>) -> Vec<String> {
    let text = raw.unwrap_or_default();
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }
    serde_json::from_str::<Vec<String>>(trimmed)
        .map(|models| {
            let mut seen = std::collections::HashSet::new();
            models
                .into_iter()
                .map(|m| m.trim().to_string())
                .filter(|m| !m.is_empty() && seen.insert(m.clone()))
                .collect()
        })
        .unwrap_or_default()
}

/// 给 webdav 模块用的内部入口：命令函数本身不能被其他模块直接调用
/// （`#[tauri::command]` 生成的宏名会与跨模块引用冲突），这里只做一层转发。
pub(crate) fn backup_export_for_webdav(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    export_backup(state, path, include_api_keys, include_webdav, app)
}

pub(crate) fn backup_import_for_webdav(
    state: State<AppState>,
    path: String,
) -> Result<BackupSummary, String> {
    import_backup(state, path)
}

pub(crate) fn backup_import_sqlite_for_webdav(
    state: State<AppState>,
    path: String,
) -> Result<BackupSummary, String> {
    import_sqlite_backup(state, path)
}

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL,
            ai_access INTEGER NOT NULL DEFAULT 2
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id INTEGER,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            is_deleted INTEGER DEFAULT 0,
            deleted_at TEXT,
            is_pinned INTEGER DEFAULT 0,
            ai_access INTEGER NOT NULL DEFAULT 2,
            FOREIGN KEY (category_id) REFERENCES categories(id)
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_providers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            provider_type TEXT NOT NULL,
            api_base_url TEXT NOT NULL,
            api_key TEXT NOT NULL,
            api_path TEXT,
            enabled_model TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            provider_id INTEGER NOT NULL,
            model TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS ai_chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            content TEXT NOT NULL,
            created_at TEXT NOT NULL,
            FOREIGN KEY (session_id) REFERENCES ai_chat_sessions(id)
        )",
        [],
    )?;

    // ---- 应用设置（AI 设置、记忆/前置提示词等）----
    // 键值对形式：每个设置一行，缺键时前端自动回退到默认值。
    // 老版本用 localStorage 存的设置会在首次读取时迁移进来（见前端 migrateLocalSettings）。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )",
        [],
    )?;

    /*
     * ---- 标签（跨分组的主题检索）----
     * 一篇笔记只能进一个分组，标签是第二条维度：多对多，用来回答「所有和 X 相关的笔记」。
     *
     * `source` 记在**关联表**上而不是标签上：同一个词（比如「待办」）可能用户自己打过、
     * 也被 AI 打过，把它拆成两个 tag 行会让计数与去重都变得很难解释。
     * 标签行的 source 表示「这个词最初是谁建的」，只用于展示；删除与否看关联表。
     */
    conn.execute(
        "CREATE TABLE IF NOT EXISTS tags (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL COLLATE NOCASE UNIQUE,
            source TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_tags (
            note_id INTEGER NOT NULL,
            tag_id INTEGER NOT NULL,
            source TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL,
            PRIMARY KEY (note_id, tag_id)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_tags_tag ON note_tags(tag_id)",
        [],
    )?;

    // ---- 笔记历史版本 ----
    // 内容/标题/分组变化前把旧版本存进来，但距上一条历史不足间隔时不重复记
    // （app.config.general.noteHistoryIntervalMinutes，默认 5 分钟）。
    // 超出上限（noteHistoryLimit）时只删中间的旧版本，最早一条始终保留。
    // 永久删除笔记时一并清理，回滚只恢复这几列（标签、AI 访问权限不动）。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS notes_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            note_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category_id INTEGER,
            is_pinned INTEGER NOT NULL DEFAULT 0,
            kind TEXT NOT NULL DEFAULT 'auto',
            pinned INTEGER NOT NULL DEFAULT 0,
            saved_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_notes_history_note ON notes_history(note_id, id DESC)",
        [],
    )?;
    // ---- 迁移：历史版本来源与固定标记 ----
    // kind 区分自动 / 打开笔记时的会话基线 / 手动保存（早期数据还可能有回滚前快照）；
    // pinned 标记用户固定、永不自动清理的版本。
    if !has_column(conn, "notes_history", "kind") {
        conn.execute(
            "ALTER TABLE notes_history ADD COLUMN kind TEXT NOT NULL DEFAULT 'auto'",
            [],
        )?;
    }
    if !has_column(conn, "notes_history", "pinned") {
        conn.execute(
            "ALTER TABLE notes_history ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0",
            [],
        )?;
    }

    // ---- 迁移：多选模型列表 ----
    // 老库只有 enabled_model（单选），这里补上 enabled_models（JSON 数组）并把旧值回填进去
    if !has_column(conn, "ai_providers", "enabled_models") {
        conn.execute(
            "ALTER TABLE ai_providers ADD COLUMN enabled_models TEXT",
            [],
        )?;
    }
    let legacy: Vec<(i64, Option<String>)> = {
        let mut stmt = conn.prepare(
            "SELECT id, enabled_model FROM ai_providers
             WHERE (enabled_models IS NULL OR TRIM(enabled_models) = '')
               AND enabled_model IS NOT NULL AND TRIM(enabled_model) <> ''",
        )?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.flatten().collect()
    };
    for (id, model) in legacy {
        if let Some(model) = model {
            let json = serde_json::to_string(&vec![model]).unwrap_or_else(|_| "[]".to_string());
            conn.execute(
                "UPDATE ai_providers SET enabled_models = ?1 WHERE id = ?2",
                params![json, id],
            )?;
        }
    }

    // ---- 迁移：笔记置顶字段 ----
    if !has_column(conn, "notes", "is_pinned") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN is_pinned INTEGER DEFAULT 0",
            [],
        )?;
    }

    // ---- 迁移：AI 访问档位（0=禁止 / 1=只读 / 2=完全）----
    // 老库默认全开，行为与升级前一致；档位分「分组」和「笔记」两级，实际生效取更严格的。
    if !has_column(conn, "notes", "ai_access") {
        conn.execute(
            "ALTER TABLE notes ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 2",
            [],
        )?;
    }
    if !has_column(conn, "categories", "ai_access") {
        conn.execute(
            "ALTER TABLE categories ADD COLUMN ai_access INTEGER NOT NULL DEFAULT 2",
            [],
        )?;
    }

    // 一次性数据迁移：早期版本把 ai_access 当布尔用（1=开放），
    // 三档之后 1 表示"只读"。若不迁移，升级会把开放过的笔记静默降级成只读。
    // 用 schema_migrations 记住"已迁移"，否则每次启动都会把用户手动设的只读改成完全。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            name TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL
        )",
        [],
    )?;
    let done: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE name = 'ai_access_levels_v2'",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    if done == 0 {
        conn.execute("UPDATE notes SET ai_access = 2 WHERE ai_access = 1", [])?;
        conn.execute(
            "UPDATE categories SET ai_access = 2 WHERE ai_access = 1",
            [],
        )?;
        conn.execute(
            "INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES ('ai_access_levels_v2', ?1)",
            params![Local::now().to_rfc3339()],
        )?;
    }

    // ---- 语义搜索 ----
    // 向量按块存（一篇笔记多行），文本与向量同表：检索命中后直接取片段，不必回查 notes。
    // 这里不建外键：永久删除笔记时由索引 worker 统一清孤儿，避免删除路径到处补级联。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_chunks (
            note_id INTEGER NOT NULL,
            seq INTEGER NOT NULL,
            text TEXT NOT NULL,
            dim INTEGER NOT NULL,
            embedding BLOB NOT NULL,
            PRIMARY KEY (note_id, seq)
        )",
        [],
    )?;
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_note_chunks_note ON note_chunks(note_id)",
        [],
    )?;
    // 脏判定：notes.updated_at 与本表不一致（或本表无记录）就该重建该笔记的块。
    // 不用内容哈希——写入方只要碰过 updated_at 就会触发，创建/导入/恢复都自动覆盖。
    conn.execute(
        "CREATE TABLE IF NOT EXISTS note_index_state (
            note_id INTEGER PRIMARY KEY,
            note_updated_at TEXT NOT NULL,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL
        )",
        [],
    )?;
    conn.execute(
        "CREATE TABLE IF NOT EXISTS semantic_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )",
        [],
    )?;

    Ok(())
}

fn map_row_to_ai_provider(row: &rusqlite::Row) -> Result<AiProvider, rusqlite::Error> {
    let enabled_model: Option<String> = row.get(6)?;
    // 按"列名"取多选列表：不依赖列位置，SELECT 里没有这列时也不会报
    // "Invalid column index"（这正是"库里有数据但界面读不到"的原因）。
    let raw_models: Option<String> = match row.as_ref().column_index("enabled_models") {
        Ok(idx) => row.get(idx)?,
        Err(_) => None,
    };
    let mut enabled_models = parse_models_json(raw_models);
    // 兼容：旧数据没有列表时，把单选模型当作列表唯一项
    if enabled_models.is_empty() {
        if let Some(single) = enabled_model.clone().filter(|m| !m.trim().is_empty()) {
            enabled_models.push(single);
        }
    }
    Ok(AiProvider {
        id: row.get(0)?,
        name: row.get(1)?,
        provider_type: row.get(2)?,
        api_base_url: row.get(3)?,
        api_key: row.get(4)?,
        api_path: row.get(5)?,
        enabled_model,
        enabled_models,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else {
        format!("{}/{}", base, path.trim_start_matches('/'))
    }
}

fn openai_chat_path(provider: &AiProvider) -> String {
    provider
        .api_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| "/v1/chat/completions".to_string())
}

fn openai_models_url(provider: &AiProvider) -> String {
    let chat_path = openai_chat_path(provider);
    let model_path = if chat_path.contains("/chat/completions") {
        chat_path.replace("/chat/completions", "/models")
    } else {
        "/v1/models".to_string()
    };
    join_url(&provider.api_base_url, &model_path)
}

fn extract_text(value: &Value, paths: &[&[&str]]) -> Option<String> {
    for path in paths {
        let mut current = value;
        let mut matched = true;
        for key in *path {
            if let Ok(index) = key.parse::<usize>() {
                if let Some(next) = current.get(index) {
                    current = next;
                } else {
                    matched = false;
                    break;
                }
            } else if let Some(next) = current.get(*key) {
                current = next;
            } else {
                matched = false;
                break;
            }
        }
        if matched {
            if let Some(text) = current.as_str() {
                if !text.trim().is_empty() {
                    return Some(text.to_string());
                }
            }
        }
    }
    None
}

fn selected_model(provider: &AiProvider) -> Result<String, String> {
    // 优先用当前选中的模型；为空（例如刚勾选完还没在对话里选）时回退到列表第一项
    provider
        .enabled_model
        .clone()
        .filter(|model| !model.trim().is_empty())
        .or_else(|| provider.enabled_models.first().cloned())
        .filter(|model| !model.trim().is_empty())
        .ok_or_else(|| "请先在设置中勾选可用模型".to_string())
}

/// 强制深度思考的系统提示词（始终生效，独立于前端提示词）
const DEEP_THINKING_PROMPT: &str = r#"## Deep thinking requirement (highest priority, cannot be skipped)
Before giving any answer or calling any tool, you MUST complete one full, in-depth reasoning pass between <thinking> and </thinking>. This is not optional.

Your thinking must cover:
1. What result the user actually wants (identify implicit intent, and which note or category is being referred to).
2. Is the information you have enough? What is missing?
3. Do you need to call a tool? If so, which tool, in what order, and where do the arguments come from?
4. For destructive operations such as deleting, overwriting or renaming, first confirm that the target object really is the one the user means.
5. Did the execution result match expectations, and is a next step needed?

Hard rules:
- Every reply must contain <thinking>...</thinking>, and its content must be genuine reasoning (at least about 80 characters is recommended) — never an empty tag, never a single throwaway sentence.
- Thinking alone, without also outputting <tool_calls>, triggers no tools; the thinking and the call must be output together.
- Never output tool calls outside <thinking>; never fabricate note IDs, category IDs or execution results.
- After a tool result comes back, you must enter <thinking> again to analyze that result, then decide whether to keep calling tools or give a final answer."#;

/// 判断该模型是否可能拒绝 OpenAI 的 reasoning_effort 参数（DeepSeek 推理模型自带思考）
fn is_deepseek_reasoner(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("deepseek-reasoner") || m.contains("deepseek-r1")
}

/// 判断模型是否支持 OpenAI 的 reasoning_effort 参数
fn supports_reasoning_effort(model: &str) -> bool {
    if is_deepseek_reasoner(model) {
        return false;
    }
    let m = model.to_lowercase();
    m.starts_with("o1")
        || m.starts_with("o3")
        || m.starts_with("o4")
        || m.contains("gpt-5")
        || m.contains("thinking")
        || m.contains("reason")
}

/// 判断 Claude 模型是否支持扩展思考（extended thinking）
fn supports_extended_thinking(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("3-7") || m.contains("sonnet-4") || m.contains("opus-4") || m.contains("thinking")
}

#[tauri::command]
fn create_category(
    name: String,
    ai_access: Option<i64>,
    state: State<AppState>,
) -> Result<Category, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    // 同 create_note：默认档位由前端按设置传入，缺省"完全"
    let ai_access = ai_access.unwrap_or(2).clamp(0, 2);

    conn.execute(
        "INSERT INTO categories (name, created_at, ai_access) VALUES (?1, ?2, ?3)",
        params![name, now, ai_access],
    )
    .map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    Ok(Category {
        id,
        name,
        created_at: now,
        note_count: 0,
        ai_access,
    })
}

/* ---------------- 应用设置（键值对） ----------------
 * 所有设置都存在 app_settings 表里：读不到某个键时由前端回退到默认值，
 * 因此升级/新增设置项都不需要迁移脚本。
 */

#[tauri::command]
fn get_app_settings(
    state: State<AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut map = std::collections::HashMap::new();
    for row in rows {
        let (key, value) = row.map_err(|e| e.to_string())?;
        map.insert(key, value);
    }
    Ok(map)
}

#[tauri::command]
fn set_app_setting(key: String, value: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_app_setting(key: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
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
    /// 备份文件的导出时间（恢复时从文件里带回，便于界面展示）
    pub exported_at: Option<String>,
}

/// 按行查询并映射成 JSON 数组
fn query_rows<F>(conn: &Connection, sql: &str, mut map: F) -> Result<Vec<Value>, String>
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

fn json_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// 取字符串字段，缺失或空串时用默认值（旧备份缺新字段）
fn json_str_or(v: &Value, key: &str, fallback: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

fn json_opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

fn json_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn json_opt_i64(v: &Value, key: &str) -> Option<i64> {
    v.get(key).and_then(|x| x.as_i64())
}

fn json_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// 取布尔字段，缺失时用指定默认值（旧备份缺新字段时保持升级前的行为）
fn json_bool_or(v: &Value, key: &str, fallback: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(fallback)
}

/// 取 AI 访问档位（0/1/2）。
/// 兼容三种历史写法：数字档位、旧的布尔（true=完全 / false=禁止）、字段缺失（用默认值）。
fn json_level(v: &Value, key: &str, fallback: i64) -> i64 {
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
fn json_arr<'a>(data: &'a Value, key: &str) -> &'a [Value] {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

/// 时间字段缺失时补当前时间（列上有 NOT NULL 约束）
fn non_empty_or_now(text: String) -> String {
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

/// 读出本机全部 webdav.* 设置（服务器、账号、密码、自动备份配置与运行状态）。
/// 备份默认不带 WebDAV；恢复时这些键按「备份里有就用备份、没有就保留本机」合并，
/// 避免一次恢复把本机正在用的云端配置抹成默认值。
fn read_local_only_settings(conn: &Connection) -> Vec<(String, String, String)> {
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

fn restore_local_only_settings(
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

#[tauri::command]
fn export_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let categories = query_rows(
        &conn,
        "SELECT id, name, created_at, ai_access FROM categories ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, String>(2)?,
                "ai_access": row.get::<_, i64>(3)?.clamp(0, 2),
            }))
        },
    )?;

    let notes = query_rows(
        &conn,
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                is_pinned, ai_access
         FROM notes ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "title": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "category_id": row.get::<_, Option<i64>>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
                "is_deleted": row.get::<_, i64>(6)? != 0,
                "deleted_at": row.get::<_, Option<String>>(7)?,
                "is_pinned": row.get::<_, i64>(8)? != 0,
                "ai_access": row.get::<_, i64>(9)?.clamp(0, 2),
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

    // 本机专属设置默认不进备份：未勾选 WebDAV 时整组 webdav.* 都排除；
    // 勾选后仍只排除自动备份运行状态，密码会在下面解密成明文写进 JSON（换机可直接恢复）。
    let settings_sql = if include_webdav {
        "SELECT key, value, updated_at FROM app_settings
         WHERE key NOT IN ('webdav.lastAutoBackupAt', 'webdav.lastAutoAttemptAt',
                           'webdav.lastAutoError', 'webdav.lastAutoFile')
         ORDER BY key"
    } else {
        "SELECT key, value, updated_at FROM app_settings
         WHERE key NOT LIKE 'webdav.%'
         ORDER BY key"
    };
    let mut settings = query_rows(&conn, settings_sql, |row| {
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
        "SELECT note_id, tag_id, source, created_at FROM note_tags ORDER BY note_id, tag_id",
        |row| {
            Ok(json!({
                "note_id": row.get::<_, i64>(0)?,
                "tag_id": row.get::<_, i64>(1)?,
                "source": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let notes_history = query_rows(
        &conn,
        "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
         FROM notes_history ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "note_id": row.get::<_, i64>(1)?,
                "title": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "category_id": row.get::<_, Option<i64>>(4)?,
                "is_pinned": row.get::<_, i64>(5)? != 0,
                "kind": row.get::<_, String>(6)?,
                "pinned": row.get::<_, i64>(7)? != 0,
                "saved_at": row.get::<_, String>(8)?,
            }))
        },
    )?;

    let exported_at = Local::now().to_rfc3339();
    let summary = BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
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
        }
    });

    let text = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("写入备份文件失败：{e}"))?;
    Ok(summary)
}

#[tauri::command]
fn import_backup(state: State<AppState>, path: String) -> Result<BackupSummary, String> {
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

    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
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
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access) VALUES (?1, ?2, ?3, ?4)",
            params![
                json_i64(c, "id"),
                json_str(c, "name"),
                non_empty_or_now(json_str(c, "created_at")),
                // 旧备份可能没有这个字段，或是布尔（true=完全 / false=禁止）：统一归一化
                json_level(c, "ai_access", 2)
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                                is_pinned, ai_access)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                json_i64(n, "id"),
                json_str(n, "title"),
                json_str(n, "content"),
                json_opt_i64(n, "category_id"),
                non_empty_or_now(json_str(n, "created_at")),
                non_empty_or_now(json_str(n, "updated_at")),
                if json_bool(n, "is_deleted") { 1 } else { 0 },
                json_opt_str(n, "deleted_at"),
                // 旧备份没有这两个字段：置顶 / AI 访问都按默认值兜底
                if json_bool_or(n, "is_pinned", false) { 1 } else { 0 },
                json_level(n, "ai_access", 2)
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
                json_i64(h, "note_id"),
                json_str(h, "title"),
                json_str(h, "content"),
                json_opt_i64(h, "category_id"),
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
                json_i64(nt, "note_id"),
                json_i64(nt, "tag_id"),
                normalize_source(Some(json_str(nt, "source"))),
                non_empty_or_now(json_str(nt, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
        exported_at: doc
            .get("exported_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
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

fn count_rows(conn: &Connection, table: &str) -> usize {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(0) as usize
}

#[tauri::command]
fn export_sqlite_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let exported_at = Local::now().to_rfc3339();
    let summary = BackupSummary {
        notes: count_rows(&conn, "notes"),
        categories: count_rows(&conn, "categories"),
        providers: count_rows(&conn, "ai_providers"),
        sessions: count_rows(&conn, "ai_chat_sessions"),
        messages: count_rows(&conn, "ai_chat_messages"),
        settings: count_rows(&conn, "app_settings"),
        exported_at: Some(exported_at.clone()),
    };

    let target = std::path::PathBuf::from(&path);
    let parent = target.parent().ok_or("备份路径不可用".to_string())?;
    // 保存对话框给出的目标可能已存在，而 VACUUM INTO 要求目标不存在：
    // 先写同目录临时文件，成功后再替换，避免中途失败留下半个备份。
    let tmp = parent.join(format!(".fastnote-sqlite-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let result = (|| -> Result<(), String> {
        conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy().to_string()])
            .map_err(|e| format!("生成数据库快照失败：{e}"))?;

        {
            let snap = Connection::open(&tmp).map_err(|e| format!("打开数据库快照失败：{e}"))?;
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
                    ("exported_at", exported_at.clone()),
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
                snap.execute(
                    "DELETE FROM app_settings WHERE key = ?1",
                    params![key],
                )
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
        }

        // Windows 的 rename 不会覆盖已有文件，先删除旧目标
        if target.exists() {
            std::fs::remove_file(&target).map_err(|e| format!("覆盖已有备份文件失败：{e}"))?;
        }
        std::fs::rename(&tmp, &target).map_err(|e| format!("保存备份文件失败：{e}"))?;
        Ok(())
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    Ok(summary)
}

/** SQLite 快照读出的数据：字段与当前库结构对齐，缺失的列由读取 SQL 补默认值 */
#[derive(Default)]
struct SqliteBackupData {
    categories: Vec<SqliteCategoryRow>,
    notes: Vec<SqliteNoteRow>,
    providers: Vec<SqliteProviderRow>,
    sessions: Vec<SqliteSessionRow>,
    messages: Vec<SqliteMessageRow>,
    settings: Vec<SqliteSettingRow>,
    tags: Vec<SqliteTagRow>,
    note_tags: Vec<SqliteNoteTagRow>,
    notes_history: Vec<SqliteNoteHistoryRow>,
    exported_at: Option<String>,
}

struct SqliteCategoryRow {
    id: i64,
    name: String,
    created_at: String,
    ai_access: i64,
}

struct SqliteNoteRow {
    id: i64,
    title: String,
    content: String,
    category_id: Option<i64>,
    created_at: String,
    updated_at: String,
    is_deleted: i64,
    deleted_at: Option<String>,
    is_pinned: i64,
    ai_access: i64,
}

struct SqliteProviderRow {
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

struct SqliteSessionRow {
    id: i64,
    title: String,
    provider_id: i64,
    model: String,
    created_at: String,
    updated_at: String,
}

struct SqliteMessageRow {
    id: i64,
    session_id: i64,
    role: String,
    content: String,
    created_at: String,
}

struct SqliteSettingRow {
    key: String,
    value: String,
    updated_at: String,
}

struct SqliteTagRow {
    id: i64,
    name: String,
    source: String,
    created_at: String,
}

struct SqliteNoteTagRow {
    note_id: i64,
    tag_id: i64,
    source: String,
    created_at: String,
}

struct SqliteNoteHistoryRow {
    id: i64,
    note_id: i64,
    title: String,
    content: String,
    category_id: Option<i64>,
    is_pinned: i64,
    kind: String,
    pinned: i64,
    saved_at: String,
}

/// 读取并校验 SQLite 备份。表结构必须包含当前版本的核心列；
/// 后加的列（置顶、AI 档位、多选模型等）缺失时用默认值补齐。
fn read_sqlite_backup(conn: &Connection) -> Result<SqliteBackupData, String> {
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
            "SELECT id, name, created_at, {} FROM categories ORDER BY id",
            ai_access("categories")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteCategoryRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    ai_access: row.get::<_, i64>(3)?.clamp(0, 2),
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.categories.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let sql = format!(
            "SELECT id, title, content, category_id, created_at, updated_at, {}, {}, {}, {}
             FROM notes ORDER BY id",
            col("notes", "is_deleted", "0"),
            col("notes", "deleted_at", "NULL"),
            col("notes", "is_pinned", "0"),
            ai_access("notes")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    category_id: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_deleted: row.get(6)?,
                    deleted_at: row.get(7)?,
                    is_pinned: row.get(8)?,
                    ai_access: row.get::<_, i64>(9)?.clamp(0, 2),
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
                    note_id: row.get(1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    category_id: row.get(4)?,
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
                    note_id: row.get(0)?,
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

    Ok(out)
}

#[tauri::command]
fn import_sqlite_backup(state: State<AppState>, path: String) -> Result<BackupSummary, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let source_canonical =
        std::fs::canonicalize(&source).map_err(|e| format!("读取备份文件失败：{e}"))?;

    let bak = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开 SQLite 备份文件：{e}"))?;
    // 先做完整性检查，再读表结构；坏文件不进入覆盖流程
    let quick_check: String = bak
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("无法校验 SQLite 备份文件：{e}"))?;
    if quick_check != "ok" {
        return Err("SQLite 备份文件已损坏，无法恢复".to_string());
    }
    let data = read_sqlite_backup(&bak)?;
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
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in &data.categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access) VALUES (?1, ?2, ?3, ?4)",
            params![
                c.id,
                c.name,
                non_empty_or_now(c.created_at.clone()),
                c.ai_access
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in &data.notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted,
                                deleted_at, is_pinned, ai_access)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                n.id,
                n.title,
                n.content,
                n.category_id,
                non_empty_or_now(n.created_at.clone()),
                non_empty_or_now(n.updated_at.clone()),
                if n.is_deleted != 0 { 1 } else { 0 },
                n.deleted_at,
                if n.is_pinned != 0 { 1 } else { 0 },
                n.ai_access
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
                h.note_id,
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
                nt.note_id,
                nt.tag_id,
                normalize_source(Some(nt.source.clone())),
                non_empty_or_now(nt.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: data.notes.len(),
        categories: data.categories.len(),
        providers: data.providers.len(),
        sessions: data.sessions.len(),
        messages: data.messages.len(),
        settings: data.settings.len(),
        exported_at: data.exported_at,
    })
}

/* ---------------- 分组导出（ZIP / 电子书） ----------------
 * 笔记正文是 Markdown 原文，导出 HTML / EPUB 时用 pulldown-cmark 渲染成网页。
 * 章节顺序统一为「按创建时间正序」：最早创建的笔记在前；章节名直接用笔记标题。
 */

#[derive(Debug)]
struct ZipEntry {
    name: String,
    content: String,
}

/// 压缩包「其他文件格式」下，单篇笔记自选的后缀
#[derive(Debug, Deserialize)]
struct NoteFormatSpec {
    id: i64,
    ext: String,
}

/// 按顺序写进 zip；EPUB 要求 mimetype 必须是第一个条目且不压缩，这里按名字特殊处理
fn write_zip_file(path: &str, entries: &[ZipEntry]) -> Result<(), String> {
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
        zip.write_all(entry.content.as_bytes())
            .map_err(|e| format!("写入 {0} 失败：{1}", entry.name, e))?;
    }

    zip.finish().map_err(|e| format!("生成压缩包失败：{e}"))?;
    Ok(())
}

/// Markdown → HTML 片段
fn md_to_html(text: &str) -> String {
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

fn esc_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// 文件名清洗：去掉 Windows 不允许的字符，截断长度，空标题用兜底名
fn safe_filename(name: &str, fallback: &str) -> String {
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
fn sanitize_ext(ext: &str) -> String {
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
fn load_category_notes(conn: &Connection, category_id: i64) -> Result<Vec<Note>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND category_id = ?1
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
fn load_notes_by_ids(conn: &Connection, note_ids: &[i64]) -> Result<Vec<Note>, String> {
    if note_ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND id = ?1",
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

fn load_category_name(conn: &Connection, category_id: i64) -> Result<String, String> {
    conn.query_row(
        "SELECT name FROM categories WHERE id = ?1",
        params![category_id],
        |row| row.get::<_, String>(0),
    )
    .map_err(|_| "分组不存在".to_string())
}

/// 单篇笔记的完整 HTML 页面
fn note_html_page(title: &str, content: &str) -> String {
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nh1{{border-bottom:1px solid #e2e8f0;padding-bottom:8px}}\n</style>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
        esc_html(title),
        esc_html(title),
        md_to_html(content)
    )
}

/// 导出分组为压缩包：一篇笔记一个文件，格式可选
#[tauri::command]
fn export_category_zip(
    state: State<AppState>,
    category_id: i64,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let notes = load_category_notes(&conn, category_id)?;
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

        entries.push(ZipEntry { name, content });
    }

    let total = entries.len();
    write_zip_file(&path, &entries)?;
    Ok(total)
}

/// 导出分组为电子书
#[tauri::command]
fn export_category_ebook(
    state: State<AppState>,
    category_id: i64,
    path: String,
    format: String,
) -> Result<usize, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let title = load_category_name(&conn, category_id)?;
    let notes = load_category_notes(&conn, category_id)?;
    if notes.is_empty() {
        return Err("这个分组下还没有笔记，没什么可导出的".to_string());
    }

    match format.as_str() {
        "html" => {
            let text = ebook_single_html(&notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
        "epub" => {
            let entries = ebook_epub_entries(&title, &notes);
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
#[tauri::command]
fn export_notes_zip(
    state: State<AppState>,
    note_ids: Vec<i64>,
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
    let per_note: std::collections::HashMap<i64, String> = note_formats
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

        entries.push(ZipEntry { name, content });
    }

    let total = entries.len();
    write_zip_file(&path, &entries)?;
    Ok(total)
}

/// 导出指定笔记 ID 列表为电子书
#[tauri::command]
fn export_notes_ebook(
    state: State<AppState>,
    note_ids: Vec<i64>,
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
            let text = ebook_single_html(&notes);
            std::fs::write(&path, text).map_err(|e| format!("写入文件失败：{e}"))?;
            Ok(notes.len())
        }
        "epub" => {
            let entries = ebook_epub_entries(&title, &notes);
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
fn ebook_single_html(notes: &[Note]) -> String {
    let mut toc = String::new();
    let mut body = String::new();
    for (i, note) in notes.iter().enumerate() {
        let anchor = format!("chapter-{}", i + 1);
        toc.push_str(&format!(
            "<li><a href=\"#{anchor}\">{}</a></li>\n",
            esc_html(&note.title)
        ));
        body.push_str(&format!(
            "<section id=\"{anchor}\">\n<h2>{}</h2>\n{}\n</section>\n",
            esc_html(&note.title),
            md_to_html(&note.content)
        ));
    }
    // 沉浸式正文：不出现书名大标题，页面标题取第一章标题
    let page_title = notes
        .first()
        .map(|note| note.title.trim())
        .filter(|title| !title.is_empty())
        .unwrap_or("笔记");
    format!(
        "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\">\n<title>{}</title>\n<style>\nbody{{max-width:820px;margin:40px auto;padding:0 20px;font-family:system-ui,-apple-system,\"Microsoft YaHei\",sans-serif;line-height:1.8;color:#1e293b}}\npre{{background:#f1f5f9;padding:12px;border-radius:8px;overflow-x:auto}}\ncode{{background:#f1f5f9;padding:2px 4px;border-radius:4px}}\ntable{{border-collapse:collapse}}th,td{{border:1px solid #e2e8f0;padding:6px 10px}}\nblockquote{{border-left:3px solid #cbd5e1;margin:0;padding-left:14px;color:#64748b}}\nsection{{margin-top:48px;padding-top:16px;border-top:1px solid #e2e8f0}}\n.toc{{background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:12px 24px}}\n</style>\n</head>\n<body>\n<nav class=\"toc\">\n<h3>目录</h3>\n<ol>\n{}</ol>\n</nav>\n{}\n</body>\n</html>\n",
        esc_html(page_title),
        toc,
        body
    )
}

/// 纯文本电子书：只按章节拼接，不出现书名与章节数，正文是 Markdown 原文
fn ebook_plain_text(notes: &[Note]) -> String {
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
fn ebook_epub_entries(title: &str, notes: &[Note]) -> Vec<ZipEntry> {
    let modified = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string();
    let book_id = format!("urn:fastnote:{}", chrono::Utc::now().timestamp());

    let mut manifest = String::new();
    let mut spine = String::new();
    let mut nav = String::new();

    let mut entries = Vec::with_capacity(notes.len() + 4);

    // mimetype 必须是第一个条目且不压缩（write_zip_file 按名字处理）
    entries.push(ZipEntry {
        name: "mimetype".to_string(),
        content: "application/epub+zip".to_string(),
    });
    entries.push(ZipEntry {
        name: "META-INF/container.xml".to_string(),
        content: "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n  <rootfiles>\n    <rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/>\n  </rootfiles>\n</container>\n".to_string(),
    });

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

        entries.push(ZipEntry {
            name: format!("OEBPS/{href}"),
            content: format!(
                "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"zh-CN\" lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\"/>\n<title>{}</title>\n</head>\n<body>\n<h1>{}</h1>\n{}\n</body>\n</html>\n",
                esc_html(&note.title),
                esc_html(&note.title),
                md_to_html(&note.content)
            ),
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
        content: nav_doc,
    });
    entries.push(ZipEntry {
        name: "OEBPS/content.opf".to_string(),
        content: opf,
    });

    entries
}

#[tauri::command]
fn get_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.created_at, COUNT(n.id) as note_count, c.ai_access
         FROM categories c
         LEFT JOIN notes n ON c.id = n.category_id AND n.is_deleted = 0
         GROUP BY c.id, c.name, c.created_at, c.ai_access
         ORDER BY c.created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let categories = stmt
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                note_count: row.get(3)?,
                ai_access: row.get::<_, i64>(4)?.clamp(0, 2),
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for category in categories {
        result.push(category.map_err(|e| e.to_string())?);
    }

    Ok(result)
}

#[tauri::command]
fn update_category(id: i64, name: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute(
        "UPDATE categories SET name = ?1 WHERE id = ?2",
        params![name, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_category(id: i64, delete_notes: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    if delete_notes {
        let now = Local::now().to_rfc3339();
        conn.execute(
            "UPDATE notes SET is_deleted = 1, deleted_at = ?1, category_id = NULL WHERE category_id = ?2",
            params![now, id],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE notes SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }

    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    // 进回收站的笔记不再参与语义检索；向量缓存按库快照建，必须整表失效
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn create_note(
    title: String,
    content: String,
    category_id: Option<i64>,
    ai_access: Option<i64>,
    state: State<AppState>,
) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    // 新笔记的 AI 档位由调用方给（设置里的「新建笔记默认权限」），缺省按"完全"，
    // 与老版本行为一致；写库时显式带上，返回值也用同一个值，避免库里是 A 返回是 B
    let ai_access = ai_access.unwrap_or(2).clamp(0, 2);

    conn.execute(
        "INSERT INTO notes (title, content, category_id, created_at, updated_at, is_pinned, ai_access) VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)",
        params![title, content, category_id, now, now, ai_access],
    ).map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    Ok(Note {
        id,
        title,
        content,
        category_id,
        created_at: now.clone(),
        updated_at: now,
        is_deleted: false,
        deleted_at: None,
        is_pinned: false,
        ai_access,
    })
}

fn map_row_to_note(row: &rusqlite::Row) -> Result<Note, rusqlite::Error> {
    // 使用列名获取，兼容旧数据没有 is_pinned 列的情况
    let is_pinned: i64 = match row.as_ref().column_index("is_pinned") {
        Ok(_) => row.get("is_pinned")?,
        Err(_) => 0,
    };
    // ai_access 一律按列名读取：所有 note 查询都必须带上这一列，漏了会直接报错，
    // 而不是悄悄把受保护的笔记当成"对 AI 开放"
    let ai_access: i64 = row.get::<_, i64>("ai_access")?.clamp(0, 2);
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        category_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        is_deleted: row.get(6)?,
        deleted_at: row.get(7)?,
        is_pinned: is_pinned != 0,
        ai_access,
    })
}

/// 查询笔记列表（含正文）。正文随列表一起返回，AI 读未打开的笔记也无需额外请求。
#[tauri::command]
fn get_notes(
    category_id: Option<i64>,
    sort_by: String,
    sort_order: String,
    state: State<AppState>,
) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();

    let order_direction = if sort_order == "asc" { "ASC" } else { "DESC" };

    // 优先排序：置顶笔记在前，然后按用户选择的排序方式
    let order_clause = match sort_by.as_str() {
        "created_at" => format!("ORDER BY is_pinned DESC, created_at {}", order_direction),
        "updated_at" => format!("ORDER BY is_pinned DESC, updated_at {}", order_direction),
        "title" => format!(
            "ORDER BY is_pinned DESC, title {}",
            if sort_order == "asc" { "ASC" } else { "DESC" }
        ),
        _ => format!("ORDER BY is_pinned DESC, updated_at {}", order_direction),
    };

    let sql = if let Some(_cat_id) = category_id {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0 AND category_id = ?1
             {}",
            order_clause
        )
    } else {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access
             FROM notes
             WHERE is_deleted = 0
             {}",
            order_clause
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let notes_iter = if let Some(cat_id) = category_id {
        stmt.query_map(params![cat_id], map_row_to_note)
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], map_row_to_note)
            .map_err(|e| e.to_string())?
    };

    let mut result = Vec::new();
    for note in notes_iter {
        result.push(note.map_err(|e| e.to_string())?);
    }

    Ok(result)
}

/// 读取单条笔记（含正文），供编辑器保存前的兜底校验/按 id 取用。
#[tauri::command]
fn get_note(id: i64, state: State<AppState>) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access
             FROM notes WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    stmt.query_row(params![id], map_row_to_note)
        .map_err(|e| e.to_string())
}

const NOTE_HISTORY_LIMIT_KEY: &str = "app.config.general.noteHistoryLimit";
const NOTE_HISTORY_INTERVAL_KEY: &str = "app.config.general.noteHistoryIntervalMinutes";

/// 历史版本上限：默认 10，夹到 1–100，避免手工改库写出几万条历史把库撑大
fn note_history_limit(app: &AppHandle) -> u64 {
    crate::read_setting_u64(app, NOTE_HISTORY_LIMIT_KEY, 10).clamp(1, 100)
}

/// 两条自动历史之间的最小间隔（秒）：默认 5 分钟，夹到 1–60 分钟。
/// 自动保存是 500ms 防抖，若每次保存都记历史，反复停顿打字几分钟就能把保留窗口刷满。
fn note_history_interval_secs(app: &AppHandle) -> i64 {
    (crate::read_setting_u64(app, NOTE_HISTORY_INTERVAL_KEY, 5).clamp(1, 60) as i64) * 60
}

const HISTORY_KIND_AUTO: &str = "auto";
const HISTORY_KIND_SESSION: &str = "session";
const HISTORY_KIND_MANUAL: &str = "manual";
const HISTORY_KIND_PRE_ROLLBACK: &str = "pre-rollback";

/// 未知来源（旧备份/手工改库）一律按自动版本处理，避免把脏 kind 带进界面
fn normalize_history_kind(kind: &str) -> String {
    match kind {
        HISTORY_KIND_MANUAL | HISTORY_KIND_SESSION | HISTORY_KIND_PRE_ROLLBACK => kind.to_string(),
        _ => HISTORY_KIND_AUTO.to_string(),
    }
}

/// 把笔记当前状态写进历史表（调用前不要先 UPDATE，否则存进去的是新版本）
fn snapshot_note(
    conn: &Connection,
    note_id: i64,
    saved_at: &str,
    kind: &str,
) -> Result<bool, String> {
    let inserted = conn
        .execute(
            "INSERT INTO notes_history (note_id, title, content, category_id, is_pinned, kind, saved_at)
             SELECT id, title, content, category_id, is_pinned, ?2, ?3 FROM notes WHERE id = ?1",
            params![note_id, kind, saved_at],
        )
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// 最新一条历史（标题 / 正文 / 分组 / 保存时间）；没有历史时返回 None
fn latest_history(
    conn: &Connection,
    note_id: i64,
) -> Result<Option<(String, String, Option<i64>, String)>, String> {
    let latest = conn.query_row(
        "SELECT title, content, category_id, saved_at
         FROM notes_history WHERE note_id = ?1 ORDER BY id DESC LIMIT 1",
        params![note_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );
    match latest {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 当前内容是否与最新一条历史完全相同（没有历史时为 false）
fn history_matches_latest(
    conn: &Connection,
    note_id: i64,
    title: &str,
    content: &str,
    category: Option<i64>,
) -> Result<bool, String> {
    Ok(latest_history(conn, note_id)?
        .map(|(last_title, last_content, last_category, _)| {
            last_title == title && last_content == content && last_category == category
        })
        .unwrap_or(false))
}

/// 本次自动改动是否值得写一条历史。
///
/// - 还没有任何历史：写。保证「最初版本」一定留得下来（老笔记第一次被编辑时也走这条）。
/// - 与最新一条内容完全相同：不写。用户改回原样时不该再堆一条重复版本。
/// - 距最新一条不足间隔：不写。打字停顿触发的自动保存不等于一个值得回看的版本。
/// - 时间不可解析 / 系统时间回拨：写。宁可多记一条，也不要因为脏时间戳从此不再记录。
fn should_snapshot_history(
    conn: &Connection,
    note_id: i64,
    old_title: &str,
    old_content: &str,
    old_category: Option<i64>,
    now: &str,
    interval_secs: i64,
) -> Result<bool, String> {
    let Some((last_title, last_content, last_category, last_saved_at)) =
        latest_history(conn, note_id)?
    else {
        return Ok(true);
    };

    if last_title == old_title && last_content == old_content && last_category == old_category {
        return Ok(false);
    }

    let (now_at, last_at) = match (
        DateTime::parse_from_rfc3339(now),
        DateTime::parse_from_rfc3339(&last_saved_at),
    ) {
        (Ok(now_at), Ok(last_at)) => (now_at, last_at),
        _ => return Ok(true),
    };
    let elapsed = now_at.signed_duration_since(last_at).num_seconds();
    Ok(elapsed < 0 || elapsed >= interval_secs)
}

/// 历史保留策略：
///
/// - 固定版本（pinned）与手动版本（manual）永不自动删除；
/// - 自动版本保留最新 `limit` 条；
/// - 最早一条自动版本始终保留（找回最初内容）；
/// - 更早的自动版本按天抽样：最近 30 天里每天最多留一条，避免密集自动版本把库撑大，
///   同时保留一条远期时间线。
///
/// 已保留版本覆盖到的日期不再补抽样，否则同一天的中间版本会挤占配额。
fn prune_note_history(
    conn: &Connection,
    note_id: i64,
    limit: u64,
    now: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, pinned, saved_at FROM notes_history
             WHERE note_id = ?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    if rows.is_empty() {
        return Ok(());
    }

    let mut keep: HashSet<i64> = HashSet::new();
    let mut newest_auto = 0u64;
    let mut oldest_auto: Option<i64> = None;

    for (id, kind, pinned, _) in &rows {
        let is_manual = kind.as_str() == HISTORY_KIND_MANUAL;
        let is_pinned = *pinned != 0;
        if is_pinned || is_manual {
            keep.insert(*id);
        } else if newest_auto < limit {
            keep.insert(*id);
            newest_auto += 1;
        }
        if !is_pinned && !is_manual {
            oldest_auto = Some(*id);
        }
    }
    if let Some(id) = oldest_auto {
        keep.insert(id);
    }

    let now_date = DateTime::parse_from_rfc3339(now)
        .map(|d| d.date_naive())
        .unwrap_or_else(|_| Local::now().date_naive());
    let cutoff = now_date - Duration::days(30);

    let mut covered_dates = HashSet::new();
    for (id, _, _, saved_at) in &rows {
        if !keep.contains(id) {
            continue;
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(saved_at) {
            covered_dates.insert(dt.date_naive());
        }
    }

    for (id, kind, pinned, saved_at) in &rows {
        if *pinned != 0 || kind.as_str() == HISTORY_KIND_MANUAL || keep.contains(id) {
            continue;
        }
        let Ok(dt) = DateTime::parse_from_rfc3339(saved_at) else {
            continue;
        };
        let date = dt.date_naive();
        if date < cutoff {
            continue;
        }
        if covered_dates.insert(date) {
            keep.insert(*id);
        }
    }

    if keep.len() == rows.len() {
        return Ok(());
    }

    let mut delete = conn
        .prepare("DELETE FROM notes_history WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    for (id, _, _, _) in &rows {
        if !keep.contains(id) {
            delete.execute(params![id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 回滚时丢弃目标版本及其之后的所有历史：id 自增，`id >= from_entry_id` 即更新的版本。
fn truncate_note_history(
    conn: &Connection,
    note_id: i64,
    from_entry_id: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notes_history WHERE note_id = ?1 AND id >= ?2",
        params![note_id, from_entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn purge_note_history(conn: &Connection, note_id: i64) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notes_history WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod note_history_tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id INTEGER,
                is_pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE notes_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id INTEGER NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id INTEGER,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'auto',
                pinned INTEGER NOT NULL DEFAULT 0,
                saved_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, content, category_id, is_pinned) VALUES (1, '标题', '正文', NULL, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn insert_version_at(
        conn: &Connection,
        note_id: i64,
        title: &str,
        content: &str,
        saved_at: &str,
    ) {
        conn.execute(
            "INSERT INTO notes_history (note_id, title, content, saved_at) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, title, content, saved_at],
        )
        .unwrap();
    }

    fn insert_version(conn: &Connection, note_id: i64, title: &str) {
        insert_version_at(
            conn,
            note_id,
            title,
            "正文",
            "2026-10-25T10:00:00+08:00",
        );
    }

    fn insert_version_kind(
        conn: &Connection,
        note_id: i64,
        title: &str,
        kind: &str,
        pinned: bool,
        saved_at: &str,
    ) {
        conn.execute(
            "INSERT INTO notes_history (note_id, title, content, kind, pinned, saved_at)
             VALUES (?1, ?2, '正文', ?3, ?4, ?5)",
            params![note_id, title, kind, if pinned { 1 } else { 0 }, saved_at],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_copies_current_note() {
        let conn = setup();
        assert!(snapshot_note(&conn, 1, "2026-10-25T10:00:00+08:00", HISTORY_KIND_AUTO).unwrap());
        let (title, content, note_pinned, kind, pinned): (String, String, i64, String, i64) = conn
            .query_row(
                "SELECT title, content, is_pinned, kind, pinned FROM notes_history WHERE note_id = 1",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "标题");
        assert_eq!(content, "正文");
        assert_eq!(note_pinned, 1);
        assert_eq!(kind, HISTORY_KIND_AUTO);
        assert_eq!(pinned, 0);
    }

    fn titles_of(conn: &Connection, note_id: i64) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT title FROM notes_history WHERE note_id = ?1 ORDER BY id")
            .unwrap();
        let rows = stmt
            .query_map(params![note_id], |row| row.get::<_, String>(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn prune_keeps_latest_versions_and_the_earliest() {
        let conn = setup();
        for title in ["v1", "v2", "v3", "v4"] {
            insert_version(&conn, 1, title);
        }
        insert_version(&conn, 2, "other");

        prune_note_history(&conn, 1, 2, NOW).unwrap();

        // 最新 2 条 + 最早 1 条：v1 不能被挤出窗口
        assert_eq!(titles_of(&conn, 1), vec!["v1", "v3", "v4"]);
        // 另一篇笔记的历史不受影响
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_history WHERE note_id = 2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(others, 1);
    }

    #[test]
    fn truncate_drops_target_and_newer_versions() {
        let conn = setup();
        for title in ["v1", "v2", "v3", "v4"] {
            insert_version(&conn, 1, title);
        }
        // 更新的历史即使被固定，也随回滚一起删除
        insert_version_kind(
            &conn,
            1,
            "v5",
            HISTORY_KIND_MANUAL,
            true,
            "2026-10-25T10:00:00+08:00",
        );
        insert_version(&conn, 2, "other");

        let target_id: i64 = conn
            .query_row(
                "SELECT id FROM notes_history WHERE note_id = 1 AND title = 'v2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        truncate_note_history(&conn, 1, target_id).unwrap();

        assert_eq!(titles_of(&conn, 1), vec!["v1"]);
        assert_eq!(titles_of(&conn, 2), vec!["other"]);
    }

    #[test]
    fn prune_keeps_earliest_even_with_limit_one() {
        let conn = setup();
        for title in ["v1", "v2", "v3"] {
            insert_version(&conn, 1, title);
        }

        prune_note_history(&conn, 1, 1, NOW).unwrap();

        assert_eq!(titles_of(&conn, 1), vec!["v1", "v3"]);
    }

    #[test]
    fn prune_keeps_pinned_and_manual_versions() {
        let conn = setup();
        insert_version_kind(
            &conn,
            1,
            "v1",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:00:00+08:00",
        );
        insert_version_kind(
            &conn,
            1,
            "v2",
            HISTORY_KIND_MANUAL,
            false,
            "2026-10-25T09:10:00+08:00",
        );
        insert_version_kind(
            &conn,
            1,
            "v3",
            HISTORY_KIND_SESSION,
            true,
            "2026-10-25T09:20:00+08:00",
        );
        insert_version_kind(
            &conn,
            1,
            "v4",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:30:00+08:00",
        );
        insert_version_kind(
            &conn,
            1,
            "v5",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:40:00+08:00",
        );

        prune_note_history(&conn, 1, 1, NOW).unwrap();

        // 手动 / 固定永不删除；自动版本仍按「最新 1 条 + 最早 1 条」保留
        assert_eq!(titles_of(&conn, 1), vec!["v1", "v2", "v3", "v5"]);
    }

    #[test]
    fn prune_keeps_one_auto_per_day_in_recent_month() {
        let conn = setup();
        let rows = [
            ("v1", "2026-08-01T09:00:00+08:00"), // 超出 30 天窗口，只作为最早版本保留
            ("v2", "2026-09-26T09:00:00+08:00"),
            ("v3", "2026-09-26T12:00:00+08:00"), // 同日第二条，让位给当天较新的一条
            ("v4", "2026-09-27T09:00:00+08:00"),
            ("v5", "2026-10-24T09:00:00+08:00"),
            ("v6", "2026-10-24T20:00:00+08:00"),
            ("v7", "2026-10-25T09:00:00+08:00"),
        ];
        for (title, saved_at) in rows {
            insert_version_kind(&conn, 1, title, HISTORY_KIND_AUTO, false, saved_at);
        }

        prune_note_history(&conn, 1, 2, NOW).unwrap();

        // 最新 2 条(v7,v6) + 最早 1 条(v1) + 每个更早日期各 1 条(v4,v3)
        assert_eq!(titles_of(&conn, 1), vec!["v1", "v3", "v4", "v6", "v7"]);
    }

    #[test]
    fn unknown_history_kind_normalizes_to_auto() {
        assert_eq!(normalize_history_kind("tampered"), HISTORY_KIND_AUTO);
        assert_eq!(
            normalize_history_kind(HISTORY_KIND_MANUAL),
            HISTORY_KIND_MANUAL
        );
    }

    const NOW: &str = "2026-10-25T10:06:00+08:00";

    #[test]
    fn snapshot_required_when_note_has_no_history() {
        let conn = setup();
        assert!(should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_skipped_for_identical_latest_version() {
        let conn = setup();
        insert_version_at(
            &conn,
            1,
            "标题",
            "正文",
            "2026-10-25T10:00:00+08:00",
        );
        assert!(!should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_throttled_within_interval() {
        let conn = setup();
        insert_version_at(
            &conn,
            1,
            "旧标题",
            "旧正文",
            "2026-10-25T10:04:00+08:00",
        );
        assert!(!should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_after_interval() {
        let conn = setup();
        insert_version_at(
            &conn,
            1,
            "旧标题",
            "旧正文",
            "2026-10-25T10:00:00+08:00",
        );
        assert!(should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_when_saved_at_is_unparsable() {
        let conn = setup();
        insert_version_at(&conn, 1, "旧标题", "旧正文", "not-a-time");
        assert!(should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_when_clock_moved_backwards() {
        let conn = setup();
        insert_version_at(
            &conn,
            1,
            "旧标题",
            "旧正文",
            "2026-10-25T10:10:00+08:00",
        );
        assert!(should_snapshot_history(&conn, 1, "标题", "正文", None, NOW, 300).unwrap());
    }

    /// 按 update_note 的顺序模拟「每 30 秒一次自动保存、间隔 1 分钟、只留 1 条最近版本」：
    /// 无论保存多频繁，最早那一版都必须还在。
    #[test]
    fn frequent_autosaves_do_not_evict_the_original_version() {
        let conn = setup();
        conn.execute("UPDATE notes SET content = 'v0' WHERE id = 1", [])
            .unwrap();

        let base = DateTime::parse_from_rfc3339("2026-10-25T10:00:00+08:00").unwrap();
        let mut current = "v0".to_string();
        for i in 1..=20 {
            let at = (base + Duration::seconds(30 * i)).to_rfc3339();
            if should_snapshot_history(&conn, 1, "标题", &current, None, &at, 60).unwrap() {
                snapshot_note(&conn, 1, &at, HISTORY_KIND_AUTO).unwrap();
            }
            prune_note_history(&conn, 1, 1, &at).unwrap();

            current = format!("v{i}");
            conn.execute(
                "UPDATE notes SET content = ?1 WHERE id = 1",
                params![current],
            )
            .unwrap();
        }

        let contents: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT content FROM notes_history WHERE note_id = 1 ORDER BY id")
                .unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(contents, vec!["v0", "v18"]);
    }
}

#[derive(Debug, Serialize)]
struct NoteHistoryEntry {
    id: i64,
    note_id: i64,
    title: String,
    content: String,
    category_id: Option<i64>,
    is_pinned: bool,
    /// auto = 自动 / session = 打开笔记时 / manual = 手动保存 / pre-rollback = 早期回滚快照
    kind: String,
    /// 固定版本：不会被自动清理
    pinned: bool,
    saved_at: String,
}

/// 某篇笔记的历史版本，新的在前。
#[tauri::command]
fn get_note_history(note_id: i64, state: State<AppState>) -> Result<Vec<NoteHistoryEntry>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
             FROM notes_history WHERE note_id = ?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            Ok(NoteHistoryEntry {
                id: row.get(0)?,
                note_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                category_id: row.get(4)?,
                is_pinned: row.get::<_, i64>(5)? != 0,
                kind: normalize_history_kind(&row.get::<_, String>(6)?),
                pinned: row.get::<_, i64>(7)? != 0,
                saved_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 删除单条历史版本（只动历史表，不碰笔记本身）
#[tauri::command]
fn delete_note_history_entry(entry_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM notes_history WHERE id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空某篇笔记的全部历史版本
#[tauri::command]
fn clear_note_history(note_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    purge_note_history(&conn, note_id)
}

/// 手动保存当前状态为历史版本；与最新一条内容相同时不重复写。
#[tauri::command]
fn create_note_history_version(
    note_id: i64,
    app: AppHandle,
    state: State<AppState>,
) -> Result<bool, String> {
    let limit = note_history_limit(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (title, content, category): (String, String, Option<i64>) = tx
        .query_row(
            "SELECT title, content, category_id FROM notes WHERE id = ?1",
            params![note_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;

    if history_matches_latest(&tx, note_id, &title, &content, category)? {
        return Ok(false);
    }
    let inserted = snapshot_note(&tx, note_id, &now, HISTORY_KIND_MANUAL)?;
    prune_note_history(&tx, note_id, limit, &now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// 打开笔记时记录会话基线：当前内容与最新历史不同才写，存成 `session` 版本。
/// 这样长时间编辑里「这次打开时的样子」不会被自动保存的节流漏掉。
#[tauri::command]
fn snapshot_note_session(
    note_id: i64,
    app: AppHandle,
    state: State<AppState>,
) -> Result<bool, String> {
    let limit = note_history_limit(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let current = tx.query_row(
        "SELECT title, content, category_id FROM notes WHERE id = ?1",
        params![note_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
            ))
        },
    );
    let (title, content, category) = match current {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };

    // 还没有任何历史时不写：第一次编辑时 update_note 会把编辑前内容存成 auto，
    // 仅仅是打开一篇从未记录过的笔记不应该凭空多出一条历史。
    if latest_history(&tx, note_id)?.is_none() {
        return Ok(false);
    }
    if history_matches_latest(&tx, note_id, &title, &content, category)? {
        return Ok(false);
    }
    let inserted = snapshot_note(&tx, note_id, &now, HISTORY_KIND_SESSION)?;
    prune_note_history(&tx, note_id, limit, &now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// 固定 / 取消固定一条历史版本。固定版本不会被自动清理，只能手动删除。
#[tauri::command]
fn set_note_history_pinned(
    entry_id: i64,
    pinned: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE notes_history SET pinned = ?1 WHERE id = ?2",
            params![if pinned { 1 } else { 0 }, entry_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("历史版本不存在或已被清理".to_string());
    }
    Ok(())
}

/// 回滚到某个历史版本：目标版本和所有更新的版本一起删除，不生成新的历史。
/// 回到更早的状态后，那些更新的版本已不属于当前分支，留着只会让列表越回滚越长。
#[tauri::command]
fn rollback_note_history(entry_id: i64, state: State<AppState>) -> Result<Note, String> {
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (note_id, title, content, category_id, is_pinned): (
        i64,
        String,
        String,
        Option<i64>,
        i64,
    ) = tx
        .query_row(
            "SELECT note_id, title, content, category_id, is_pinned FROM notes_history WHERE id = ?1",
            params![entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|_| "历史版本不存在或已被清理".to_string())?;

    let (cur_title, cur_content, cur_category, cur_is_pinned): (String, String, Option<i64>, i64) = tx
        .query_row(
            "SELECT title, content, category_id, is_pinned FROM notes WHERE id = ?1",
            params![note_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;

    let changed = cur_title != title
        || cur_content != content
        || cur_category != category_id
        || cur_is_pinned != is_pinned;

    // 即使回滚目标与当前内容一致，也要丢弃这条及之后的历史
    truncate_note_history(&tx, note_id, entry_id)?;

    if changed {
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, is_pinned = ?4, updated_at = ?5 WHERE id = ?6",
            params![title, content, category_id, is_pinned, now, note_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![note_id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![note_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let note = tx
        .query_row(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access
             FROM notes WHERE id = ?1",
            params![note_id],
            map_row_to_note,
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    semantic::invalidate(&state.semantic);
    Ok(note)
}

#[tauri::command]
fn update_note(
    id: i64,
    title: String,
    content: String,
    category_id: Option<i64>,
    is_pinned: Option<i64>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // 读设置要在锁住 conn 之前：read_setting_* 内部也会拿同一把锁
    let limit = note_history_limit(&app);
    let interval_secs = note_history_interval_secs(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (old_title, old_content, old_category): (String, String, Option<i64>) = tx
        .query_row(
            "SELECT title, content, category_id FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|e| e.to_string())?;

    // 只改了置顶不算内容变化，不必占一条历史
    let changed = old_title != title || old_content != content || old_category != category_id;
    if changed
        && should_snapshot_history(
            &tx,
            id,
            &old_title,
            &old_content,
            old_category,
            &now,
            interval_secs,
        )?
    {
        snapshot_note(&tx, id, &now, HISTORY_KIND_AUTO)?;
    }

    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, is_pinned = COALESCE(?4, is_pinned), updated_at = ?5 WHERE id = ?6",
        params![title, content, category_id, is_pinned, now, id],
    ).map_err(|e| e.to_string())?;

    // 旧块立刻作废：否则 worker 重建前的这几秒里，语义搜索会拿旧正文当片段返回。
    // note_index_state 一并删掉，worker 下一轮凭「state 缺失」判定为脏。
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    if changed {
        prune_note_history(&tx, id, limit, &now)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    semantic::invalidate(&state.semantic);
    Ok(())
}

/// 设置单篇笔记的 AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
/// 只写标志位：真正的拦截在前端工具链（读、写、检索、选择都会先过这一关），
/// 所以这里不做级联，也不改动 content。
#[tauri::command]
fn set_note_ai_access(id: i64, level: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE notes SET ai_access = ?1 WHERE id = ?2",
            params![level.clamp(0, 2), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("未找到 ID 为 {} 的笔记", id));
    }
    Ok(())
}

/// 设置分组的 AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
/// 分组的档位是组内笔记的上限，但不改写笔记自身字段——
/// 重新放开分组后，之前单独收紧过的笔记仍然保持自己的档位。
#[tauri::command]
fn set_category_ai_access(id: i64, level: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE categories SET ai_access = ?1 WHERE id = ?2",
            params![level.clamp(0, 2), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("未找到 ID 为 {} 的分组", id));
    }
    Ok(())
}

/* ---------------- 标签 ---------------- */

/// 取某个标签 id（没有就按 source 建一条），失败时返回 Err。
/// 名称统一 trim：`" 待办 "` 和 `"待办"` 是同一个标签。
fn ensure_tag(conn: &Connection, name: &str, source: &str) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    if let Ok(id) = conn.query_row(
        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |row| row.get::<_, i64>(0),
    ) {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO tags (name, source, created_at) VALUES (?1, ?2, ?3)",
        params![name, source, Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// 清掉已失效的关联与空标签。
///
/// 没有开 `PRAGMA foreign_keys`（开了会影响既有删除逻辑的执行计划），
/// 级联删除不会自动发生 —— 彻底删除笔记、恢复备份之后都靠这一步收尾，
/// 否则 tags 里会留下永远数不到笔记的孤儿行。
fn prune_tag_links(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_tags WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/** 某篇笔记的标签（含计数），按名称排序 */
fn tags_of_note(conn: &Connection, note_id: i64) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, nt.source, t.created_at
             FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
             WHERE nt.note_id = ?1
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            let id = row.get::<_, i64>(0)?;
            let used: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                     WHERE nt.tag_id = ?1 AND n.is_deleted = 0",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(Tag {
                id,
                name: row.get::<_, String>(1)?,
                source: row.get::<_, String>(2)?,
                created_at: row.get::<_, String>(3)?,
                note_count: used,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 参数里的 source 归一化：只允许 "user" / "ai"，别的写法（含空串）一律当 user。
fn normalize_source(source: Option<String>) -> String {
    match source.as_deref().map(|s| s.trim().to_lowercase()) {
        Some(s) if s == "ai" => "ai".to_string(),
        _ => "user".to_string(),
    }
}

/** 全部标签 + 每篇用了多少：给属性窗的候选、AI 查标签用 */
#[tauri::command]
fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.source, t.created_at,
                    (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                      WHERE nt.tag_id = t.id AND n.is_deleted = 0) AS note_count
             FROM tags t
             ORDER BY note_count DESC, t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
                note_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/** 某篇笔记的标签列表 */
#[tauri::command]
fn list_note_tags(note_id: i64, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    tags_of_note(&conn, note_id)
}

/**
 * 给笔记加标签（词不存在会自动创建），返回加完之后这篇笔记的完整标签列表。
 *
 * 一律返回完整列表是有意的：UI 与 AI 都不用再发一次 GET，
 * 也就不会出现"加成功了但列表没刷新"这种假失败。
 */
#[tauri::command]
fn add_note_tags(
    note_id: i64,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let src = normalize_source(source);
    let conn = state.conn.lock().unwrap();
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let tag_id = ensure_tag(&conn, &name, &src)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![note_id, tag_id, src, Local::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
        // 已存在但来源是另一方的（用户先打了、AI 又打一遍）：保留先来的一方，
        // 因为删除权限按 source 判定，贸然改写会把别人的标签变成自己的。
    }
    tags_of_note(&conn, note_id)
}

/**
 * 摘掉笔记上的标签。
 *
 * `source` 传了就只摘那一种来源 —— AI 工具固定传 "ai"，于是 AI 删不到用户手打的标签；
 * 不传则不限来源（属性窗侧的兜底由 UI 负责：按钮本来就只出现在用户标签上）。
 */
#[tauri::command]
fn remove_note_tags(
    note_id: i64,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    let filter_src = source.clone().map(|s| normalize_source(Some(s)));
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let sql = match filter_src {
            Some(_) => {
                "DELETE FROM note_tags
                  WHERE note_id = ?1 AND source = ?2
                    AND tag_id IN (SELECT id FROM tags WHERE name = ?3 COLLATE NOCASE)"
            }
            None => {
                "DELETE FROM note_tags
                  WHERE note_id = ?1
                    AND tag_id IN (SELECT id FROM tags WHERE name = ?3 COLLATE NOCASE)"
            }
        };
        if let Some(src) = &filter_src {
            conn.execute(sql, params![note_id, src, name])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(sql, params![note_id, name])
                .map_err(|e| e.to_string())?;
        }
    }
    prune_tag_links(&conn)?;
    tags_of_note(&conn, note_id)
}

/**
 * 整体替换笔记在某个来源下的标签：`source="ai"` 时只改 AI 那一批，用户手打的不受影响。
 * AI 打标签是"重新看一遍这篇笔记"的结果，用整体替换而不是逐条增删，避免出现重复思考两轮的残留。
 */
#[tauri::command]
fn set_note_tags(
    note_id: i64,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let src = normalize_source(source);
    let conn = state.conn.lock().unwrap();
    // 先清掉这个来源在这篇笔记上的旧关联
    conn.execute(
        "DELETE FROM note_tags WHERE note_id = ?1 AND source = ?2",
        params![note_id, src],
    )
    .map_err(|e| e.to_string())?;
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let tag_id = ensure_tag(&conn, &name, &src)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![note_id, tag_id, src, Local::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    prune_tag_links(&conn)?;
    tags_of_note(&conn, note_id)
}

/// 全局改名：标签在所有笔记上的关联一并跟着走（改的是"这个词"，不是某篇的关联）。
#[tauri::command]
fn rename_tag(id: i64, name: String, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let conn = state.conn.lock().unwrap();
    // 目标名已被别的标签占用：直接合并到它下面，避免改名把一条关系弄丢
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![name, id],
            |row| row.get(0),
        )
        .ok();
    let surviving = match clash {
        // 目标名已被别的标签占用：把关联并入它，返回它作为"改名后的那个词"
        Some(target) => {
            conn.execute(
                "UPDATE OR IGNORE note_tags SET tag_id = ?1 WHERE tag_id = ?2",
                params![target, id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            target
        }
        None => {
            conn.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![name, id])
                .map_err(|e| e.to_string())?;
            id
        }
    };
    list_tags_by_ids(&conn, vec![surviving])
}

/// 删标签（连带它在所有笔记上的关联）。`source` 传了就只删那一种来源 additions 的标签，
/// 用来保证 AI 删不到用户自己打的标签。
#[tauri::command]
fn delete_tag(id: i64, source: Option<String>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let owned: bool = match source.clone() {
        Some(s) => {
            let want = normalize_source(Some(s));
            conn.query_row(
                "SELECT COUNT(*) FROM tags WHERE id = ?1 AND source = ?2",
                params![id, want],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
                > 0
        }
        None => true,
    };
    if !owned {
        return Err("只能删除自己添加的标签".to_string());
    }
    conn.execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 内部：`list_tags` 的过滤版（改名后只回访受影响的行，减少无谓序列化）
fn list_tags_by_ids(conn: &Connection, ids: Vec<i64>) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.source, t.created_at,
                    (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                      WHERE nt.tag_id = t.id AND n.is_deleted = 0) AS note_count
             FROM tags t ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
                note_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let tag = row.map_err(|e| e.to_string())?;
        if ids.contains(&tag.id) {
            out.push(tag);
        }
    }
    Ok(out)
}

/** 按标签找笔记（多对多的反面：给这个词，捞所有带它的笔记） */
#[tauri::command]
fn list_notes_by_tag(name: String, state: State<AppState>) -> Result<Vec<Note>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.content, n.category_id, n.created_at, n.updated_at,
                    n.is_deleted, n.deleted_at, n.is_pinned, n.ai_access
             FROM notes n
               JOIN note_tags nt ON nt.note_id = n.id
               JOIN tags t ON t.id = nt.tag_id
             WHERE t.name = ?1 COLLATE NOCASE AND n.is_deleted = 0
             ORDER BY n.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![name], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                category_id: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                is_deleted: row.get::<_, i64>(6)? != 0,
                deleted_at: row.get(7)?,
                is_pinned: row.get::<_, i64>(8)? != 0,
                ai_access: row.get::<_, i64>(9)?.clamp(0, 2),
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
fn pin_note(id: i64, pinned: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute(
        "UPDATE notes SET is_pinned = ?1 WHERE id = ?2",
        params![if pinned { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn move_to_trash(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();

    conn.execute(
        "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn restore_note(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute(
        "UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn get_trash_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn.prepare(
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, 
                is_pinned, ai_access
         FROM notes 
         WHERE is_deleted = 1 
         ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;

    let notes = stmt
        .query_map([], map_row_to_note)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for note in notes {
        result.push(note.map_err(|e| e.to_string())?);
    }

    Ok(result)
}

#[tauri::command]
fn delete_note_permanently(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    purge_note_history(&conn, id)?;

    // 没开级联外键，笔记没了标签关联会留成孤儿（list_tags 的计数会飘）
    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn delete_multiple_notes_permanently(ids: Vec<i64>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    for id in ids {
        conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        purge_note_history(&conn, id)?;
    }

    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn cleanup_old_trash(state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let thirty_days_ago = Local::now() - Duration::days(30);
    let threshold = thirty_days_ago.to_rfc3339();

    conn.execute(
        "DELETE FROM notes_history WHERE note_id IN (
            SELECT id FROM notes WHERE is_deleted = 1 AND deleted_at < ?1
         )",
        params![threshold],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM notes WHERE is_deleted = 1 AND deleted_at < ?1",
        params![threshold],
    )
    .map_err(|e| e.to_string())?;

    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
fn create_ai_provider(
    name: String,
    provider_type: String,
    api_base_url: String,
    api_key: String,
    api_path: Option<String>,
    // 新建时可以一并提交已勾选的模型，避免"先保存才能选模型"导致的选择丢失
    enabled_models: Option<Vec<String>>,
    state: State<AppState>,
) -> Result<AiProvider, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let clean_api_path = api_path.filter(|path| !path.trim().is_empty());

    let mut seen = std::collections::HashSet::new();
    let clean_models: Vec<String> = enabled_models
        .unwrap_or_default()
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
        .collect();
    let models_json = serde_json::to_string(&clean_models).unwrap_or_else(|_| "[]".to_string());
    // 当前使用模型默认取列表第一项，保证保存后就能直接对话
    let enabled_model = clean_models.first().cloned();
    // API Key 落库前加密（绝不明文写入数据库文件）
    let api_key = encrypt_secret(&conn, &api_key)?;

    conn.execute(
        "INSERT INTO ai_providers (name, provider_type, api_base_url, api_key, api_path, enabled_model, enabled_models, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![
            name,
            provider_type,
            api_base_url,
            api_key,
            clean_api_path,
            enabled_model,
            models_json,
            now,
            now
        ],
    ).map_err(|e| e.to_string())?;

    let id = conn.last_insert_rowid();

    Ok(AiProvider {
        id,
        name,
        provider_type,
        api_base_url,
        api_key,
        api_path: clean_api_path,
        enabled_model,
        enabled_models: clean_models,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
fn get_ai_providers(state: State<AppState>) -> Result<Vec<AiProvider>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT id, name, provider_type, api_base_url, api_key, api_path, enabled_model,
                created_at, updated_at, enabled_models
         FROM ai_providers
         ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let providers = stmt
        .query_map([], map_row_to_ai_provider)
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for provider in providers {
        result.push(provider.map_err(|e| e.to_string())?);
    }
    // 读出后统一解密；顺便把历史遗留的明文记录迁移成密文（一次性自动完成）
    for provider in result.iter_mut() {
        if is_encrypted(&provider.api_key) {
            // 解密失败（例如密钥文件被删/换机器）时只让这一条留空，不整体报错，
            // 用户重新填一次 Key 即可，其余服务商照常可用。
            match decrypt_secret(&conn, &provider.api_key) {
                Ok(plain) => provider.api_key = plain,
                Err(e) => {
                    eprintln!("[fastnote] 服务商 {} 的 API Key 解密失败：{e}", provider.id);
                    provider.api_key = String::new();
                }
            }
        } else if !provider.api_key.is_empty() {
            let encrypted = encrypt_secret(&conn, &provider.api_key)?;
            conn.execute(
                "UPDATE ai_providers SET api_key = ?1 WHERE id = ?2",
                params![encrypted, provider.id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}

#[tauri::command]
fn update_ai_provider(provider: AiProvider, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let clean_api_path = provider.api_path.filter(|path| !path.trim().is_empty());
    let clean_enabled_model = provider
        .enabled_model
        .filter(|model| !model.trim().is_empty());
    // 去重并清理空白项后序列化为 JSON 数组
    let mut seen = std::collections::HashSet::new();
    let clean_models: Vec<String> = provider
        .enabled_models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty() && seen.insert(m.clone()))
        .collect();
    let models_json = serde_json::to_string(&clean_models).unwrap_or_else(|_| "[]".to_string());
    // 同样是加密后落库（若前端回传的就是密文则原样保留，避免二次加密）
    let api_key = if is_encrypted(&provider.api_key) {
        provider.api_key.clone()
    } else {
        encrypt_secret(&conn, &provider.api_key)?
    };

    conn.execute(
        "UPDATE ai_providers
         SET name = ?1, provider_type = ?2, api_base_url = ?3, api_key = ?4, api_path = ?5,
             enabled_model = ?6, updated_at = ?7, enabled_models = ?8
         WHERE id = ?9",
        params![
            provider.name,
            provider.provider_type,
            provider.api_base_url,
            api_key,
            clean_api_path,
            clean_enabled_model,
            now,
            models_json,
            provider.id
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn delete_ai_provider(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn get_ai_provider(id: i64, state: &State<AppState>) -> Result<AiProvider, String> {
    let conn = state.conn.lock().unwrap();
    let mut provider = conn
        .query_row(
            "SELECT id, name, provider_type, api_base_url, api_key, api_path, enabled_model,
                created_at, updated_at, enabled_models
         FROM ai_providers WHERE id = ?1",
            params![id],
            map_row_to_ai_provider,
        )
        .map_err(|e| e.to_string())?;
    // 单条读取同样解密，并顺手迁移明文（对话、拉取模型都走这里）
    if is_encrypted(&provider.api_key) {
        match decrypt_secret(&conn, &provider.api_key) {
            Ok(plain) => provider.api_key = plain,
            Err(e) => {
                eprintln!("[fastnote] 服务商 {} 的 API Key 解密失败：{e}", provider.id);
                provider.api_key = String::new();
            }
        }
    } else if !provider.api_key.is_empty() {
        let encrypted = encrypt_secret(&conn, &provider.api_key)?;
        conn.execute(
            "UPDATE ai_providers SET api_key = ?1 WHERE id = ?2",
            params![encrypted, provider.id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(provider)
}

/* ---------------- API Key 加密存储 ----------------
 * 目标：数据库文件里绝不出现明文 Key。
 *
 * 方案：AES-256-GCM（ring）+ 独立密钥文件，密钥再与"当前用户 + 机器名"绑定派生。
 * 为什么不用非对称加密：本机应用如果把私钥随程序一起发出去，等于把钥匙和锁放一起，
 * 起不到保护作用；真正有效的是"密钥不写在数据库里、且换台机器/换个用户解不开"，
 * 这正是下面这套做法提供的性质。
 *
 * 存储格式：enc:v1:<hex(12 字节 nonce || 密文+tag)>；不带前缀的一律视为历史明文。
 */
const ENC_PREFIX: &str = "enc:v1:";
const KEY_FILE: &str = "fastnote.key";

fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(ENC_PREFIX)
}

fn to_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

fn from_hex(text: &str) -> Result<Vec<u8>, String> {
    if text.len() % 2 != 0 {
        return Err("密文格式不正确".into());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or("密文格式不正确")?;
        let lo = (pair[1] as char).to_digit(16).ok_or("密文格式不正确")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

/// 取（必要时生成）主密钥：文件存在则读，不存在则随机生成 32 字节写入。
/// 密钥文件与数据库同目录，但**不在数据库里**；复制走数据库文件也解不开。
fn load_or_create_master_key(conn: &Connection) -> Result<[u8; 32], String> {
    let db_path = conn.path().ok_or("无法定位数据库文件，不能保存加密密钥")?;
    let key_path = std::path::Path::new(db_path)
        .parent()
        .ok_or("数据库目录不可用")?
        .join(KEY_FILE);
    let raw = if key_path.exists() {
        std::fs::read(&key_path).map_err(|e| format!("读取密钥文件失败：{e}"))?
    } else {
        let mut buf = [0u8; 32];
        SystemRandom::new()
            .fill(&mut buf)
            .map_err(|_| "生成随机密钥失败".to_string())?;
        std::fs::write(&key_path, buf).map_err(|e| format!("写入密钥文件失败：{e}"))?;
        buf.to_vec()
    };
    if raw.len() < 32 {
        return Err("密钥文件已损坏（长度不足）".into());
    }
    // 再与当前用户 + 机器名混合派生：换用户或换机器都解不开
    let mut hasher = Sha256::new();
    hasher.update(&raw);
    hasher.update(b"|fastnote-api-key-v1|");
    hasher.update(std::env::var("USERNAME").unwrap_or_default().as_bytes());
    hasher.update(b"|");
    hasher.update(std::env::var("COMPUTERNAME").unwrap_or_default().as_bytes());
    let digest = hasher.finalize();
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest);
    Ok(key)
}

fn aead_key(conn: &Connection) -> Result<ring::aead::LessSafeKey, String> {
    let key = load_or_create_master_key(conn)?;
    let unbound = ring::aead::UnboundKey::new(&ring::aead::AES_256_GCM, &key)
        .map_err(|_| "初始化加密器失败".to_string())?;
    Ok(ring::aead::LessSafeKey::new(unbound))
}

/// 加密：返回 enc:v1:<hex>，空串原样返回（没填 Key 时不必加密）
pub(crate) fn encrypt_secret(conn: &Connection, plain: &str) -> Result<String, String> {
    if plain.is_empty() {
        return Ok(String::new());
    }
    if is_encrypted(plain) {
        return Ok(plain.to_string());
    }
    let key = aead_key(conn)?;
    let mut nonce_bytes = [0u8; ring::aead::NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成随机数失败".to_string())?;
    let nonce = ring::aead::Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plain.as_bytes().to_vec();
    key.seal_in_place_append_tag(nonce, ring::aead::Aad::empty(), &mut in_out)
        .map_err(|_| "加密失败".to_string())?;
    let mut payload = nonce_bytes.to_vec();
    payload.extend_from_slice(&in_out);
    Ok(format!("{ENC_PREFIX}{}", to_hex(&payload)))
}

/// 解密：非密文（历史明文）原样返回，交由调用方迁移
pub(crate) fn decrypt_secret(conn: &Connection, stored: &str) -> Result<String, String> {
    if !is_encrypted(stored) {
        return Ok(stored.to_string());
    }
    let key = aead_key(conn)?;
    let raw = from_hex(&stored[ENC_PREFIX.len()..])?;
    if raw.len() <= ring::aead::NONCE_LEN {
        return Err("密文长度不正确".into());
    }
    let (nonce_bytes, cipher_text) = raw.split_at(ring::aead::NONCE_LEN);
    let nonce = ring::aead::Nonce::try_assume_unique_for_key(nonce_bytes)
        .map_err(|_| "密文 nonce 不正确".to_string())?;
    let mut buf = cipher_text.to_vec();
    let plain = key
        .open_in_place(nonce, ring::aead::Aad::empty(), &mut buf)
        .map_err(|_| "解密失败（密钥文件可能已更换或损坏）".to_string())?;
    String::from_utf8(plain.to_vec()).map_err(|_| "解密结果不是合法文本".to_string())
}

#[tauri::command]
async fn fetch_ai_models(provider: AiProvider) -> Result<Vec<String>, String> {
    let client = reqwest::Client::new();
    let provider_type = provider.provider_type.as_str();

    let response = match provider_type {
        "openai" => {
            client
                .get(openai_models_url(&provider))
                .bearer_auth(provider.api_key.trim())
                .send()
                .await
        }
        "google" => {
            let url = join_url(&provider.api_base_url, "/models");
            client
                .get(url)
                .query(&[("key", provider.api_key.trim())])
                .send()
                .await
        }
        "claude" => {
            let url = join_url(&provider.api_base_url, "/v1/models");
            client
                .get(url)
                .header("x-api-key", provider.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
        }
        _ => return Err("不支持的 API 兼容类型".to_string()),
    }
    .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("获取模型失败：{} {}", status, body));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let models = match provider_type {
        "google" => value
            .get("models")
            .and_then(|models| models.as_array())
            .map(|models| {
                models
                    .iter()
                    .filter_map(|model| {
                        model
                            .get("name")
                            .and_then(|name| name.as_str())
                            .map(|name| name.trim_start_matches("models/").to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
        _ => value
            .get("data")
            .and_then(|data| data.as_array())
            .map(|data| {
                data.iter()
                    .filter_map(|model| {
                        model
                            .get("id")
                            .and_then(|id| id.as_str())
                            .map(|id| id.to_string())
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default(),
    };

    if models.is_empty() {
        return Err("没有从响应中解析到模型列表".to_string());
    }

    Ok(models)
}

#[tauri::command]
async fn send_ai_chat(
    provider_id: i64,
    messages: Vec<AiChatMessage>,
    note_title: String,
    note_content: String,
    max_tokens: Option<u32>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 输出上限由前端设置传入。以前这里写死 2048（Claude 非流式），长回答必被截断。
    let max_tokens = max_tokens.unwrap_or(8192).clamp(256, 32000);
    let provider = get_ai_provider(provider_id, &state)?;
    let model = selected_model(&provider)?;
    let client = reqwest::Client::new();
    let base_prompt = format!(
        "You are FastNote's built-in note assistant. Current note title: {}.\nYou help the user polish, continue, summarize, rewrite, or generate content that can be inserted into the note. When the note needs to be modified, output ready-to-use body text directly; never make up information that does not exist.\nCurrent note content:\n{}",
        note_title, note_content
    );
    let system_prompt = format!("{}\n\n{}", DEEP_THINKING_PROMPT, base_prompt);

    let response = match provider.provider_type.as_str() {
        "openai" => {
            let url = join_url(&provider.api_base_url, &openai_chat_path(&provider));
            let mut api_messages = vec![json!({ "role": "system", "content": system_prompt })];
            api_messages.extend(
                messages
                    .iter()
                    .map(|message| json!({ "role": message.role, "content": message.content })),
            );
            client
                .post(url)
                .bearer_auth(provider.api_key.trim())
                .json(&json!({
                    "model": model,
                    "messages": api_messages,
                    "temperature": 0.7,
                    "max_tokens": max_tokens
                }))
                .send()
                .await
        }
        "google" => {
            let url = join_url(
                &provider.api_base_url,
                &format!(
                    "/models/{}:generateContent",
                    model.trim_start_matches("models/")
                ),
            );
            let contents = messages
                .iter()
                .filter(|message| message.role != "system")
                .map(|message| {
                    let role = if message.role == "assistant" {
                        "model"
                    } else {
                        "user"
                    };
                    json!({
                        "role": role,
                        "parts": [{ "text": message.content }]
                    })
                })
                .collect::<Vec<_>>();
            client
                .post(url)
                .query(&[("key", provider.api_key.trim())])
                .json(&json!({
                    "systemInstruction": {
                        "parts": [{ "text": system_prompt }]
                    },
                    "contents": contents,
                    "generationConfig": { "maxOutputTokens": max_tokens }
                }))
                .send()
                .await
        }
        "claude" => {
            let url = join_url(&provider.api_base_url, "/v1/messages");
            let api_messages = messages
                .iter()
                .filter(|message| message.role != "system")
                .map(|message| {
                    json!({
                        "role": if message.role == "assistant" { "assistant" } else { "user" },
                        "content": message.content
                    })
                })
                .collect::<Vec<_>>();
            client
                .post(url)
                .header("x-api-key", provider.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model,
                    "max_tokens": max_tokens,
                    "system": system_prompt,
                    "messages": api_messages
                }))
                .send()
                .await
        }
        _ => return Err("不支持的 API 兼容类型".to_string()),
    }
    .map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI 请求失败：{} {}", status, body));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let text = match provider.provider_type.as_str() {
        "openai" => extract_text(&value, &[&["choices", "0", "message", "content"]]),
        "google" => extract_text(
            &value,
            &[&["candidates", "0", "content", "parts", "0", "text"]],
        ),
        "claude" => extract_text(&value, &[&["content", "0", "text"]]),
        _ => None,
    };

    text.ok_or_else(|| "没有从 AI 响应中解析到文本内容".to_string())
}

/// Google Gemini：将思考配置合并进 generationConfig
fn google_thinking_config(include_thoughts: bool) -> Value {
    json!({
        "thinkingConfig": {
            "includeThoughts": include_thoughts,
            "thinkingBudget": 8192
        }
    })
}

/// 统一的 SSE 解析：返回 (正文, 推理内容)
/// 兼容 OpenAI(delta.content / delta.reasoning_content / delta.reasoning)、
/// Google(parts[].text / parts[].thought)、Claude(content_block_delta) 三种格式。
fn parse_sse_event(event: &str) -> (Option<String>, Option<String>) {
    let mut text: Option<String> = None;
    let mut reasoning: Option<String> = None;
    for line in event.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(data) => data,
            None => continue,
        };
        if data.trim() == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(data) {
            // ---------- OpenAI 兼容格式 ----------
            if let Some(choices) = value.get("choices").and_then(|c| c.as_array()) {
                if let Some(delta) = choices.first().and_then(|c| c.get("delta")) {
                    // DeepSeek 等推理模型的思维链
                    for key in ["reasoning_content", "reasoning"] {
                        if let Some(r) = delta.get(key).and_then(|v| v.as_str()) {
                            if !r.is_empty() {
                                let slot = reasoning.get_or_insert_with(String::new);
                                slot.push_str(r);
                            }
                        }
                    }
                    if let Some(c) = delta.get("content").and_then(|v| v.as_str()) {
                        if !c.is_empty() {
                            let slot = text.get_or_insert_with(String::new);
                            slot.push_str(c);
                        }
                    }
                }
            }
            // ---------- Google Gemini 格式 ----------
            if let Some(parts) = value
                .get("candidates")
                .and_then(|c| c.as_array())
                .and_then(|c| c.first())
                .and_then(|c| c.get("content"))
                .and_then(|c| c.get("parts"))
                .and_then(|p| p.as_array())
            {
                for part in parts {
                    let is_thought = part
                        .get("thought")
                        .and_then(|t| t.as_bool())
                        .unwrap_or(false);
                    if let Some(part_text) = part.get("text").and_then(|t| t.as_str()) {
                        if part_text.is_empty() {
                            continue;
                        }
                        if is_thought {
                            let slot = reasoning.get_or_insert_with(String::new);
                            slot.push_str(part_text);
                        } else {
                            let slot = text.get_or_insert_with(String::new);
                            slot.push_str(part_text);
                        }
                    }
                }
            }
            // ---------- Claude 格式 ----------
            if let Some(delta) = value.get("delta") {
                // 扩展思考：content_block_delta + thinking_delta
                if let Some(t) = delta.get("thinking").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        let slot = reasoning.get_or_insert_with(String::new);
                        slot.push_str(t);
                    }
                }
                if let Some(t) = delta.get("text").and_then(|v| v.as_str()) {
                    if !t.is_empty() {
                        let slot = text.get_or_insert_with(String::new);
                        slot.push_str(t);
                    }
                }
            }
        }
    }
    (text, reasoning)
}

#[tauri::command]
async fn send_ai_chat_stream(
    app_handle: AppHandle,
    provider_id: i64,
    messages: Vec<AiChatMessage>,
    note_title: String,
    note_content: String,
    min_thinking_len: Option<usize>,
    current_note_id: Option<i64>,
    max_tokens: Option<u32>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // 输出上限由前端设置传入；OpenAI 兼容分支以前**完全没发 max_tokens**，
    // 于是走服务商默认值（常见 2048~4096），长回答/长工具参数一到头就被砍断。
    let max_tokens = max_tokens.unwrap_or(8192).clamp(256, 32000);
    let provider = get_ai_provider(provider_id, &state)?;
    let model = selected_model(&provider)?;
    let client = reqwest::Client::new();
    // 单独给出当前笔记 ID：同名笔记无法靠标题区分，只有 ID 唯一
    let note_id_line = match current_note_id {
        Some(id) if id > 0 => format!(
            "- ID of the currently open note: {} (when the user says \"this note / the current note / it\", this is the ID they mean)",
            id
        ),
        _ => "- No note is currently open (if the user refers to \"this note\", first ask them to point out which one)".to_string(),
    };
    let base_prompt = format!(
        "You are FastNote's built-in note assistant.\n\n## Current context\n{}\n- Current note title: {}\n\nYou help the user polish, continue, summarize, rewrite, or generate content that can be inserted into the note. When the note needs to be modified, output ready-to-use body text directly; never make up information that does not exist.\n\nCurrent note content:\n{}",
        note_id_line, note_title, note_content
    );
    // 深度思考提示词始终注入，保证模型看到它的优先级高于其它提示词
    let system_prompt = format!("{}\n\n{}", DEEP_THINKING_PROMPT, base_prompt);
    // 要求模型先思考再回答；min_thinking_len 由前端传入（默认 80 字）
    let min_thinking = min_thinking_len.unwrap_or(80);
    let thinking_reminder = if min_thinking > 0 {
        format!(
            "\n\n## Mandatory checks for this reply\n- Your <thinking> content must be at least {} characters long, and must include an analysis of the user's intent and of the next step to take.\n- If your thinking concludes that a tool is needed, you must also output <tool_calls>; otherwise the reply is considered invalid.",
            min_thinking
        )
    } else {
        String::new()
    };

    let response = match provider.provider_type.as_str() {
        "openai" => {
            let url = join_url(&provider.api_base_url, &openai_chat_path(&provider));
            let mut api_messages = vec![json!({ "role": "system", "content": format!("{}{}", system_prompt, thinking_reminder) })];
            api_messages.extend(messages.iter().map(|message| {
                json!({ "role": message.role, "content": message.content })
            }));
            // 强制开启深度思考：推理模型走 reasoning_effort，其余模型依靠提示词约束
            let mut body = json!({
                "model": model.clone(),
                "messages": api_messages,
                "max_tokens": max_tokens,
                "stream": true
            });
            if supports_reasoning_effort(&model) {
                body["reasoning_effort"] = json!("high");
            } else {
                body["temperature"] = json!(0.7);
            }
            client
                .post(url)
                .bearer_auth(provider.api_key.trim())
                .json(&body)
                .send()
                .await
        }
        "google" => {
            let url = join_url(
                &provider.api_base_url,
                &format!("/models/{}:streamGenerateContent", model.trim_start_matches("models/")),
            );
            let contents = messages
                .iter()
                .filter(|message| message.role != "system")
                .map(|message| {
                    let role = if message.role == "assistant" { "model" } else { "user" };
                    json!({
                        "role": role,
                        "parts": [{ "text": message.content }]
                    })
                })
                .collect::<Vec<_>>();
            client
                .post(url)
                .query(&[("key", provider.api_key.trim())])
                .json(&json!({
                    "systemInstruction": {
                        "parts": [{ "text": format!("{}{}", system_prompt, thinking_reminder) }]
                    },
                    "contents": contents,
                    "generationConfig": google_thinking_config(true)
                }))
                .send()
                .await
        }
        "claude" => {
            let url = join_url(&provider.api_base_url, "/v1/messages");
            let api_messages = messages
                .iter()
                .filter(|message| message.role != "system")
                .map(|message| {
                    json!({
                        "role": if message.role == "assistant" { "assistant" } else { "user" },
                        "content": message.content
                    })
                })
                .collect::<Vec<_>>();
            let mut body = json!({
                "model": model.clone(),
                "max_tokens": max_tokens,
                "system": format!("{}{}", system_prompt, thinking_reminder),
                "messages": api_messages,
                "stream": true
            });
            if supports_extended_thinking(&model) {
                body["thinking"] = json!({ "type": "enabled", "budget_tokens": 4096 });
                // 扩展思考要求 temperature 必须为 1
                body["temperature"] = json!(1);
            }
            client
                .post(url)
                .header("x-api-key", provider.api_key.trim())
                .header("anthropic-version", "2023-06-01")
                .json(&body)
                .send()
                .await
        }
        _ => return Err("不支持的 API 兼容类型".to_string()),
    }.map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        let _ = app_handle.emit(
            "ai-chat-error",
            json!({"error": format!("AI 请求失败：{} {}", status, body)}),
        );
        return Err(format!("AI 请求失败：{} {}", status, body));
    }

    let mut full_text = String::new();
    let mut full_reasoning = String::new();
    let mut buffer = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk_result) = stream.next().await {
        let chunk = chunk_result.map_err(|e| e.to_string())?;
        if let Ok(text) = String::from_utf8(chunk.to_vec()) {
            buffer.push_str(&text);
            // Process complete SSE events (separated by \n\n)
            while let Some(pos) = buffer.find("\n\n") {
                let event = buffer[..pos].to_string();
                buffer = buffer[pos + 2..].to_string();
                let (delta_text, delta_reasoning) = parse_sse_event(&event);
                let mut changed = false;
                if let Some(t) = delta_text {
                    full_text.push_str(&t);
                    changed = true;
                }
                if let Some(r) = delta_reasoning {
                    full_reasoning.push_str(&r);
                    changed = true;
                }
                if changed {
                    let _ = app_handle.emit(
                        "ai-chat-chunk",
                        json!({
                            "content": derive_stream_payload(&full_reasoning, &full_text),
                            "reasoning": &full_reasoning,
                            "text": &full_text
                        }),
                    );
                }
            }
        }
    }

    // Process any remaining buffer
    if !buffer.trim().is_empty() {
        let (delta_text, delta_reasoning) = parse_sse_event(&buffer);
        if let Some(t) = delta_text {
            full_text.push_str(&t);
        }
        if let Some(r) = delta_reasoning {
            full_reasoning.push_str(&r);
        }
    }

    if full_text.is_empty() && full_reasoning.is_empty() {
        let _ = app_handle.emit(
            "ai-chat-error",
            json!({"error": "没有从 AI 响应中解析到文本内容"}),
        );
        return Err("没有从 AI 响应中解析到文本内容".to_string());
    }

    let final_content = derive_stream_payload(&full_reasoning, &full_text);
    let _ = app_handle.emit(
        "ai-chat-done",
        json!({ "content": &final_content, "reasoning": &full_reasoning, "text": &full_text }),
    );
    Ok(())
}

/// 组装流式负载：把模型原生思维链包装成 <thinking> 标签，兼容前端的解析逻辑
fn derive_stream_payload(reasoning: &str, text: &str) -> String {
    if reasoning.trim().is_empty() {
        return text.to_string();
    }
    if text.is_empty() {
        return format!("<thinking>{}</thinking>", reasoning);
    }
    format!("<thinking>{}</thinking>\n{}", reasoning, text)
}

#[tauri::command]
fn create_chat_session(
    title: String,
    provider_id: i64,
    model: String,
    state: State<AppState>,
) -> Result<AiChatSession, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_chat_sessions (title, provider_id, model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, provider_id, model, now, now],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(AiChatSession {
        id,
        title,
        provider_id,
        model,
        created_at: now.clone(),
        updated_at: now,
    })
}

#[tauri::command]
fn get_chat_sessions(state: State<AppState>) -> Result<Vec<AiChatSession>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, model, created_at, updated_at FROM ai_chat_sessions ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let sessions = stmt
        .query_map([], |row| {
            Ok(AiChatSession {
                id: row.get(0)?,
                title: row.get(1)?,
                provider_id: row.get(2)?,
                model: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for session in sessions {
        result.push(session.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn get_chat_messages(
    session_id: i64,
    state: State<AppState>,
) -> Result<Vec<AiChatDbMessage>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at FROM ai_chat_messages WHERE session_id = ?1 ORDER BY id ASC"
    ).map_err(|e| e.to_string())?;
    let messages = stmt
        .query_map(params![session_id], |row| {
            Ok(AiChatDbMessage {
                id: row.get(0)?,
                session_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for message in messages {
        result.push(message.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn save_chat_message(
    session_id: i64,
    role: String,
    content: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role, content, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE ai_chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_chat_session_title(
    session_id: i64,
    title: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE ai_chat_sessions SET title = ?1 WHERE id = ?2",
        params![title, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_chat_session(session_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM ai_chat_messages WHERE session_id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM ai_chat_sessions WHERE id = ?1",
        params![session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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

#[tauri::command]
fn read_text_file(path: String) -> Result<TextFileInfo, String> {
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

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
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

/* ---------------- 单实例 / 托盘 / 窗口管理 ----------------
 * 全部由 Rust 侧驱动，不依赖前端 JS（JS 只在设置变化时下发指令）：
 *   - 单实例：run() 里注册 tauri-plugin-single-instance（命名互斥量，跨进程有效），
 *     第二个实例启动时会回调这里 → 聚焦已有窗口并自行退出。
 *     开关在库里（app.config.general.singleInstance，默认开）：插件一旦注册就必然创建
 *     互斥量、且无法在注册后再撤销，所以只能在 Builder 之前先读一次设置再决定是否注册。
 *   - 托盘：setup() 里用 TrayIconBuilder 创建，生命周期归 Rust 所有；
 *     即使窗口隐藏、webview 不再执行 JS，托盘依然存在。
 *   - 关闭行为：on_window_event(CloseRequested) 读库里的设置，
 *     决定「隐藏到托盘」还是「退出应用」。
 */

/// 托盘图标 ID
const TRAY_ID: &str = "fastnote-tray";

/// 库文件名：解析数据目录后拼上它就是数据库路径
const DB_FILE_NAME: &str = "fastnote.db";

/// 兜底用的包标识：与 tauri.conf.json 的 identifier 一致（只在 dirs 兜底分支用到）
const APP_IDENTIFIER: &str = "com.smartist.fastnote";

/**
 * 数据目录：优先 exe 同级的 data（便携模式，拷走整个目录就带着数据走），
 * 否则退回系统应用数据目录（与 tauri 的 app_data_dir 同规则：dirs::data_dir()/identifier）。
 *
 * 两处都要用：run() 里读单例开关时还没有 AppHandle，setup() 里才拿得到 tauri 的路径。
 * 抽成一个函数是为了保证两边算出同一个库文件——算出不同路径等于换了个空库。
 *
 * @param app_data_dir tauri 解析出的应用数据目录；run() 阶段传 None，此时用 dirs 兜底
 */
pub(crate) fn resolve_data_dir(app_data_dir: Option<std::path::PathBuf>) -> std::path::PathBuf {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let install_data_dir = exe_dir.join("data");
            if std::fs::create_dir_all(&install_data_dir).is_ok() {
                return install_data_dir;
            }
        }
    }
    app_data_dir.unwrap_or_else(|| {
        dirs::data_dir()
            .map(|d| d.join(APP_IDENTIFIER))
            .unwrap_or_else(|| std::path::PathBuf::from("data"))
    })
}

/**
 * 在 Builder 之前读一次「单例模式」开关。
 *
 * 只读、且库文件不存在时直接返回默认（true）：绝不能在这里新建数据库——
 * 真正的建库在 setup() 里做，那时才确定最终路径。
 * 读不到（键缺失 / 脏值 / 库被占用）一律按默认「开启」处理，多开的风险远大于误挡一次启动。
 */
fn read_single_instance_enabled(app_data_dir: Option<std::path::PathBuf>) -> bool {
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

/// 读取 app_settings 表里某个键的原始字符串值（值以 JSON 文本存储）
fn read_setting_raw(app: &AppHandle, key: &str) -> Option<String> {
    let state = app.try_state::<AppState>()?;
    let conn = state.conn.lock().ok()?;
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// 读布尔设置；缺失或解析失败时回退 fallback
fn read_setting_bool(app: &AppHandle, key: &str, fallback: bool) -> bool {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<bool>(&raw).ok())
        .unwrap_or(fallback)
}

/// 读字符串设置；缺失或解析失败时回退 fallback
fn read_setting_string(app: &AppHandle, key: &str, fallback: &str) -> String {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<String>(&raw).ok())
        .unwrap_or_else(|| fallback.to_string())
}

/// 读无符号数值设置；缺失、为负数或解析失败时回退 fallback
pub(crate) fn read_setting_u64(app: &AppHandle, key: &str, fallback: u64) -> u64 {
    read_setting_raw(app, key)
        .and_then(|raw| serde_json::from_str::<u64>(&raw).ok())
        .unwrap_or(fallback)
}

/// 启动时是否应该显示主窗口。
///
/// 窗口以 `visible: false` 创建、由前端在首帧画完后 show()（见 main.tsx），
/// 所以"开机自启 + 开机后最小化 + 托盘已开启"这条规则要让前端也问一次：
/// 否则前端那句 show() 会把本该藏在托盘里的窗口顶出来。
/// 与 setup 里的分支用同一套判定，改规则时两处一起改。
#[tauri::command]
fn should_show_on_startup(app: AppHandle) -> bool {
    let tray_on = read_setting_bool(&app, "app.config.general.trayEnabled", true);
    let minimize_to_tray = read_setting_bool(&app, "app.config.general.minimizeToTray", false);
    !(launched_from_autostart() && minimize_to_tray && tray_on)
}

/// 从托盘 / 单实例唤出窗口。
///
/// WebView2 在窗口隐藏或最小化期间会暂停合成，直接 show() 有概率只呈现一帧空白。
/// 处理顺序：先解除最小化 → 显示 → 聚焦；确实是从隐藏/最小化恢复时，
/// 再在后台做一次「1px 尺寸抖动」，逼 WebView2 重新分配渲染表面。
fn show_main_window(app: &AppHandle) {
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

/// 创建托盘图标（已存在则跳过）
fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    if app.tray_by_id(TRAY_ID).is_some() {
        return Ok(());
    }

    let show_item = MenuItem::with_id(app, "show", "显示 FastNote", true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_item, &quit_item])?;

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

/// 启用/禁用托盘图标（设置项「显示托盘图标」变化时由前端调用）
#[tauri::command]
fn set_tray_enabled(app: AppHandle, enabled: bool) -> Result<(), String> {
    if enabled {
        create_tray(&app).map_err(|e| e.to_string())
    } else {
        let _ = app.remove_tray_by_id(TRAY_ID);
        Ok(())
    }
}

/* ---------------- 开机自启动 (Windows 启动文件夹方式) ---------------- */

/// 开机自启动快捷方式路径：
/// %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\FastNote.lnk
fn startup_shortcut_path() -> Result<std::path::PathBuf, String> {
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
fn launched_from_autostart() -> bool {
    std::env::args().any(|arg| arg == "--autostart" || arg == "--minimized")
}

/// 写入开机启动快捷方式：用 WScript.Shell 生成 .lnk，无需额外依赖。
/// 参数固定为 --autostart，只负责标记「这次是开机拉起的」；
/// 拉起后是否隐藏到托盘由库里的「开机后最小化到托盘」设置决定，因此切换该设置不需要动快捷方式。
fn write_autostart_shortcut(shortcut: &std::path::Path) -> Result<(), String> {
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

/// 启用/禁用开机自启：在启动文件夹里创建/删除快捷方式。
/// 只在「开机自启动」开关真正变化时由前端调用，不做无谓的重写。
#[tauri::command]
fn set_autostart_enabled(enabled: bool) -> Result<(), String> {
    let shortcut = startup_shortcut_path()?;
    if enabled {
        write_autostart_shortcut(&shortcut)
    } else if shortcut.exists() {
        std::fs::remove_file(&shortcut).map_err(|e| format!("删除开机启动快捷方式失败：{}", e))
    } else {
        Ok(())
    }
}

/// 启动时对齐一次：只有快捷方式「该在却不在 / 不该在却在」时才动手。
/// 正常情况下（设置已开启且快捷方式已存在）这里什么都不做，不会每次都跑一遍 PowerShell。
fn sync_autostart_shortcut(app: &AppHandle) {
    let Ok(shortcut) = startup_shortcut_path() else {
        return;
    };
    if read_setting_bool(app, "app.config.general.autostart", false) {
        if !shortcut.exists() {
            if let Err(e) = write_autostart_shortcut(&shortcut) {
                eprintln!("创建开机启动快捷方式失败：{}", e);
            }
        }
    } else if shortcut.exists() {
        let _ = std::fs::remove_file(&shortcut);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]

pub fn run() {
    // 单实例开关必须在 Builder 之前读：插件一旦注册就必然创建互斥量，事后无法撤销。
    // 关掉时干脆不注册——第二实例不会创建互斥量，也就不会被挡下，可以真正多开。
    let single_instance = read_single_instance_enabled(None);
    let mut builder = tauri::Builder::default();
    if single_instance {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // 已有实例在运行：呼出它的窗口（窗口可能正处于隐藏/最小化状态）
            show_main_window(app);
        }));
    }
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            create_category,
            get_categories,
            update_category,
            delete_category,
            create_note,
            get_notes,
            get_note,
            update_note,
            get_note_history,
            delete_note_history_entry,
            clear_note_history,
            create_note_history_version,
            snapshot_note_session,
            set_note_history_pinned,
            rollback_note_history,
            set_note_ai_access,
            set_category_ai_access,
            list_tags,
            list_note_tags,
            add_note_tags,
            remove_note_tags,
            set_note_tags,
            rename_tag,
            delete_tag,
            list_notes_by_tag,
            pin_note,
            move_to_trash,
            restore_note,
            get_trash_notes,
            delete_note_permanently,
            delete_multiple_notes_permanently,
            cleanup_old_trash,
            create_ai_provider,
            get_ai_providers,
            update_ai_provider,
            delete_ai_provider,
            fetch_ai_models,
            send_ai_chat,
            send_ai_chat_stream,
            create_chat_session,
            get_chat_sessions,
            get_chat_messages,
            save_chat_message,
            update_chat_session_title,
            delete_chat_session,
            get_app_settings,
            set_app_setting,
            delete_app_setting,
            export_backup,
            import_backup,
            export_sqlite_backup,
            import_sqlite_backup,
            webdav::webdav_status,
            webdav::webdav_set_password,
            webdav::webdav_test,
            webdav::webdav_backup,
            webdav::webdav_list_remote,
            webdav::webdav_restore_remote,
            webdav::webdav_list_local,
            webdav::webdav_restore_local,
            webdav::webdav_backup_dir,
            export_category_zip,
            export_category_ebook,
            export_notes_zip,
            export_notes_ebook,
            read_text_file,
            write_text_file,
            set_tray_enabled,
            set_autostart_enabled,
            should_show_on_startup,
            semantic::semantic_status,
            semantic::semantic_download_model,
            semantic::semantic_delete_model,
            semantic::semantic_import_model,
            semantic::semantic_rebuild_index,
            semantic::semantic_cancel_index,
            semantic::semantic_search,
            #[cfg(debug_assertions)]
            semantic::semantic_debug_embed,
            download::toolbox_download,
            download::toolbox_download_cancel,
            download::toolbox_download_dir,
            fingerprint::fingerprint_info,
            opener::open_app_folder,
        ])
        .setup(|app| {
            // 与 run() 里读开关时同一套解析规则，保证两边是同一个库文件
            let data_dir = resolve_data_dir(app.path().app_data_dir().ok());
            if let Err(e) = std::fs::create_dir_all(&data_dir) {
                panic!("failed to create app data dir: {e}");
            }

            let db_path = data_dir.join(DB_FILE_NAME);

            let conn = Connection::open(db_path).expect("failed to open database");
            init_database(&conn).expect("failed to initialize database");

            let state = AppState {
                conn: Mutex::new(conn),
                semantic: semantic::SemanticState::default(),
                download: download::DownloadState::default(),
                webdav: webdav::WebdavState::default(),
            };

            app.manage(state);
            webdav::spawn_auto_backup(app.handle().clone());
            // 旧版本模型放在应用数据目录，搬进便携数据目录后再启动索引
            semantic::model::migrate_legacy(app.handle());
            // 索引 worker 自己轮询开关与模型状态，未开启时每 2 秒空转一次，几乎无开销
            semantic::spawn_worker(app.handle().clone());

            let window = app
                .get_webview_window("main")
                .expect("main window not found");

            if let Ok(cursor_pos) = window.cursor_position() {
                if let Ok(monitors) = app.available_monitors() {
                    let mut target_monitor = None;

                    for monitor in monitors {
                        let pos = monitor.position();
                        let size = monitor.size();

                        let x1 = pos.x as f64;
                        let y1 = pos.y as f64;
                        let x2 = (pos.x + size.width as i32) as f64;
                        let y2 = (pos.y + size.height as i32) as f64;

                        if cursor_pos.x >= x1
                            && cursor_pos.x <= x2
                            && cursor_pos.y >= y1
                            && cursor_pos.y <= y2
                        {
                            target_monitor = Some(monitor);
                            break;
                        }
                    }

                    if let Some(monitor) = target_monitor {
                        let monitor_pos = monitor.position();
                        let monitor_size = monitor.size();

                        let window_width = 1200.0;
                        let window_height = 800.0;

                        let center_x = monitor_pos.x as f64 + (monitor_size.width as f64 / 2.0)
                            - (window_width / 2.0);
                        let center_y = monitor_pos.y as f64 + (monitor_size.height as f64 / 2.0)
                            - (window_height / 2.0);

                        let _ =
                            window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                                x: center_x,
                                y: center_y,
                            }));
                    }
                }
            }

            // 开机启动：只在快捷方式与库里的设置不一致时对齐一次，正常启动不会重写
            sync_autostart_shortcut(app.handle());

            // 托盘图标：按库里的设置决定是否创建（读不到键时默认开启）
            let tray_on = read_setting_bool(app.handle(), "app.config.general.trayEnabled", true);
            if tray_on {
                if let Err(e) = create_tray(app.handle()) {
                    eprintln!("创建托盘图标失败：{}", e);
                }
            }

            // 开机自启动拉起时：只有设置里选了「开机后最小化到托盘」且托盘图标已开启，才隐藏窗口。
            // 其余情况都正常显示（托盘没开时隐藏会让用户失去找回窗口的入口）。
            let minimize_to_tray =
                read_setting_bool(app.handle(), "app.config.general.minimizeToTray", false);
            if launched_from_autostart() && minimize_to_tray && tray_on {
                let _ = window.hide();
            } else {
                /*
                 * 不在这里直接 show：窗口一显示，系统会先画出 webview 的空白帧
                 * （深色主题是黑屏、浅色是白屏），之后才轮到 index.html 里的加载页。
                 * 正常路径由前端 main.tsx 在首帧画完后自己 show()，这里只做兜底：
                 * 前端脚本出错 / 加载失败时窗口不能永远不出现。
                 */
                let fallback = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(3));
                    if !fallback.is_visible().unwrap_or(true) {
                        let _ = fallback.show();
                        let _ = fallback.set_focus();
                    }
                });
            }

            Ok(())
        })
        // 关闭窗口行为：读库里的设置，决定「隐藏到托盘」还是「退出应用」
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() != "main" {
                    return;
                }
                let app = window.app_handle();
                let behavior =
                    read_setting_string(app, "app.config.general.closeBehavior", "minimize");
                let tray_on = read_setting_bool(app, "app.config.general.trayEnabled", true);
                if behavior == "minimize" && tray_on {
                    api.prevent_close();
                    let _ = window.hide();
                } else {
                    app.exit(0);
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

