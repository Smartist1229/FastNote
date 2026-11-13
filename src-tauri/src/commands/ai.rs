use crate::models::*;
use chrono::Local;
use futures_util::StreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tauri::{AppHandle, State, Emitter};
use crate::{AppState, encrypt_secret, decrypt_secret, is_encrypted};
use crate::parse_models_json;

/* ---------- 运行时：复用的 HTTP 客户端 + 请求取消 ---------- */

/// AI 请求运行时，挂在 AppState 上。
///
/// 两个职责：
/// - **复用 reqwest 客户端**：过去每次请求都 `Client::new()`，等于每次重建连接池与 TLS 会话，
///   多轮工具调用（一轮一次请求）时握手开销会叠加成肉眼可见的等待。
/// - **按 requestId 取消**：前端点"停止"过去只是不再渲染，Rust 侧的流仍在跑、仍在计费。
///   这里给每个在飞的请求挂一个 AtomicBool，流式循环每个 chunk 检查一次。
///
/// 超时策略：连接 20s（连不上要快速失败，别让用户干等），整体 600s（允许长思考 + 长回复，
/// 但没有上限的话网络吊死会永久占住一个请求）。
pub struct AiRuntime {
    pub client: reqwest::Client,
    pub cancels: StdMutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for AiRuntime {
    fn default() -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .timeout(Duration::from_secs(600))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            cancels: StdMutex::new(HashMap::new()),
        }
    }
}

impl AiRuntime {
    /// 登记一个请求并返回它自己的取消标志；同一 requestId 重复登记时会拿到新标志。
    pub fn register(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut map) = self.cancels.lock() {
            map.insert(request_id.to_string(), flag.clone());
        }
        flag
    }

    /// 请求结束（成功/失败/取消都要调）后摘掉标志，避免 map 无限增长。
    pub fn release(&self, request_id: &str) {
        if let Ok(mut map) = self.cancels.lock() {
            map.remove(request_id);
        }
    }
}

/// 前端点"停止"时调用：只置标志，不打断底层 TCP（由流式循环自己退出）。
/// 找不到 requestId 说明请求已经结束，直接忽略即可。
#[tauri::command]
pub fn cancel_ai_chat(request_id: String, state: State<AppState>) {
    if let Ok(map) = state.ai.cancels.lock() {
        if let Some(flag) = map.get(&request_id) {
            flag.store(true, Ordering::SeqCst);
        }
    }
}

/// token 用量。字段名与前端 interface 一一对应（snake_case 直传）。
///
/// 三种协议来源不同：
/// - OpenAI 兼容：最后一个 chunk 的 `usage`（需要 `stream_options.include_usage`）
/// - Google：每个 chunk 的 `usageMetadata`
/// - Claude：`message_start` 的 input_tokens + `message_delta` 的 output_tokens
///
/// 拿不到时全部为 0，前端回退到本地估算（不要让"没有 usage"变成"没有统计"）。
#[derive(Serialize, Deserialize, Default, Clone, Copy, Debug)]
pub struct AiUsage {
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    /// 命中前缀缓存的输入 token（省钱的部分，界面可单独展示）
    pub cached_tokens: u32,
}

/// 流式请求的最终结果。内容仍由事件推送，这里回传一份终态 + 用量，
/// 让 invoke 的 resolve 值可以直接用于落库与统计（不必再拼一次事件）。
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct AiStreamResult {
    pub content: String,
    pub reasoning: String,
    pub usage: AiUsage,
    /// 用户点了停止：前端据此把这一轮标记成"已停止"而不是"失败"
    pub aborted: bool,
}

/// 把累积的字节缓冲按 SSE 事件边界（`\n\n`）切开。
///
/// 必须按字节切：HTTP chunk 的边界可能落在汉字中间，此时单独解码这个 chunk 会失败
/// （旧实现用 `String::from_utf8(chunk)` 直接丢掉了整块，表现是流式输出偶发丢字）。
fn take_sse_events(buf: &mut Vec<u8>) -> Vec<String> {
    let mut events = Vec::new();
    loop {
        match buf.windows(2).position(|w| w == b"\n\n") {
            Some(pos) => {
                let event = String::from_utf8_lossy(&buf[..pos]).to_string();
                buf.drain(..pos + 2);
                events.push(event);
            }
            None => break,
        }
    }
    events
}

