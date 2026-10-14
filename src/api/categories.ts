/* 分组相关后端调用：增删改查。 */

import { invoke } from '@tauri-apps/api/core';

import type { Category } from '@/interface/note';

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
