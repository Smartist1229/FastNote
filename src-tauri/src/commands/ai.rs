use crate::models::*;
use chrono::Local;
use futures_util::StreamExt;
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{AppHandle, State, Emitter};
use crate::{AppState, encrypt_secret, decrypt_secret, is_encrypted};
use crate::parse_models_json;

pub(crate) fn map_row_to_ai_provider(row: &rusqlite::Row) -> Result<AiProvider, rusqlite::Error> {
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

pub(crate) fn join_url(base: &str, path: &str) -> String {
    let base = base.trim().trim_end_matches('/');
    let path = path.trim();
    if path.starts_with("http://") || path.starts_with("https://") {
        path.to_string()
    } else {
        format!("{}/{}", base, path.trim_start_matches('/'))
    }
}

pub(crate) fn openai_chat_path(provider: &AiProvider) -> String {
    provider
        .api_path
        .clone()
        .filter(|path| !path.trim().is_empty())
        .unwrap_or_else(|| "/v1/chat/completions".to_string())
}

pub(crate) fn openai_models_url(provider: &AiProvider) -> String {
    let chat_path = openai_chat_path(provider);
    let model_path = if chat_path.contains("/chat/completions") {
        chat_path.replace("/chat/completions", "/models")
    } else {
        "/v1/models".to_string()
    };
    join_url(&provider.api_base_url, &model_path)
}

pub(crate) fn extract_text(value: &Value, paths: &[&[&str]]) -> Option<String> {
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

pub(crate) fn selected_model(provider: &AiProvider) -> Result<String, String> {
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
pub(crate) fn is_deepseek_reasoner(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("deepseek-reasoner") || m.contains("deepseek-r1")
}

/// 判断模型是否支持 OpenAI 的 reasoning_effort 参数
pub(crate) fn supports_reasoning_effort(model: &str) -> bool {
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
pub(crate) fn supports_extended_thinking(model: &str) -> bool {
    let m = model.to_lowercase();
    m.contains("3-7") || m.contains("sonnet-4") || m.contains("opus-4") || m.contains("thinking")
}

#[tauri::command]
pub fn create_ai_provider(
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
pub fn get_ai_providers(state: State<AppState>) -> Result<Vec<AiProvider>, String> {
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
pub fn update_ai_provider(provider: AiProvider, state: State<AppState>) -> Result<(), String> {
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
pub fn delete_ai_provider(id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute("DELETE FROM ai_providers WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn get_ai_provider(id: i64, state: &State<AppState>) -> Result<AiProvider, String> {
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

#[tauri::command]
pub async fn fetch_ai_models(provider: AiProvider) -> Result<Vec<String>, String> {
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
pub async fn send_ai_chat(
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
pub(crate) fn google_thinking_config(include_thoughts: bool) -> Value {
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
pub(crate) fn parse_sse_event(event: &str) -> (Option<String>, Option<String>) {
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
pub async fn send_ai_chat_stream(
    app_handle: AppHandle,
    provider_id: i64,
    messages: Vec<AiChatMessage>,
    note_title: String,
    note_content: String,
    min_thinking_len: Option<usize>,
    current_note_id: Option<String>,
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
        Some(id) if !id.is_empty() => format!(
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
pub(crate) fn derive_stream_payload(reasoning: &str, text: &str) -> String {
    if reasoning.trim().is_empty() {
        return text.to_string();
    }
    if text.is_empty() {
        return format!("<thinking>{}</thinking>", reasoning);
    }
    format!("<thinking>{}</thinking>\n{}", reasoning, text)
}

#[tauri::command]
pub fn create_chat_session(
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
pub fn get_chat_sessions(state: State<AppState>) -> Result<Vec<AiChatSession>, String> {
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
pub fn get_chat_messages(
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
pub fn save_chat_message(
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
pub fn update_chat_session_title(
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
pub fn delete_chat_session(session_id: i64, state: State<AppState>) -> Result<(), String> {
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
