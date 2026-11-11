/**
 * 笔记导出前端 API 层：压缩包与电子书两种形态（导出范围是**选中的若干笔记**）。
 * path 由调用方通过保存对话框选定；命令返回实际导出的条目数，失败以字符串 reject。
 */

import { invoke } from '@tauri-apps/api/core';

import type { CategoryEbookFormat, CategoryZipFormat, NoteFormatSpec } from '@/interface/settings/backup';

/**
 * 指定笔记导出为压缩包（export_notes_zip），返回笔记数。
 * noteFormats 用于「其他文件格式」逐篇自选后缀；传了它时后端以逐篇后缀为准并忽略 format，
 * 未传时发送空数组。
 */
export const exportNotesZip = async (
  noteIds: string[],
  path: string,
  format: CategoryZipFormat,
  noteFormats?: NoteFormatSpec[],
): Promise<number> => {
  return await invoke<number>('export_notes_zip', { noteIds, path, format, noteFormats: noteFormats ?? [] });
};

/** 指定笔记导出为电子书（export_notes_ebook），返回章节数；EPUB 书名取保存路径的文件名 */
export const exportNotesEbook = async (
  noteIds: string[],
  path: string,
  format: CategoryEbookFormat,
): Promise<number> => {
  return await invoke<number>('export_notes_ebook', { noteIds, path, format });
};
