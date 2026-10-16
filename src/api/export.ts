/* 分组/笔记导出：压缩包与电子书两种形态。 */

import { invoke } from '@tauri-apps/api/core';

import type { CategoryEbookFormat, CategoryZipFormat, NoteFormatSpec } from '@/interface/backup';

/** 把整个分组导出成压缩包（一篇笔记一个文件），返回导出的笔记数 */
export const exportCategoryZip = async (
  categoryId: number,
  path: string,
  format: CategoryZipFormat,
): Promise<number> => {
  return await invoke<number>('export_category_zip', { categoryId, path, format });
};

/** 把整个分组导出成电子书（章节按创建时间正序，最早创建的在最前），返回导出的章节数 */
export const exportCategoryEbook = async (
  categoryId: number,
  path: string,
  format: CategoryEbookFormat,
): Promise<number> => {
  return await invoke<number>('export_category_ebook', { categoryId, path, format });
};

/**
 * 导出指定笔记 ID 列表为压缩包，返回导出的笔记数。
 * noteFormats 用于「其他文件格式」逐篇自选后缀；传了它时后端按笔记取后缀，忽略 format。
 */
export const exportNotesZip = async (
  noteIds: number[],
  path: string,
  format: CategoryZipFormat,
  noteFormats?: NoteFormatSpec[],
): Promise<number> => {
  return await invoke<number>('export_notes_zip', { noteIds, path, format, noteFormats: noteFormats ?? [] });
};

/** 导出指定笔记 ID 列表为电子书，参数里的 title 用于电子书标题 */
export const exportNotesEbook = async (
  noteIds: number[],
  path: string,
  format: CategoryEbookFormat,
): Promise<number> => {
  return await invoke<number>('export_notes_ebook', { noteIds, path, format });
};
