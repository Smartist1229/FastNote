/**
 * AI 能力前端 API 层：服务商 CRUD、模型列表、对话（普通/流式）、会话与消息。
 *
 * 全部是 Tauri invoke 的薄封装：参数以 camelCase 传入，Rust 侧对应 snake_case；
 * 命令的 `Result<T, String>` 失败会以字符串 reject，本层不吞错，由调用方 toast。
 * 无缓存；只有 sendAiChatStream 会临时注册事件监听，并在 finally 中注销。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

import type { AiChatDbMessage, AiChatMessage, AiChatSession, AiProvider } from '@/interface/ai/ai';

/**
 * 新建服务商（create_ai_provider），返回含 id 的记录。
 * enabledModels 会去空去重，列表第一项自动成为当前模型。
 * 返回值的非空 api_key 是落库密文；需要明文请重新调用 getAiProviders。
 */
export const createAiProvider = async (
  name: string,
  providerType: AiProvider['provider_type'],
  apiBaseUrl: string,
  apiKey: string,
  apiPath: string | null,
  enabledModels: string[] = [],
): Promise<AiProvider> => {
  return await invoke('create_ai_provider', {
    name,
    providerType,
    apiBaseUrl,
    apiKey,
    apiPath,
    enabledModels,
  });
};

/** 读取全部服务商（get_ai_providers），按 updated_at 倒序，api_key 已由 Rust 解密为明文 */
export const getAiProviders = async (): Promise<AiProvider[]> => {
  return await invoke('get_ai_providers');
};

/** 整条更新服务商（update_ai_provider）；api_key 若为明文，Rust 侧会重新加密后入库 */
export const updateAiProvider = async (provider: AiProvider): Promise<void> => {
  return await invoke('update_ai_provider', { provider });
};

/** 删除服务商（delete_ai_provider），返回 void */
export const deleteAiProvider = async (id: number): Promise<void> => {
  return await invoke('delete_ai_provider', { id });
};

/** 用给定服务商的 base_url/api_key 现场拉取模型列表（fetch_ai_models）；不写库、不缓存 */
export const fetchAiModels = async (provider: AiProvider): Promise<string[]> => {
  return await invoke('fetch_ai_models', { provider });
};

/**
 * 非流式对话（send_ai_chat）：Rust 请求服务商，返回完整文本。
 * 只用于摘要、标题这类辅助任务；主对话请用 sendAiChatStream（才有流式与用量）。
 * modelOverride 可临时指定模型（辅助模型走便宜档），不传则用服务商当前选中的模型。
 * maxTokens 默认 8192，Rust 侧再 clamp 到 256–32000；失败以字符串 reject。
 */
export const sendAiChat = async (
  providerId: number,
  messages: AiChatMessage[],
  noteTitle: string,
  noteContent: string,
  maxTokens = 8192,
  modelOverride?: string,
): Promise<string> => {
  return await invoke('send_ai_chat', {
    providerId,
    messages,
    noteTitle,
    noteContent,
    maxTokens,
    modelOverride: modelOverride ?? null,
  });
};

/** 一次请求的 token 用量；拿不到时各字段为 0，调用方回退到本地估算 */
export interface AiUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  /** 命中前缀缓存的输入 token（真正省钱的那部分） */
  cached_tokens: number;
}

/** 流式请求的最终结果：内容以它为准（增量事件只用于实时预览） */
export interface AiStreamResult {
  content: string;
  reasoning: string;
  usage: AiUsage;
  /** 用户点了停止（Rust 侧主动断流），不是失败 */
  aborted: boolean;
}