/// 把 messages 里的 system 消息按顺序合并成一段文本。
///
/// Gemini 与 Claude 的 system 是**独立字段**、不在 messages 里，旧实现只把前端传的
/// system 消息过滤掉、却用自己的 base_prompt 顶替，等于摘要/标题请求的提示词被静默丢弃
/// （表现是"摘要写成了一篇续写"）。这里统一合并，OpenAI 分支则保持消息原序。
fn collect_system(messages: &[AiChatMessage]) -> String {
    messages
        .iter()
        .filter(|message| message.role == "system")
        .map(|message| message.content.trim())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

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

/*
 * 深度思考要求不再由 Rust 注入。
 *
 * 过去这里有一份 DEEP_THINKING_PROMPT，前端 aiDefaults 的 AI_SYSTEM_PROMPT 与
 * buildThinkRule 又各写了一份，三处叠加的结果是：每轮请求都要额外付约 400 输入 token，
 * 而且模型被反复要求"至少写 80~120 字思考"，工具轮次里这些思考对用户没有价值，
 * 纯属白烧输出 token（8 轮工具调用能烧掉上千 token）。
 *
 * 现在唯一来源是前端 buildThinkRule（可直接受设置面板的 minThinkingLen 控制），
 * Rust 只负责把前端拼好的 system 原样送出去，不再追加任何提示词。
 */

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
                    crate::log_error!("服务商 {} 的 API Key 解密失败：{e}", provider.id);
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
                crate::log_error!("服务商 {} 的 API Key 解密失败：{e}", provider.id);
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
    // 覆盖服务商当前选中的模型：辅助模型（摘要/标题）与会话级模型都靠它指定，
    // 传空/不传时退回 provider 的 enabled_model
    model_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // 输出上限由前端设置传入。以前这里写死 2048（Claude 非流式），长回答必被截断。
    let max_tokens = max_tokens.unwrap_or(8192).clamp(256, 32000);
    let provider = get_ai_provider(provider_id, &state)?;
    let model = match model_override.filter(|model| !model.trim().is_empty()) {
        Some(model) => model,
        None => selected_model(&provider)?,
    };
    // 复用全局客户端：不再每次请求重建连接池
    let client = state.ai.client.clone();
    /*
     * 非流式只服务摘要、标题、打标这类辅助任务：它们的 system 已经由前端放在 messages 里。
     * 过去这里无条件再插一条 "You are FastNote's note assistant + 当前笔记正文"，
     * 于是每次摘要请求都带两份 system（其中一份还是空笔记占位），纯属浪费。
     * 现在只有调用方一个 system 都没给时才兜底，且不再追加深度思考提示词。
     */
    let has_system = messages.iter().any(|message| message.role == "system");
    let base_prompt = if has_system {
        String::new()
    } else {
        format!(
            "You are FastNote's built-in note assistant. Current note title: {}.\nYou help the user polish, continue, summarize, rewrite, or generate content that can be inserted into the note. When the note needs to be modified, output ready-to-use body text directly; never make up information that does not exist.\nCurrent note content:\n{}",
            note_title, note_content
        )
    };

    let response = match provider.provider_type.as_str() {
        "openai" => {
            let url = join_url(&provider.api_base_url, &openai_chat_path(&provider));
            let mut api_messages: Vec<Value> = Vec::new();
            if !base_prompt.is_empty() {
                api_messages.push(json!({ "role": "system", "content": base_prompt }));
            }
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
            // Gemini 的 system 是独立字段：把前端给的 system 与兜底提示词合并后送进去，
            // 否则摘要/标题请求的提示词会被 filter 掉，模型完全不知道自己要干什么。
            let system_text: Vec<String> = vec![base_prompt.clone(), collect_system(&messages)]
                .into_iter()
                .filter(|text| !text.trim().is_empty())
                .collect();
            let mut body = json!({
                "contents": contents,
                "generationConfig": { "maxOutputTokens": max_tokens }
            });
            if !system_text.is_empty() {
                body["systemInstruction"] = json!({
                    "parts": [{ "text": system_text.join("\n\n") }]
                });
            }
            client
                .post(url)
                .query(&[("key", provider.api_key.trim())])
                .json(&body)
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
            let system_text: Vec<String> = vec![base_prompt.clone(), collect_system(&messages)]
                .into_iter()
                .filter(|text| !text.trim().is_empty())
                .collect();
            let mut body = json!({
                "model": model,
                "max_tokens": max_tokens,
                "messages": api_messages
            });
            if !system_text.is_empty() {
                body["system"] = json!(system_text.join("\n\n"));
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

/// 请求结束时自动注销取消标志：无论成功、失败还是提前 return，都不会在 map 里留垃圾。
struct RequestGuard<'a> {
    runtime: &'a AiRuntime,
    request_id: String,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.runtime.release(&self.request_id);
    }
}

/// 从任意一种协议的 SSE 事件里吸收 token 用量（找到就覆盖，找不到就保持原值）。
///
/// 不追求精确：流式协议里 usage 出现的位置各家不同——OpenAI 在最后一个 chunk 的顶层，
/// Claude 在 `message_start.message.usage`（输入）与 `message_delta.usage`（输出）两处，
/// Gemini 每个 chunk 的 `usageMetadata` 都带一份累计值。只要字段名存在就更新即可。
fn absorb_usage(event: &str, usage: &mut AiUsage) {
    for line in event.lines() {
        let data = match line.strip_prefix("data: ") {
            Some(data) => data,
            None => continue,
        };
        if data.trim() == "[DONE]" {
            continue;
        }
        let value: Value = match serde_json::from_str(data) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let mut apply = |u: &Value| {
            if let Some(v) = u.get("prompt_tokens").and_then(|v| v.as_u64()) {
                usage.prompt_tokens = v as u32;
            }
            if let Some(v) = u.get("input_tokens").and_then(|v| v.as_u64()) {
                usage.prompt_tokens = v as u32;
            }
            if let Some(v) = u.get("completion_tokens").and_then(|v| v.as_u64()) {
                usage.completion_tokens = v as u32;
            }
            // Claude 的 message_delta 里 output_tokens 是"到目前为止"的累计值
            if let Some(v) = u.get("output_tokens").and_then(|v| v.as_u64()) {
                usage.completion_tokens = v as u32;
            }
            if let Some(v) = u
                .pointer("/prompt_tokens_details/cached_tokens")
                .and_then(|v| v.as_u64())
            {
                usage.cached_tokens = v as u32;
            }
            if let Some(v) = u.get("cache_read_input_tokens").and_then(|v| v.as_u64()) {
                usage.cached_tokens = v as u32;
            }
            if let Some(v) = u.get("promptTokenCount").and_then(|v| v.as_u64()) {
                usage.prompt_tokens = v as u32;
            }
            if let Some(v) = u.get("candidatesTokenCount").and_then(|v| v.as_u64()) {
                usage.completion_tokens = v as u32;
            }
            if let Some(v) = u.get("cachedContentTokenCount").and_then(|v| v.as_u64()) {
                usage.cached_tokens = v as u32;
            }
            if let Some(v) = u.get("total_tokens").and_then(|v| v.as_u64()) {
                usage.total_tokens = v as u32;
            }
            if let Some(v) = u.get("totalTokenCount").and_then(|v| v.as_u64()) {
                usage.total_tokens = v as u32;
            }
        };
        if let Some(u) = value.get("usage") {
            apply(u);
        }
        // Claude：输入 token 只在 message_start 里出现一次
        if let Some(u) = value.pointer("/message/usage") {
            apply(u);
        }
        if let Some(u) = value.get("usageMetadata") {
            apply(u);
        }
    }
    if usage.total_tokens == 0 && (usage.prompt_tokens > 0 || usage.completion_tokens > 0) {
        usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    }
}

/// 流式对话。事件契约（每个请求独立命名，天然隔离，不存在两个会话串台）：
///   `ai-chat-chunk-{requestId}`  { text?: 增量正文, reasoning?: 增量思维链 }
/// 结束由 invoke 的返回值 `AiStreamResult` 承载（含完整正文、完整思维链、用量、是否被取消）；
/// 失败以 Err 返回。不再发 done / error 事件——两条通道传同一件事只会让前端重复处理。
///
/// `system_stable` 是永不变化的部分（角色 + 工具协议），`system_dynamic` 是每轮都可能变的
/// 部分（当前笔记、记忆、访问限制）。这样拆开才能命中服务商的前缀缓存。
#[tauri::command]
pub async fn send_ai_chat_stream(
    app_handle: AppHandle,
    provider_id: i64,
    messages: Vec<AiChatMessage>,
    note_title: String,
    note_content: String,
    current_note_id: Option<String>,
    max_tokens: Option<u32>,
    request_id: Option<String>,
    system_stable: Option<String>,
    system_dynamic: Option<String>,
    model_override: Option<String>,
    state: State<'_, AppState>,
) -> Result<AiStreamResult, String> {
    // 输出上限由前端设置传入；OpenAI 兼容分支以前**完全没发 max_tokens**，
    // 于是走服务商默认值（常见 2048~4096），长回答/长工具参数一到头就被砍断。
    let max_tokens = max_tokens.unwrap_or(8192).clamp(256, 32000);
    let provider = get_ai_provider(provider_id, &state)?;
    let model = match model_override.filter(|model| !model.trim().is_empty()) {
        Some(model) => model,
        None => selected_model(&provider)?,
    };
    // 复用全局客户端：多轮工具调用时不再每轮重建连接池
    let client = state.ai.client.clone();
    let request_id = request_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| format!("ai-{}", Local::now().timestamp_micros()));
    let cancel_flag = state.ai.register(&request_id);
    let _guard = RequestGuard {
        runtime: &state.ai,
        request_id: request_id.clone(),
    };
    let chunk_event = format!("ai-chat-chunk-{}", request_id);

    // 单独给出当前笔记 ID：同名笔记无法靠标题区分，只有 ID 唯一
    let note_id_line = match current_note_id {
        Some(id) if !id.is_empty() => format!(
            "- ID of the currently open note: {} (when the user says \"this note / the current note / it\", this is the ID they mean)",
            id
        ),
        _ => "- No note is currently open (if the user refers to \"this note\", first point out which one)".to_string(),
    };
    // 前端没拆分时（旧调用方）退回旧形态：全部当稳定段，功能不受影响，只是缓存命中不了
    let stable_prompt = match system_stable.filter(|text| !text.trim().is_empty()) {
        Some(text) => text,
        None => format!(
            "You are FastNote's built-in note assistant.\n\n## Current context\n{}\n- Current note title: {}\n\nYou help the user polish, continue, summarize, rewrite, or generate content that can be inserted into the note. When the note needs to be modified, output ready-to-use body text directly; never make up information that does not exist.\n\nCurrent note content:\n{}",
            note_id_line, note_title, note_content
        ),
    };
    let dynamic_prompt = system_dynamic.unwrap_or_default();
    let full_system = if dynamic_prompt.trim().is_empty() {
        stable_prompt.clone()
    } else {
        format!("{}\n\n{}", stable_prompt, dynamic_prompt)
    };

    let response = match provider.provider_type.as_str() {
        "openai" => {
            let url = join_url(&provider.api_base_url, &openai_chat_path(&provider));
            let mut api_messages = vec![json!({ "role": "system", "content": full_system })];
            // 对话历史按原序追加：工具结果、摘要、纠错提示都是 system，位置有意义，不能挪到头部
            api_messages.extend(messages.iter().map(|message| {
                json!({ "role": message.role, "content": message.content })
            }));
            // 推理模型走 reasoning_effort，其余模型依靠提示词约束
            let mut body = json!({
                "model": model.clone(),
                "messages": api_messages,
                "max_tokens": max_tokens,
                "stream": true,
                // 让服务商在最后一个 chunk 回传真实用量（拿不到时前端回退本地估算）
                "stream_options": { "include_usage": true }
            });
            if supports_reasoning_effort(&model) {
                body["reasoning_effort"] = json!("high");
            } else {
                body["temperature"] = json!(0.7);
            }
            let first = client
                .post(&url)
                .bearer_auth(provider.api_key.trim())
                .json(&body)
                .send()
                .await;
            // 少数网关不认识 stream_options 会直接 400。这类错误与内容无关，
            // 去掉该字段重试一次即可，不必让用户自己去改服务商。
            match first {
                Ok(resp) if resp.status().is_client_error() => {
                    let status = resp.status();
                    let text = resp.text().await.unwrap_or_default();
                    if text.contains("stream_options") || text.contains("include_usage") {
                        body.as_object_mut().map(|obj| obj.remove("stream_options"));
                        client
                            .post(&url)
                            .bearer_auth(provider.api_key.trim())
                            .json(&body)
                            .send()
                            .await
                    } else {
                        return Err(format!("AI 请求失败：{} {}", status, text));
                    }
                }
                other => other,
            }
        }
        "google" => {
            let url = join_url(
                &provider.api_base_url,
                &format!("/models/{}:streamGenerateContent", model.trim_start_matches("models/")),
            );
            // system 消息（工具结果等）在 Gemini 里没有独立角色，映射成 user 而不是丢弃：
            // 丢掉的话模型看不到任何工具执行结果，工具循环在 Gemini 上会直接"失忆"。
            let contents = messages
                .iter()
                .map(|message| {
                    let role = if message.role == "assistant" { "model" } else { "user" };
                    json!({
                        "role": role,
                        "parts": [{ "text": message.content }]
                    })
                })
                .collect::<Vec<_>>();
            let mut generation_config = json!({ "maxOutputTokens": max_tokens });
            if let Some(thinking) = google_thinking_config(true).get("thinkingConfig") {
                generation_config["thinkingConfig"] = thinking.clone();
            }
            client
                .post(url)
                .query(&[("key", provider.api_key.trim())])
                .json(&json!({
                    "systemInstruction": { "parts": [{ "text": full_system }] },
                    "contents": contents,
                    "generationConfig": generation_config
                }))
                .send()
                .await
        }
        "claude" => {
            let url = join_url(&provider.api_base_url, "/v1/messages");
            let api_messages = messages
                .iter()
                .map(|message| {
                    json!({
                        "role": if message.role == "assistant" { "assistant" } else { "user" },
                        "content": message.content
                    })
                })
                .collect::<Vec<_>>();
            /*
             * Claude 的前缀缓存要显式打点：把稳定段标成 cache_control 断点，
             * 后续轮次只要能命中就能把这段输入按约 10% 计价。
             * 官方要求断点前的 prompt 至少有 1024 token，太短会被忽略（不报错），
             * 所以只在稳定段确实够长时才加，避免有的代理把它当非法字段拒掉。
             */
            let mut system_blocks: Vec<Value> = Vec::new();
            if !stable_prompt.trim().is_empty() {
                let mut block = json!({ "type": "text", "text": stable_prompt });
                if stable_prompt.chars().count() >= 2048 {
                    block["cache_control"] = json!({ "type": "ephemeral" });
                }
                system_blocks.push(block);
            }
            if !dynamic_prompt.trim().is_empty() {
                system_blocks.push(json!({ "type": "text", "text": dynamic_prompt }));
            }
            let mut body = json!({
                "model": model.clone(),
                "max_tokens": max_tokens,
                "system": system_blocks,
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
    }
    .map_err(|e| e.to_string())?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        return Err(format!("AI 请求失败：{} {}", status, body));
    }

    let mut full_text = String::new();
    let mut full_reasoning = String::new();
    // 按字节累积：chunk 边界可能切在汉字中间，先拼字节、按事件边界切开再解码
    let mut pending: Vec<u8> = Vec::new();
    let mut usage = AiUsage::default();
    let mut stream = response.bytes_stream();

    loop {
        if cancel_flag.load(Ordering::SeqCst) {
            return Ok(AiStreamResult {
                content: derive_stream_payload(&full_reasoning, &full_text),
                reasoning: full_reasoning,
                usage,
                aborted: true,
            });
        }
        /*
         * 500ms 心跳取一次数据。
         * 不能直接 `while let Some(chunk) = stream.next().await`：模型思考期间可能几十秒
         * 一个字节都不发，只在收到 chunk 后才检查取消标志的话，用户点"停止"要等到模型
         * 开口才生效——这段时间的 token 照样计费。超时分支回来重查一次标志即可。
         */
        let next = match tokio::time::timeout(Duration::from_millis(500), stream.next()).await {
            Err(_elapsed) => continue,
            Ok(None) => break,
            Ok(Some(chunk)) => chunk,
        };
        let chunk = next.map_err(|e| e.to_string())?;
        pending.extend_from_slice(&chunk);
        for event in take_sse_events(&mut pending) {
            if event.trim().is_empty() {
                continue;
            }
            absorb_usage(&event, &mut usage);
            let (delta_text, delta_reasoning) = parse_sse_event(&event);
            if delta_text.is_none() && delta_reasoning.is_none() {
                continue;
            }
            if let Some(text) = &delta_text {
                full_text.push_str(text);
            }
            if let Some(reasoning) = &delta_reasoning {
                full_reasoning.push_str(reasoning);
            }
            // 只推增量：过去每个 chunk 都发完整累计文本（content 与 text 还各发一份），
            // 长回复的总传输量是平方级的，前端每个 chunk 还要重新 diff 整段 Markdown。
            let _ = app_handle.emit(
                &chunk_event,
                json!({ "text": delta_text, "reasoning": delta_reasoning }),
            );
        }
    }

    // 收尾：缓冲区里可能还剩一个没以 \n\n 结尾的事件
    if !pending.is_empty() {
        let tail = String::from_utf8_lossy(&pending).to_string();
        absorb_usage(&tail, &mut usage);
        let (delta_text, delta_reasoning) = parse_sse_event(&tail);
        if let Some(text) = delta_text {
            full_text.push_str(&text);
        }
        if let Some(reasoning) = delta_reasoning {
            full_reasoning.push_str(&reasoning);
        }
    }

    if full_text.is_empty() && full_reasoning.is_empty() {
        return Err("没有从 AI 响应中解析到文本内容".to_string());
    }

    Ok(AiStreamResult {
        content: derive_stream_payload(&full_reasoning, &full_text),
        reasoning: full_reasoning,
        usage,
        aborted: false,
    })
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
