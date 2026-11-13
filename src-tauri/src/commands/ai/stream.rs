use super::*;

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

/// 请求结束时自动注销取消标志：无论成功、失败还是提前 return，都不会在 map 里留垃圾。
pub(crate) struct RequestGuard<'a> {
    pub(crate) runtime: &'a AiRuntime,
    pub(crate) request_id: String,
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
pub(crate) fn absorb_usage(event: &str, usage: &mut AiUsage) {
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

