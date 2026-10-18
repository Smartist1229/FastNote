/**
 * 笔记前端 API 层：增删改查、回收站、永久删除，以及电脑文本文件读写。
 *
 * 均为 Tauri invoke 薄封装，命令失败以字符串 reject；本层不缓存、不派发事件，
 * 列表刷新由调用方负责。categoryId 为 null 表示「全部分组」或「未分组」，语义见各命令。
 */

import { invoke } from '@tauri-apps/api/core';

import type { ExternalTextFile, Note } from '@/interface/note';

/** 新建笔记（create_note），返回完整 Note（含 id 与时间戳）；categoryId 为 null 表示未分组 */
export const createNote = async (title: string, content: string, categoryId: number | null): Promise<Note> => {
  return await invoke('create_note', { title, content, categoryId });
};

/**
 * 查询笔记（get_notes）。categoryId 为 null 查全部分组；
 * sortBy 支持 created_at/updated_at/title，其它值按 updated_at；sortOrder 仅 "asc" 生效。
 * 置顶笔记恒在最前；返回不含回收站内的笔记。
 */
export const getNotes = async (categoryId: number | null, sortBy: string, sortOrder: string): Promise<Note[]> => {
  return await invoke('get_notes', { categoryId, sortBy, sortOrder });
};

/** 更新标题/正文/分组并刷新 updated_at（update_note）；不传 is_pinned，Rust 侧保持原值 */
export const updateNote = async (id: number, title: string, content: string, categoryId: number | null): Promise<void> => {
  return await invoke('update_note', { id, title, content, categoryId });
};

/** 切换收藏/置顶（pin_note）：所在分组内置顶并进入收藏视图；不改变 updated_at */
export const pinNote = async (id: number, pinned: boolean): Promise<void> => {
  return await invoke('pin_note', { id, pinned });
};

/**
 * 设置单篇笔记的 AI 访问档位（set_note_ai_access，0 禁止 / 1 只读 / 2 完全）。
 * 只改档位，不触碰正文；分组档位更严格时以分组为准（两者取小）。
 */
export const setNoteAiAccess = async (id: number, level: number): Promise<void> => {
  return await invoke('set_note_ai_access', { id, level });
};

/** 移入回收站（move_to_trash）：软删除，写 is_deleted 与 deleted_at，可恢复 */
export const moveToTrash = async (id: number): Promise<void> => {
  return await invoke('move_to_trash', { id });
};

/** 从回收站恢复（restore_note）：清空 is_deleted/deleted_at，原分组保持不变 */
export const restoreNote = async (id: number): Promise<void> => {
  return await invoke('restore_note', { id });
};

/** 读取回收站列表（get_trash_notes），按 deleted_at 倒序 */
export const getTrashNotes = async (): Promise<Note[]> => {
  return await invoke('get_trash_notes');
};

/** 永久删除单篇（delete_note_permanently），直接 DELETE，不可恢复 */
export const deleteNotePermanently = async (id: number): Promise<void> => {
  return await invoke('delete_note_permanently', { id });
};

/** 批量永久删除（delete_multiple_notes_permanently）；Rust 侧逐条 DELETE，非事务 */
export const deleteMultipleNotesPermanently = async (ids: number[]): Promise<void> => {
  return await invoke('delete_multiple_notes_permanently', { ids });
};

/** 清理回收站（cleanup_old_trash）：删除 deleted_at 早于 30 天前的笔记 */
export const cleanupOldTrash = async (): Promise<void> => {
  return await invoke('cleanup_old_trash');
};

/* ---------- 电脑文本文件（拖入/打开） ---------- */

/**
 * 读取电脑上的文本文件（read_text_file），返回 { path, name, content }。
 * name 是去掉扩展名的文件名（readme.md → readme）；会去 UTF-8 BOM。
 * 非文件、超过 5 MB、开头 8 KB 含 NUL 字节、非 UTF-8 都会 reject。
 */
export const readTextFile = async (path: string): Promise<Omit<ExternalTextFile, 'id'>> => {
  return await invoke<Omit<ExternalTextFile, 'id'>>('read_text_file', { path });
};

/** 写回电脑文件（write_text_file）：同目录临时文件 + rename 原子替换；父目录必须已存在 */
export const writeTextFile = async (path: string, content: string): Promise<void> => {
  return await invoke('write_text_file', { path, content });
};
