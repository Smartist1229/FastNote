import type { ToolExecutors } from "./types";
import { notesExecutors } from "./executors/notes";
import { semanticExecutors } from "./executors/semantic";
import { trashExecutors } from "./executors/trash";
import { categoriesExecutors } from "./executors/categories";
import { tagsExecutors } from "./executors/tags";

export { TOOL_LABELS } from "./labels";
export { sourceText, summarizeToolCall, toolDetail } from "./detail";
export { fetchNoteById, visibleNotes, findCategoryByName, findWritableCategoryByName, normalizeTagNames, noteEditReceipt, readNoteWindow } from "./helpers";

/**
 * 工具名 → 执行器。args 来自模型输出的 <tool_calls>，ctx 只携带 currentNoteId。
 * 约定：可预期的业务失败用 { error } 或 { success: false, error } 返回，交给模型自我纠正；
 * 未捕获的异常由 runTool 转成失败轨迹。写操作在此直接落库，确认流程在上层 agentLoop。
 */
export const TOOL_EXECUTORS: ToolExecutors = Object.assign(
  {},
  notesExecutors,
  semanticExecutors,
  trashExecutors,
  categoriesExecutors,
  tagsExecutors,
);
