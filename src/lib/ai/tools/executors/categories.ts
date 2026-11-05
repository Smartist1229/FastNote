import * as categoriesApi from "@/api/note/categories";
import { AI_ACCESS_DENIED_NOTE, canAiReadCategory, canAiWriteCategory } from "@/lib/ai/aiAccess";
import type { ToolExecutors } from "../types";

export const categoriesExecutors: ToolExecutors = {
  getCategories: async (_args, ctx) => {
    const cats = await categoriesApi.getCategories();
    return cats.filter((c) => canAiReadCategory(ctx.access, c)).map((c) => ({ id: c.id, name: c.name }));
  },
  createCategory: async (args, ctx) => {
    const r = await categoriesApi.createCategory(String(args.name), ctx.defaultCategoryAiAccess);
    return { id: r.id, name: r.name };
  },
  renameCategory: async (args, ctx) => {
    const cid = String(args.categoryId ?? "");
    const cats = await categoriesApi.getCategories();
    const hit = cats.find((c) => c.id === cid);
    if (!hit) return { error: `未找到 ID 为 ${cid} 的分组` };
    if (!canAiWriteCategory(ctx.access, hit)) return { error: AI_ACCESS_DENIED_NOTE };
    await categoriesApi.updateCategory(cid, String(args.name));
    return { id: cid, name: args.name };
  },
  /**
   * 删除分组。deleteNotes=true 时组内笔记会被移入回收站（不是彻底删除，仍可还原）；
   * false（默认）则只解除归类，笔记留在"未分类"里。
   */
  deleteCategory: async (args, ctx) => {
    const cid = String(args.categoryId ?? "");
    if (!cid) return { success: false, error: "缺少有效的 categoryId" };
    const withNotes = args.deleteNotes === true || args.deleteNotes === "true";
    // 先取分组名与组内笔记数：轨迹要显示"删除分组「读书」· 组内 3 篇移入回收站"
    let name = "";
    let noteCount = 0;
    try {
      const cats = await categoriesApi.getCategories();
      const hit = cats.find(c => c.id === cid);
      if (!hit) return { success: false, error: `未找到 ID 为 ${cid} 的分组` };
      if (!canAiWriteCategory(ctx.access, hit)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
      name = hit.name || "";
      noteCount = Number(hit.note_count || 0);
    } catch {}
    await categoriesApi.deleteCategory(cid, withNotes);
    return {
      deleted: true,
      id: cid,
      name,
      noteCount,
      notesMovedToTrash: withNotes,
      note: withNotes ? "组内笔记已移入回收站（可还原，未被彻底删除）" : "组内笔记已变为未分类",
    };
  },
};
