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

/** 压缩包里单篇笔记的文件格式（预设） */
export type CategoryZipFormat = "md" | "txt" | "html" | "json";
/** 电子书格式 */
export type CategoryEbookFormat = "txt" | "html" | "epub";

/** 压缩包「其他文件格式」：逐篇笔记自选的后缀（ext 不含点，限纯文本白名单） */
export interface NoteFormatSpec {
  id: number;
  ext: string;
}
