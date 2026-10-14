/* 数据备份与分组导出相关的类型。 */

/** 备份内容统计（导出/恢复后用于提示用户） */
export interface BackupSummary {
  notes: number;
  categories: number;
  providers: number;
  sessions: number;
  messages: number;
  settings: number;
  /** 备份文件的导出时间（ISO 字符串） */
  exported_at: string | null;
}

/** 压缩包里单篇笔记的文件格式 */
export type CategoryZipFormat = "md" | "txt" | "html" | "json";
/** 电子书格式 */
export type CategoryEbookFormat = "txt" | "html" | "epub";
