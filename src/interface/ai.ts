/* AI 数据模型：服务商、对话消息、会话、前置提示词与全局 AI 设置。 */

export type AiProviderType = "openai" | "google" | "claude";

export interface AiProvider {
  id: number;
  name: string;
  provider_type: AiProviderType;
  api_base_url: string;
  api_key: string;
  api_path: string | null;
  /** 当前对话使用的模型 */
  enabled_model: string | null;
  /** 设置中勾选的可用模型列表 */
  enabled_models?: string[];
  created_at: string;
  updated_at: string;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
  /** 模型原生思维链（如 DeepSeek 的 reasoning_content），回传给后端以保持上下文 */
  reasoning?: string;
}

/**
 * 用户自定义的「前置提示词 / 长期记忆」条目。
 * enabled 的条目会在每次请求里追加到系统提示词末尾（既是默认要求，也可当记忆用）。
 */
export interface AiPromptEntry {
  id: string;
  text: string;
  enabled: boolean;
}

/**
 * AI 全局设置（统一的设置窗口里编辑，本机持久化）。
 * 每一项都真实作用于请求或界面行为，不做"摆设开关"。
 */
export interface AiSettings {
  /** 深度思考最少字数：同时传给后端用于提示词约束与"思考太浅"的判定 */
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
  /** 输入框高度（像素）：0 = 自动（内容变多自动长高，上限约 320px）；大于 0 = 手动固定高度（拖上边缘设定） */
  composerHeight: number;
}

export interface AiChatSession {
  id: number;
  title: string;
  provider_id: number;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface AiChatDbMessage {
  id: number;
  session_id: number;
  role: string;
  content: string;
  created_at: string;
}

/** 从数据库读回的一整套 AI 配置（含已迁移标记） */
export interface LoadedAiConfig {
  settings: AiSettings;
  prompts: AiPromptEntry[];
  /** 是否已经把老版本的 localStorage 数据迁移进数据库 */
  migrated: boolean;
}
