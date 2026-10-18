/**
 * AI 层数据契约。
 *
 * 字段名一律沿用后端的 snake_case（不做驼峰转换），来源分三类：
 * - 数据库行：ai_providers / ai_chat_sessions / ai_chat_messages 三张表；
 * - Tauri 命令载荷：如 send_ai_chat 的 messages、currentNoteId、maxTokens；
 * - app_settings 里的配置：ai.setting.<字段> 单值、ai.prompts 记忆数组。
 *
 * id 与时间戳由 Rust 侧生成，前端只读；改动字段名等于改契约，需同步 lib.rs。
 */

/** 服务商协议风格：决定请求体格式、鉴权头与该类型的默认接口路径 */
export type AiProviderType = "openai" | "google" | "claude";

/** ai_providers 表的一行（增删改分别走 create/update/delete_ai_provider） */
export interface AiProvider {
  id: number;
  name: string;
  provider_type: AiProviderType;
  /** 服务根地址，不含接口路径，如 https://api.openai.com */
  api_base_url: string;
  api_key: string;
  /** 自定义接口路径；null = 由后端按 provider_type 取默认路径 */
  api_path: string | null;
  /** 当前对话使用的模型（聊天面板下拉的当前值），null = 尚未选模型 */
  enabled_model: string | null;
  /** 设置里勾选的可用模型列表（库里是 JSON 列，后端读出即成数组）；可选标记为历史兼容 */
  enabled_models?: string[];
  created_at: string;
  updated_at: string;
}

/** 单条对话消息：send_ai_chat / send_ai_chat_stream 的 messages 元素 */
export interface AiChatMessage {
  /** user / assistant = 用户与模型发言；system = 系统提示词、工具结果、上下文摘要 */
  role: "user" | "assistant" | "system";
  content: string;
  /** 模型原生思维链（如 DeepSeek 的 reasoning_content），回传给后端以保持上下文 */
  reasoning?: string;
}

/**
 * 用户自定义的「前置提示词 / 长期记忆」条目，整组以 JSON 数组存于 ai.prompts。
 * enabled 的条目追加到系统提示词末尾（既是默认要求，也可当记忆用）。
 */
export interface AiPromptEntry {
  id: string;
  text: string;
  enabled: boolean;
}

/**
 * AI 全局设置：逐字段存于 app_settings（键 ai.setting.<字段>，值为 JSON 文本）。
 * 读取时经 normalizeAiSettings 逐项校验并收敛边界，写入时整个对象回写。
 */
export interface AiSettings {
  /** 深度思考最少字数：既拼进提示词，也作为"思考太浅"的判定门槛 */
  minThinkingLen: number;
  /** 单次提问最多跑多少轮工具调用；0 = 不限制（仅保留死循环保险） */
  maxRounds: number;
  /** 历史上下文预算（token）：超出就把更早的对话压成摘要 */
  contextBudget: number;
  /** 无论如何都完整保留的最近消息条数 */
  keepRecent: number;
  /** 每个工具结果注入上下文的最大字数 */
  toolResultChars: number;
  /** 思考过浅时是否要求模型重来一次 */
  retryShallowThinking: boolean;
  /** 是否自动根据首轮对话生成会话标题 */
  autoTitle: boolean;
  /** 是否使用流式输出（关闭后等待完整回复一次性显示） */
  streaming: boolean;
  /** 默认开启"工具执行前确认"（面板里可临时切换） */
  confirmByDefault: boolean;
  /** 是否在回复里附上工具执行轨迹 */
  showToolTrace: boolean;
  /** 单次回复的最大输出长度（token）：太小会频繁出现「回复被截断」 */
  maxTokens: number;
  /**
   * AI 访问的总开关（默认 true）。
   * 关闭后 AI 完全看不到笔记内容：当前笔记上下文置空，所有笔记/分组工具直接返回无权限，
   * 但对话本身仍可用（当作普通聊天）。分组级、笔记级开关在此基础上进一步限制。
   */
  aiAccessEnabled: boolean;
  /**
   * 输入框高度（px）：0 = 自动（44px 起随内容长高，上限 min(320, 面板可用高度 45%)）；
   * > 0 = 手动固定（拖上边缘设定，双击恢复自动）。
   */
  composerHeight: number;
}

/** ai_chat_sessions 表的一行；provider_id / model 记录该会话创建时选定的服务商与模型 */
export interface AiChatSession {
  id: number;
  title: string;
  provider_id: number;
  model: string;
  created_at: string;
  updated_at: string;
}

/** ai_chat_messages 表的一行；role 在库里是裸字符串，读出后按 AiChatMessage 的联合类型使用 */
export interface AiChatDbMessage {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: string;
}

/** loadAiConfig 的返回值：已归一化的设置、记忆列表，以及是否完成过 localStorage 迁移 */
export interface LoadedAiConfig {
  settings: AiSettings;
  prompts: AiPromptEntry[];
  /** 老版本 localStorage 数据是否已迁移进数据库 */
  migrated: boolean;
}
