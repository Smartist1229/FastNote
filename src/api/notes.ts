/* 笔记相关后端调用：增删改查、回收站/恢复/永久删除，以及电脑文本文件读写。 */

import { invoke } from '@tauri-apps/api/core';

import type { ExternalTextFile, Note } from '@/interface/note';

export const createNote = async (title: string, content: string, categoryId: number | null): Promise<Note> => {
  return await invoke('create_note', { title, content, categoryId });
};

export const getNotes = async (categoryId: number | null, sortBy: string, sortOrder: string): Promise<Note[]> => {
  return await invoke('get_notes', { categoryId, sortBy, sortOrder });
};

export const updateNote = async (id: number, title: string, content: string, categoryId: number | null): Promise<void> => {
  return await invoke('update_note', { id, title, content, categoryId });
};

/** 切换收藏（置顶）状态：收藏的笔记在所在分组内置顶，并出现在收藏视图 */
export const pinNote = async (id: number, pinned: boolean): Promise<void> => {
  return await invoke('pin_note', { id, pinned });
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

/* ---------------- 电脑文本文件（拖入/打开） ---------------- */

/** 读取电脑上的文本文件；非文本/过大/读失败会抛错（错误信息已是中文提示） */
export const readTextFile = async (path: string): Promise<Omit<ExternalTextFile, 'id'>> => {
  return await invoke<Omit<ExternalTextFile, 'id'>>('read_text_file', { path });
};

/** 把内容写回电脑上的文本文件（原子替换） */
export const writeTextFile = async (path: string, content: string): Promise<void> => {
  return await invoke('write_text_file', { path, content });
};
