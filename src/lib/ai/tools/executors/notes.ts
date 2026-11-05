import * as notesApi from "@/api/note/notes";
import * as categoriesApi from "@/api/note/categories";
import type { Note } from "@/interface/note/note";
import { AI_ACCESS_DENIED_NOTE, AI_READ_ONLY_NOTE, canAiWriteCategory, canAiWriteNote } from "@/lib/ai/aiAccess";
import { emitAppEvent } from "@/shared/bus";
import { t as translate } from "@/i18n";
import {
  fetchNoteById,
  findCategoryByName,
  findWritableCategoryByName,
  noteEditReceipt,
  readNoteWindow,
  visibleNotes,
} from "../helpers";
import type { ToolExecutors } from "../types";

export const notesExecutors: ToolExecutors = {
  searchNotes: async (args, ctx) => {
    // 只搜对 AI 开放的笔记：受限内容连"命中数量"都不该出现在结果里
    const visible = await visibleNotes(ctx.access);
    const q = String(args.query || "").trim().toLowerCase();
    const hay = (n: Note) => `${n.title || ""}\n${n.content || ""}`.toLowerCase();
    // 先做严格的连续子串匹配
    let hits = q ? visible.filter((n) => hay(n).includes(q)) : visible;
    let fuzzy = false;
    // 命中为空时退化为宽松匹配：中文按"每个字都出现"，英文按"每个词都出现"。
    // 否则"浏览器渲染"匹配不到标题《浏览器是如何渲染页面的？》（中间隔了"是如何"）。
    if (hits.length === 0 && q) {
      const cjkChars = [...new Set(q.split("").filter(ch => /[\u4e00-\u9fff]/.test(ch)))];
      const words = q.split(/\s+/).filter(t => t.length >= 2);
      const key = cjkChars.length >= 2 ? cjkChars : words;
      if (key.length >= 2) {
        hits = visible.filter((n) => key.every(k => hay(n).includes(k)));
        fuzzy = hits.length > 0;
      }
    }
    // 同名笔记会让"按标题操作"产生歧义，显式提示模型并要求用户确认
    const titleCounts = new Map<string, number>();
    for (const n of hits) titleCounts.set(n.title, (titleCounts.get(n.title) || 0) + 1);
    const duplicateTitles = [...titleCounts.entries()].filter(([, c]) => c > 1).map(([t]) => t);
    return {
      matches: hits.slice(0, 15).map((n) => ({ id: n.id, title: n.title, content: n.content ? n.content.substring(0, 100) : "", category_id: n.category_id })),
      total: hits.length,
      duplicateTitles,
      ...(fuzzy
        ? { fuzzy: true, note: "以上为宽松匹配（关键词不是连续子串），请核对标题确认是不是用户指的那一篇。" }
        : {}),
      ...(duplicateTitles.length > 0
        ? { warning: `存在同名笔记（${duplicateTitles.join("、")}）。标题无法唯一定位，必须让用户确认要操作哪一个 ID。` }
        : {}),
      // 关键词只在标题/正文里找。用户说的常常是主题而不是原话，这时换标签检索才对路，
      // 否则模型只会换个词再硬搜一次。
      ...(hits.length === 0
        ? { hint: "没有命中。关键词只在标题与正文里匹配：若用户说的是主题（而不是原文用词），改用 listTags 看库里有哪些标签，再用 findNotesByTag 检索；也可以换成 2-4 个字的短关键词再搜一次。" }
        : {}),
    };
  },
  getNoteContent: async (args, ctx) => {
    const n = await fetchNoteById(String(args.noteId ?? ""), ctx.access);
    if (!n) return null;
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /** 列出笔记（按更新时间倒序，可限定分组与条数）：回答"我最近记了什么/某个分组里有什么" */
  listNotes: async (args, ctx) => {
    let list = await visibleNotes(ctx.access);
    if (args.categoryName) {
      const cat = await findCategoryByName(args.categoryName, ctx.access);
      if (!cat) return { error: `未找到分组「${String(args.categoryName)}」` };
      list = list.filter((n) => n.category_id === cat.id);
    }
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
    const categories = await categoriesApi.getCategories();
    const nameOf = (id: string | null) => categories.find(c => c.id === id)?.name || "未分类";
    return {
      total: list.length,
      notes: list.slice(0, limit).map((n) => ({
        id: n.id, title: n.title, category: nameOf(n.category_id), updated_at: n.updated_at,
        preview: String(n.content || "").replace(/\s+/g, " ").slice(0, 60),
      })),
    };
  },
  /** 读取"当前打开的笔记"，让"总结这篇/续写这篇"无需 ID */
  getCurrentNote: async (_args, ctx) => {
    const nid = String(ctx.currentNoteId ?? "");
    if (!nid) return { error: "当前没有打开任何笔记，请让用户先打开一篇或提供标题" };
    const n = await fetchNoteById(nid, ctx.access);
    return n ? readNoteWindow(n) : { error: `未找到 ID 为 ${nid} 的笔记` };
  },
  /**
   * 按行范围读取（长文的关键工具）。
   * 1000 行的笔记不必从头读到尾：只取需要的窗口，带行号返回，方便随后按行修改。
   */
  readNoteLines: async (args, ctx) => {
    const nid = String(args.noteId ?? args.id ?? "");
    if (!nid) return { error: "缺少 noteId" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /**
   * 在笔记里按内容定位行号（相当于 grep -n）。
   * 解决"这段话在第几行"：返回命中行号（可带上下文行），拿到行号后就能直接用
   * replaceLines/deleteLines 精确定位修改，完全不用把全文读进来。
   */
  findInNote: async (args, ctx) => {
    const nid = String(args.noteId ?? args.id ?? "");
    if (!nid) return { error: "缺少 noteId" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    const lines = String(n.content ?? "").split("\n");
    const caseSensitive = args.caseSensitive === true || args.caseSensitive === "true";
    const needle = caseSensitive ? query : query.toLowerCase();
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 50);
    // 注意：这里不能用 ctx 命名，参数里的 ctx 是 ToolContext
    const contextLines = Math.min(Math.max(Math.floor(Number(args.contextLines) || 0), 0), 3);
    const matches: { line: number; text: string; context?: string }[] = [];
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (!hay.includes(needle)) continue;
      const from = Math.max(0, i - contextLines);
      const to = Math.min(lines.length - 1, i + contextLines);
      matches.push({
        line: i + 1,
        text: lines[i].slice(0, 200),
        ...(contextLines > 0 ? { context: lines.slice(from, to + 1).map((l, k) => `${from + k + 1}| ${l}`).join("\n") } : {}),
      });
    }
    return {
      id: nid,
      title: n.title,
      totalLines: lines.length,
      query,
      count: matches.length,
      matches,
      ...(matches.length === 0
        ? { hint: "没有命中。这里用的是连续子串匹配，换更短的关键词（2~4 个字）再试。" }
        : { hint: "拿到行号后可直接用 replaceLines/deleteLines 精确修改，不要整篇覆盖。" }),
    };
  },
  /** 按行替换：只改指定行区间，前后内容原样保留（不必全文覆盖） */
  replaceLines: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const lines = String(n.content ?? "").split("\n");
    const from = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const to = Math.min(lines.length, Math.max(from, Math.floor(Number(args.endLine) || from)));
    const text = String(args.text ?? "");
    const newLines = text.length > 0 ? text.split("\n") : [];
    lines.splice(from - 1, to - from + 1, ...newLines);
    await notesApi.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已用 ${newLines.length} 行替换原第 ${from}-${to} 行`, from, from + Math.max(0, newLines.length - 1)),
    };
  },
  /** 在指定行之后插入内容；afterLine=0 表示插到最前面 */
  insertLines: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const lines = String(n.content ?? "").split("\n");
    const after = Math.min(lines.length, Math.max(0, Math.floor(Number(args.afterLine) || 0)));
    const text = String(args.text ?? "");
    const newLines = text.length > 0 ? text.split("\n") : [];
    if (newLines.length === 0) return { success: false, error: "插入内容为空" };
    lines.splice(after, 0, ...newLines);
    await notesApi.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已在第 ${after} 行后插入 ${newLines.length} 行`, after + 1, after + newLines.length),
    };
  },
  /** 按行删除 */
  deleteLines: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const lines = String(n.content ?? "").split("\n");
    const from = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const to = Math.min(lines.length, Math.max(from, Math.floor(Number(args.endLine) || from)));
    lines.splice(from - 1, to - from + 1);
    await notesApi.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已删除第 ${from}-${to} 行`, Math.max(1, from - 2), from + 2),
    };
  },
  /** 定点替换文本：适合改错别字、统一措辞、替换某个词（不必按行） */
  replaceInNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const oldText = String(args.oldText ?? "");
    const newText = String(args.newText ?? "");
    if (!oldText) return { success: false, error: "oldText 不能为空" };
    const content = String(n.content ?? "");
    const count = content.split(oldText).length - 1;
    if (count === 0) return { success: false, error: `正文里没有找到「${oldText.slice(0, 40)}」，请先读取确认原文` };
    const replaceAll = args.replaceAll === true || args.replaceAll === "true";
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    await notesApi.updateNote(nid, n.title, next, n.category_id ?? null);
    const lines = next.split("\n");
    const hitLine = lines.findIndex(l => l.includes(newText || oldText)) + 1;
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      replaced: replaceAll ? count : 1,
      message: noteEditReceipt(lines, `已替换 ${replaceAll ? count : 1} 处（共匹配 ${count} 处）`, Math.max(1, hitLine - 2), hitLine + 2),
    };
  },
  /** 在末尾追加内容（不覆盖原有正文），续写/补充信息比 updateNote 更安全 */
  appendToNote: async (args, ctx) => {
    const nid = String(args.noteId ?? ctx.currentNoteId ?? "");
    if (!nid) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const text = String(args.text ?? "").trim();
    if (!text) return { success: false, error: "追加内容为空" };
    const prev = String(n.content ?? "");
    const sep = prev && !prev.endsWith("\n") ? "\n\n" : "";
    await notesApi.updateNote(nid, n.title, `${prev}${sep}${text}`, n.category_id ?? null);
    return { success: true, id: nid, title: n.title, appendedLength: text.length };
  },
  /** 一次创建多篇笔记（例如把一段内容拆成若干篇） */
  createNotes: async (args, ctx) => {
    const raw: unknown[] = Array.isArray(args.notes) ? args.notes : [];
    if (raw.length === 0) return { success: false, error: "notes 为空，需要 [{title, content?, categoryName?}]" };
    const created: { id: string; title: string }[] = [];
    for (const item of raw.slice(0, 10)) {
      const it = (item || {}) as Record<string, unknown>;
      const cat = it.categoryName ? await findWritableCategoryByName(it.categoryName, ctx.access) : null;
      // 名字存在但分组受限时不能悄悄写到"未分类"，直接中止并说明原因
      if (it.categoryName && !cat) {
        return {
          success: false,
          error: `分组「${String(it.categoryName)}」不存在，或对 AI 不可写（可能被设为只读/禁止），批量创建已中止（此前已创建 ${created.length} 篇）`,
          created,
        };
      }
      const r = await notesApi.createNote(
        String(it.title ?? translate("无标题")),
        String(it.content ?? ""),
        cat?.id ?? null,
        ctx.defaultNoteAiAccess,
      );
      created.push({ id: r.id, title: r.title });
    }
    return { success: true, count: created.length, created };
  },
  createNote: async (args, ctx) => {
    const cat = args.categoryName ? await findWritableCategoryByName(args.categoryName, ctx.access) : null;
    if (args.categoryName && !cat) return { error: `分组「${String(args.categoryName)}」不存在，或对 AI 不可写（可能被设为只读/禁止）` };
    const r = await notesApi.createNote(
      String(args.title || ""),
      String(args.content || ""),
      cat?.id ?? null,
      ctx.defaultNoteAiAccess,
    );
    return { id: r.id, title: r.title };
  },
  updateNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    if (!nid) return { success: false, error: "缺少有效的 noteId，无法定位笔记" };
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const cat = args.categoryName ? await findWritableCategoryByName(args.categoryName, ctx.access) : null;
    if (args.categoryName && !cat) return { success: false, error: `分组「${String(args.categoryName)}」不存在，或对 AI 不可写（可能被设为只读/禁止）` };
    await notesApi.updateNote(nid, String(args.title ?? n.title), String(args.content ?? n.content), cat?.id ?? n.category_id ?? null);
    return { success: true, id: nid, title: String(args.title ?? n.title) };
  },
  updateCurrentNote: async (args, ctx) => {
    const nid = String(ctx.currentNoteId ?? "");
    if (!nid) {
      return { success: false, error: "当前没有打开的笔记，无法执行 updateCurrentNote" };
    }
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到当前笔记（ID ${nid}）` };
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const nextTitle = args.title !== undefined ? String(args.title) : n.title;
    const nextContent = args.content !== undefined ? String(args.content) : n.content;
    const cat = args.categoryName ? await findWritableCategoryByName(args.categoryName, ctx.access) : null;
    if (args.categoryName && !cat) return { success: false, error: `分组「${String(args.categoryName)}」不存在，或对 AI 不可写（可能被设为只读/禁止）` };
    await notesApi.updateNote(nid, nextTitle, nextContent, cat?.id ?? n.category_id ?? null);
    return { success: true, id: nid, title: nextTitle };
  },
  deleteNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    if (!nid) return { success: false, error: "缺少有效的 noteId" };
    // 先取出标题：轨迹里要能显示"删除笔记 #16 · 《XX》"，只有一个 ID 用户看不出删了什么
    // 顺带拦下受限笔记：取不到就直接拒，绝不先删再说
    const before = await fetchNoteById(nid, ctx.access);
    if (!before) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    if (!canAiWriteNote(ctx.access, before)) return { success: false, error: AI_READ_ONLY_NOTE };
    await notesApi.moveToTrash(nid);
    return { deleted: true, id: nid, title: before?.title ?? "", toTrash: true };
  },
  moveNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    const n = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    // 目标分组同样要过权限：不能把笔记搬进 AI 无权访问的分组（等于顺手解锁）
    const rawTarget = args.categoryId;
    const targetId = rawTarget === null || rawTarget === undefined || rawTarget === "" ? null : String(rawTarget);
    let category = "";
    if (targetId !== null) {
      const cats = await categoriesApi.getCategories();
      const target = cats.find((c) => c.id === targetId);
      if (!target) return { success: false, error: `未找到 ID 为 ${targetId} 的分组` };
      if (!canAiWriteCategory(ctx.access, target)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
      category = target.name || "";
    }
    await notesApi.updateNote(nid, n.title, n.content, targetId);
    return { moved: true, id: nid, title: n.title, category: category || "未分类" };
  },
  selectNote: async (args, ctx) => {
    const nid = String(args.noteId ?? "");
    if (!nid) return { selected: false, error: "缺少有效的 noteId" };
    // 先确认笔记存在再打开：否则"s打开成功"只是谎报，模型会以为已经打开而继续往下说
    const note = await fetchNoteById(nid, ctx.access);
    if (!note) return { selected: false, error: `未找到 ID 为 ${nid} 的笔记，请先用 searchNotes 确认 ID` };
    emitAppEvent('fastnote-select-note', { noteId: nid });
    return { selected: true, noteId: nid, title: note.title };
  },
};
