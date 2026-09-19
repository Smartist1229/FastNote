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
