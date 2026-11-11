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
  /**
   * 恢复时保留下来的「本地独有内容」行数。
   *
   * 恢复是覆盖式的，备份里没有的本地内容（加密笔记、密钥、根密码材料、本机设置…）
   * 会在恢复前先拍快照，恢复完再补回来；这个数是补回来的行数。
   */
  preserved: number;
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
  id: string;
  /** 后缀，不含点；限纯文本白名单 */
  ext: string;
}

/** 预检里的一项分组：从备份里恢复这个分组会带回来几篇笔记 */
export interface BackupGroupInfo {
  id: string;
  name: string;
  notes: number;
  /** 加密分组：名称在备份里是密文，需要原设备根密码才能看 */
  encrypted: boolean;
}

/**
 * 恢复前的只读摘要（preflight_backup）。
 *
 * 用户先看清单再决定恢复什么，而不是「点了之后才被告知不行」。
 * 字段名与 Rust 侧 `BackupPreflight` 的 camelCase 序列化对齐。
 */
export interface BackupPreflight {
  format: string;
  version: number;
  exportedAt: string | null;
  categories: number;
  notes: number;
  /** 加密笔记数：换机恢复需要原设备根密码 */
  encryptedNotes: number;
  encryptedCategories: number;
  history: number;
  tags: number;
  attachments: number;
  providers: number;
  sessions: number;
  messages: number;
  settings: number;
  /** 备份里带了密钥环（包裹后的 DEK） */
  hasKeyring: boolean;
  /** 备份里带了根密码材料（app.security.root.*） */
  hasRootKey: boolean;
  /** 与本地同 id 已存在的笔记数：会被覆盖，或按「保留本地」跳过 */
  conflictsNotes: number;
  conflictsCategories: number;
  /** 本地是否已设置过根密码 */
  localRootSet: boolean;
  groups: BackupGroupInfo[];
  /** 笔记清单（逐篇勾选用）；超过上限时只给前 2000 条 */
  noteList: BackupNoteInfo[];
  /** 清单是否被截断：截断时提示用户改用分组筛选 */
  noteListTruncated: boolean;
}

/** 预检里的一条笔记：不带正文，够列表显示与搜索 */
export interface BackupNoteInfo {
  id: string;
  title: string;
  categoryId: string | null;
  encrypted: boolean;
  updatedAt: string;
  /** 与本地同 id：会被覆盖，或按「保留本地」跳过 */
  conflict: boolean;
}

/**
 * 恢复选项：要哪几类数据、冲突怎么处理、只恢复哪些分组。
 *
 * 字段名与 Rust 侧 `BackupSelection` 的 camelCase 序列化对齐；
 * `categoryIds` 为空数组表示「全部分组」，未分组笔记用 `__none__` 表示。
 */
export interface BackupSelection {
  categories: boolean;
  notes: boolean;
  tags: boolean;
  history: boolean;
  attachments: boolean;
  providers: boolean;
  sessions: boolean;
  settings: boolean;
  /** true = 同 id 冲突时保留本地版本（跳过备份条目）；默认 false = 用备份覆盖 */
  keepLocal: boolean;
  categoryIds: string[];
  /** 只恢复这些笔记（空 = 不限制）；非空时分组只带回来这些笔记所属的那几个 */
  noteIds: string[];
}

/** 「未分组」在分组勾选列表里的固定键，与 Rust 侧 SELECTION_UNGROUPED 一致 */
export const UNGROUPED_CATEGORY_KEY = "__none__";
