/** 分组前端 API 层：增删改查。Tauri invoke 薄封装，失败以字符串 reject，无缓存。 */

import { invoke } from '@tauri-apps/api/core';

import type { Category } from '@/interface/note';

/** 新建分组（create_category），返回含 id 的记录，note_count 初始为 0 */
export const createCategory = async (name: string): Promise<Category> => {
  return await invoke('create_category', { name });
};

/** 读取全部分组（get_categories），按 created_at 倒序；note_count 不含回收站笔记 */
export const getCategories = async (): Promise<Category[]> => {
  return await invoke('get_categories');
};

/** 重命名分组（update_category）；笔记的 category_id 不变 */
export const updateCategory = async (id: number, name: string): Promise<void> => {
  return await invoke('update_category', { id, name });
};

/**
 * 设置分组的 AI 访问档位（set_category_ai_access，0 禁止 / 1 只读 / 2 完全）。
 * 分组档位是组内笔记的上限，但不会改写笔记自身的档位，放开分组即可恢复。
 */
export const setCategoryAiAccess = async (id: number, level: number): Promise<void> => {
  return await invoke('set_category_ai_access', { id, level });
};

/**
 * 删除分组（delete_category）。deleteNotes=true 时组内笔记先移入回收站并清空分组，
 * false 时笔记保留但 category_id 置空；两种都不会永久删除笔记。
 */
export const deleteCategory = async (id: number, deleteNotes: boolean): Promise<void> => {
  return await invoke('delete_category', { id, deleteNotes });
};
