/**
 * 分组/笔记导出前端 API 层：压缩包与电子书两种形态。
 * path 由调用方通过保存对话框选定；命令返回实际导出的条目数，失败以字符串 reject。
 */

import { invoke } from '@tauri-apps/api/core';

import type { CategoryEbookFormat, CategoryZipFormat, NoteFormatSpec } from '@/interface/backup';

/** 整个分组导出为压缩包（export_category_zip），一篇笔记一个文件；返回笔记数 */
export const exportCategoryZip = async (
  categoryId: number,
  path: string,
  format: CategoryZipFormat,
): Promise<number> => {
  return await invoke<number>('export_category_zip', { categoryId, path, format });
};

/** 整个分组导出为电子书（export_category_ebook），章节按创建时间正序；返回章节数 */
export const exportCategoryEbook = async (
  categoryId: number,
  path: string,
  format: CategoryEbookFormat,
): Promise<number> => {
  return await invoke<number>('export_category_ebook', { categoryId, path, format });
};

/**
 * 指定笔记导出为压缩包（export_notes_zip），返回笔记数。
 * noteFormats 用于「其他文件格式」逐篇自选后缀；传了它时后端以逐篇后缀为准并忽略 format，
 * 未传时发送空数组。
 */
export const exportNotesZip = async (
  noteIds: number[],
  path: string,
  format: CategoryZipFormat,
  noteFormats?: NoteFormatSpec[],
): Promise<number> => {
  return await invoke<number>('export_notes_zip', { noteIds, path, format, noteFormats: noteFormats ?? [] });
};

/** 指定笔记导出为电子书（export_notes_ebook），返回章节数；EPUB 书名取保存路径的文件名 */
export const exportNotesEbook = async (
  noteIds: number[],
  path: string,
  format: CategoryEbookFormat,
): Promise<number> => {
  return await invoke<number>('export_notes_ebook', { noteIds, path, format });
};
