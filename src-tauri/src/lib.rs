use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Mutex;
use futures_util::StreamExt;
use tauri::{AppHandle, Emitter, Manager, State};
use chrono::{Local, Duration};
use sha2::{Digest, Sha256};
use ring::rand::{SecureRandom, SystemRandom};

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
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    pub id: i64,
    pub name: String,
    pub created_at: String,
    pub note_count: i32,
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

fn init_database(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            created_at TEXT NOT NULL
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

    // ---- 迁移：多选模型列表 ----
    // 老库只有 enabled_model（单选），这里补上 enabled_models（JSON 数组）并把旧值回填进去
    if !has_column(conn, "ai_providers", "enabled_models") {
        conn.execute("ALTER TABLE ai_providers ADD COLUMN enabled_models TEXT", [])?;
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
    m.contains("3-7")
        || m.contains("sonnet-4")
        || m.contains("opus-4")
        || m.contains("thinking")
}

#[tauri::command]
fn create_category(name: String, state: State<AppState>) -> Result<Category, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "INSERT INTO categories (name, created_at) VALUES (?1, ?2)",
        params![name, now],
    ).map_err(|e| e.to_string())?;
    
    let id = conn.last_insert_rowid();
    
    Ok(Category {
        id,
        name,
        created_at: now,
        note_count: 0,
    })
}

/* ---------------- 应用设置（键值对） ----------------
 * 所有设置都存在 app_settings 表里：读不到某个键时由前端回退到默认值，
 * 因此升级/新增设置项都不需要迁移脚本。
 */

#[tauri::command]
fn get_app_settings(state: State<AppState>) -> Result<std::collections::HashMap<String, String>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare("SELECT key, value FROM app_settings")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
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
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_app_setting(key: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let conn = state.conn.lock().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT c.id, c.name, c.created_at, COUNT(n.id) as note_count
         FROM categories c
         LEFT JOIN notes n ON c.id = n.category_id AND n.is_deleted = 0
         GROUP BY c.id, c.name, c.created_at
         ORDER BY c.created_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let categories = stmt.query_map([], |row| {
        Ok(Category {
            id: row.get(0)?,
            name: row.get(1)?,
            created_at: row.get(2)?,
            note_count: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;
    
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
    ).map_err(|e| e.to_string())?;
    
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
        ).map_err(|e| e.to_string())?;
    }
    
    conn.execute(
        "DELETE FROM categories WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn create_note(title: String, content: String, category_id: Option<i64>, state: State<AppState>) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "INSERT INTO notes (title, content, category_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, content, category_id, now, now],
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
    })
}

fn map_row_to_note(row: &rusqlite::Row) -> Result<Note, rusqlite::Error> {
    Ok(Note {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        category_id: row.get(3)?,
        created_at: row.get(4)?,
        updated_at: row.get(5)?,
        is_deleted: row.get(6)?,
        deleted_at: row.get(7)?,
    })
}

#[tauri::command]
fn get_notes(category_id: Option<i64>, sort_by: String, sort_order: String, state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();
    
    let order_direction = if sort_order == "asc" { "ASC" } else { "DESC" };
    
    let order_clause = match sort_by.as_str() {
        "created_at" => format!("ORDER BY created_at {}", order_direction),
        "updated_at" => format!("ORDER BY updated_at {}", order_direction),
        "title" => format!("ORDER BY title {}", if sort_order == "asc" { "ASC" } else { "DESC" }),
        _ => format!("ORDER BY updated_at {}", order_direction),
    };
    
    let sql = if let Some(_cat_id) = category_id {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
             FROM notes 
             WHERE is_deleted = 0 AND category_id = ?1 
             {}",
            order_clause
        )
    } else {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
             FROM notes 
             WHERE is_deleted = 0 
             {}",
            order_clause
        )
    };
    
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    
    let notes_iter = if let Some(cat_id) = category_id {
        stmt.query_map(params![cat_id], map_row_to_note).map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], map_row_to_note).map_err(|e| e.to_string())?
    };
    
    let mut result = Vec::new();
    for note in notes_iter {
        result.push(note.map_err(|e| e.to_string())?);
    }
    
    Ok(result)
}

