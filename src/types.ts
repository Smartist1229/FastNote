export interface Note {
  id: number;
  title: string;
  content: string;
  category_id: number | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
}

export interface Category {
  id: number;
  name: string;
  created_at: string;
  note_count: number;
}

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

export const DEFAULT_AI_SETTINGS: AiSettings = {
  minThinkingLen: 120,
  maxRounds: 0,
  contextBudget: 14000,
  keepRecent: 8,
  toolResultChars: 1500,
  retryShallowThinking: true,
  autoTitle: true,
  streaming: true,
  confirmByDefault: true,
  showToolTrace: true,
  maxTokens: 8192,
  composerHeight: 0,
};

/**
 * 逐项把"数据库里的值"归一化成合法设置：
 * 类型不对 / 缺键 → 用默认值；数值再做边界收敛，脏数据也不会让行为异常。
 */
export const normalizeAiSettings = (raw: Record<string, unknown> | null | undefined): AiSettings => {
  const merged: AiSettings = { ...DEFAULT_AI_SETTINGS };
  for (const key of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    const value = (raw || {})[key];
    if (typeof value === typeof DEFAULT_AI_SETTINGS[key]) {
      // @ts-expect-error 上面已按字段类型逐项校验
      merged[key] = value;
    }
  }
  merged.minThinkingLen = Math.min(1000, Math.max(0, Math.round(merged.minThinkingLen)));
  merged.maxRounds = Math.min(200, Math.max(0, Math.round(merged.maxRounds)));
  merged.contextBudget = Math.min(200000, Math.max(2000, Math.round(merged.contextBudget)));
  merged.keepRecent = Math.min(50, Math.max(2, Math.round(merged.keepRecent)));
  merged.toolResultChars = Math.min(20000, Math.max(200, Math.round(merged.toolResultChars)));
  merged.composerHeight = Math.min(1200, Math.max(0, Math.round(merged.composerHeight)));
  merged.maxTokens = Math.min(32000, Math.max(256, Math.round(merged.maxTokens)));
  return merged;
};

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
