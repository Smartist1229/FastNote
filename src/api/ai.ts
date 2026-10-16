/* AI 相关后端调用：服务商、对话发送、会话与消息。 */

import { invoke } from '@tauri-apps/api/core';
import { listen, once } from '@tauri-apps/api/event';

import type { AiChatDbMessage, AiChatMessage, AiChatSession, AiProvider } from '@/interface/ai';

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

export const getAiProviders = async (): Promise<AiProvider[]> => {
  return await invoke('get_ai_providers');
};

export const updateAiProvider = async (provider: AiProvider): Promise<void> => {
  return await invoke('update_ai_provider', { provider });
};

export const deleteAiProvider = async (id: number): Promise<void> => {
  return await invoke('delete_ai_provider', { id });
};

export const fetchAiModels = async (provider: AiProvider): Promise<string[]> => {
  return await invoke('fetch_ai_models', { provider });
};

export const sendAiChat = async (
  providerId: number,
  messages: AiChatMessage[],
  noteTitle: string,
  noteContent: string,
  maxTokens = 8192,
): Promise<string> => {
  return await invoke('send_ai_chat', { providerId, messages, noteTitle, noteContent, maxTokens });
};

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

  // 先把 resolve/reject 提升到外部，然后 await once 确保注册完成后再 invoke
  let resolve: (value: string) => void;
  let reject: (reason: unknown) => void;
  const resultPromise = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  // 必须 await once 注册，否则生产环境下 Rust 端的 ai-chat-done 事件
  // 可能在监听器注册完成前到达，导致 Promise 永远不 resolve
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

export const createChatSession = async (title: string, providerId: number, model: string): Promise<AiChatSession> => {
  return await invoke('create_chat_session', { title, providerId, model });
};

export const getChatSessions = async (): Promise<AiChatSession[]> => {
  return await invoke('get_chat_sessions');
};

export const getChatMessages = async (sessionId: number): Promise<AiChatDbMessage[]> => {
  return await invoke('get_chat_messages', { sessionId });
};

export const saveChatMessage = async (sessionId: number, role: string, content: string): Promise<void> => {
  return await invoke('save_chat_message', { sessionId, role, content });
};

export const updateChatSessionTitle = async (sessionId: number, title: string): Promise<void> => {
  return await invoke('update_chat_session_title', { sessionId, title });
};

export const deleteChatSession = async (sessionId: number): Promise<void> => {
  return await invoke('delete_chat_session', { sessionId });
};