#[tauri::command]
fn update_note(id: i64, title: String, content: String, category_id: Option<i64>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, updated_at = ?4 WHERE id = ?5",
        params![title, content, category_id, now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn move_to_trash(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    
    conn.execute(
        "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn restore_note(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    conn.execute(
        "UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn get_trash_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();
    
    let mut stmt = conn.prepare(
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at 
         FROM notes 
         WHERE is_deleted = 1 
         ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let notes = stmt.query_map([], map_row_to_note).map_err(|e| e.to_string())?;
    
    let mut result = Vec::new();
    for note in notes {
        result.push(note.map_err(|e| e.to_string())?);
    }
    
    Ok(result)
}

#[tauri::command]
fn delete_note_permanently(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    conn.execute(
        "DELETE FROM notes WHERE id = ?1",
        params![id],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
fn delete_multiple_notes_permanently(ids: Vec<i64>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    
    for id in ids {
        conn.execute(
            "DELETE FROM notes WHERE id = ?1",
            params![id],
        ).map_err(|e| e.to_string())?;
    }
    
    Ok(())
}

#[tauri::command]
fn cleanup_old_trash(state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let thirty_days_ago = Local::now() - Duration::days(30);
    let threshold = thirty_days_ago.to_rfc3339();
    
    conn.execute(
        "DELETE FROM notes WHERE is_deleted = 1 AND deleted_at < ?1",
        params![threshold],
    ).map_err(|e| e.to_string())?;
    
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
    let mut stmt = conn.prepare(
        "SELECT id, name, provider_type, api_base_url, api_key, api_path, enabled_model,
                created_at, updated_at, enabled_models
         FROM ai_providers
         ORDER BY updated_at DESC",
    ).map_err(|e| e.to_string())?;

    let providers = stmt.query_map([], map_row_to_ai_provider).map_err(|e| e.to_string())?;
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
            ).map_err(|e| e.to_string())?;
        }
    }
    Ok(result)
}

#[tauri::command]
fn update_ai_provider(provider: AiProvider, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let clean_api_path = provider.api_path.filter(|path| !path.trim().is_empty());
    let clean_enabled_model = provider.enabled_model.filter(|model| !model.trim().is_empty());
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
    ).map_err(|e| e.to_string())?;

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
    let mut provider = conn.query_row(
        "SELECT id, name, provider_type, api_base_url, api_key, api_path, enabled_model,
                created_at, updated_at, enabled_models
         FROM ai_providers WHERE id = ?1",
        params![id],
        map_row_to_ai_provider,
    ).map_err(|e| e.to_string())?;
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
        ).map_err(|e| e.to_string())?;
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
fn encrypt_secret(conn: &Connection, plain: &str) -> Result<String, String> {
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
fn decrypt_secret(conn: &Connection, stored: &str) -> Result<String, String> {
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
    }.map_err(|e| e.to_string())?;

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
                    .filter_map(|model| model.get("id").and_then(|id| id.as_str()).map(|id| id.to_string()))
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
            api_messages.extend(messages.iter().map(|message| {
                json!({ "role": message.role, "content": message.content })
            }));
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
                &format!("/models/{}:generateContent", model.trim_start_matches("models/")),
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
    }.map_err(|e| e.to_string())?;

    let status = response.status();
    let body = response.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("AI 请求失败：{} {}", status, body));
    }

    let value: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let text = match provider.provider_type.as_str() {
        "openai" => extract_text(&value, &[&["choices", "0", "message", "content"]]),
        "google" => extract_text(&value, &[&["candidates", "0", "content", "parts", "0", "text"]]),
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
                    let is_thought = part.get("thought").and_then(|t| t.as_bool()).unwrap_or(false);
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
        let _ = app_handle.emit("ai-chat-error", json!({"error": format!("AI 请求失败：{} {}", status, body)}));
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
        let _ = app_handle.emit("ai-chat-error", json!({"error": "没有从 AI 响应中解析到文本内容"}));
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
fn create_chat_session(title: String, provider_id: i64, model: String, state: State<AppState>) -> Result<AiChatSession, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_chat_sessions (title, provider_id, model, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![title, provider_id, model, now, now],
    ).map_err(|e| e.to_string())?;
    let id = conn.last_insert_rowid();
    Ok(AiChatSession { id, title, provider_id, model, created_at: now.clone(), updated_at: now })
}