export interface SendAiChatStreamOptions {
  providerId: number;
  /** 对话历史，不含系统提示词（由 systemStable / systemDynamic 单独给） */
  messages: AiChatMessage[];
  /**
   * 永不变化的系统提示词（角色 + 工具协议）。放在最前面且内容稳定，
   * 服务商的前缀缓存才能命中；Claude 侧还会在它之后打 cache_control 断点。
   */
  systemStable: string;
  /** 每轮都可能变的系统提示词（当前笔记、记忆、访问限制），追加在稳定段之后 */
  systemDynamic?: string;
  noteTitle?: string;
  noteContent?: string;
  currentNoteId?: string | null;
  maxTokens?: number;
  modelOverride?: string;
  /** 取消信号：abort 时通知 Rust 真正断流（否则只是不渲染，token 照烧） */
  signal?: AbortSignal;
}

/**
 * 流式对话（send_ai_chat_stream）。
 *
 * 事件契约（每个请求一个独立事件名，多窗口/多会话天然隔离、不会串台）：
 *   `ai-chat-chunk-{requestId}`  { text?: 增量正文, reasoning?: 增量思维链 }
 * 结束由 invoke 的返回值承载（含完整内容与用量），失败以 Error reject。
 * onDelta 拿到的是**增量**，调用方自己累积；最终请以返回值的 content 为准
 * （事件是异步投递的，最后几个 chunk 可能在 resolve 之后才到）。
 */
export const sendAiChatStream = async (
  options: SendAiChatStreamOptions,
  onDelta: (text: string, reasoning: string) => void,
): Promise<AiStreamResult> => {
  const requestId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const eventName = `ai-chat-chunk-${requestId}`;

  const unlisten = await listen<{ text?: string; reasoning?: string }>(eventName, (event) => {
    onDelta(event.payload.text || '', event.payload.reasoning || '');
  });

  // 取消必须真正通知后端：只把前端中断言置位的话，Rust 侧的流会继续跑到模型说完为止
  const abortHandler = () => {
    void invoke('cancel_ai_chat', { requestId }).catch(() => {});
  };
  options.signal?.addEventListener('abort', abortHandler, { once: true });

  try {
    // 监听注册完成后再 invoke：首包/结束可能瞬间到达，漏听会让内容凭空缺失
    return await invoke<AiStreamResult>('send_ai_chat_stream', {
      providerId: options.providerId,
      messages: options.messages,
      noteTitle: options.noteTitle ?? '',
      noteContent: options.noteContent ?? '',
      currentNoteId: options.currentNoteId ?? null,
      maxTokens: options.maxTokens ?? 8192,
      requestId,
      systemStable: options.systemStable,
      systemDynamic: options.systemDynamic ?? '',
      modelOverride: options.modelOverride ?? null,
    });
  } finally {
    options.signal?.removeEventListener('abort', abortHandler);
    unlisten();
  }
};

/** 新建会话（create_chat_session），返回含 id 的记录；model 决定后续请求使用的模型 */
export const createChatSession = async (title: string, providerId: number, model: string): Promise<AiChatSession> => {
  return await invoke('create_chat_session', { title, providerId, model });
};

/** 读取会话列表（get_chat_sessions），按 updated_at 倒序 */
export const getChatSessions = async (): Promise<AiChatSession[]> => {
  return await invoke('get_chat_sessions');
};

/** 读取某会话的全部消息（get_chat_messages），按 id 正序，即时间正序 */
export const getChatMessages = async (sessionId: number): Promise<AiChatDbMessage[]> => {
  return await invoke('get_chat_messages', { sessionId });
};

/** 追加一条消息（save_chat_message），同时刷新会话 updated_at；不返回新消息 id */
export const saveChatMessage = async (sessionId: number, role: string, content: string): Promise<void> => {
  return await invoke('save_chat_message', { sessionId, role, content });
};

/** 只改会话标题（update_chat_session_title），不触碰消息 */
export const updateChatSessionTitle = async (sessionId: number, title: string): Promise<void> => {
  return await invoke('update_chat_session_title', { sessionId, title });
};

/** 删除会话及其全部消息（delete_chat_session 内两条 DELETE），不可恢复 */
export const deleteChatSession = async (sessionId: number): Promise<void> => {
  return await invoke('delete_chat_session', { sessionId });
};
