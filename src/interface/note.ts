/**
 * 笔记与分组的数据层类型。
 *
 * Note / Category 分别对应 SQLite 的 notes / categories 表，字段名与列名一一对应
 * （snake_case 直接序列化，不做驼峰转换），改动字段需同步 src-tauri/src/lib.rs。
 * ExternalTextFile 是「编辑电脑上的文件」时的内存结构，不落库。
 */

import type { AiAccessLevel } from "./aiAccess";

/** notes 表的一行；软删除由 is_deleted / deleted_at 表示，回收站只是 is_deleted = 1 的视图 */
export interface Note {
  id: number;
  title: string;
  content: string;
  /** 所属分组；null = 未分类 */
  category_id: number | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  /** 移入回收站的时间；未删除时为 null */
  deleted_at: string | null;
  /** 是否置顶/收藏：置顶笔记在所在分组顶部显示，收藏视图中也会显示 */
  is_pinned: boolean;
  /**
   * AI 访问档位（0 禁止 / 1 只读 / 2 完全，默认 2）。
   * 实际生效值 = min(本字段, 所属分组档位)，总开关关闭时一律按 0。
   */
  ai_access: AiAccessLevel;
}

/** categories 表的一行；note_count 是查询时 LEFT JOIN notes 聚合的结果（已排除软删除） */
export interface Category {
  id: number;
  name: string;
  created_at: string;
  note_count: number;
  /** AI 访问档位（0 禁止 / 1 只读 / 2 完全）：作为组内笔记的上限，不改写笔记自身的档位 */
  ai_access: AiAccessLevel;
}

/**
 * tags 表的一行（跨分组的主题词）。
 *
 * `source` 表示**这个词最初是谁建的**，只用于 UI 区分样式与操作权限；
 * 真正决定"谁能删"的是 `note_tags.source`（同一篇笔记上 user / ai 可以是两个来源）。
 */
export interface Tag {
  id: number;
  name: string;
  /** "user" 用户手动添加 | "ai" AI 生成 */
  source: "user" | "ai";
  created_at: string;
  /** 关联了多少篇**未删除**的笔记 */
  note_count: number;
}

/** 历史版本的来源：自动保存 / 打开笔记时的会话基线 / 手动保存 / 早期数据的回滚前快照 */
export type NoteHistoryKind = "auto" | "session" | "manual" | "pre-rollback";

/**
 * 一篇笔记的历史版本（notes_history 表的一行）。
 * 只快照标题 / 正文 / 分组 / 置顶；回滚不恢复标签与 AI 访问档位。
 */
export interface NoteHistoryEntry {
  id: number;
  note_id: number;
  title: string;
  content: string;
  category_id: number | null;
  is_pinned: boolean;
  /** 来源：auto / session / manual / pre-rollback */
  kind: NoteHistoryKind;
  /** 固定版本：不会被自动清理，只能手动删除 */
  pinned: boolean;
  /** 该版本被替换下来的时间（ISO 字符串） */
  saved_at: string;
}

/**
 * 直接编辑电脑上的文本文件时，编辑器里承载的内容。
 * 不落库：读取走 read_text_file，保存走 write_text_file。
 */
export interface ExternalTextFile {
  /** 伪笔记 id：负数哨兵（从 -1000001 起递减），仅用于让编辑器感知"换了一篇" */
  id: number;
  /** 文件绝对路径 */
  path: string;
  /** 去掉扩展名的文件名（readme.md → readme），直接用作编辑器标题 */
  name: string;
  content: string;
}
