import { invoke } from '@tauri-apps/api/core';
import { Note, Category } from './types';

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
