import { invoke } from '@tauri-apps/api/core';
import { listen, once } from '@tauri-apps/api/event';
import { AiChatDbMessage, AiChatMessage, AiChatSession, AiProvider, Note, Category } from './types';

export const createCategory = async (name: string): Promise<Category> => {
  return await invoke('create_category', { name });
};

export const getCategories = async (): Promise<Category[]> => {
  return await invoke('get_categories');
};

export const updateCategory = async (id: number, name: string): Promise<void> => {
  return await invoke('update_category', { id, name });
};

export const deleteCategory = async (id: number, deleteNotes: boolean): Promise<void> => {
  return await invoke('delete_category', { id, deleteNotes });
};

export const createNote = async (title: string, content: string, categoryId: number | null): Promise<Note> => {
  return await invoke('create_note', { title, content, categoryId });
};

export const getNotes = async (categoryId: number | null, sortBy: string, sortOrder: string): Promise<Note[]> => {
  return await invoke('get_notes', { categoryId, sortBy, sortOrder });
};

export const updateNote = async (id: number, title: string, content: string, categoryId: number | null): Promise<void> => {
  return await invoke('update_note', { id, title, content, categoryId });
};

export const moveToTrash = async (id: number): Promise<void> => {
  return await invoke('move_to_trash', { id });
};

export const restoreNote = async (id: number): Promise<void> => {
  return await invoke('restore_note', { id });
};

export const getTrashNotes = async (): Promise<Note[]> => {
  return await invoke('get_trash_notes');
};

export const deleteNotePermanently = async (id: number): Promise<void> => {
  return await invoke('delete_note_permanently', { id });
};

export const deleteMultipleNotesPermanently = async (ids: number[]): Promise<void> => {
  return await invoke('delete_multiple_notes_permanently', { ids });
};

export const cleanupOldTrash = async (): Promise<void> => {
  return await invoke('cleanup_old_trash');
};

export const createAiProvider = async (
  name: string,
  providerType: AiProvider['provider_type'],
  apiBaseUrl: string,
  apiKey: string,
  apiPath: string | null,
): Promise<AiProvider> => {
  return await invoke('create_ai_provider', { name, providerType, apiBaseUrl, apiKey, apiPath });
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
): Promise<string> => {
  return await invoke('send_ai_chat', { providerId, messages, noteTitle, noteContent });
};

export const sendAiChatStream = async (
  providerId: number,
  messages: AiChatMessage[],
  noteTitle: string,
  noteContent: string,
  onChunk: (fullText: string) => void,
): Promise<string> => {
  const unlistenChunk = await listen<{ content: string }>('ai-chat-chunk', (event) => {
    onChunk(event.payload.content);
  });

  const resultPromise = new Promise<string>((resolve, reject) => {
    once<{ content: string }>('ai-chat-done', (event) => {
      resolve(event.payload.content);
    });
    once<{ error: string }>('ai-chat-error', (event) => {
      reject(new Error(event.payload.error));
    });
  });

  try {
    await invoke('send_ai_chat_stream', { providerId, messages, noteTitle, noteContent });
    const result = await resultPromise;
    return result;
  } finally {
    unlistenChunk();
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
