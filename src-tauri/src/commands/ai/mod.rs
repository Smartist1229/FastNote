//! AI 对话：服务商配置、流式请求、会话与消息。
//!
//! - `provider`：服务商的增删改查与模型选择
//! - `stream`：SSE 解析、请求发送、用量统计与取消
//! - `session`：会话与消息的落库
//! - `util`：URL 拼装、响应字段提取、思考模式判定
//! - `mod`：运行时状态与请求取消入口

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


mod util;
mod provider;
mod stream;
mod session;

pub(crate) use util::*;
pub(crate) use provider::*;
pub(crate) use stream::*;
pub(crate) use session::*;
