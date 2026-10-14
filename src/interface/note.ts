/* 笔记、分组，以及直接编辑电脑文本文件时承载的数据类型。 */

export interface Note {
  id: number;
  title: string;
  content: string;
  category_id: number | null;
  created_at: string;
  updated_at: string;
  is_deleted: boolean;
  deleted_at: string | null;
}

export interface Category {
  id: number;
  name: string;
  created_at: string;
  note_count: number;
}

/** 直接编辑电脑上的文本文件时，编辑器里承载的内容（不落库） */
export interface ExternalTextFile {
  /** 伪笔记 id（负数哨兵值，仅用于让编辑器刷新内容） */
  id: number;
  /** 文件绝对路径 */
  path: string;
  /** 文件名（含扩展名，如 readme.md） */
  name: string;
  content: string;
}
