import * as notesApi from "@/api/note/notes";
import { AI_ACCESS_DENIED_NOTE, AI_READ_ONLY_NOTE, canAiReadNote, canAiWriteNote } from "@/lib/ai/aiAccess";
import type { ToolExecutors } from "../types";

export const trashExecutors: ToolExecutors = {
  /** 查看回收站（受限笔记不出现：连"回收站里有几篇"都不该暴露给它） */
  listTrash: async (_args, ctx) => {
    const notes = (await notesApi.getTrashNotes()).filter((n) => canAiReadNote(ctx.access, n));
    return {
      total: notes.length,
      notes: notes.slice(0, 20).map((n) => ({ id: n.id, title: n.title, deleted_at: n.deleted_at })),
    };
  },
  /** 从回收站还原笔记 */
  restoreNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    if (!nid) return { success: false, error: "缺少有效的 noteId" };
    // 从回收站列表里取标题（回收站里的笔记用 get_note_content 不一定可靠）
    let title = "";
    try {
      const trashed = await notesApi.getTrashNotes();
      const hit = trashed.find((n) => n.id === nid);
      if (hit && !canAiReadNote(ctx.access, hit)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
      // 还原是写操作：只读档也不能动
      if (hit && !canAiWriteNote(ctx.access, hit)) return { success: false, error: AI_READ_ONLY_NOTE };
      title = hit?.title || "";
    } catch {}
    await notesApi.restoreNote(nid);
    return { success: true, id: nid, title, restored: true };
  },
  /** 彻底删除回收站中的某篇笔记（不可恢复） */
  deleteFromTrash: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    if (!nid) return { success: false, error: "缺少有效的 noteId" };
    const trashed = await notesApi.getTrashNotes();
    const target = trashed.find(n => n.id === nid);
    if (!target) return { success: false, error: `回收站里没有 ID 为 ${nid} 的笔记（先用 listTrash 确认）` };
    if (!canAiReadNote(ctx.access, target)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
    if (!canAiWriteNote(ctx.access, target)) return { success: false, error: AI_READ_ONLY_NOTE };
    await notesApi.deleteNotePermanently(nid);
    return { success: true, id: nid, title: target.title, permanent: true };
  },
  /** 清空回收站（不可恢复） */
  emptyTrash: async (_args, ctx) => {
    const trashed = await notesApi.getTrashNotes();
    if (trashed.length === 0) return { success: true, deleted: 0, note: "回收站本来就是空的" };
    // 只要有一篇"禁止"或"只读"的笔记就整体拒绝：清空不可恢复，不能顺带删掉 AI 无权删除的内容
    const blocked = trashed.filter((n) => !canAiWriteNote(ctx.access, n));
    if (blocked.length > 0) {
      return {
        success: false,
        error: `回收站里有 ${blocked.length} 篇笔记未对 AI 开放，清空会一并永久删除它们，已拒绝。请让用户自己在回收站里清空。`,
      };
    }
    await notesApi.deleteMultipleNotesPermanently(trashed.map(n => n.id));
    return { success: true, deleted: trashed.length };
  },
};
