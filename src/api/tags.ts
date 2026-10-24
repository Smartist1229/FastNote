/**
 * 标签前端 API 层：标签读写 + 笔记与标签的关联。Tauri invoke 薄封装，失败以字符串 reject。
 *
 * 增删改一律返回**操作后这篇笔记的完整标签列表**：调用方（UI 与 AI 工具）都不必再发一次 GET，
 * 也就不会出现"写入成功了但界面没跟上"这种假失败。
 */

import { invoke } from "@tauri-apps/api/core";

import type { Note, Tag } from "@/interface/note";

/**
 * 全部标签及各自的使用篇数（list_tags），按使用数降序。
 * 给属性窗的候选列表、AI 的"库里有哪些标签"查询用。
 */
export const listTags = async (): Promise<Tag[]> => {
  return await invoke("list_tags");
};

/** 某篇笔记的标签列表（list_note_tags），按名称排序 */
export const listNoteTags = async (noteId: number): Promise<Tag[]> => {
  return await invoke("list_note_tags", { noteId });
};

/**
 * 给笔记加标签（add_note_tags），词不存在会自动创建，返回加完之后的完整列表。
 * source 省略时按 "user"；已存在的关联不会被重复插入，也不会改写来源。
 */
export const addNoteTags = async (noteId: number, names: string[], source?: "user" | "ai"): Promise<Tag[]> => {
  return await invoke("add_note_tags", { noteId, names, source });
};

/**
 * 摘掉笔记上的标签（remove_note_tags），返回摘完之后的完整列表。
 * source 传了只摘那一种来源（AI 工具固定传 "ai"，删不到用户手打的）；不传则不限来源。
 */
export const removeNoteTags = async (noteId: number, names: string[], source?: "user" | "ai"): Promise<Tag[]> => {
  return await invoke("remove_note_tags", { noteId, names, source });
};

/**
 * 整体替换笔记在某个来源下的标签（set_note_tags），返回替换后的完整列表。
 * AI 打标签是"重新看一遍这篇笔记"的结果，用替换而不是逐条增删，避免两轮思考留下残留。
 */
export const setNoteTags = async (noteId: number, names: string[], source?: "user" | "ai"): Promise<Tag[]> => {
  return await invoke("set_note_tags", { noteId, names, source });
};

/**
 * 标签改名（rename_tag），全局生效——标签是"词"，改名会把所有笔记上的关联一起换掉。
 * 目标名已存在时合并到它下面，返回改完之后的标签列表（合并场景下是合并目标的记录）。
 */
export const renameTag = async (id: number, name: string): Promise<Tag[]> => {
  return await invoke("rename_tag", { id, name });
};

/**
 * 删标签（delete_tag），连带它在所有笔记上的关联。
 * source 传了会校验归属（AI 传 "ai"，删不到用户建的标签），不匹配时 reject。
 */
export const deleteTag = async (id: number, source?: "user" | "ai"): Promise<void> => {
  return await invoke("delete_tag", { id, source });
};

/** 按标签名找笔记（list_notes_by_tag），大小写不敏感；名字为空时 reject */
export const listNotesByTag = async (name: string): Promise<Note[]> => {
  return await invoke("list_notes_by_tag", { name });
};
