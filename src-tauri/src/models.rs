use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Note {
    /// 随机 UUID v4（TEXT 主键）。历史库里的加密笔记可能仍是旧数字 id 的字符串形式。
    pub id: String,
    pub title: String,
    pub content: String,
    /// 分组 id（TEXT 短随机串；旧数据里可能是数字 id 的字符串形式）
    pub category_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub is_deleted: bool,
    pub deleted_at: Option<String>,
    pub is_pinned: bool,
    /// AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
    /// 笔记与所属分组各存一档，生效值取更严格的那个（见前端 lib/aiAccess.ts）。
    pub ai_access: i64,
    /// 0 = 未加密；1 = 单篇密码；2 = 随所属分组加密。
    pub enc_mode: i64,
    /// 锁定态：内容已清空，前端显示占位标题。
    pub is_locked: bool,
    /// 用户设置的密码提示（明文），锁定时可用于提示。
    pub enc_hint: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Category {
    /// 短随机字符串（TEXT 主键）。已加密分组保留旧数字 id 的字符串形式。
    pub id: String,
    pub name: String,
    pub created_at: String,
    pub note_count: i32,
    /// AI 访问档位（0=禁止 / 1=只读 / 2=完全），作为组内笔记的上限
    pub ai_access: i64,
    pub is_encrypted: bool,
    pub is_locked: bool,
    pub enc_hint: Option<String>,
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
