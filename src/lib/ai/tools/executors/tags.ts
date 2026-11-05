import * as tagsApi from "@/api/note/tags";
import * as categoriesApi from "@/api/note/categories";
import type { Tag } from "@/interface/note/note";
import { AI_READ_ONLY_NOTE, canAiReadNote, canAiWriteNote } from "@/lib/ai/aiAccess";
import { fetchNoteById, normalizeTagNames } from "../helpers";
import type { ToolExecutors } from "../types";

export const tagsExecutors: ToolExecutors = {
  /* ---------------- 标签 ----------------
   * 权限上有一条硬线：AI 只能动 source="ai" 的标签，用户手打的一个也碰不到。
   * 这条线落在 Rust 侧（按 source 过滤 DELETE / UPDATE），前端这里是同一套意图的第二道保险。
   */

  /** 全部标签及各标签的笔记数：让模型优先复用库里已有的词，而不是每次都造同义的新词 */
  listTags: async () => {
    const tags = await tagsApi.listTags();
    return {
      total: tags.length,
      tags: tags.slice(0, 60).map((t) => ({ id: t.id, name: t.name, source: t.source, note_count: t.note_count })),
      hint: "source=user 的是用户手打的标签。请优先复用已有标签名，避免造出同义词。",
    };
  },

  /** 某篇笔记的标签；顺带回答"这篇有没有标签"，决定是否自动补打 */
  getNoteTags: async (args, ctx) => {
    const nid = String(args.noteId ?? ctx.currentNoteId ?? "");
    if (!nid) return { error: "缺少 noteId，且当前没有打开的笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    const tags = await tagsApi.listNoteTags(nid);
    const user = tags.filter((t) => t.source !== "ai").map((t) => t.name);
    const ai = tags.filter((t) => t.source === "ai").map((t) => t.name);
    return {
      id: nid,
      title: n.title,
      total: tags.length,
      tags: tags.map((t) => ({ id: t.id, name: t.name, source: t.source })),
      userTags: user,
      aiTags: ai,
      ...(tags.length === 0
        ? { empty: true, hint: "这篇还没有任何标签。读完正文后可调用 setNoteTags 补上 2-5 个简短标签（先用 listTags 复用已有词）。" }
        : { hint: "source=user 的是用户手打的，不能删除或改名；source=ai 的才是你可以调整的。" }),
    };
  },

  /**
   * 按标签查找笔记：标签的意义就是跨分组检索。
   * 精确名没命中时退一步用"包含关系"再找一遍（「读书」→「读书笔记」「读书方法」）：
   * 标签是用户/模型自己起的词，很难和用户的说法一字不差，直接回"没有"等于让
   * 模型放弃标签这条路、回去硬搜关键词。
   */
  findNotesByTag: async (args, ctx) => {
    const name = String(args.tagName ?? args.name ?? "").trim();
    if (!name) return { error: "缺少 tagName" };
    let all = await tagsApi.listNotesByTag(name);
    /** 退一步时实际用到的标签名（回给模型核对，避免它以为「读书」这个标签本身存在） */
    const matchedTags: string[] = [];
    if (all.length === 0) {
      const library = await tagsApi.listTags().catch(() => [] as Tag[]);
      const near = library
        .filter((t) => t.name.toLowerCase().includes(name.toLowerCase()))
        .slice(0, 5);
      for (const t of near) {
        const notes = await tagsApi.listNotesByTag(t.name).catch(() => []);
        matchedTags.push(t.name);
        for (const n of notes) if (!all.some((x) => x.id === n.id)) all.push(n);
      }
      if (matchedTags.length > 0) {
        all.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
      }
    }
    // 与别处一致：未授权的笔记连出现在结果里都不行
    const visible = all.filter((n) => canAiReadNote(ctx.access, n));
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    const categories = await categoriesApi.getCategories();
    const nameOf = (id: string | null) => categories.find((c) => c.id === id)?.name || "未分类";
    return {
      tag: name,
      ...(matchedTags.length > 0 ? { matchedTags } : {}),
      total: visible.length,
      notes: visible.slice(0, limit).map((n) => ({
        id: n.id,
        title: n.title,
        category: nameOf(n.category_id),
        updated_at: n.updated_at,
        preview: String(n.content || "").replace(/\s+/g, " ").slice(0, 60),
      })),
      ...(visible.length === 0
        ? { hint: `没有笔记带标签「${name}」。先用 listTags 看看库里有哪些。` }
        : matchedTags.length > 0
          ? { hint: `库里没有叫「${name}」的标签，以上是包含关系匹配到的标签（${matchedTags.join("、")}）下的笔记。` }
          : {}),
    };
  },

  /**
   * 添加标签。
   * 写操作要过权限（canAiWriteNote），但两种来源可以共存：同一篇笔记上允许同时挂 user / ai 标签。
   */
  addNoteTags: async (args, ctx) => {
    const nid = String(args.noteId ?? ctx.currentNoteId ?? "");
    if (!nid) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const names = normalizeTagNames(args.names ?? args.name);
    if (names.length === 0) return { success: false, error: "names 为空，需要 ['标签1','标签2']" };
    const next = await tagsApi.addNoteTags(nid, names.slice(0, 10), "ai");
    return {
      success: true,
      id: nid,
      title: n.title,
      added: names,
      tags: next.map((t) => ({ id: t.id, name: t.name, source: t.source })),
    };
  },

  /** 移除标签：Rust 侧按 source="ai" 过滤，用户手打的删不掉，返回的最新列表也不会变 */
  removeNoteTags: async (args, ctx) => {
    const nid = String(args.noteId ?? ctx.currentNoteId ?? "");
    if (!nid) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const names = normalizeTagNames(args.names ?? args.name);
    if (names.length === 0) return { success: false, error: "names 为空" };
    const next = await tagsApi.removeNoteTags(nid, names, "ai");
    const still = new Set(next.map((t) => t.name.toLowerCase()));
    // 有一部分没删掉：多半是用户创建的，明确告诉模型别再重试
    const skipped = names.filter((x) => still.has(x.toLowerCase()));
    return {
      success: true,
      id: nid,
      title: n.title,
      removed: names.filter((x) => !still.has(x.toLowerCase())),
      tags: next.map((t) => ({ id: t.id, name: t.name, source: t.source })),
      ...(skipped.length > 0
        ? { skipped, note: `「${skipped.join("、")}」未被移除：它们可能不是 AI 添加的，或已不存在。用户手动添加的标签无法由你删除。` }
        : {}),
    };
  },

  /**
   * 整体重写这篇笔记的 AI 标签。
   * 用它而不是逐条增删：这是"重新看一遍这篇笔记"的结果，留旧标签等于把两轮判断混在一起。
   */
  setNoteTags: async (args, ctx) => {
    const nid = String(args.noteId ?? ctx.currentNoteId ?? "");
    if (!nid) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const names = normalizeTagNames(args.names ?? args.name);
    if (names.length === 0) return { success: false, error: "names 为空，至少给一个标签" };
    const next = await tagsApi.setNoteTags(nid, names.slice(0, 10), "ai");
    return {
      success: true,
      id: nid,
      title: n.title,
      aiTags: next.filter((t) => t.source === "ai").map((t) => t.name),
      tags: next.map((t) => ({ id: t.id, name: t.name, source: t.source })),
    };
  },

  /**
   * 标签改名（全局）：按名字定位是因为模型手里通常只有词、没有 id。
   *
   * 改名已免确认，而 Rust 的 rename_tag 不按 source 过滤（它要同时服务属性窗的用户改名），
   * 所以"只能改自己创建的标签"这条线由这里守住：放过去就等于让 AI 无声改掉用户
   * 所有笔记上的同一个词。deleteTag 有 Rust 侧的 source 校验，不需要这道。
   */
  renameTag: async (args) => {
    const from = String(args.tagName ?? args.name ?? "").trim();
    const to = String(args.newName ?? "").trim();
    if (!from) return { success: false, error: "缺少 tagName" };
    if (!to) return { success: false, error: "缺少 newName" };
    const tags = await tagsApi.listTags();
    const hit = tags.find((t) => t.name.toLowerCase() === from.toLowerCase());
    if (!hit) return { success: false, error: `库里没有标签「${from}」，先用 listTags 确认` };
    if (hit.source !== "ai") {
      return { success: false, error: `「${hit.name}」是用户创建的标签，你无法重命名（只能改自己创建的 AI 标签）` };
    }
    const next = await tagsApi.renameTag(hit.id, to);
    return { success: true, id: hit.id, from: hit.name, to, tags: next.map((t) => ({ id: t.id, name: t.name })) };
  },

  /** 删除标签（全局）：连带它在所有笔记上的关联，AI 建的才能删 */
  deleteTag: async (args) => {
    const name = String(args.tagName ?? args.name ?? "").trim();
    if (!name) return { success: false, error: "缺少 tagName" };
    const tags = await tagsApi.listTags();
    const hit = tags.find((t) => t.name.toLowerCase() === name.toLowerCase());
    if (!hit) return { success: false, error: `库里没有标签「${name}」` };
    try {
      await tagsApi.deleteTag(hit.id, "ai");
      return { success: true, id: hit.id, name: hit.name, deleted: true };
    } catch (error) {
      // Rust 侧的归属校验会抛错，这里翻成人话告诉模型，别让它再试一次
      return { success: false, id: hit.id, name: hit.name, error: `无法删除「${hit.name}」：${error}` };
    }
  },
};
