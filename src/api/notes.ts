/**
 * 笔记前端 API 层：增删改查、回收站、永久删除，以及电脑文本文件读写。
 *
 * 均为 Tauri invoke 薄封装，命令失败以字符串 reject；本层不缓存、不派发事件，
 * 列表刷新由调用方负责。categoryId 为 null 表示「全部分组」或「未分组」，语义见各命令。
 */

import { invoke } from '@tauri-apps/api/core';

import type { ExternalTextFile, Note, NoteHistoryEntry } from '@/interface/note';

/**
 * 新建笔记（create_note），返回完整 Note（含 id 与时间戳）；categoryId 为 null 表示未分组。
 * aiAccess 是这条笔记的初始 AI 访问档位（0 禁止 / 1 只读 / 2 完全），由调用方按
 * 「新建笔记默认权限」传入；省略时 Rust 侧按 2（完全）处理，与老版本一致。
 */
export const createNote = async (
  title: string,
  content: string,
  categoryId: number | null,
  aiAccess?: number,
): Promise<Note> => {
  return await invoke('create_note', { title, content, categoryId, aiAccess });
};

/**
 * 查询笔记列表（get_notes）。categoryId 为 null 查全部分组；
 * sortBy 支持 created_at/updated_at/title，其它值按 updated_at；sortOrder 仅 "asc" 生效。
 * 置顶笔记恒在最前；返回不含回收站内的笔记，且始终带正文——
 * AI 读取未打开的笔记依赖它，不能在这里裁掉 content。
 */
export const getNotes = async (
  categoryId: number | null,
  sortBy: string,
  sortOrder: string,
): Promise<Note[]> => {
  return await invoke('get_notes', { categoryId, sortBy, sortOrder });
};

/** 读取单条笔记（get_note），返回带正文的完整 Note；不存在时 reject */
export const getNote = async (id: number): Promise<Note> => {
  return await invoke('get_note', { id });
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

/** 批量永久删除（delete_multiple_notes_permanently）；加密笔记会被跳过，返回跳过条数 */
export const deleteMultipleNotesPermanently = async (ids: number[]): Promise<number> => {
  return await invoke('delete_multiple_notes_permanently', { ids });
};

/** 清理回收站（cleanup_old_trash）：删除 deleted_at 早于 30 天前的笔记 */
export const cleanupOldTrash = async (): Promise<void> => {
  return await invoke('cleanup_old_trash');
};

/* ---------- 历史版本 ---------- */

/** 某篇笔记的历史版本（get_note_history），新的在前；只含标题/正文/分组/置顶 */
export const getNoteHistory = async (noteId: number): Promise<NoteHistoryEntry[]> => {
  return await invoke('get_note_history', { noteId });
};

/**
 * 回滚到指定历史版本（rollback_note_history），返回回滚后的完整笔记。
 * 该版本及所有更新的版本会被删除，回滚本身不生成新的历史。
 */
export const rollbackNoteHistory = async (entryId: number): Promise<Note> => {
  return await invoke('rollback_note_history', { entryId });
};

/** 手动保存当前状态为历史版本（create_note_history_version）；内容与最新一条相同时返回 false */
export const createNoteHistoryVersion = async (noteId: number): Promise<boolean> => {
  return await invoke('create_note_history_version', { noteId });
};

/** 打开笔记时记录会话基线（snapshot_note_session）；还没有历史或与最新历史相同则不写，返回 false */
export const snapshotNoteSession = async (noteId: number): Promise<boolean> => {
  return await invoke('snapshot_note_session', { noteId });
};

/** 固定 / 取消固定一条历史版本（set_note_history_pinned）；固定版本不会被自动清理 */
export const setNoteHistoryPinned = async (entryId: number, pinned: boolean): Promise<void> => {
  await invoke('set_note_history_pinned', { entryId, pinned });
};

/** 删除单条历史版本（delete_note_history_entry），不影响笔记本身 */
export const deleteNoteHistoryEntry = async (entryId: number): Promise<void> => {
  await invoke('delete_note_history_entry', { entryId });
};

/** 清空某篇笔记的全部历史版本（clear_note_history） */
export const clearNoteHistory = async (noteId: number): Promise<void> => {
  await invoke('clear_note_history', { noteId });
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
