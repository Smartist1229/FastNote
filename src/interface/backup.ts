/**
 * 数据备份与分组导出的类型。
 *
 * 两者都不落库：备份是整库导出的 JSON 或 SQLite 文件（JSON 带 format / version /
 * exported_at / data），分组导出是 zip 或电子书。字段名与 Rust 侧 BackupSummary、
 * NoteFormatSpec 对齐。
 */

/** export_backup / import_backup 的返回值：各类数据的行数与备份时间 */
export interface BackupSummary {
  /** notes 表行数（含回收站里 is_deleted = 1 的笔记） */
  notes: number;
  categories: number;
  providers: number;
  sessions: number;
  messages: number;
  /** app_settings 的键数 */
  settings: number;
  /** 因加密而跳过的笔记数；备份里不含这些内容 */
  skipped_encrypted: number;
  /** 备份文件的导出时间（ISO 字符串）；导入旧文件缺失时为 null */
  exported_at: string | null;
}

/**
 * 压缩包里单篇笔记的文件格式（预设）：
 * md = 原文直出，txt = 纯文本，html = 渲染后的网页，json = 含标题/正文/时间等字段。
 */
export type CategoryZipFormat = "md" | "txt" | "html" | "json";
/** 电子书格式：txt / html 为单文件，epub 为标准电子书（mimetype 必须是首个且不压缩的条目） */
export type CategoryEbookFormat = "txt" | "html" | "epub";

/** export_notes_zip 的 noteFormats 元素：按笔记 id 逐篇指定压缩包内的后缀 */
export interface NoteFormatSpec {
  id: number;
  /** 后缀，不含点；限纯文本白名单 */
  ext: string;
}
