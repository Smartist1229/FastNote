/**
 * AI 能力前端 API 层：服务商 CRUD、模型列表、对话（普通/流式）、会话与消息。
 *
 * 全部是 Tauri invoke 的薄封装：参数以 camelCase 传入，Rust 侧对应 snake_case；
 * 命令的 `Result<T, String>` 失败会以字符串 reject，本层不吞错，由调用方 toast。
 * 无缓存；只有 sendAiChatStream 会临时注册事件监听，并在 finally 中注销。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, once } from '@tauri-apps/api/event';

import type { AiChatDbMessage, AiChatMessage, AiChatSession, AiProvider } from '@/interface/ai';

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
 * 非流式对话（send_ai_chat）：Rust 拼接当前笔记上下文后请求服务商，返回完整文本。
 * maxTokens 默认 8192，Rust 侧再 clamp 到 256–32000；失败以字符串 reject。
 */
export const sendAiChat = async (
  providerId: number,
  messages: AiChatMessage[],
  noteTitle: string,
  noteContent: string,
  maxTokens = 8192,
): Promise<string> => {
  return await invoke('send_ai_chat', { providerId, messages, noteTitle, noteContent, maxTokens });
};

/**
 * 流式对话（send_ai_chat_stream），事件契约：
 *   ai-chat-chunk  { content: 累计负载（原生思维链已包进 <thinking>）,
 *                    reasoning?: 累计思维链 }
 *   ai-chat-done   { content, reasoning } 结束并 resolve 累计负载
 *   ai-chat-error  { error }              以 Error reject
 * onChunk 拿到的是累计值而非增量，可直接覆盖渲染；minThinkingLen 透传给 Rust 约束提示词。
 * 必须在 invoke 之前注册好三个监听，否则首包/结束事件可能早于监听导致 Promise 永挂；
 * 无论成功失败都在 finally 中注销。
 */
export const sendAiChatStream = async (
  providerId: number,
  messages: AiChatMessage[],
  noteTitle: string,
  noteContent: string,
  onChunk: (fullText: string, reasoning: string) => void,
  minThinkingLen = 120,
  currentNoteId: number | null = null,
  maxTokens = 8192,
): Promise<string> => {
  const unlistenChunk = await listen<{ content: string; reasoning?: string; text?: string }>('ai-chat-chunk', (event) => {
    onChunk(event.payload.content, event.payload.reasoning || "");
  });

  // 先建 Promise 并把 resolve/reject 暴露给下方的事件回调
  let resolve: (value: string) => void;
  let reject: (reason: unknown) => void;
  const resultPromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // 注册完成后再 invoke：done/error 可能瞬间到达，漏听会让 Promise 永久挂起
  const unlistenDone = await once<{ content: string; reasoning?: string }>('ai-chat-done', (event) => {
    resolve(event.payload.content);
  });
  const unlistenError = await once<{ error: string }>('ai-chat-error', (event) => {
    reject(new Error(event.payload.error));
  });

  try {
    await invoke('send_ai_chat_stream', {
      providerId,
      messages,
      noteTitle,
      noteContent,
      minThinkingLen,
      currentNoteId,
      maxTokens,
    });
    const result = await resultPromise;
    return result;
  } finally {
    unlistenChunk();
    unlistenDone();
    unlistenError();
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