#[tauri::command]
fn get_chat_sessions(state: State<AppState>) -> Result<Vec<AiChatSession>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, title, provider_id, model, created_at, updated_at FROM ai_chat_sessions ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let sessions = stmt.query_map([], |row| {
        Ok(AiChatSession {
            id: row.get(0)?,
            title: row.get(1)?,
            provider_id: row.get(2)?,
            model: row.get(3)?,
            created_at: row.get(4)?,
            updated_at: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for session in sessions {
        result.push(session.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn get_chat_messages(session_id: i64, state: State<AppState>) -> Result<Vec<AiChatDbMessage>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn.prepare(
        "SELECT id, session_id, role, content, created_at FROM ai_chat_messages WHERE session_id = ?1 ORDER BY id ASC"
    ).map_err(|e| e.to_string())?;
    let messages = stmt.query_map(params![session_id], |row| {
        Ok(AiChatDbMessage {
            id: row.get(0)?,
            session_id: row.get(1)?,
            role: row.get(2)?,
            content: row.get(3)?,
            created_at: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for message in messages {
        result.push(message.map_err(|e| e.to_string())?);
    }
    Ok(result)
}

#[tauri::command]
fn save_chat_message(session_id: i64, role: String, content: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    conn.execute(
        "INSERT INTO ai_chat_messages (session_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4)",
        params![session_id, role, content, now],
    ).map_err(|e| e.to_string())?;
    conn.execute(
        "UPDATE ai_chat_sessions SET updated_at = ?1 WHERE id = ?2",
        params![now, session_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_chat_session_title(session_id: i64, title: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "UPDATE ai_chat_sessions SET title = ?1 WHERE id = ?2",
        params![title, session_id],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_chat_session(session_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM ai_chat_messages WHERE session_id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM ai_chat_sessions WHERE id = ?1", params![session_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            update_note,
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
        ])
        .setup(|app| {
            let data_dir = match std::env::current_exe() {
                Ok(exe_path) => {
                    if let Some(exe_dir) = exe_path.parent() {
                        let install_data_dir = exe_dir.join("data");
                        if std::fs::create_dir_all(&install_data_dir).is_ok() {
                            install_data_dir
                        } else {
                            let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                            std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                            app_data_dir
                        }
                    } else {
                        let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                        std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                        app_data_dir
                    }
                }
                Err(_) => {
                    let app_data_dir = app.path().app_data_dir().expect("failed to get app data dir");
                    std::fs::create_dir_all(&app_data_dir).expect("failed to create app data dir");
                    app_data_dir
                }
            };
            
            let db_path = data_dir.join("fastnote.db");

            let conn = Connection::open(db_path).expect("failed to open database");
            init_database(&conn).expect("failed to initialize database");
            
            let state = AppState {
                conn: Mutex::new(conn),
            };
            
            app.manage(state);
            
            let window = app.get_webview_window("main").expect("main window not found");
            
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
                        
                        if cursor_pos.x >= x1 && cursor_pos.x <= x2 && 
                           cursor_pos.y >= y1 && cursor_pos.y <= y2 {
                            target_monitor = Some(monitor);
                            break;
                        }
                    }
                    
                    if let Some(monitor) = target_monitor {
                        let monitor_pos = monitor.position();
                        let monitor_size = monitor.size();
                        
                        let window_width = 1200.0;
                        let window_height = 800.0;
                        
                        let center_x = monitor_pos.x as f64 + (monitor_size.width as f64 / 2.0) - (window_width / 2.0);
                        let center_y = monitor_pos.y as f64 + (monitor_size.height as f64 / 2.0) - (window_height / 2.0);
                        
                        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                            x: center_x,
                            y: center_y,
                        }));
                    }
                }
            }
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
