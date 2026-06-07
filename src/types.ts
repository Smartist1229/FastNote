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
  enabled_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface AiChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
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
