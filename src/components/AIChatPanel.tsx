import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { Icon } from "./Icon";
import * as api from "../api";
import { AiChatMessage, AiChatSession, AiProvider, AiPromptEntry, AiSettings } from "../types";
import {
  buildFinalContent,
  cleanSessionTitle,
  compressTranscript,
  estimateTokens,
  finalReplyText,
  firstLine,
  formatError,
  hasActionClaim,
  isThinkingDeepEnough,
  localSummaryFallback,
  parseResponse,
  parseStreamContent,
  selectContextWindow,
  shouldRetryForShallowThinking,
  streamStartsWithThinking,
  stripAiTags,
  type ToolCall,
  type ToolTrace,
} from "../aiChatParse";
import { useToast } from "./Toast";
import { MdPreview } from "md-editor-rt";
import "md-editor-rt/lib/style.css";
import {
  AI_SYSTEM_PROMPT,
  CLAIM_WITHOUT_TOOLS_NOTICE,
  CONTEXT_SUMMARY_PROMPT,
  MIN_THINKING_LEN,
  SUMMARY_INJECT_PREFIX,
  THINKING_RETRY_MIN_LEN,
  TITLE_USER_MESSAGE,
  TOOL_DEFS,
  TOOL_RESULT_MAX_CHARS,
  TRUNCATED_TOOL_CALL_NOTICE,
  UNLIMITED_ROUND_SAFETY,
  buildMemoryBlock,
  buildShallowThinkingNotice,
  buildSummaryUserMessage,
  buildThinkRule,
  buildTitlePrompt,
  buildToolResultMessage,
} from "../config/aiDefaults";

interface AIChatPanelProps {
  isOpen: boolean;
  noteTitle: string;
  noteContent: string;
  /** 当前打开笔记的 ID：AI 用它精确定位"这篇笔记"，避免同名笔记歧义 */
  currentNoteId?: number | null;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  /** 把 AI 回复当作临时内容在编辑器里打开（只预览，不写入笔记） */
  onOpenInEditor: (title: string, content: string) => void;
  onOpenProviderSettings: () => void;
  /** 打开「AI 记忆 / 前置提示词」设置 */
  onOpenAiMemory: () => void;
  /** 用户自定义的前置提示词与长期记忆（启用中的会追加到系统提示词） */
  aiPrompts: AiPromptEntry[];
  /** 统一设置窗口里的 AI 设置 */
  aiSettings: AiSettings;
  /** 设置里可改的项通过这个回调回写（例如拖动输入区高度） */
  onAiSettingsChange?: (patch: Partial<AiSettings>) => void;
  /** 关闭面板 */
  onClose?: () => void;
}

const MIN_PANEL_WIDTH = 350; const MAX_PANEL_WIDTH = 640; const DEFAULT_PANEL_WIDTH = 400;
/** 内容区保底宽度：面板上限 = 可用宽度(窗口宽 − 侧栏) − 该值，窗口越宽面板越能放宽 */
const CONTENT_MIN_WIDTH = 455;
/** 距底部小于该像素即视为"贴底"，此时才自动跟随最新回复 */
const STICK_BOTTOM_THRESHOLD = 48;
/** 阅读线：容器顶部往下这么多像素以内的最后一条用户消息，就是"当前所在的历史段落" */
const ANCHOR_READING_LINE = 40;
/** 点击锚点后目标消息距容器顶部的留白 */
const ANCHOR_JUMP_OFFSET = 8;
/** 单条锚点提示最多显示的字数 */
const ANCHOR_PREVIEW_LEN = 80;

/** 工具调用的中文短标签：回复上方以紧凑轨迹展示，一眼能看清到底做了什么 */
const TOOL_LABELS: Record<string, string> = {
  searchNotes: "搜索笔记",
  listNotes: "列出笔记",
  getNoteContent: "读取笔记",
  getCurrentNote: "读取当前笔记",
  readNoteLines: "读取行范围",
  findInNote: "定位行号",
  getCategories: "读取分组",
  listTrash: "查看回收站",
  createNote: "创建笔记",
  createNotes: "批量创建笔记",
  appendToNote: "追加内容",
  updateNote: "修改笔记",
  updateCurrentNote: "修改当前笔记",
  replaceLines: "按行替换",
  insertLines: "插入内容",
  deleteLines: "删除行",
  replaceInNote: "替换文本",
  deleteNote: "删除笔记",
  restoreNote: "还原笔记",
  deleteFromTrash: "彻底删除",
  emptyTrash: "清空回收站",
  createCategory: "创建分组",
  renameCategory: "重命名分组",
  deleteCategory: "删除分组",
  moveNote: "移动笔记",
  selectNote: "打开笔记",
};

/** 工具轨迹右侧的目标信息：执行前用入参，执行后用结果把它补得更具体 */
const toolDetail = (name: string, args: Record<string, unknown>, result: unknown): string => {
  const isObj = !!result && typeof result === "object";
  const r = (isObj && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  const arr = Array.isArray(result) ? (result as Record<string, unknown>[]) : null;
  const rawTitle = (typeof r.title === "string" && r.title) || (args.title !== undefined ? String(args.title) : "");
  const title = rawTitle ? `《${String(rawTitle).slice(0, 18)}》` : "";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
  const clip = (v: unknown, n = 22) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const head = (id: unknown) => (id !== undefined && id !== null && id !== "" && Number.isFinite(Number(id)) ? `#${id}` : "");
  /** 目标笔记的统一写法：#ID · 《标题》（结果里的 id/noteId 都认，标题也可以从入参兜底） */
  const target = [head(r.id ?? r.noteId ?? args.noteId), title].filter(Boolean).join(" · ");
  /** 失败时轨迹上直接显示原因（红色行），不用点开才知道 */
  const failure = typeof r.error === "string" && r.error ? `失败：${clip(r.error, 40)}` : "";
  switch (name) {
    case "selectNote":
      return target ? `已打开 ${target}` : failure;
    case "getNoteContent":
    case "getCurrentNote":
    case "readNoteLines": {
      // 读了哪几行、整篇多大：这是"读取笔记"最该让用户看到的信息
      const range = typeof r.lines === "string" ? r.lines : "";
      const total = num(r.totalLines);
      const chars = num(r.totalChars);
      const parts = [target];
      if (range) parts.push(`第 ${range} 行`);
      if (Number.isFinite(total) && total > 0) parts.push(`共 ${total} 行`);
      if (Number.isFinite(chars) && chars > 0 && !range) parts.push(`${chars} 字`);
      return parts.filter(Boolean).join(" · ") || failure;
    }
    case "findInNote": {
      const count = num(r.count);
      const lines = Array.isArray(r.matches)
        ? (r.matches as { line?: unknown }[]).map((m) => num(m.line)).filter((n) => Number.isFinite(n)).slice(0, 6)
        : [];
      const parts = [target, args.query ? `「${clip(args.query, 14)}」` : ""];
      if (Number.isFinite(count)) parts.push(`命中 ${count} 处`);
      if (lines.length > 0) parts.push(`第 ${lines.join("、")}${count > lines.length ? "…" : ""} 行`);
      return parts.filter(Boolean).join(" · ");
    }
    case "replaceLines": {
      const total = num(r.totalLines);
      return [target, `改第 ${args.startLine}-${args.endLine} 行`, Number.isFinite(total) ? `现共 ${total} 行` : ""].filter(Boolean).join(" · ");
    }
    case "insertLines": {
      const total = num(r.totalLines);
      const text = String(args.text ?? "");
      return [target, `第 ${args.afterLine} 行后插入 ${text ? text.split("\n").length : 0} 行`, Number.isFinite(total) ? `现共 ${total} 行` : ""].filter(Boolean).join(" · ");
    }
    case "deleteLines": {
      const total = num(r.totalLines);
      return [target, `删第 ${args.startLine}-${args.endLine} 行`, Number.isFinite(total) ? `现共 ${total} 行` : ""].filter(Boolean).join(" · ");
    }
    case "replaceInNote": {
      const replaced = num(r.replaced);
      return [target, `替换 ${Number.isFinite(replaced) ? replaced : 1} 处`, args.oldText ? `「${clip(args.oldText, 12)}」` : ""].filter(Boolean).join(" · ");
    }
    case "appendToNote": {
      const len = num(r.appendedLength);
      return [target, Number.isFinite(len) ? `追加 ${len} 字` : args.text ? `追加 ${String(args.text).length} 字` : ""].filter(Boolean).join(" · ");
    }
    case "createNote":
    case "updateNote":
    case "updateCurrentNote": {
      // 写操作要说清"改了哪些字段"，光一个标题看不出做了什么
      const changed: string[] = [];
      if (name !== "createNote") {
        if (args.title !== undefined) changed.push("标题");
        if (args.content !== undefined) changed.push("正文");
        if (args.categoryName !== undefined) changed.push("分组");
      } else if (args.content) {
        changed.push(`${String(args.content).length} 字`);
      }
      return [target, changed.length > 0 ? changed.join("/") : ""].filter(Boolean).join(" · ");
    }
    case "createNotes": {
      const created = Array.isArray(r.created) ? (r.created as { id?: unknown; title?: unknown }[]) : [];
      if (created.length > 0) {
        const names = created.slice(0, 3).map((c) => `#${c.id}《${clip(c.title, 10)}》`).join("、");
        return `创建 ${created.length} 篇：${names}${created.length > 3 ? "…" : ""}`;
      }
      return Array.isArray(args.notes) ? `${(args.notes as unknown[]).length} 篇` : "";
    }
    case "getCategories": {
      const list = Array.isArray(result) ? (result as { name?: unknown }[]) : [];
      const names = list.slice(0, 3).map((c) => clip(c.name, 8)).join("、");
      return list.length > 0 ? `${list.length} 个分组${names ? `：${names}${list.length > 3 ? "…" : ""}` : ""}` : "";
    }
    case "moveNote": {
      const to = typeof r.category === "string" && r.category ? `→「${clip(r.category, 12)}」` : args.categoryId !== undefined ? `→分组 #${args.categoryId}` : "";
      return [head(r.id ?? args.noteId), to].filter(Boolean).join(" ");
    }
    case "emptyTrash": {
      const deleted = num(r.deleted);
      return Number.isFinite(deleted) ? `清空 ${deleted} 篇` : "";
    }
    case "searchNotes": {
      const q = args.query ? `「${clip(args.query, 14)}」` : "";
      const total = num(r.total);
      const fuzzy = r.fuzzy === true ? "（模糊）" : "";
      return [q + fuzzy, Number.isFinite(total) ? `命中 ${total} 篇` : ""].filter(Boolean).join(" · ");
    }
    case "listNotes": {
      const scope = args.categoryName ? `「${clip(args.categoryName)}」` : "全部";
      const total = num(r.total);
      const shown = Array.isArray(r.notes) ? r.notes.length : NaN;
      return [scope, Number.isFinite(total) ? `${total} 篇${Number.isFinite(shown) ? `（列出 ${shown}）` : ""}` : ""].filter(Boolean).join(" · ");
    }
    case "listTrash": {
      const total = num(r.total);
      return Number.isFinite(total) ? `${total} 篇` : "";
    }
    case "deleteNote":
      return [target, "已移入回收站（可还原）"].filter(Boolean).join(" · ") || failure;
    case "restoreNote":
      return [target, "已还原"].filter(Boolean).join(" · ") || failure;
    case "deleteFromTrash":
      return [target, "已彻底删除（不可恢复）"].filter(Boolean).join(" · ") || failure;
    case "createCategory":
      return [head(r.id), args.name ? `「${clip(args.name)}」` : ""].filter(Boolean).join(" · ") || failure;
    case "renameCategory":
      return [head(r.id ?? args.categoryId), args.name ? `改名为「${clip(args.name)}」` : ""].filter(Boolean).join(" · ") || failure;
    case "deleteCategory": {
      const cnt = num(r.noteCount);
      const mode = r.notesMovedToTrash === true ? (Number.isFinite(cnt) && cnt > 0 ? `组内 ${cnt} 篇已移入回收站` : "组内笔记已移入回收站") : "组内笔记已变为未分类";
      return [head(r.id ?? args.categoryId), r.name ? `「${clip(r.name)}」` : "", mode].filter(Boolean).join(" · ") || failure;
    }
    default: {
      // 兜底：任何工具都至少说清"做了什么/多大/几项"，不留空白
      if (failure) return failure;
      if (arr) return `${arr.length} 项`;
      if (target) return target;
      const keys = Object.keys(r).filter(k => k !== "success" && k !== "note");
      if (keys.length > 0) return clip(JSON.stringify(r), 40);
      return r.note ? clip(r.note, 40) : "已完成";
    }
  }
};


/** Generate a human-readable summary of a tool call for the confirm dialog */
const summarizeToolCall = (c: ToolCall): string => {
  switch (c.name) {
    case "createNote":
      return `创建笔记「${(String(c.args.title || "")).substring(0, 30)}」并填入内容`;
    case "updateNote": {
      const parts: string[] = [];
      if (c.args.title) parts.push(`标题：「${String(c.args.title).substring(0, 30)}」`);
      if (c.args.content) parts.push(`内容已更新`);
      if (c.args.categoryName) parts.push(`移至分组「${String(c.args.categoryName)}」`);
      return `修改笔记 #${c.args.noteId}${parts.length > 0 ? `（${parts.join("，")}）` : ""}`;
    }
    case "updateCurrentNote": {
      const parts: string[] = [];
      if (c.args.title) parts.push(`标题改为「${String(c.args.title).substring(0, 30)}」`);
      if (c.args.content) parts.push(`正文将被覆盖`);
      if (c.args.categoryName) parts.push(`移至分组「${String(c.args.categoryName)}」`);
      return `修改当前打开的笔记${parts.length > 0 ? `（${parts.join("，")}）` : ""}`;
    }
    case "deleteNote":
      return `删除笔记 #${c.args.noteId}`;
    case "replaceLines":
      return `替换笔记 #${c.args.noteId} 的第 ${c.args.startLine}-${c.args.endLine} 行（只改这一段，其余保留）`;
    case "insertLines":
      return `在笔记 #${c.args.noteId} 第 ${c.args.afterLine} 行后插入内容（约 ${String(c.args.text || "").length} 字）`;
    case "deleteLines":
      return `删除笔记 #${c.args.noteId} 的第 ${c.args.startLine}-${c.args.endLine} 行`;
    case "replaceInNote": {
      const all = c.args.replaceAll === true || c.args.replaceAll === "true";
      return `在笔记 #${c.args.noteId} 里把「${String(c.args.oldText || "").slice(0, 20)}」替换为「${String(c.args.newText || "").slice(0, 20)}」${all ? "（全部匹配）" : "（仅第一处）"}`;
    }
    case "restoreNote":
      return `从回收站还原笔记 #${c.args.noteId}`;
    case "deleteFromTrash":
      return `彻底删除回收站中的笔记 #${c.args.noteId}（不可恢复）`;
    case "emptyTrash":
      return `清空回收站（不可恢复）`;
    case "appendToNote": {
      const target = c.args.noteId ? `笔记 #${c.args.noteId}` : "当前打开的笔记";
      return `在${target}末尾追加内容（约 ${String(c.args.text || "").length} 字）`;
    }
    case "createNotes": {
      const n = Array.isArray(c.args.notes) ? (c.args.notes as unknown[]).length : 0;
      return `一次创建 ${n} 篇笔记`;
    }
    case "createCategory":
      return `创建分组「${String(c.args.name || "").substring(0, 20)}」`;
    case "renameCategory":
      return `重命名分组为「${String(c.args.name || "").substring(0, 20)}」`;
    case "deleteCategory":
      return c.args.deleteNotes === true || c.args.deleteNotes === "true"
        ? `删除分组（组内笔记移入回收站，可还原）`
        : `删除分组（组内笔记变为未分类）`;
    case "moveNote":
      return `移动笔记到其他分组`;
    default:
      return c.name;
  }
};

/**
 * 工具执行上下文：把"当前打开的笔记"等易变状态显式传进来，
 * 而不是让执行器去读模块级可变变量——后者是全局状态，没法隔离也没法测。
 */
interface ToolContext {
  /** 用户此刻正在看的笔记 ID（"这篇笔记"的指代对象） */
  currentNoteId: number | null;
}

/** 读取服务商在设置中勾选的可用模型（兼容只有单个 enabled_model 的旧数据） */
const getEnabledModels = (provider: AiProvider): string[] => {
  const list = (provider.enabled_models || []).filter((m) => m && m.trim());
  const unique = [...new Set(list)];
  if (unique.length > 0) return unique;
  return provider.enabled_model ? [provider.enabled_model] : [];
};

/** 本次对话使用的模型：优先已选值，未选/已失效时回退到勾选列表第一项 */
const activeModelOf = (provider: AiProvider | null, enabled: string[]): string => {
  if (!provider || enabled.length === 0) return "";
  return provider.enabled_model && enabled.includes(provider.enabled_model)
    ? provider.enabled_model
    : enabled[0];
};

/** 按 ID 精确读取单条笔记（同名笔记也不会取错） */
const fetchNoteById = async (noteId: number) => {
  const all = await api.getNotes(null, "updated_at", "desc");
  return all.find((n: any) => n.id === noteId && !n.is_deleted) || null;
};

/** 按名称解析分组 ID；未找到时返回 undefined（保持原分组） */
const resolveCategoryId = async (categoryName: unknown): Promise<number | null | undefined> => {
  if (!categoryName) return undefined;
  const cats = await api.getCategories();
  const hit = cats.find((c: any) => c.name === String(categoryName));
  return hit ? hit.id : undefined;
};

const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>> = {
  searchNotes: async (args) => {
    const all = await api.getNotes(null, "updated_at", "desc");
    const q = String(args.query || "").trim().toLowerCase();
    const visible = all.filter((n: any) => !n.is_deleted);
    const hay = (n: any) => `${n.title || ""}\n${n.content || ""}`.toLowerCase();
    // 先做严格的连续子串匹配
    let hits = q ? visible.filter((n: any) => hay(n).includes(q)) : visible;
    let fuzzy = false;
    // 命中为空时退化为宽松匹配：中文按"每个字都出现"，英文按"每个词都出现"。
    // 否则"浏览器渲染"匹配不到标题《浏览器是如何渲染页面的？》（中间隔了"是如何"）。
    if (hits.length === 0 && q) {
      const cjkChars = [...new Set(q.split("").filter(ch => /[\u4e00-\u9fff]/.test(ch)))];
      const words = q.split(/\s+/).filter(t => t.length >= 2);
      const key = cjkChars.length >= 2 ? cjkChars : words;
      if (key.length >= 2) {
        hits = visible.filter((n: any) => key.every(k => hay(n).includes(k)));
        fuzzy = hits.length > 0;
      }
    }
    // 同名笔记会让"按标题操作"产生歧义，显式提示模型并要求用户确认
    const titleCounts = new Map<string, number>();
    for (const n of hits) titleCounts.set(n.title, (titleCounts.get(n.title) || 0) + 1);
    const duplicateTitles = [...titleCounts.entries()].filter(([, c]) => c > 1).map(([t]) => t);
    return {
      matches: hits.slice(0, 15).map((n: any) => ({ id: n.id, title: n.title, content: n.content ? n.content.substring(0, 100) : "", category_id: n.category_id })),
      total: hits.length,
      duplicateTitles,
      ...(fuzzy
        ? { fuzzy: true, note: "以上为宽松匹配（关键词不是连续子串），请核对标题确认是不是用户指的那一篇。" }
        : {}),
      ...(duplicateTitles.length > 0
        ? { warning: `存在同名笔记（${duplicateTitles.join("、")}）。标题无法唯一定位，必须让用户确认要操作哪一个 ID。` }
        : {}),
    };
  },
  getNoteContent: async (args) => {
    const n: any = await fetchNoteById(Number(args.noteId));
    if (!n) return null;
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /** 列出笔记（按更新时间倒序，可限定分组与条数）：回答"我最近记了什么/某个分组里有什么" */
  listNotes: async (args) => {
    const all = await api.getNotes(null, "updated_at", "desc");
    let list = all.filter((n: any) => !n.is_deleted);
    if (args.categoryName) {
      const cid = await resolveCategoryId(args.categoryName);
      if (cid === undefined) return { error: `未找到分组「${String(args.categoryName)}」` };
      list = list.filter((n: any) => n.category_id === cid);
    }
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
    const categories = await api.getCategories();
    const nameOf = (id: number | null) => categories.find(c => c.id === id)?.name || "未分类";
    return {
      total: list.length,
      notes: list.slice(0, limit).map((n: any) => ({
        id: n.id, title: n.title, category: nameOf(n.category_id), updated_at: n.updated_at,
        preview: String(n.content || "").replace(/\s+/g, " ").slice(0, 60),
      })),
    };
  },
  /** 读取"当前打开的笔记"，让"总结这篇/续写这篇"无需 ID */
  getCurrentNote: async (_args, ctx) => {
    const nid = Number(ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "当前没有打开任何笔记，请让用户先打开一篇或提供标题" };
    const n: any = await fetchNoteById(nid);
    return n ? readNoteWindow(n) : { error: `未找到 ID 为 ${nid} 的笔记` };
  },
  /**
   * 按行范围读取（长文的关键工具）。
   * 1000 行的笔记不必从头读到尾：只取需要的窗口，带行号返回，方便随后按行修改。
   */
  readNoteLines: async (args) => {
    const nid = Number(args.noteId ?? args.id);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "缺少 noteId" };
    const n: any = await fetchNoteById(nid);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /**
   * 在笔记里按内容定位行号（相当于 grep -n）。
   * 解决"这段话在第几行"：返回命中行号（可带上下文行），拿到行号后就能直接用
   * replaceLines/deleteLines 精确定位修改，完全不用把全文读进来。
   */
  findInNote: async (args) => {
    const nid = Number(args.noteId ?? args.id);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "缺少 noteId" };
    const n: any = await fetchNoteById(nid);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    const lines = String(n.content ?? "").split("\n");
    const caseSensitive = args.caseSensitive === true || args.caseSensitive === "true";
    const needle = caseSensitive ? query : query.toLowerCase();
    const limit = Math.min(Math.max(Math.floor(Number(args.limit) || 20), 1), 50);
    const ctx = Math.min(Math.max(Math.floor(Number(args.contextLines) || 0), 0), 3);
    const matches: { line: number; text: string; context?: string }[] = [];
    for (let i = 0; i < lines.length && matches.length < limit; i++) {
      const hay = caseSensitive ? lines[i] : lines[i].toLowerCase();
      if (!hay.includes(needle)) continue;
      const from = Math.max(0, i - ctx);
      const to = Math.min(lines.length - 1, i + ctx);
      matches.push({
        line: i + 1,
        text: lines[i].slice(0, 200),
        ...(ctx > 0 ? { context: lines.slice(from, to + 1).map((l, k) => `${from + k + 1}| ${l}`).join("\n") } : {}),
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
  replaceLines: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const lines = String(n.content ?? "").split("\n");
    const from = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const to = Math.min(lines.length, Math.max(from, Math.floor(Number(args.endLine) || from)));
    const text = String(args.text ?? "");
    const newLines = text.length > 0 ? text.split("\n") : [];
    lines.splice(from - 1, to - from + 1, ...newLines);
    await api.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已用 ${newLines.length} 行替换原第 ${from}-${to} 行`, from, from + Math.max(0, newLines.length - 1)),
    };
  },
  /** 在指定行之后插入内容；afterLine=0 表示插到最前面 */
  insertLines: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const lines = String(n.content ?? "").split("\n");
    const after = Math.min(lines.length, Math.max(0, Math.floor(Number(args.afterLine) || 0)));
    const text = String(args.text ?? "");
    const newLines = text.length > 0 ? text.split("\n") : [];
    if (newLines.length === 0) return { success: false, error: "插入内容为空" };
    lines.splice(after, 0, ...newLines);
    await api.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已在第 ${after} 行后插入 ${newLines.length} 行`, after + 1, after + newLines.length),
    };
  },
  /** 按行删除 */
  deleteLines: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const lines = String(n.content ?? "").split("\n");
    const from = Math.max(1, Math.floor(Number(args.startLine) || 1));
    const to = Math.min(lines.length, Math.max(from, Math.floor(Number(args.endLine) || from)));
    lines.splice(from - 1, to - from + 1);
    await api.updateNote(nid, n.title, lines.join("\n"), n.category_id ?? null);
    return {
      success: true,
      id: nid,
      title: n.title,
      totalLines: lines.length,
      message: noteEditReceipt(lines, `已删除第 ${from}-${to} 行`, Math.max(1, from - 2), from + 2),
    };
  },
  /** 定点替换文本：适合改错别字、统一措辞、替换某个词（不必按行） */
  replaceInNote: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const oldText = String(args.oldText ?? "");
    const newText = String(args.newText ?? "");
    if (!oldText) return { success: false, error: "oldText 不能为空" };
    const content = String(n.content ?? "");
    const count = content.split(oldText).length - 1;
    if (count === 0) return { success: false, error: `正文里没有找到「${oldText.slice(0, 40)}」，请先读取确认原文` };
    const replaceAll = args.replaceAll === true || args.replaceAll === "true";
    const next = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    await api.updateNote(nid, n.title, next, n.category_id ?? null);
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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const text = String(args.text ?? "").trim();
    if (!text) return { success: false, error: "追加内容为空" };
    const prev = String(n.content ?? "");
    const sep = prev && !prev.endsWith("\n") ? "\n\n" : "";
    await api.updateNote(nid, n.title, `${prev}${sep}${text}`, n.category_id ?? null);
    return { success: true, id: nid, title: n.title, appendedLength: text.length };
  },
  /** 查看回收站 */
  listTrash: async () => {
    const notes: any[] = await api.getTrashNotes();
    return {
      total: notes.length,
      notes: notes.slice(0, 20).map((n) => ({ id: n.id, title: n.title, deleted_at: n.deleted_at })),
    };
  },
  /** 从回收站还原笔记 */
  restoreNote: async (args) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    // 从回收站列表里取标题（回收站里的笔记用 get_note_content 不一定可靠）
    let title = "";
    try {
      const trashed: any[] = await api.getTrashNotes();
      title = trashed.find(n => n.id === nid)?.title || "";
    } catch {}
    await api.restoreNote(nid);
    return { success: true, id: nid, title, restored: true };
  },
  /** 彻底删除回收站中的某篇笔记（不可恢复） */
  deleteFromTrash: async (args) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    const trashed: any[] = await api.getTrashNotes();
    const target = trashed.find(n => n.id === nid);
    if (!target) return { success: false, error: `回收站里没有 ID 为 ${nid} 的笔记（先用 listTrash 确认）` };
    await api.deleteNotePermanently(nid);
    return { success: true, id: nid, title: target.title, permanent: true };
  },
  /** 清空回收站（不可恢复） */
  emptyTrash: async () => {
    const trashed: any[] = await api.getTrashNotes();
    if (trashed.length === 0) return { success: true, deleted: 0, note: "回收站本来就是空的" };
    await api.deleteMultipleNotesPermanently(trashed.map(n => n.id));
    return { success: true, deleted: trashed.length };
  },
  /** 一次创建多篇笔记（例如把一段内容拆成若干篇） */
  createNotes: async (args) => {
    const raw = Array.isArray(args.notes) ? (args.notes as any[]) : [];
    if (raw.length === 0) return { success: false, error: "notes 为空，需要 [{title, content?, categoryName?}]" };
    const created: { id: number; title: string }[] = [];
    for (const item of raw.slice(0, 10)) {
      const it: any = item || {};
      const cid = await resolveCategoryId(it.categoryName);
      const r = await api.createNote(String(it.title ?? "无标题"), String(it.content ?? ""), cid ?? null);
      created.push({ id: r.id, title: r.title });
    }
    return { success: true, count: created.length, created };
  },
  getCategories: async () => { const cats = await api.getCategories(); return cats.map((c: any) => ({ id: c.id, name: c.name })); },
  createNote: async (args) => { const cid = await resolveCategoryId(args.categoryName); const r = await api.createNote(String(args.title || ""), String(args.content || ""), cid ?? null); return { id: r.id, title: r.title }; },
  updateNote: async (args) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId，无法定位笔记" };
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    const cid = await resolveCategoryId(args.categoryName);
    await api.updateNote(nid, String(args.title ?? n.title), String(args.content ?? n.content), cid ?? n.category_id ?? null);
    return { success: true, id: nid, title: String(args.title ?? n.title) };
  },
  updateCurrentNote: async (args, ctx) => {
    const nid = Number(ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) {
      return { success: false, error: "当前没有打开的笔记，无法执行 updateCurrentNote" };
    }
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到当前笔记（ID ${nid}）` };
    const nextTitle = args.title !== undefined ? String(args.title) : n.title;
    const nextContent = args.content !== undefined ? String(args.content) : n.content;
    const cid = await resolveCategoryId(args.categoryName);
    await api.updateNote(nid, nextTitle, nextContent, cid ?? n.category_id ?? null);
    return { success: true, id: nid, title: nextTitle };
  },
  deleteNote: async (args) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    // 先取出标题：轨迹里要能显示"删除笔记 #16 · 《XX》"，只有一个 ID 用户看不出删了什么
    const before: any = await fetchNoteById(nid);
    await api.moveToTrash(nid);
    return { deleted: true, id: nid, title: before?.title ?? "", toTrash: true };
  },
  createCategory: async (args) => { const r = await api.createCategory(String(args.name)); return { id: r.id, name: r.name }; },
  renameCategory: async (args) => { await api.updateCategory(Number(args.categoryId), String(args.name)); return { id: Number(args.categoryId), name: args.name }; },
  /**
   * 删除分组。deleteNotes=true 时组内笔记会被移入回收站（不是彻底删除，仍可还原）；
   * false（默认）则只解除归类，笔记留在"未分类"里。
   */
  deleteCategory: async (args) => {
    const cid = Number(args.categoryId);
    if (!Number.isFinite(cid)) return { success: false, error: "缺少有效的 categoryId" };
    const withNotes = args.deleteNotes === true || args.deleteNotes === "true";
    // 先取分组名与组内笔记数：轨迹要显示"删除分组「读书」· 组内 3 篇移入回收站"
    let name = "";
    let noteCount = 0;
    try {
      const cats: any[] = await api.getCategories();
      const hit = cats.find(c => c.id === cid);
      name = hit?.name || "";
      noteCount = Number(hit?.note_count || 0);
      if (!name && !hit) return { success: false, error: `未找到 ID 为 ${cid} 的分组` };
    } catch {}
    await api.deleteCategory(cid, withNotes);
    return {
      deleted: true,
      id: cid,
      name,
      noteCount,
      notesMovedToTrash: withNotes,
      note: withNotes ? "组内笔记已移入回收站（可还原，未被彻底删除）" : "组内笔记已变为未分类",
    };
  },
  moveNote: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    await api.updateNote(nid, n.title, n.content, Number(args.categoryId));
    // 带上目标分组名：这样界面上能看到"移动笔记 #29 → 「读书笔记」"，而不是只有一个 ID
    let category = "";
    try {
      const cats = await api.getCategories();
      category = cats.find((c: any) => c.id === Number(args.categoryId))?.name || "";
    } catch {}
    return { moved: true, id: nid, title: n.title, category };
  },
  selectNote: async (args) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid) || nid <= 0) return { selected: false, error: "缺少有效的 noteId" };
    // 先确认笔记存在再打开：否则"s打开成功"只是谎报，模型会以为已经打开而继续往下说
    const note: any = await fetchNoteById(nid);
    if (!note) return { selected: false, error: `未找到 ID 为 ${nid} 的笔记，请先用 searchNotes 确认 ID` };
    window.dispatchEvent(new CustomEvent('fastnote-select-note', { detail: { noteId: nid } }));
    return { selected: true, noteId: nid, title: note.title };
  },
};



/** 消息操作按钮：只有小图标、不带文字 */
const MSG_ACTION_BTN =
  "inline-flex items-center justify-center p-1 rounded-lg text-slate-400 hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-95";

/** 复制图标 */
const CopyIcon = ({ className = "w-3.5 h-3.5" }: { className?: string }) => (
  <Icon name="ai-copy" className={className} />
);

/**
 * 一条消息占用的 token 估算。AI 回复把「思考过程 + 工具调用与结果」一并计入，
 * 因为它们同样要回传给模型、同样占上下文。
 * 复用上下文预算的同一套估算规则，保证两处口径一致。
 */
const msgTokens = (msg: AiChatMessage & { thinking?: string; tools?: ToolTrace[] }): number => {
  const parts = [msg.content || ""];
  if (msg.thinking) parts.push(msg.thinking);
  if (msg.tools?.length) parts.push(JSON.stringify(msg.tools));
  return estimateTokens(parts.join("\n"));
};

/** token 数展示：过千用 k，避免窄面板里挤出一长串数字 */
const formatTokens = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * 单条消息（用户气泡 / AI 无气泡回复）。
 * 用 memo 隔离是非常关键的性能优化：流式输出时 streamingContent 每 50ms 变一次，
 * 若不隔离，历史消息里的每一个 MdPreview（markdown 重解析）都会被重新渲染一遍，界面就会卡。
 */
const ChatMessageRow = memo(function ChatMessageRow({
  msg, index, expanded, toolOpen, isSending, showToolTrace, onToggleThinking, onToggleTool, onInsertText, onReplaceContent, onCopyText, onOpenInEditor,
}: {
  msg: AiChatMessage & { thinking?: string; tools?: ToolTrace[]; at?: number; thinkMs?: number };
  index: number;
  expanded: boolean;
  /** 这一行自己的工具展开状态（按行传入，切换某一行不会让整列重渲染） */
  toolOpen: Record<string, boolean>;
  isSending: boolean;
  /** 是否显示工具执行轨迹（设置里可关） */
  showToolTrace: boolean;
  onToggleThinking: (i: number) => void;
  onToggleTool: (key: string) => void;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  onCopyText: (text: string) => void;
  /** 在编辑器里临时打开这条 AI 回复 */
  onOpenInEditor: (content: string) => void;
}) {
  const msgThinking = msg.thinking;
  const msgTools = msg.tools;
  const delay = `${Math.min(index, 5) * 15}ms`;
  /** 底部元信息：时间 · 用时 · token（AI 回复的 token 含思考过程与工具调用） */
  const metaText = [
    msg.at ? formatMessageTime(msg.at) : "",
    msg.thinkMs ? `用时 ${(msg.thinkMs / 1000).toFixed(1)}s` : "",
    `${formatTokens(msgTokens(msg))} tok`,
  ].filter(Boolean).join(" · ");

  if (msg.role === 'user') {
    // 用户消息：浅色气泡、右对齐（对齐主流编程 Agent 的样式）
    return (
      <div data-chat-anchor="true" className="group/msg flex flex-col items-end animate-fade-in" style={{ animationDelay: delay }}>
        <div className="selectable rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap bg-slate-100 text-slate-700 max-w-[85%]">{msg.content}</div>
        <div className="mt-0.5 mr-1 flex items-center gap-0.5">
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-slate-300 tabular-nums select-none" title="整条消息的估算 token">{msg.at ? `${formatMessageTime(msg.at)} · ` : ""}{formatTokens(msgTokens(msg))} tok</span>
          <button
            onClick={() => onCopyText(msg.content)}
            className={MSG_ACTION_BTN}
            title="复制消息"
          >
            <CopyIcon />
          </button>
        </div>
      </div>
    );
  }

  // AI 回复：无气泡、无头像、无名字，整段正文直接铺在面板上（同主流编程 Agent）
  return (
    <div className="group/msg animate-fade-in space-y-0.5" style={{ animationDelay: delay }}>
      {msgThinking ? (
        <div className="group/thinking">
          <button
            onClick={() => onToggleThinking(index)}
            className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-slate-400 hover:text-slate-600 transition-colors py-0.5"
            title={expanded ? "收起思考过程" : "展开思考过程"}
          >
            <Icon name="ai-lightbulb" className="w-3 h-3 flex-shrink-0" />
            <span className="flex-shrink-0">思考</span>
            {/* 预览始终保留：展开/收起只靠右侧箭头旋转表示，不要把内容换成"收起"两个字 */}
            <span className="text-slate-300 flex-shrink-0">·</span>
            <span className="min-w-0 flex-1 truncate">{firstLine(msgThinking)}</span>
            <span className="flex-shrink-0 text-[10.5px] text-slate-300 opacity-0 group-hover/thinking:opacity-100 transition-opacity">
              {expanded ? "收起" : "展开"}
            </span>
            <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 transition-transform " + (expanded ? "rotate-90" : "")} />
          </button>
          {expanded && (<div className="thinking-body chat-scrollbar mt-0.5 px-3 py-2 bg-slate-50 rounded-lg text-xs text-slate-500 leading-relaxed whitespace-pre-wrap border border-slate-100">{msgThinking}</div>)}
        </div>
      ) : null}
      {/* 实际执行过的工具：一条工具一行，点击展开可看调用 JSON 与执行结果 */}
      {showToolTrace && msgTools?.length ? msgTools.map((tool, ti) => {
        const traceKey = `${index}-${ti}`;
        const open = !!toolOpen[traceKey];
        const running = tool.ok === null || tool.ok === undefined;
        return (
          <div key={traceKey}>
            <button
              type="button"
              onClick={() => onToggleTool(traceKey)}
              className={`flex w-full items-center gap-1.5 text-left text-[11.5px] transition-colors py-0.5 ${
                tool.ok === false ? 'text-red-500 hover:text-red-600' : 'text-slate-400 hover:text-slate-600'
              }`}
              title="展开查看调用参数与结果"
            >
              {running ? (
                <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" />
                </span>
              ) : tool.ok ? (
                <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0 text-slate-300" />
              ) : (
                <Icon name="ai-alert-triangle" className="w-3 h-3 flex-shrink-0" />
              )}
              <span className="flex-shrink-0">{TOOL_LABELS[tool.name] || tool.name}</span>
              {tool.detail ? (<><span className="text-slate-300 flex-shrink-0">·</span><span className="truncate" title={tool.detail}>{tool.detail}</span></>) : null}
              {running ? <span className="flex-shrink-0 text-slate-300">执行中…</span> : null}
              <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 text-slate-300 transition-transform " + (open ? "rotate-90" : "")} />
            </button>
            {open && (
              <pre className="mt-0.5 mb-1 ml-[18px] px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-100 text-[10.5px] leading-relaxed text-slate-500 whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{`调用 ${JSON.stringify({ name: tool.name, args: tool.args })}　结果 ${
                running ? '（执行中）' : JSON.stringify(tool.result ?? null).slice(0, 400)
              }`}</pre>
            )}
          </div>
        );
      }) : null}
      {msg.content ? (
        <div className="text-[13px] leading-[1.75] text-slate-700 ai-markdown">
          <MdPreview modelValue={msg.content} theme="light" previewTheme="github" codeTheme="github" noMermaid={false} noKatex={false} noHighlight={false}/>
        </div>
      ) : null}
      {/* 时间 + 操作按钮：同一行固定展示（与用户消息对称，AI 这条在左下角） */}
      {(msg.content || msg.at || msg.thinkMs) ? (
        <div className="pt-0.5 flex items-center gap-0.5">
          {msg.content && !isSending && (
            <>
              <button onClick={() => onInsertText(msg.content)} className={MSG_ACTION_BTN} title="将内容插入到光标处"><Icon name="ai-plus" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onReplaceContent(msg.content)} className={`${MSG_ACTION_BTN} hover:!text-amber-600 hover:!bg-amber-50`} title="覆盖当前打开的笔记"><Icon name="ai-replace" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onCopyText(msg.content)} className={MSG_ACTION_BTN} title="复制消息"><CopyIcon /></button>
              <button onClick={() => onOpenInEditor(msg.content)} className={`${MSG_ACTION_BTN} hover:!text-sky-600 hover:!bg-sky-50`} title="在编辑器中打开（临时预览，不会保存为笔记）"><Icon name="open-in-editor" className="w-3.5 h-3.5" /></button>
            </>
          )}
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-slate-300 tabular-nums select-none" title="整条回复的估算 token（含思考过程与工具调用）">{metaText}</span>
        </div>
      ) : null}
    </div>
  );
});

/** 空对象常量：给"这一行没有展开任何工具"的行用，保证 props 引用稳定、memo 不失效 */
const NO_OPEN_TOOLS: Record<string, boolean> = {};

/** 锚点每条横线的热区高度与最小/最大间距（像素）：条数多时压缩间距，永不溢出 */
const RAIL_ITEM_H = 7;
const RAIL_MIN_GAP = 1;
const RAIL_MAX_GAP = 5;
/** 悬浮波浪：离鼠标越近的横线越长越粗（0 = 鼠标正下方）。
 *  系数刻意保守：横线放大后仍留在 24px 点击热区内，不会盖到正文；纵向上限也压低，避免线条显粗。 */
const RAIL_WAVE_SCALE_X = [1.3, 1.16, 1.06, 1.02];
const RAIL_WAVE_SCALE_Y = [1.4, 1.18, 1.06, 1.02];

/**
 * 右侧历史锚点导轨（横线样式）。
 * memo 化很关键：流式输出时父组件每 50ms 刷新一次，若不隔离，几十条横线和 tooltip
 * 会跟着一起重渲染，滚动/悬停都会顿。
 */
const AnchorRail = memo(function AnchorRail({
  anchors, activeOriginal, gap, onJump, onHover, onLeave, onScroll,
}: {
  /** 采样后的可见锚点（index 是它在完整列表里的原始序号） */
  anchors: { index: number; preview: string }[];
  /** 当前查看的锚点原始序号 */
  activeOriginal: number;
  /** 横线间距（由父组件按可用高度算好） */
  gap: number;
  onJump: (originalIndex: number) => void;
  onHover: (originalIndex: number, el: HTMLElement) => void;
  onLeave: () => void;
  onScroll: () => void;
}) {
  // hooks 必须在任何早退之前
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (anchors.length < 2) return null;
  // 当前活跃的那条：取原始序号不超过 activeOriginal 的最后一个可见条
  let activeBar = 0;
  anchors.forEach((a, i) => { if (a.index <= activeOriginal) activeBar = i; });
  return (
    <nav className="chat-anchor-rail" aria-label="对话历史" onScroll={onScroll}>
      <div className="chat-anchor-list" style={{ gap }}>
        {anchors.map((anchor, i) => {
          const isActive = i === activeBar;
          // 11px 基准线 × 1.35（选中）× 1.3（波浪）= 19.3px，仍在 24px 热区之内
          let sx = isActive ? 1.35 : 1;
          let sy = isActive ? 1.1 : 1;
          if (hoverIdx !== null) {
            const d = Math.abs(i - hoverIdx);
            if (d < RAIL_WAVE_SCALE_X.length) {
              sx *= RAIL_WAVE_SCALE_X[d];
              sy *= RAIL_WAVE_SCALE_Y[d];
            }
          }
          return (
            <button
              key={anchor.index}
              type="button"
              className={"chat-anchor-bar" + (isActive ? " is-active" : "")}
              onClick={() => onJump(anchor.index)}
              onMouseEnter={(e) => { setHoverIdx(i); onHover(anchor.index, e.currentTarget); }}
              onMouseLeave={() => { setHoverIdx(null); onLeave(); }}
              onFocus={(e) => { setHoverIdx(i); onHover(anchor.index, e.currentTarget); }}
              onBlur={() => { setHoverIdx(null); onLeave(); }}
              style={{ height: RAIL_ITEM_H }}
              aria-label={`跳到第 ${anchor.index + 1} 条消息（第 ${i + 1} 个锚点）：${anchor.preview}`}
              aria-current={isActive ? "true" : undefined}
            >
              <span className="chat-anchor-line" style={{ transform: `scaleX(${sx.toFixed(3)}) scaleY(${sy.toFixed(3)})` }} />
            </button>
          );
        })}
      </div>
    </nav>
  );
});

/** 工具执行结果的一条记录 */
interface ToolResult {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  success: boolean;
}

/** 用户点了"取消"时写进工具结果的固定文案 */
const CONFIRM_CANCELLED = "用户已取消";
/** 等待用户确认的超时时间：弹窗被意外关闭/遗忘时按"取消"处理，避免整轮卡死 */
const CONFIRM_TIMEOUT_MS = 180000;

/** 对话列表里的相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / MM-DD */
const relativeTime = (iso?: string): string => {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  const d = new Date(t);
  const today = new Date();
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((dayStart(today) - dayStart(d)) / 86_400_000);
  if (dayDiff === 0) return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (dayDiff === 1) return "昨天";
  if (dayDiff < 7) return `${dayDiff} 天前`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/** 工具轨迹的中文一句话摘要：写进正文，让用户/模型都能看清做了什么 */
const describeTools = (tools: ToolTrace[] | undefined): string[] =>
  (tools || []).map(t => `${TOOL_LABELS[t.name] || t.name}${t.detail ? ` · ${t.detail}` : ""}`);

/* ---------------- 上下文瘦身（记忆管理） ---------------- */

/**
 * 工具结果进上下文前的瘦身。
 * getNoteContent 会把整篇笔记原样回传，一次就是几千 token；多轮工具调用下来，
 * 上下文增长的主要来源就是这些回传。这里截断并明确告诉模型"需要细节请按范围读"。
 */
const compactToolResult = (result: unknown, max = TOOL_RESULT_MAX_CHARS): string => {
  let text: string;
  try { text = JSON.stringify(result ?? null); } catch { text = String(result); }
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}…(truncated; for details, read again by range with getNoteContent/readNoteLines)` : text;
};

/** 旧工具结果压缩：只保留最近 keep 条原样，更早的折叠到 max 字 */
const compressOldToolResults = <T extends { role: string; content: string }>(msgs: T[], keep = 2, max = 400): T[] => {
  const toolIdx = msgs
    .map((m, i) => (m.role === "system" && m.content.startsWith("Tool execution results:") ? i : -1))
    .filter(i => i >= 0);
  if (toolIdx.length <= keep) return msgs;
  const oldOnes = new Set(toolIdx.slice(0, toolIdx.length - keep));
  return msgs.map((m, i) =>
    oldOnes.has(i) && m.content.length > max
      ? { ...m, content: `${m.content.slice(0, max)}…(earlier tool results were compressed; read them again if needed)` }
      : m,
  );
};

/** 把笔记正文按行切片（供"只读某一段"用），返回带行号文本与总行数 */
const sliceNoteLines = (content: string, startLine: number, lineCount: number) => {
  const lines = (content || "").split("\n");
  const from = Math.max(1, Math.floor(startLine) || 1);
  const take = Math.max(1, Math.floor(lineCount) || 1);
  const to = Math.min(lines.length, from + take - 1);
  const numbered = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n");
  return { totalLines: lines.length, from, to, numbered, lines };
};

/** 写回后给模型的紧凑回执：行数 + 局部预览，绝不回传全文 */
const noteEditReceipt = (lines: string[], changed: string, fromLine: number, toLine: number): string => {
  const from = Math.max(1, fromLine);
  const to = Math.min(lines.length, Math.max(from, toLine));
  const preview = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n").slice(0, 600);
  return `（${changed}，现在共 ${lines.length} 行）\n${from}-${to} 行现在是：\n${preview}`;
};

/** 默认一次读取 200 行，最多 800 行：既不给上下文塞全文，也不至于要读十几次 */
const NOTE_READ_LINES = 200;
const NOTE_READ_MAX_LINES = 800;

/**
 * 读取笔记的一个"行窗口"。
 * 长笔记绝不整篇回传（那是上下文爆炸和"改一行读全文"的根源）：
 * 带行号返回窗口内容，并明确告诉模型总行数与后续怎么读。
 */
const readNoteWindow = (n: any, startLineArg?: unknown, lineCountArg?: unknown) => {
  const content = String(n.content ?? "");
  const startLine = Math.max(1, Math.floor(Number(startLineArg) || 1));
  const lineCount = Math.min(Math.max(Math.floor(Number(lineCountArg) || NOTE_READ_LINES), 1), NOTE_READ_MAX_LINES);
  const { totalLines, from, to, numbered } = sliceNoteLines(content, startLine, lineCount);
  return {
    id: n.id,
    title: n.title,
    category_id: n.category_id ?? null,
    totalLines,
    totalChars: content.length,
    lines: `${from}-${to}`,
    content: numbered,
    ...(to < totalLines
      ? { hint: `本笔记共 ${totalLines} 行，本次只返回第 ${from}-${to} 行；继续读取请调用 getNoteContent/readNoteLines 并带 startLine=${to + 1}。修改请用 replaceLines/insertLines/deleteLines，不要整篇覆盖。` }
      : { hint: "已返回全部内容（行号仅用于定位，不要写进正文）。" }),
  };
};

/**
 * 消息时间显示：今天只显示 时:分，昨天加"昨天"，更早带上日期。
 * 遇到非法/缺失的时间戳返回空串，绝不显示 NaN。
 */
const formatMessageTime = (at?: number): string => {
  if (!at || Number.isNaN(at)) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const startOfDay = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (dayDiff <= 0) return `${hh}:${mm}`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  const md = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  if (d.getFullYear() === new Date().getFullYear()) return `${md} ${hh}:${mm}`;
  return `${d.getFullYear()}-${md} ${hh}:${mm}`;
};

export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, currentNoteId, onInsertText, onReplaceContent, onOpenInEditor, onOpenProviderSettings, onOpenAiMemory, aiPrompts, aiSettings, onAiSettingsChange, onClose }) => {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number>(0);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number>(0);
  /** 读取服务商失败时的错误文案（用于界面提示，便于定位问题） */
  const [providersError, setProvidersError] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  /** 模型下拉菜单（自定义，替代原生 select） */
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  /** 是否把当前打开的笔记作为上下文一起发送 */
  const [attachNote, setAttachNote] = useState(true);
  /** 正在拖动输入区上边缘调整高度 */
  const [composerDragging, setComposerDragging] = useState(false);
  /** 生成中的计时器：每 500ms 触发一次重渲染，用来显示"思考中 · 12s" */
  const [tick, setTick] = useState(0);
  /** 各会话的输入草稿：切换会话不丢未发送的内容 */
  const draftsRef = useRef<Record<number, string>>({});
  /** 本次会话发送过的内容，供 ↑ 键快速召回 */
  const sentHistoryRef = useRef<string[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  /** 面板父容器（主内容区）的实际宽度：用它算上限，自动包含侧栏折叠、窗口缩放等所有布局变化 */
  const [availWidth, setAvailWidth] = useState(0);
  const panelRef = useRef<HTMLElement | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  /** 对话管理弹窗里的搜索词 */
  const [sessionQuery, setSessionQuery] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  /** 工具轨迹行的展开状态（key = 消息序号-工具序号），展开可看调用 JSON 与结果 */
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [pendingConfirm, setPendingConfirm] = useState<{calls: ToolCall[]; resolve: (v: boolean) => void} | null>(null);
  /** 确认弹窗的 resolver 与超时定时器：保证"等待确认"一定会有结果，不会卡死发送锁 */
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const confirmSettledRef = useRef(false);
  const [confirmMode, setConfirmMode] = useState(aiSettings.confirmByDefault);
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 消息内容包裹层：观察它的尺寸变化，用来补"之后再长高"的贴底 */
  const scrollContentRef = useRef<HTMLDivElement>(null);
  /** 是否贴底跟随最新回复：滚轮上滑查看历史时置 false，回到底部自动恢复 */
  const stickToBottomRef = useRef(true);
  /** 供界面使用的贴底状态（控制"回到最新"按钮） */
  const [atBottom, setAtBottom] = useState(true);
  /** 当前视口所处的历史锚点（第几条用户消息） */
  const [activeAnchor, setActiveAnchor] = useState(0);
  /** 消息区可用高度：锚点导轨按它决定条数与间距，保证永不溢出 */
  const [messagesAreaH, setMessagesAreaH] = useState(0);
  /** 锚点悬浮气泡：内容取用户消息，位置贴着被悬停的那个点 */
  const [anchorTip, setAnchorTip] = useState<{ index: number; top: number; visible: boolean }>({ index: 0, top: 0, visible: false });
  /** 消息视口外层容器：用于把气泡定位在点的同一高度 */
  const messagesAreaRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  /** 刚点击过的锚点：平滑滚动过程中锁定高亮，等用户自己滚轮滚动时再交还给视口 */
  const jumpTargetRef = useRef<number | null>(null);
  const dragRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 已经生成过标题的会话 ID；用 ref 记住具体会话，避免"新对话"标题反复生成 */
  const titleGenRef = useRef<number | null>(null);
  const abortRef = useRef(false);
  const isSendingRef = useRef(false);
  /** 发送同步锁：防止连按回车 / 输入法提交把同一条消息发出两次 */
  const sendLockRef = useRef(false);
  /**
   * 当前请求的轮次编号。
   * 点"停止"时只是打断了本地流程，**正在飞的那次流式请求不会立刻结束**，
   * 所以要靠这个编号让旧循环在下一个检查点安静退出；同时旧循环收尾时
   * 也不能误释放"新一轮"的发送锁（否则连点两下就会重复发送）。
   */
  const runIdRef = useRef(0);
  /**
   * 流式内容缓冲：模型每个 token 都回调一次，若每次都 setState，整棵消息树（含每条消息里
   * 的 MdPreview）都要重新 diff 一次，界面就会卡。这里按 50ms 合并刷新一次。
   */
  const streamGenRef = useRef(0);
  const streamPendingRef = useRef<string | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  /** 本轮流式开始的时间：用于"先按住正文、避免抢答闪一下"的时间上限 */
  const streamStartedAtRef = useRef(0);
  const placeholderRef = useRef<AiChatMessage | null>(null);
  /** 当前打开笔记的 ID（组件内持有，工具执行时作为上下文传入） */
  const currentNoteIdRef = useRef<number | null>(null);
  /**
   * 这个模型是否"会写思考"。
   * 协议要求先 <thinking> 再回答；若某轮没写，我们会按住它的回答并要求重来一次。
   * 如果重来后仍然没有思考，说明这个模型根本不写标签 —— 之后就不再按住、不再重来，
   * 否则每一轮都要白等一次、白烧一遍 token。
   */
  const thinkingCapableRef = useRef(true);
  /** 已生成的上下文摘要（按会话缓存）：{sid 会话, covered 已覆盖的消息条数, text 摘要} */
  const contextSummaryRef = useRef<{ sid: number; covered: number; text: string } | null>(null);
  /** 这一轮的起点：用于生成中的实时计时，以及消息上显示的"用时" */
  const turnStartedAtRef = useRef(0);
  /** 本次回答里已执行过的工具调用签名，用于跳过完全重复的调用 */
  const executedCallKeys = useRef<Set<string>>(new Set());
  const activeProvider = useMemo(() => providers.find((p) => p.id === selectedProviderId) || null, [providers, selectedProviderId]);
  /** 设置中勾选的可用模型（下拉候选） */
  const enabledModels = useMemo(() => (activeProvider ? getEnabledModels(activeProvider) : []), [activeProvider]);
  /** 本次对话使用的模型：优先已选值，未选时回退到勾选列表第一项 */
  const activeModel = activeModelOf(activeProvider, enabledModels);
  /** 选中的模型写回服务商，保证后端 selected_model 与界面一致 */
  const persistActiveModel = useCallback((model: string) => {
    if (!activeProvider || !model || activeProvider.enabled_model === model) return;
    const next = { ...activeProvider, enabled_model: model };
    setProviders((prev) => prev.map((p) => (p.id === next.id ? next : p)));
    api.updateAiProvider(next).catch(() => {});
  }, [activeProvider]);

  // 同步"当前打开笔记的 ID"，供 updateCurrentNote 等工具使用
  // 同步"当前打开笔记的 ID"：工具执行时作为 ToolContext 传入，
  // 让 updateCurrentNote / appendToNote 永远作用于用户此刻正在看的那一篇。
  useEffect(() => { currentNoteIdRef.current = currentNoteId ?? null; }, [currentNoteId]);

  useEffect(() => {
    // 面板收起时 DOM 被销毁，悬浮气泡的状态要一并复位，避免重新展开时残留显示
    if (!isOpen) {
      hideAnchorTip();
      // 确认弹窗也会随面板消失：必须把它结算掉，否则 agentLoop 会永远停在等待确认上
      settleConfirm(false);
      return;
    }
    resetToLatest();
    loadProviders();
    loadSessions();
  }, [isOpen]);
  // 监听面板父容器（主内容区）的实际宽度：窗口缩放、侧栏折叠、全屏切换等任何布局变化都会触发重算
  useLayoutEffect(() => {
    if (!isOpen) return;
    const host = panelRef.current?.parentElement;
    if (!host) return;
    const update = () => setAvailWidth(host.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, [isOpen]);
  /** 面板上限：可用宽度 − 内容区保底；窗口越宽上限越大（全屏时可达 MAX_PANEL_WIDTH） */
  const maxPanelWidth = availWidth > 0
    ? Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, availWidth - CONTENT_MIN_WIDTH))
    : MAX_PANEL_WIDTH;
  /**
   * 实际渲染宽度 = min(用户设定宽度, 上限)。
   * 做成派生值而不是回写 state：窗口变小时必然跟着收窄（不可能挤压内容区），
   * 窗口再变大时会恢复用户原本设定的宽度。
   */
  const effectivePanelWidth = Math.min(panelWidth, maxPanelWidth);
  // Reload providers when modified via provider modal
  useEffect(() => {
    const handler = () => { loadProviders(); };
    window.addEventListener('fastnote-providers-changed', handler);
    return () => window.removeEventListener('fastnote-providers-changed', handler);
  }, []);
  // When user selects a different saved provider in the modal, switch to it and load its models
  useEffect(() => {
    const handler = (e: Event) => {
      const { providerId } = (e as CustomEvent).detail;
      if (providerId) {
        setSelectedProviderId(providerId);
      }
    };
    window.addEventListener('fastnote-provider-selected', handler);
    return () => window.removeEventListener('fastnote-provider-selected', handler);
  }, []);
  /**
   * 结束一次"等待确认"：只生效一次，并且一定让 agentLoop 里的 Promise 落地。
   * 关闭面板、切换会话、点停止、超时都会走这里，避免确认弹窗凭空消失导致整轮卡死。
   */
  const settleConfirm = useCallback((value: boolean) => {
    if (confirmSettledRef.current) return;
    confirmSettledRef.current = true;
    if (confirmTimerRef.current !== null) {
      window.clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    const resolve = confirmResolveRef.current;
    confirmResolveRef.current = null;
    setPendingConfirm(null);
    resolve?.(value);
  }, []);

  /** 打开确认弹窗前重置"已结算"标记 */
  const beginConfirm = useCallback(() => { confirmSettledRef.current = false; }, []);

  /**
   * 询问用户是否执行这批破坏性工具。
   * 返回的 Promise 一定会 settle（按钮、遮罩、关闭面板、切换会话、点停止、超时都会结算），
   * 否则 agentLoop 永不返回、发送锁永不释放，之后所有发送都会被静默吞掉。
   */
  const confirmDestructive = useCallback((calls: ToolCall[]): Promise<boolean> => {
    beginConfirm();
    return new Promise<boolean>(resolve => {
      confirmResolveRef.current = resolve;
      setPendingConfirm({ calls, resolve: settleConfirm });
      confirmTimerRef.current = window.setTimeout(() => settleConfirm(false), CONFIRM_TIMEOUT_MS);
    });
  }, [beginConfirm, settleConfirm]);

  /** 把一段结果说明写回对话：优先就地替换占位气泡，没有占位就追加 */
  const commitNotice = useCallback(async (sid: number, text: string, leftover: any) => {
    const usedMs = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;
    setMessages(m => {
      const msg = { role: 'assistant' as const, content: text, thinking: leftover?.thinking, tools: leftover?.tools, at: leftover?.at ?? Date.now(), thinkMs: usedMs || undefined } as any;
      const idx = leftover ? m.findIndex(x => x === leftover) : -1;
      return idx >= 0 ? [...m.slice(0, idx), msg] : [...m, msg];
    });
    try { await api.saveChatMessage(sid, 'assistant', text); } catch {}
  }, []);

  /** 重置为"跟随最新回复"状态（切换/新建会话、发送新消息、重新打开面板时调用） */
  const resetToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    jumpTargetRef.current = null;
    setAtBottom(true);
    // 不在这里重置 activeAnchor：随后的 syncScrollState 会按新视口算出正确的锚点，
    // 否则发送消息时会看到高亮先跳回第一个点、再跳回最后一个点。
  }, []);

  /** 开始新一轮流式输出：作废上一次缓冲，旧文本会一直显示到新内容到来（避免闪一下空白） */
  const bumpStreamGen = useCallback(() => {
    streamGenRef.current += 1;
    streamStartedAtRef.current = Date.now();
    if (streamTimerRef.current !== null) {
      window.clearTimeout(streamTimerRef.current);
      streamTimerRef.current = null;
    }
    streamPendingRef.current = null;
    return streamGenRef.current;
  }, []);

  /** 流式文本合并刷新（同一轮内最多每 50ms 一次） */
  const pushStreamContent = useCallback((text: string, gen: number) => {
    streamPendingRef.current = text;
    if (streamTimerRef.current !== null) return;
    streamTimerRef.current = window.setTimeout(() => {
      streamTimerRef.current = null;
      // 本轮已经结束（或已切换会话）：丢弃迟到的刷新，避免旧内容又冒出来
      if (streamGenRef.current !== gen) return;
      const pending = streamPendingRef.current;
      streamPendingRef.current = null;
      if (pending !== null) setStreamingContent(pending);
    }, 50);
  }, []);

  /** 结束流式显示：作废缓冲并清空（工具轮、最终回复、停止、切换会话时用） */
  const resetStreaming = useCallback(() => {
    bumpStreamGen();
    setStreamingContent('');
  }, [bumpStreamGen]);

  useEffect(() => () => {
    if (streamTimerRef.current !== null) window.clearTimeout(streamTimerRef.current);
  }, []);

  /** 同步滚动状态：是否贴底 + 当前视口由哪条用户消息"领读"（驱动锚点高亮） */
  const syncScrollState = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottomNow = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_BOTTOM_THRESHOLD;
    stickToBottomRef.current = atBottomNow;
    setAtBottom(atBottomNow);
    // 刚点过锚点：保持该点高亮，避免"点了 A 却因目标到底部而高亮 B"
    if (jumpTargetRef.current !== null) return;
    const anchors = el.querySelectorAll<HTMLElement>('[data-chat-anchor]');
    if (anchors.length === 0) { setActiveAnchor(0); return; }
    // 贴底 = 正在看最新回复：此刻最新那条提问往往还在阅读线下方（回复刚开头 / 只有"思考中"），
    // 若仍按阅读线取"线以上的最后一个"，高亮就会停留在上一轮，所以这里直接锁定最后一次提问。
    if (atBottomNow) { setActiveAnchor(anchors.length - 1); return; }
    const line = el.getBoundingClientRect().top + ANCHOR_READING_LINE;
    let active = 0;
    anchors.forEach((node, index) => {
      if (node.getBoundingClientRect().top <= line) active = index;
    });
    setActiveAnchor(active);
  }, []);

  /** 用户自己滚动（滚轮/触屏）即解除"点击锁定"，高亮重新跟手 */
  const releaseJumpTarget = useCallback(() => { jumpTargetRef.current = null; }, []);

  /**
   * 悬停锚点：气泡渲染在导轨之外（导轨要滚动就必然 clip 掉左侧元素），
   * 这里按被悬停圆点的位置算出气泡的纵向坐标，并夹在视口内避免被面板裁掉。
   */
  const showAnchorTip = useCallback((index: number, el: HTMLElement) => {
    const area = messagesAreaRef.current;
    if (!area) return;
    const areaRect = area.getBoundingClientRect();
    const dotRect = el.getBoundingClientRect();
    const raw = dotRect.top + dotRect.height / 2 - areaRect.top;
    const top = Math.max(30, Math.min(areaRect.height - 30, raw));
    setAnchorTip({ index, top, visible: true });
  }, []);

  const hideAnchorTip = useCallback(() => {
    setAnchorTip(prev => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  /** 滚动事件用 rAF 节流，避免流式输出时每帧多次 setState */
  const handleChatScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) return;
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      syncScrollState();
    });
  }, [syncScrollState]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  /**
   * 贴底保险（回答结束后有时"停在用户那条消息"的根因）：
   * 流式结束、消息落地时，正文的 Markdown 高亮/表格/KaTeX 往往还在异步渲染，
   * 内容会再长高一截。只在 messages/streamingContent 变化时滚一次底，就会漏掉这一次增长 ——
   * 于是回答完了视口却不在底部，得手动往下拉（而且"有时候才发生"）。
   * 这里直接观察内容尺寸，尺寸一变就重新贴底（仅限"跟随模式"，用户上滑看历史时不打扰）。
   */
  useEffect(() => {
    if (!isOpen) return;
    const content = scrollContentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el || !stickToBottomRef.current) return;
        el.scrollTop = el.scrollHeight;
        syncScrollState();
      });
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [isOpen, syncScrollState]);

  /**
   * 仅"贴底"时才自动跟随最新内容：
   * - AI 流式回复（一个字一个字地增长）时，无论增长多少行，视口始终停在最底部；
   * - 用户一旦用滚轮上滑查看历史，就不再被拽回底部，滚动在哪就停在哪；
   * - 用户重新滚回最底部后，自动恢复跟随。
   */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
      syncScrollState();
    });
    return () => cancelAnimationFrame(frame);
    // isOpen：面板收起时 DOM 被销毁，重新展开后需要重新贴到底部
  }, [messages, streamingContent, isOpen, syncScrollState]);

  /** 点击右侧锚点：平滑滚动到对应的用户消息处 */
  const jumpToAnchor = useCallback((index: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const node = el.querySelectorAll<HTMLElement>('[data-chat-anchor]')[index];
    if (!node) return;
    // 主动回看历史：先解除贴底，否则流式回复会在下一帧把视口拽回底部
    stickToBottomRef.current = false;
    jumpTargetRef.current = index;
    setAtBottom(false);
    setActiveAnchor(index);
    const top = el.scrollTop + node.getBoundingClientRect().top - el.getBoundingClientRect().top - ANCHOR_JUMP_OFFSET;
    el.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  /** 回到最新回复并恢复自动跟随 */
  const jumpToLatest = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = true;
    jumpTargetRef.current = null;
    setAtBottom(true);
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  useEffect(() => { if (sessions.length > 0 && !activeSessionId) { setActiveSessionId(sessions[0].id); loadSessionMessages(sessions[0].id); } }, [sessions]);
  useEffect(() => { isSendingRef.current = isSending; }, [isSending]);
  // 下拉候选 = 设置里勾选的模型（不再每次拉取全部模型）
  useEffect(() => { setModels(enabledModels); }, [enabledModels]);

  // 未显式选过模型时，自动落定到第一个可用模型并持久化
  useEffect(() => {
    if (activeProvider && activeModel) persistActiveModel(activeModel);
  }, [activeProvider, activeModel, persistActiveModel]);

  const selectedProviderIdRef = useRef(selectedProviderId);
  useEffect(() => { selectedProviderIdRef.current = selectedProviderId; }, [selectedProviderId]);
  const loadProviders = async () => {
    try {
      const list = await api.getAiProviders();
      setProviders(list);
      setProvidersError("");
      if (list.length > 0 && !selectedProviderIdRef.current) setSelectedProviderId(list[0].id);
    } catch (error) {
      // 以前这里静默吞错，导致"明明保存成功却永远显示无可用模型"
      console.error("读取 AI 服务商失败:", error);
      setProvidersError(formatError(error));
    }
  };
  const loadSessions = async () => { try { setSessions(await api.getChatSessions()); } catch {} };
  /**
   * 加载历史消息：只对 assistant 消息做标签解析。
   * 用户消息原样展示——他可能自己粘贴了含 <tool_calls> 字样的文本，不能被剥离；
   * assistant 消息也绝不回退到原始文本，否则截断的半截工具调用会再次被显示出来。
   */
  const loadSessionMessages = async (sid: number) => {
    try {
      const m = await api.getChatMessages(sid);
      resetToLatest();
      setMessages(m.map(x => {
        const p = x.role === "assistant" ? parseResponse(x.content) : null;
        // 历史消息用数据库里的真实时间（created_at 是 RFC3339）
        const at = Date.parse(x.created_at);
        return {
          role: x.role as "user" | "assistant",
          content: p ? finalReplyText(p) : x.content,
          thinking: p?.thinkingDisplay,
          at: Number.isNaN(at) ? undefined : at,
        };
      }));
    } catch {}
  };
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await api.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; settleConfirm(false); draftsRef.current[activeSessionId] = input; setActiveSessionId(sid); setInput(draftsRef.current[sid] || ''); resetStreaming(); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { settleConfirm(false); draftsRef.current[activeSessionId] = input; const s = await api.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setInput(''); resetStreaming(); resetToLatest(); titleGenRef.current = null; };
  /**
   * 自动生成对话标题。
   * 之前的写法用组件里的 sessions 数组判断"是不是新对话"，但新建会话时那是旧闭包，
   * 永远查不到刚建的会话 → 直接 return，于是标题永远是"新对话"。这里改成：
   * 1) 用 ref 记住已生成过的会话 ID（每个会话只生成一次）；
   * 2) 真正生成前再拉一次会话列表确认真实标题，避免覆盖用户手动改过的名字。
   */
  const genTitle = async (sid: number, up: string, ar: string) => {
    if (titleGenRef.current === sid || !activeProvider) return;
    titleGenRef.current = sid;
    try {
      const list = await api.getChatSessions();
      const session = list.find(s => s.id === sid);
      if (!session || session.title !== "新对话") return;
      // 送进去的内容也要先去标签：否则整段 <thinking> 推理会被当成"对话内容"喂给标题模型
      const userText = stripAiTags(up).replace(/<[^>]+>/g, "").trim().slice(0, 300);
      const assistantText = stripAiTags(ar).replace(/<[^>]+>/g, "").trim().slice(0, 300);
      const t = await api.sendAiChat(activeProvider.id, [{ role: "system", content: buildTitlePrompt(userText, assistantText) }, { role: "user", content: TITLE_USER_MESSAGE }], "", "");
      const ct = cleanSessionTitle(t);
      // 洗不出有效标题就保持原样，下次再试；绝不要把 "thinking用" 这类垃圾写进去
      if (!ct) { titleGenRef.current = null; return; }
      await api.updateChatSessionTitle(sid, ct);
      await loadSessions();
    } catch (error) {
      console.error("生成对话标题失败:", error);
      titleGenRef.current = null; // 失败时允许下次重试
    }
  };
  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await api.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(''); await loadSessions(); } catch { showToast('重命名失败', 'error'); } };
  const agentLoop = async (sid: number, msgs: AiChatMessage[], prompt: string): Promise<void> => {
    placeholderRef.current = null;
    executedCallKeys.current = new Set();
    /** 本轮的编号：一旦被"停止"或被新消息取代，旧循环必须立刻安静退出，绝不再改界面 */
    const myRun = runIdRef.current;
    const isStale = () => abortRef.current || runIdRef.current !== myRun;
    /** 系统提示词 = 工具协议 + 深度思考要求 + 用户自定义的前置提示词/记忆（每次请求都带上） */
    const memoryBlock = buildMemoryBlock(aiPrompts);
    const systemPrompt = [AI_SYSTEM_PROMPT, buildThinkRule(aiSettings.minThinkingLen), memoryBlock].filter(Boolean).join("\n\n");
    let roundMsgs = [...msgs];

    /* ---------- 上下文压缩（滑动窗口 + 摘要，主流做法） ----------
     * 对话越来越长时，把更早的部分压成一段要点，只把"摘要 + 最近若干条"发给模型。
     * 界面上历史依旧完整，压缩只作用于请求；同一段只摘要一次（缓存在 ref 里）。
     */
    {
      const { kept, dropped } = selectContextWindow(msgs, aiSettings.contextBudget, aiSettings.keepRecent);
      const cache = contextSummaryRef.current;
      let summary = cache && cache.sid === sid ? cache.text : "";
      let covered = cache && cache.sid === sid ? cache.covered : 0;
      if (covered > dropped.length) { summary = ""; covered = 0; }              // 换会话或历史被清空
      const needsSummary = dropped.length > 0 && (!summary || dropped.length - covered >= 6);
      if (needsSummary && activeProvider?.id) {
        try {
          const text = await api.sendAiChat(
            activeProvider.id,
            [
              { role: "system", content: CONTEXT_SUMMARY_PROMPT },
              { role: "user", content: buildSummaryUserMessage(summary, compressTranscript(dropped)) },
            ],
            "",
            activeModel,
          );
          const clean = stripAiTags(text || "").replace(/<[^>]*>/g, "").trim().slice(0, 1200);
          if (clean) { summary = clean; covered = dropped.length; }
        } catch { /* 摘要失败不影响本轮：下面会用本地兜底说明 */ }
      }
      contextSummaryRef.current = summary ? { sid, covered, text: summary } : null;
      const uncovered = dropped.slice(covered);
      // selectContextWindow 返回的是通用 {role, content}，这里角色只可能是 user/assistant/system
      const rebuilt = [
        ...(summary ? [{ role: "system", content: `${SUMMARY_INJECT_PREFIX}${summary}` }] : []),
        ...(uncovered.length > 0 ? [{ role: "system", content: localSummaryFallback(uncovered) }] : []),
        ...kept,
      ].filter(m => m.content && m.content.trim()) as AiChatMessage[];
      roundMsgs = rebuilt;
    }
    /** 三个纠正各自独立记一次，互不挤占（以前共用一个标记，思考纠错一次后谎报纠错就失效了） */
    let thinkingRetryUsed = false;
    let claimRetryUsed = false;
    let truncationRetryUsed = false;
    /** 连续多少轮"全是重复调用、没有任何新动作"——用于不限制轮数时防止空转 */
    let noProgressRounds = 0;

    // 最多工具轮数：设置为 0 表示不限制；UNLIMITED_ROUND_SAFETY 是"死循环保险"
    const roundLimit = aiSettings.maxRounds > 0 ? aiSettings.maxRounds : UNLIMITED_ROUND_SAFETY;
    for (let round = 0; round < roundLimit; round++) {
      if (isStale()) return;
      setIsSending(true);
      const roundGen = bumpStreamGen();
      let nativeReasoning = '';
      try {
        // 设置里关掉流式时走一次性请求：个别服务商的流式不稳定，这时界面先显示"思考中"，
        // 拿到完整结果再一次性呈现（解析与后续流程完全一致）。
        const full = aiSettings.streaming
          ? await api.sendAiChatStream(
              activeProvider!.id,
              [{ role: 'system', content: systemPrompt }, ...roundMsgs],
              noteTitle || '',
              attachNote ? noteContent : '',
              (c, r) => {
                nativeReasoning = r;
                if (!isStale()) pushStreamContent(c, roundGen);
              },
              aiSettings.minThinkingLen,
              currentNoteId ?? null,
              aiSettings.maxTokens,
            )
          : await api.sendAiChat(
              activeProvider!.id,
              [{ role: 'system', content: systemPrompt }, ...roundMsgs],
              noteTitle || '',
              attachNote ? noteContent : '',
              aiSettings.maxTokens,
            );
        if (isStale()) return;
        const parsed = parseResponse(full, nativeReasoning);
        // thinking 为纯推理（用于校验深度），thinkingDisplay 才是思考区展示文本（含工具调用原文）
        const { thinking, thinkingDisplay, toolCalls, truncated } = parsed;

        // ---------- 纠错 1：思考过浅，要求重新深入思考 ----------
        // 只有"本轮正文从未显示给用户"时才能重来，否则会把已经看到的回答吞掉重来
        // （用户可见的"回答一次 → 文字瞬间消失 → 又出一个回答"）。
        const thinkingOk = isThinkingDeepEnough(thinking, THINKING_RETRY_MIN_LEN);
        if (thinkingOk) {
          thinkingCapableRef.current = true;
        } else if (thinkingRetryUsed) {
          // 重来过一次仍然没有思考：认定这个模型不写标签，别再折腾
          thinkingCapableRef.current = false;
        }
        // 正文什么时候算"已经显示"：原生思维链（Rust 会包成 <thinking> 放在前面）、
        // 或模型自己写了思考（正文在思考之后）、或已确认模型不写思考（不再按住）→ 都是可见的
        const replyShown = !!parsed.reply && (
          nativeReasoning.trim() !== "" ||
          streamStartsWithThinking(full) ||
          !thinkingCapableRef.current
        );
        if (aiSettings.retryShallowThinking && shouldRetryForShallowThinking({
          correctionUsed: thinkingRetryUsed,
          replyShown,
          toolCallCount: toolCalls.length,
          thinking,
          minLen: THINKING_RETRY_MIN_LEN,
        })) {
          thinkingRetryUsed = true;
          setIsSending(false);
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content:
                buildShallowThinkingNotice(thinking.replace(/\s/g, '').length, MIN_THINKING_LEN),
            },
          ];
          continue;
        }

        // ---------- 纠错 2：嘴上说"已完成"，实际一个工具都没调用 ----------
        // 以前的触发条件是"用户的话里出现打开/创建/帮我 等词"，太宽：
        // "帮我总结一下"这类正常提问也会被误判，于是把已经写好的回答整段丢掉重来
        // （用户看到的就是"先回答 → 清空 → 思考 → 再回答一遍"）。
        // 现在只在回复**声称已经完成了某个操作**、却没有对应工具执行过时才纠正。
        const claimedWithoutTools =
          toolCalls.length === 0 &&
          hasActionClaim(parsed.reply);
        if (!claimRetryUsed && claimedWithoutTools && !isStale()) {
          claimRetryUsed = true;
          setIsSending(false);
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content: CLAIM_WITHOUT_TOOLS_NOTICE,
            },
          ];
          continue;
        }

        // ---------- 工具调用被截断 / JSON 非法：先给一次纠正机会 ----------
        // 模型被输出长度限制截断时，半截的 <tool_calls> 既不能当正文，也不能当"已完成"。
        if (truncated && toolCalls.length === 0 && !truncationRetryUsed && !isStale()) {
          truncationRetryUsed = true;
          setIsSending(false);
          resetStreaming();
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content: TRUNCATED_TOOL_CALL_NOTICE,
            },
          ];
          continue;
        }

        // ---------- 无工具调用：这是最终回复 ----------
        if (toolCalls.length === 0) {
          setIsSending(false);
          resetStreaming();
          // 正文已剥离全部标签（含未闭合片段），工具调用只会出现在思考区
          const finalReply = finalReplyText(parsed);
          // 先把占位对象抓成局部变量、并清空 ref，再调用 setMessages：
          // updater 必须是纯函数——StrictMode 在开发模式下会执行两次，
          // 若在里面改 ref，第二次就会找不到占位而"追加"出一条重复消息。
          const placeholderAtFinal = placeholderRef.current as any;
          placeholderRef.current = null;
          // 工具调用之前已经写给用户的正文（如"先总结剧情，再打开下一篇"里的总结）要保留；
          // 并对"声称已完成却没执行"做事实校验（见 buildFinalContent）。
          const carriedTools = placeholderAtFinal?.tools as ToolTrace[] | undefined;
          const finalContent = buildFinalContent(finalReply, String(placeholderAtFinal?.content || ''), carriedTools || []);
          // 时间沿用占位气泡（这一轮开始的时间），没有占位就用此刻
          const finalAt: number = placeholderAtFinal?.at ?? Date.now();
          // 本轮总用时：从按下发送到出结果（含工具执行），显示在消息时间旁边
          const usedMs = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;
          setMessages(m => {
            const msg = { role: 'assistant' as const, content: finalContent, thinking: thinkingDisplay, tools: carriedTools, at: finalAt, thinkMs: usedMs || undefined };
            const idx = placeholderAtFinal ? m.findIndex(x => x === placeholderAtFinal) : -1;
            if (idx >= 0) return [...m.slice(0, idx), msg as any];
            // 兜底：末尾若残留了"内容为空但有思考"的空壳助手消息，直接替换掉，
            // 否则它会和最终回复各带一份深度思考，看起来又是重复。
            const last = m[m.length - 1] as { role?: string; content?: string } | undefined;
            if (last && last.role === 'assistant' && !last.content) {
              return [...m.slice(0, -1), msg as any];
            }
            return [...m, msg as any];
          });
          try { await api.saveChatMessage(sid, 'assistant', full); } catch {}
          // 生成标题只喂清洗后的正文，避免把截断的工具调用 JSON 塞给标题模型
          if (aiSettings.autoTitle) genTitle(sid, prompt, finalReply);
          return;
        }

        // ---------- 有工具调用：先展示思考，再执行工具 ----------
        // 同一轮对话只维护一个助手气泡：多轮工具调用时更新它，而不是每轮再插一条，
        // 否则每一轮都会多出一份"AI 深度思考"，看起来就是深度思考重复了。
        const roundReply = parsed.reply;
        const existingPlaceholder = placeholderRef.current;
        if (existingPlaceholder) {
          const nextPlaceholder: any = {
            ...existingPlaceholder,
            // 本轮若同时给了正文（例如"先总结剧情，再打开下一篇"），要留在气泡里，
            // 否则下一轮把它替换掉时，这段正文就凭空消失了。
            content: roundReply || existingPlaceholder.content || '',
            thinking: thinkingDisplay,
          };
          placeholderRef.current = nextPlaceholder;
          setMessages(m => m.map(x => (x === existingPlaceholder ? nextPlaceholder : x)));
        } else {
          const createdPlaceholder: any = { role: 'assistant' as const, content: roundReply, thinking: thinkingDisplay, at: Date.now() };
          placeholderRef.current = createdPlaceholder;
          setMessages(m => [...m, createdPlaceholder]);
        }
        // 标题生成只喂清洗后的文本，避免把工具调用 JSON 塞给标题模型
        genTitle(sid, prompt, parsed.reply || thinking);
        setIsSending(false);
        resetStreaming();
        // 同一轮对话里完全相同的调用只执行一次：模型常常把"先打开 A"再喊一遍，
        // 等于把刚打开的 B 又切回 A（用户看到的现象就是"重复一遍，最后没打开 B"）。
        const freshCalls = toolCalls.filter(tc => {
          const key = `${tc.name}:${JSON.stringify(tc.args ?? {})}`;
          if (executedCallKeys.current.has(key)) return false;
          executedCallKeys.current.add(key);
          return true;
        });
        const skippedCount = toolCalls.length - freshCalls.length;
        // Separate read-only vs destructive tools
        const readOnly = freshCalls.filter(tc => !TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        const destructive = freshCalls.filter(tc => TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        // Execute read-only tools immediately —— 逐个执行，每执行一条就立即在界面上显示出来
        let results: ToolResult[] = [];
        const runTool = async (tc: { name: string; args: Record<string, unknown> }) => {
          appendToolTrace(tc);
          let result: unknown;
          let success = true;
          try {
            result = await TOOL_EXECUTORS[tc.name](tc.args, { currentNoteId: currentNoteIdRef.current });
          } catch (e) {
            result = formatError(e);
            success = false;
          }
          finishToolTrace({ name: tc.name, args: tc.args, result, success });
          results.push({ name: tc.name, args: tc.args, result, success });
        };
        // 只读工具直接跑；需要确认的写操作先问一次，用户取消就逐条记为"已取消"
        // 每条执行前都检查轮次：用户点了停止就不再继续动数据
        for (const tc of readOnly) {
          if (isStale()) return;
          await runTool(tc);
        }
        if (destructive.length > 0) {
          const confirmed = confirmMode ? await confirmDestructive(destructive) : true;
          for (const tc of destructive) {
            if (isStale()) return;
            if (confirmed) {
              await runTool(tc);
            } else {
              appendToolTrace(tc);
              finishToolTrace({ name: tc.name, args: tc.args, result: CONFIRM_CANCELLED, success: false });
              results.push({ name: tc.name, args: tc.args, result: CONFIRM_CANCELLED, success: false });
            }
          }
        }
        // 全是重复调用 = 这一轮没有任何进展。设置为"不限制轮数"时，这种空转必须掐掉，
        // 否则模型反复要同一份数据就会一直转下去（既烧额度又看不到结果）。
        if (results.length === 0 && skippedCount > 0) {
          noProgressRounds++;
          if (noProgressRounds >= 2) break;
        } else {
          noProgressRounds = 0;
        }
        // 工具轨迹已在每条工具执行时逐条写入气泡，这里不再批量补写
        // Build result message and continue loop
        const resultParts = results.map(r => `${r.name}: ${r.success ? compactToolResult(r.result, aiSettings.toolResultChars) : '失败: ' + r.result}`);
        if (skippedCount > 0) resultParts.push(`已跳过 ${skippedCount} 个重复调用（本次回答中执行过，未重复执行）`);
        const resultSummary = resultParts.join('; ');
        if (results.length > 0) {
          try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); await loadSessions(); } catch {}
          // 历史里的工具结果按主流做法做"旧结果摘要化"：只给前 2 条保留原始长度，
          // 更早的压到 400 字以内。多轮工具调用时上下文增长最凶的就是这里。
          roundMsgs = compressOldToolResults(roundMsgs);
        }
        roundMsgs = [...roundMsgs, { role: 'assistant', content: full }, { role: 'system', content: buildToolResultMessage(resultSummary) }];
      } catch (e) {
        // 以前这里只 console.error 就直接 return：请求失败时界面上一句话都没有，
        // 用户只会看到"没反应"，然后反复发"继续"。必须把失败原因说出来。
        console.error(e);
        setIsSending(false);
        resetStreaming();
        const leftover: any = placeholderRef.current;
        placeholderRef.current = null;
        const doneTools = describeTools(leftover?.tools);
        const failure = `⚠️ 本轮请求失败了：${formatError(e)}\n\n可以检查一下：服务商配置/模型是否可用、网络是否正常，然后重发或点「继续」。`
          + (doneTools.length > 0 ? `\n\n失败前已完成的操作：\n${doneTools.map(d => `- ${d}`).join("\n")}` : "");
        await commitNotice(sid, failure, leftover);
        return;
      }
    }

    // ---------- 循环结束仍未产出最终回复（多半是步数用完）----------
    // 这一步必须有：否则工具执行了一堆，界面上一句话都没有，用户完全不知道结束没有。
    setIsSending(false);
    resetStreaming();
    const leftover: any = placeholderRef.current;
    placeholderRef.current = null;
    const doneTools = describeTools(leftover?.tools);
    // 这份清单同时是给模型看的上下文：工具调用记录只存在于界面，不在对话历史里，
    // 写进正文用户下次说"继续"时模型才知道自己刚做了什么。
    const notice = doneTools.length > 0
      ? (noProgressRounds >= 2
          ? `（模型连续两轮重复请求同样的数据、没有新进展，已先停下。已完成的操作为：\n${doneTools.map(d => `- ${d}`).join("\n")}\n\n还需要继续的话，回一句「继续」并说明下一步要做什么。）`
          : `（本次操作步骤已达上限，先停在这里。已完成的操作为：\n${doneTools.map(d => `- ${d}`).join("\n")}\n\n还需要继续的话，回一句「继续」就行。）`)
      : "（模型没有返回有效内容，请重试，或把需求说得更具体一些。）";
    await commitNotice(sid, notice, leftover);
  };

  const toggleThinking = useCallback((i: number) => { setExpandedThinking(p => ({ ...p, [i]: !p[i] })); }, []);
  const toggleToolTrace = useCallback((key: string) => { setExpandedTools(p => ({ ...p, [key]: !p[key] })); }, []);

  // 让 ChatMessageRow 的 memo 真正生效：外部传入的回调每次渲染都是新函数，
  // 这里用 ref 固定住，包装成永不变化的引用。
  const insertTextRef = useRef(onInsertText);
  const replaceContentRef = useRef(onReplaceContent);
  const openInEditorRef = useRef(onOpenInEditor);
  useEffect(() => {
    insertTextRef.current = onInsertText;
    replaceContentRef.current = onReplaceContent;
    openInEditorRef.current = onOpenInEditor;
  });
  const insertTextStable = useCallback((text: string) => insertTextRef.current(text), []);
  const replaceContentStable = useCallback((text: string) => replaceContentRef.current(text), []);
  /** AI 回复「在编辑器中打开」：从正文首个有效行提炼标题，提炼不出时回退为带时间的通用标题 */
  const openInEditorStable = useCallback((content: string) => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const stamp = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;

    // 首个非空、且不是纯分隔符的行
    const firstLine = content
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !/^[-*_`>|=+]+$/.test(line)) ?? "";
    const cleaned = firstLine
      .replace(/^#{1,6}\s*/, "")                          // 标题井号
      .replace(/^([-*+]|\d+[.)])\s+/, "")                 // 列表符号 / 有序编号
      .replace(/^>\s*/, "")                               // 引用符号
      .replace(/\*\*|__|`|\*/g, "")                       // 加粗 / 斜体 / 行内代码
      .replace(/^[【\[](.+?)[】\]]$/, "$1")               // 整体被括号包裹
      .replace(/[。：:，,、；;！!？?~～·]+$/, "")         // 结尾标点
      .trim();

    const title = cleaned.length > 20 ? `${cleaned.slice(0, 20)}…` : cleaned;
    openInEditorRef.current(title || `AI 回复 ${stamp}`, content);
  }, []);
  const copyTextStable = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => showToast("已复制", "success"),
      () => showToast("复制失败", "error")
    );
  }, [showToast]);

  /**
   * 工具执行是逐个进行的，这里把"正在执行"的一条轨迹立刻追加到当前助手气泡上，
   * 执行完再回填状态与结果——界面上就能看到 打开笔记 #16 ▸ 读取笔记 #16 ▸ … 依次出现。
   */
  const appendToolTrace = useCallback((call: { name: string; args: Record<string, unknown> }) => {
    const target: any = placeholderRef.current;
    if (!target) return;
    const traced: any = {
      ...target,
      tools: [
        ...(target.tools || []),
        { name: call.name, args: call.args, ok: null, result: undefined, detail: toolDetail(call.name, call.args, undefined) },
      ],
    };
    placeholderRef.current = traced;
    setMessages(m => m.map(x => (x === target ? traced : x)));
  }, []);

  const finishToolTrace = useCallback((done: { name: string; args: Record<string, unknown>; result: unknown; success: boolean }) => {
    const target: any = placeholderRef.current;
    if (!target?.tools?.length) return;
    const tools = [...target.tools];
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      ok: done.success,
      result: done.result,
      detail: toolDetail(done.name, done.args, done.result),
    };
    const traced: any = { ...target, tools };
    placeholderRef.current = traced;
    setMessages(m => m.map(x => (x === target ? traced : x)));
  }, []);

  /**
   * 输入框高度。
   *   composerHeight = 0 → 自动模式：随内容长高（44 ~ 320px，超出后内部滚动）
   *   composerHeight > 0 → 手动模式：固定成这个高度（拖上边缘设定，双击恢复自动）
   * 自动模式每次都先归零再按 scrollHeight 计算，否则删掉内容后高度不会缩回去。
   */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const areaH = messagesAreaRef.current?.clientHeight || 600;
    const manual = aiSettings.composerHeight > 0 ? aiSettings.composerHeight : 0;
    if (manual) {
      /*
       * 手动高度直接照用，**不能再按"消息区高度"二次夹紧**：
       * 输入框变高 → 消息区变矮 → 夹紧值变小 → 输入框又被压回去，
       * 于是拖动/松手时会看到"自己矮了一大截"。（上限交给 CSS max-height 兜底）
       */
      el.style.height = `${manual}px`;
      return;
    }
    el.style.height = "auto";
    const autoMax = Math.max(44, Math.min(320, Math.round(areaH * 0.45)));
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 44), autoMax)}px`;
  }, [input, aiSettings.composerHeight, activeSessionId, isOpen]);

  /** 生成中每 500ms 走一次秒表 */
  useEffect(() => {
    if (!isSending) return;
    const t = window.setInterval(() => setTick(v => v + 1), 500);
    return () => window.clearInterval(t);
  }, [isSending]);

  /** 面板打开时聚焦输入框，符合"打开就能打字"的直觉 */
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen, activeSessionId]);

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt) return;
    // 同步锁：isSending 是 state，要等下一次渲染才生效；连按两次回车（中文输入法提交候选词
    // 的 Enter 尤其容易触发）会在它生效之前把同一条消息发两遍，AI 也就回答两遍。
    if (sendLockRef.current || isSendingRef.current) {
      // 正常流式输出时按钮是"停止"，不会走到这里；能走到这里说明是异常态
      // （例如上一轮卡在等待确认）——必须明确告诉用户，否则就是"点了发送没反应"。
      if (!isSendingRef.current) showToast("上一条请求还没结束（可能在等待确认），本次发送已忽略", "error");
      return;
    }
    if (!activeProvider?.id || !activeModel) { showToast("请先在设置中勾选可用模型", "error"); return; }
    const myRun = ++runIdRef.current;
    turnStartedAtRef.current = Date.now();
    /*
     * 每轮新提问都重新给它一次"按协议思考"的机会。
     * thinkingCapableRef 以前是单向锁：某轮"重来过仍没写思考"就被判定为"这个模型不写标签"，
     * 之后既不按住它的抢答、也不再要求它重来 —— 于是长会话里越来越容易出现
     * "不思考、不调用工具、嘴上说改完了"，而且再也纠不回来（不重试就永远等不到一次合格思考）。
     * 改为按轮复位后，最坏情况只是每轮多跑一次纠正。
     */
    thinkingCapableRef.current = true;
    sendLockRef.current = true;
    try {
      abortRef.current = false;
      // Show user message and thinking indicator immediately
      const userMsg: AiChatMessage & { at: number } = { role: "user", content: prompt, at: Date.now() };
      setMessages(m => [...m, userMsg]);
      setInput("");
      // 记进"已发送"历史，供 ↑ 键召回
      sentHistoryRef.current = [...sentHistoryRef.current.slice(-20), prompt];
      resetStreaming();
      // 用户刚发出消息，理应看到最新回复：恢复贴底跟随
      resetToLatest();
      // 立刻把高亮切到这条新提问（其锚点序号 = 之前已有的用户消息数），不必等下一帧滚动同步
      setActiveAnchor(messages.filter(m => m.role === 'user').length);
      setIsSending(true);
      const sid = await ensureSession();
      try { await api.saveChatMessage(sid, "user", prompt); } catch {}
      await agentLoop(sid, [...messages, userMsg], prompt);
      await loadSessions();
      try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); } catch {}
    } finally {
      // 只有"自己仍是当前轮次"时才释放锁：旧循环收尾不能把新一轮的锁放掉
      if (runIdRef.current === myRun) sendLockRef.current = false;
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    // 停止 = 立即作废当前轮次并解锁：正在飞的那次流式请求可能还要一会儿才返回，
    // 不能让它卡住下一次发送（否则就会出现"上一条请求还没结束，本次发送已忽略"）。
    runIdRef.current += 1;
    sendLockRef.current = false;
    isSendingRef.current = false;
    // 若正卡在"等待确认"，把它按取消结算，agentLoop 才能立刻退出
    settleConfirm(false);
    // 中断时把"空壳占位气泡"就地替换成"已停止"，避免它带着一份思考留在对话里
    const placeholder = placeholderRef.current as any;
    placeholderRef.current = null;
    setMessages(m => {
      const stopped = {
        role: 'assistant' as const,
        content: placeholder?.content ? `${placeholder.content}\n\n已停止` : '已停止',
        thinking: placeholder?.thinking,
        tools: placeholder?.tools,
        at: placeholder?.at ?? Date.now(),
      };
      const idx = placeholder ? m.findIndex(x => x === placeholder) : -1;
      return idx >= 0 ? [...m.slice(0, idx), stopped] : [...m, stopped];
    });
    setIsSending(false);
    resetStreaming();
    if (activeSessionId) api.saveChatMessage(activeSessionId, 'assistant', '已停止').catch(()=>{});
  };

  const onResize = useCallback((e: React.MouseEvent) => {
    dragRef.current = true;
    // 拖拽期间关闭宽度过渡，让面板严格跟手；松手后再恢复，供折叠/展开等动画使用
    const panel = (e.currentTarget as HTMLElement).parentElement;
    panel?.classList.add('is-resizing');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // 面板左边界即拖拽位置，行容器右边界固定，因此视口右边界减 clientX 即为目标宽度
    const mm = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      // 必须取整：小数宽度会让面板内所有文字落在半个像素上，看起来发虚
      setPanelWidth(Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(maxPanelWidth, window.innerWidth - ev.clientX))));
    };
    const mu = () => {
      dragRef.current = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', mm);
      document.removeEventListener('mouseup', mu);
      // 等 React 把最终宽度刷进 DOM 后再恢复过渡，避免回弹
      requestAnimationFrame(() => panel?.classList.remove('is-resizing'));
    };
    document.addEventListener('mousemove', mm);
    document.addEventListener('mouseup', mu);
  }, [maxPanelWidth]);

  /* ======================= 派生数据（必须全部在 isOpen 早退之前） =======================
   * React 要求 hooks 每次渲染都以相同顺序调用；这里曾经把 useMemo 放在
   * `if (!isOpen) return null` 之后，导致开关面板时 hook 数量不一致，
   * React 抛错并卸载整棵树 —— 表现就是"点任何按钮整页变空白"。
   */
  /** 流式阶段解析出的思考与正文（与最终消息走同一套规则） */
  const streamingPreview = streamingContent ? parseStreamContent(streamingContent) : null;
  /**
   * 只显示"以思考开头"的流式内容（协议要求的形态）。
   * 模型有时先抢答一整段（例如"扩写"直接给结果）再补思考，甚至被重来覆盖——
   * 显示出来就是"闪一下又消失"。所以这类内容一律先按住只显示"思考中"：
   * 被丢弃的那一版用户永远看不到，最终只会出现"思考 → 回答"。
   * 例外：若已确认这个模型根本不写思考（连续重来仍没有），就不再按住，恢复逐字输出。
   */
  const holdEarlyReply = !!streamingPreview
    && thinkingCapableRef.current
    && !streamStartsWithThinking(streamingContent);
  /**
   * 流式预览行的归属。
   * 若本轮之前已经因为工具调用留下一条助手占位气泡（带 thinking + 工具轨迹），
   * 就把正在流式输出的正文并进那一条，而不是再追加一条新的预览行 ——
   * 否则同一次回复会同时出现两份「思考」和两个时间（占位一条、预览一条）。
   * 合并时保留靠上的那份思考与它原来的时间，即"只有一个思考、一个时间"。
   */
  const lastMsg = messages[messages.length - 1] as any;
  const mergeIntoPlaceholder = !!streamingPreview && !!placeholderRef.current && lastMsg === placeholderRef.current;
  const previewReply = streamingPreview ? (holdEarlyReply ? '' : streamingPreview.reply) : '';
  const previewContent = (() => {
    if (!mergeIntoPlaceholder) return previewReply;
    // 按住抢答时保持占位气泡原有正文不动
    if (holdEarlyReply) return String(lastMsg?.content || '');
    // 占位气泡的正文是"边调工具边写的那段"，最终回复要接在它后面（与 buildFinalContent 同规则）
    const carried = String(lastMsg?.content || '').trim();
    return carried && !previewReply.includes(carried) ? `${carried}\n\n${previewReply}` : previewReply;
  })();
  const allMsgs: (AiChatMessage & { thinking?: string; tools?: ToolTrace[]; at?: number; thinkMs?: number })[] = streamingPreview
    ? mergeIntoPlaceholder
      ? [...messages.slice(0, -1), { ...lastMsg, content: previewContent, thinking: lastMsg?.thinking || streamingPreview.thinking }]
      : [...messages, {
          role: 'assistant' as const,
          content: previewContent,
          thinking: streamingPreview.thinking,
          at: streamStartedAtRef.current || undefined,
        }]
    : messages;

  /**
   * 右侧历史锚点：每条用户消息对应一条横线。
   *
   * **index 是"第几个锚点"（0 起），不是它在 messages 里的下标** —— 这一点必须统一：
   * jumpToAnchor 用 querySelectorAll('[data-chat-anchor]')[index] 取节点、滚动同步
   * 算出的 activeAnchor 也是锚点序号。之前这里塞的是消息下标（用户消息在 messages 里
   * 的 index 是 0、2、4…），于是点第 N 条会跳错、高亮也对不上。
   *
   * 只用 messages 派生：流式气泡永远是 assistant，不产生锚点，所以流式期间这个数组
   * 保持同一引用，AnchorRail 的 memo 才不会被每 50ms 打破。
   */
  const userAnchors = useMemo(
    () => messages.reduce<{ index: number; preview: string }[]>((acc, msg) => {
      if (msg.role === 'user') {
        const plain = (msg.content || '').replace(/\s+/g, ' ').trim();
        acc.push({
          index: acc.length,
          preview: plain
            ? (plain.length > ANCHOR_PREVIEW_LEN ? `${plain.slice(0, ANCHOR_PREVIEW_LEN)}…` : plain)
            : '（空消息）',
        });
      }
      return acc;
    }, []),
    [messages]
  );
  /** 切换会话后旧索引可能越界，渲染前夹一下，保证总有一个点处于高亮态 */
  const activeDotIndex = Math.min(activeAnchor, Math.max(0, userAnchors.length - 1));

  /**
   * 锚点防溢出：按聊天区可用高度算出"最多能放几条"，超出就等距采样。
   * 这样无论多少轮对话，横线导轨都刚好铺满、居中、不出现滚动条。
   */
  const railFits = Math.max(3, Math.floor(Math.max(0, messagesAreaH - 24) / (RAIL_ITEM_H + RAIL_MIN_GAP)));
  const railGap = userAnchors.length <= 1
    ? RAIL_MAX_GAP
    : Math.min(RAIL_MAX_GAP, Math.max(RAIL_MIN_GAP, Math.floor(Math.max(0, messagesAreaH - 24) / userAnchors.length) - RAIL_ITEM_H));
  const visibleAnchors = useMemo(() => {
    if (userAnchors.length <= railFits) return userAnchors;
    // 等距采样，且务必包含最后一条（最新话题）
    const picked: typeof userAnchors = [];
    const step = userAnchors.length / railFits;
    for (let k = 0; k < railFits; k++) picked.push(userAnchors[Math.min(userAnchors.length - 1, Math.floor(k * step))]);
    if (picked[picked.length - 1]?.index !== userAnchors[userAnchors.length - 1].index) picked[picked.length - 1] = userAnchors[userAnchors.length - 1];
    return picked;
  }, [userAnchors, railFits]);

  /** 把"哪些工具轨迹展开着"按消息分组：每行只拿自己那份，引用稳定、memo 才有效 */
  const toolOpenByRow = useMemo(() => {
    const map: Record<number, Record<string, boolean>> = {};
    for (const key of Object.keys(expandedTools)) {
      if (!expandedTools[key]) continue;
      const rowIndex = Number(key.slice(0, key.indexOf('-')));
      if (Number.isNaN(rowIndex)) continue;
      (map[rowIndex] ||= {})[key] = true;
    }
    return map;
  }, [expandedTools]);

  /** 观察消息区高度：面板宽度变化、窗口缩放时锚点条数要跟着重算 */
  useEffect(() => {
    if (!isOpen) return;
    const el = messagesAreaRef.current;
    if (!el) return;
    const update = () => setMessagesAreaH(el.clientHeight);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen]);

  /** 当前对话在视图右侧的锚点列表（见 userAnchors 的说明） */
  const activeSession = sessions.find(s => s.id === activeSessionId);
  /**
   * 窄面板适配（分两档，避免"还没到阈值就已经被挤爆"）：
   *   compact（< 380）：确认 / 附笔记 只留图标，状态靠悬停提示；模型名仍显示（超长省略）
   *   showCount（≥ 440）：才显示字数，否则让位给按钮
   * 底部操作条本身也做了收缩处理：左侧胶囊可压缩，右侧发送 / 清空固定不被挤出。
   */
  const compact = effectivePanelWidth < 380;
  const showCount = effectivePanelWidth >= 440;
  /** 生成中的用时（秒）：让用户知道它在干活，而不是卡住了。按"整轮"计，工具执行的时间也算在内 */
  const elapsedSec = isSending && turnStartedAtRef.current
    ? Math.max(0, Math.floor((Date.now() - turnStartedAtRef.current) / 1000))
    : 0;
  void tick; // 计时器靠 tick 驱动重渲染
  /** 对话管理弹窗：搜索关键词 + 按日期分组 */
  const sessionQueryValue = sessionQuery.trim().toLowerCase();
  const sessionGroups = (() => {
    const filtered = sessionQueryValue
      ? sessions.filter(s => (s.title || "新对话").toLowerCase().includes(sessionQueryValue))
      : sessions;
    const buckets: { label: string; items: typeof sessions }[] = [
      { label: "今天", items: [] },
      { label: "昨天", items: [] },
      { label: "更早", items: [] },
    ];
    for (const s of filtered) {
      const iso = s.updated_at || s.created_at;
      const t = Date.parse(iso);
      const d = new Date(t);
      const now = new Date();
      const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
      const diff = Number.isNaN(t) ? 99 : Math.round((dayStart(now) - dayStart(d)) / 86_400_000);
      buckets[diff <= 0 ? 0 : diff === 1 ? 1 : 2].items.push(s);
    }
    return buckets.filter(b => b.items.length > 0);
  })();

  if (!isOpen) return null;

  return (<>
    <aside
      ref={panelRef}
      className="ai-panel relative flex-shrink-0 border-l border-slate-200/80 bg-white flex flex-col h-full"
      style={{ width: effectivePanelWidth }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-200/50 active:bg-primary-300/50 transition-colors z-10" onMouseDown={onResize}/>
      {/* 头部：左边是"会话卡片"（标题 + 当前模型），右边是一组图标按钮 */}
      <div className="ai-header flex-shrink-0">
        <button
          className="ai-session-btn"
          onClick={() => { setShowSessionPicker(true); setEditingSessionId(null); setEditTitle(''); setSessionQuery(''); }}
          title="切换 / 管理对话"
        >
          <span className="ai-session-badge">
            <Icon name="ai-chat" className="w-3.5 h-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-slate-700">{activeSession?.title || "新对话"}</span>
            <span className="block truncate text-[10.5px] text-slate-400">
              {activeProvider ? `${activeProvider.name}${activeModel ? ` · ${activeModel}` : " · 未选模型"}` : "未配置服务商"}
            </span>
          </span>
          <Icon name="ai-chevron-down" className="w-3 h-3 flex-shrink-0 text-slate-300" />
        </button>

        <button className="ai-icon-btn" onClick={handleNewSession} title="新建对话">
          <Icon name="ai-plus-bold" className="w-3.5 h-3.5" />
        </button>
        <button className="ai-icon-btn" onClick={onOpenAiMemory} title="AI 记忆 / 前置提示词">
          <Icon name="ai-lightbulb-bold" className="w-3.5 h-3.5" />
        </button>
        <button className="ai-icon-btn" onClick={onOpenProviderSettings} title="AI 设置">
          <Icon name="ai-settings" className="w-3.5 h-3.5" />
        </button>
        {onClose && (
          <button className="ai-icon-btn" title="关闭 AI 对话" onClick={onClose}>
            <Icon name="ai-close" className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
      {providersError && (
        <div className="selectable mx-3 mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-600 leading-relaxed break-all">
          读取 AI 服务商失败：{providersError}
        </div>
      )}
      {/* 消息视口：右侧锚点导轨与"回到最新"按钮都相对这一层定位，因此不会跟着内容滚动 */}
      <div ref={messagesAreaRef} className="relative flex-1 min-h-0 flex flex-col">
      <div
        ref={scrollRef}
        onScroll={handleChatScroll}
        onWheel={releaseJumpTarget}
        onTouchStart={releaseJumpTarget}
        className="flex-1 min-h-0 overflow-y-auto pl-3 py-3 pr-9 chat-scrollbar [overflow-anchor:none]"
      >
        {/* 内容包裹层：给它挂 ResizeObserver，任何"之后再长高"都能重新贴底 */}
        <div ref={scrollContentRef} className="space-y-4">
        {!activeProvider ? (
          <div className="ai-empty">
            <div className="ai-empty-icon"><Icon name="ai-bolt" className="w-5 h-5" /></div>
            <p className="ai-empty-title">还没有可用的 AI 服务商</p>
            <p className="ai-empty-desc">填一个 API Key 就能用：支持 OpenAI 兼容 / Claude / Gemini 协议。</p>
            <button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs mt-3">去配置服务商</button>
          </div>
        ) : allMsgs.length === 0 ? (
          <div className="ai-empty">
            <div className="ai-empty-icon"><Icon name="ai-sparkles" className="w-5 h-5" /></div>
            <p className="ai-empty-title">{activeModel ? "开始对话" : "还没有勾选模型"}</p>
            <p className="ai-empty-desc">
              {activeModel
                ? "可以让它整理笔记、改写润色、查找内容，也可以直接问问题。"
                : "在设置里获取并勾选一个模型即可开始。"}
            </p>
            {activeModel ? (
              <div className="ai-empty-chips">
                {["总结当前这篇笔记", "把这篇文章扩写", "新建一篇读书笔记", "我的笔记都写了什么"].map((t) => (
                  <button key={t} className="ai-empty-chip" onClick={() => { setInput(t); inputRef.current?.focus(); }}>{t}</button>
                ))}
              </div>
            ) : (
              <button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs mt-3">打开设置</button>
            )}
          </div>
        ) : (allMsgs.map((msg, i) => (
          <ChatMessageRow
            key={i}
            msg={msg as AiChatMessage & { thinking?: string; tools?: ToolTrace[] }}
            index={i}
            expanded={!!expandedThinking[i]}
            toolOpen={toolOpenByRow[i] || NO_OPEN_TOOLS}
            isSending={isSending}
            showToolTrace={aiSettings.showToolTrace}
            onToggleThinking={toggleThinking}
            onToggleTool={toggleToolTrace}
            onInsertText={insertTextStable}
            onReplaceContent={replaceContentStable}
            onCopyText={copyTextStable}
            onOpenInEditor={openInEditorStable}
          />
        )))}
        {isSending && (
          <div className="ai-thinking-live">
            <span className="thinking-dots"><span /><span /><span /></span>
            <span>{streamingPreview?.reply ? "生成中" : "思考中"}</span>
            {elapsedSec > 0 && <span className="elapsed">{elapsedSec}s</span>}
          </div>
        )}
        </div>
      </div>

      {/*
        生成状态胶囊：固定在输入框正上方，**不参与消息流布局** ——
        以前它跟在正文后面，正文一长就把它顶下去，看起来"乱跳"。
      */}
      {isSending && (
        <div className="ai-thinking-pill">
          <span className="thinking-dots"><span /><span /><span /></span>
          <span>{streamingPreview?.reply ? "生成中" : "思考中"}</span>
          {elapsedSec > 0 && <span className="elapsed">{elapsedSec}s</span>}
        </div>
      )}

      {/* 右侧垂直居中的历史锚点：一眼看出发过几次提问，点一下跳到那次提问 */}
      {userAnchors.length >= 2 && (
        <>
          <AnchorRail
            anchors={visibleAnchors}
            activeOriginal={activeDotIndex}
            gap={railGap}
            onJump={jumpToAnchor}
            onHover={showAnchorTip}
            onLeave={hideAnchorTip}
            onScroll={hideAnchorTip}
          />
          {/* 悬浮气泡：放在导轨外面，否则会被导轨的滚动容器裁掉 */}
          <div
            className={"chat-anchor-tip-floating" + (anchorTip.visible ? " is-visible" : "")}
            style={{ top: anchorTip.top }}
            aria-hidden="true"
          >
            {userAnchors[Math.min(anchorTip.index, userAnchors.length - 1)]?.preview}
          </div>
        </>
      )}

      {/* 滚轮上滑查看历史时出现：一键回到最新回复并恢复自动跟随 */}
      {!atBottom && allMsgs.length > 0 && (
        <button
          type="button"
          className="chat-jump-latest absolute right-8 bottom-3 z-20"
          onClick={jumpToLatest}
          title="回到最新回复"
          aria-label="回到最新回复"
        >
          <Icon name="ai-arrow-down" className="w-3.5 h-3.5" />
        </button>
      )}
      </div>

      {/* ================= 输入区（Composer） =================
          一个圆角卡片把输入框和底部操作条装在一起：聚焦时整卡描边高亮；
          输入越多自动长高，长到上限后内部滚动；上边缘可拖动调整上限高度。 */}
      <div className={"composer-wrap flex-shrink-0" + (composerDragging ? " is-resizing" : "")}>
        <div
          className={"composer-resize" + (composerDragging ? " is-dragging" : "")}
          onMouseDown={(e) => {
            e.preventDefault();
            const el = inputRef.current;
            if (!el) return;
            const startY = e.clientY;
            /*
             * 关键：基准取"当前实际高度"（el.clientHeight），而不是存起来的手动高度。
             * 否则自动模式下输入框比存储值矮时，拖动前一段完全没反应、跨过临界点又突然跳一截。
             * 拖动过程中直接改 DOM、不 setState：每次 mousemove 都触发重渲染会明显不跟手。
             */
            const startH = el.clientHeight;
            const areaH = messagesAreaRef.current?.clientHeight || 600;
            /*
             * 上限不能低于"当前实际高度"。
             * 输入框拉高后消息区会变矮，于是按新消息区算出的上限可能比现在的输入框还低；
             * 若直接拿它夹紧，第一次 mousemove 就会瞬间矮一大截（也就是"突然降低一半"）。
             * 取 max(startH, 计算上限) 之后：往下拖全程跟手，往上拖最多到当前高度或该上限。
             */
            const maxH = Math.max(startH, Math.max(120, Math.round(areaH * 0.7)));
            let next = startH;
            setComposerDragging(true);
            const onMove = (ev: MouseEvent) => {
              next = Math.min(maxH, Math.max(44, startH + (startY - ev.clientY)));
              el.style.height = `${next}px`;
            };
            const onUp = () => {
              document.removeEventListener("mousemove", onMove);
              document.removeEventListener("mouseup", onUp);
              setComposerDragging(false);
              // 松手才写回设置（只一次状态更新），并保持跟手时看到的高度
              onAiSettingsChange?.({ composerHeight: next });
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
          }}
          onDoubleClick={() => onAiSettingsChange?.({ composerHeight: 0 })}
          title="上下拖动调整输入框高度（双击恢复自动高度）"
        />

        {/* 模型下拉：向上弹出，不再是突兀的原生 select */}
        {modelMenuOpen && (
          <>
            <div className="fixed inset-0 z-30" onClick={() => setModelMenuOpen(false)} />
            <div className="composer-menu chat-scrollbar">
              {models.length === 0 ? (
                <div className="px-3 py-2 text-[11.5px] text-slate-400">还没有勾选可用模型</div>
              ) : models.map((m) => (
                <button
                  key={m}
                  className={"composer-menu-item" + (m === activeModel ? " is-active" : "")}
                  onClick={() => {
                    setModelMenuOpen(false);
                    if (!activeProvider) return;
                    const u = { ...activeProvider, enabled_model: m };
                    api.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x)));
                  }}
                >
                  <Icon name="ai-check" className={"w-3 h-3 flex-shrink-0 " + (m === activeModel ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{m}</span>
                </button>
              ))}
              <div className="composer-menu-sep" />
              <button className="composer-menu-item" onClick={() => { setModelMenuOpen(false); onOpenProviderSettings(); }}>
                <Icon name="ai-settings-bold" className="w-3 h-3 flex-shrink-0" />
                <span>管理模型 / 服务商…</span>
              </button>
            </div>
          </>
        )}

        <div className="composer-card">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
              // Esc：生成中=停止，否则清空输入
              if (e.key === "Escape") {
                if (isSendingRef.current) { e.preventDefault(); handleStop(); }
                else if (input) { e.preventDefault(); setInput(""); }
                return;
              }
              // ↑：输入为空且光标在最前时，召回上一条发送过的内容
              if (e.key === "ArrowUp" && !input && sentHistoryRef.current.length > 0) {
                e.preventDefault();
                setInput(sentHistoryRef.current[sentHistoryRef.current.length - 1]);
                return;
              }
              if (e.key === "Enter" && (e.shiftKey === false || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                if (isSendingRef.current) handleStop();
                else handleSend();
              }
            }}
            placeholder="输入消息…（Enter 发送 / Shift+Enter 换行）"
            rows={2}
            className="composer-input chat-scrollbar"
          />
          <div className="composer-foot">
            {/* 左：模型 + 附加选项。整组可压缩、超出裁掉，绝不把右边的按钮顶出去 */}
            <div className="flex items-center gap-1.5 flex-1 min-w-0 overflow-hidden">
            <button
              className={"composer-chip is-shrinkable" + (modelMenuOpen ? " is-on" : "")}
              onClick={() => setModelMenuOpen(v => !v)}
              disabled={!activeProvider}
              title={models.length === 0 ? "尚未勾选模型，点开去设置" : `当前模型：${activeModel || "未选"}（点击切换）`}
            >
              <Icon name="ai-monitor" className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{models.length === 0 ? (activeProvider ? "未勾选模型" : "无服务商") : (activeModel || "选择模型")}</span>
              <Icon name="ai-chevron-up" className={"w-2.5 h-2.5 flex-shrink-0 transition-transform " + (modelMenuOpen ? "rotate-180" : "")} />
            </button>

            {models.length === 0 && activeProvider && (
              <button className="composer-chip is-warn" onClick={onOpenProviderSettings} title="尚未勾选模型，点击去设置">
                <Icon name="ai-alert-triangle" className="w-3 h-3 flex-shrink-0" />
                {!compact && <span>去设置</span>}
              </button>
            )}

            <button
              className={"composer-chip" + (confirmMode ? " is-on" : "") + (compact ? " is-compact" : "")}
              onClick={() => setConfirmMode(!confirmMode)}
              title={confirmMode ? "写操作执行前需要确认（点击改为自动执行）" : "写操作直接执行（点击改为需确认）"}
            >
              <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
              {!compact && <span>{confirmMode ? "需确认" : "自动"}</span>}
            </button>

            {noteContent ? (
              <button
                className={"composer-chip" + (attachNote ? " is-on" : "") + (compact ? " is-compact" : "")}
                onClick={() => setAttachNote(v => !v)}
                title={attachNote ? `已附上当前笔记《${noteTitle || "未命名"}》作为上下文（点击取消）` : "不附上当前笔记（点击改为附上）"}
              >
                <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0" />
                {!compact && <span>附笔记</span>}
              </button>
            ) : null}
            </div>

            {/* 右：字数（够宽才显示）+ 清空 + 发送/停止。固定不压缩，保证永远点得到 */}
            {showCount && input.length > 0 && (
              <span className={"text-[10.5px] tabular-nums flex-shrink-0 " + (input.length > 2000 ? "text-amber-500" : "text-slate-300")} title={input.length > 2000 ? "内容较长，发送前会先做瘦身" : ""}>
                {input.length > 2000 ? `${input.length} 字 · 较长` : `${input.length} 字`}
              </span>
            )}
            {messages.length > 0 && !isSending && (
              <button
                className="p-1.5 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors"
                title="清空当前会话的显示内容"
                onClick={() => { setMessages([]); resetStreaming(); resetToLatest(); }}
              >
                <Icon name="ai-trash" className="w-3.5 h-3.5" />
              </button>
            )}
            {isSending ? (
              <button className="composer-send composer-stop" onClick={handleStop} title="停止生成（Esc）" aria-label="停止生成">
                <Icon name="ai-stop" className="w-3.5 h-3.5" />
              </button>
            ) : (
              <button
                className="composer-send"
                onClick={handleSend}
                disabled={!input.trim() || !activeModel}
                title={!activeModel ? "请先选择模型" : "发送（Enter）"}
                aria-label="发送"
              >
                <Icon name="ai-send" className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="composer-hint">
          {compact ? "Enter 发送 · Shift+Enter 换行" : `Enter 发送 · Shift+Enter 换行 · Esc ${isSending ? "停止" : "清空"} · ↑ 召回上一条 · 拖上边缘调高度（双击复位）`}
        </div>
      </div>
    </aside>
    {showSessionPicker && (
      <div className="ai-modal-overlay" onClick={() => setShowSessionPicker(false)}>
        <div className="ai-modal" onClick={(e) => e.stopPropagation()}>
          <div className="ai-modal-head">
            <span className="ai-modal-title">对话记录</span>
            <div className="flex items-center gap-1">
              <button
                className="ai-icon-btn"
                title="新建对话"
                onClick={() => { setShowSessionPicker(false); handleNewSession(); }}
              >
                <Icon name="ai-plus-bold" className="w-3.5 h-3.5" />
              </button>
              <button className="ai-icon-btn" title="关闭" onClick={() => setShowSessionPicker(false)}>
                <Icon name="ai-close" className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="ai-modal-search">
            <div className="relative">
              <Icon name="ai-search" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-300" />
              <input
                autoFocus
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setShowSessionPicker(false); }}
                placeholder="搜索对话标题…"
                className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-lg border border-slate-200 bg-slate-50/60 focus:bg-white focus:border-primary-300 outline-none transition-colors"
              />
            </div>
          </div>

          <div className="ai-modal-list chat-scrollbar">
            {sessionGroups.length === 0 ? (
              <div className="py-8 text-center text-[11.5px] text-slate-400">
                {sessions.length === 0 ? "还没有对话，开始聊一句就有了" : "没有匹配的对话"}
              </div>
            ) : sessionGroups.map((group) => (
              <div key={group.label}>
                <div className="ai-group-label">{group.label}</div>
                {group.items.map((s) => (
                  <div
                    key={s.id}
                    className={"ai-session-item group/sess" + (s.id === activeSessionId ? " is-active" : "")}
                    onClick={() => { switchSession(s.id); setShowSessionPicker(false); }}
                  >
                    <div className="min-w-0 flex-1">
                      {editingSessionId === s.id ? (
                        <input
                          autoFocus
                          className="w-full border border-primary-300 rounded px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-primary-500/20"
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleRenameSession(s.id);
                            if (e.key === "Escape") { setEditingSessionId(null); setEditTitle(""); }
                          }}
                          onBlur={() => { setEditingSessionId(null); setEditTitle(""); }}
                        />
                      ) : (
                        <>
                          <div className="ai-session-name truncate">{s.title || "新对话"}</div>
                          <div className="ai-session-meta truncate">{relativeTime(s.updated_at || s.created_at)}</div>
                        </>
                      )}
                    </div>
                    <div className="ai-session-actions">
                      <button
                        className="ai-icon-btn !w-6 !h-6"
                        title="重命名"
                        onClick={(e) => { e.stopPropagation(); setEditingSessionId(s.id); setEditTitle(s.title); }}
                      >
                        <Icon name="ai-edit" className="w-3 h-3" />
                      </button>
                      <button
                        className="ai-icon-btn is-danger !w-6 !h-6"
                        title="删除这个对话"
                        onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            await api.deleteChatSession(s.id);
                            setSessions(p => p.filter(x => x.id !== s.id));
                            if (activeSessionId === s.id) {
                              const rest = sessions.filter(x => x.id !== s.id);
                              if (rest.length > 0) { setActiveSessionId(rest[0].id); titleGenRef.current = null; await loadSessionMessages(rest[0].id); }
                              else { setActiveSessionId(0); setMessages([]); }
                            }
                          } catch { showToast("删除失败", "error"); }
                        }}
                      >
                        <Icon name="ai-trash" className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    )}
    {pendingConfirm && (<div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => settleConfirm(false)}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-xl shadow-2xl border border-slate-200 w-80 p-4 animate-fade-in" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-medium text-slate-700 mb-3">确认操作</h3>
        <div className="space-y-1.5 mb-4">
          {pendingConfirm.calls.map((c, i) => {
            return (<div key={i} className="flex items-center gap-2 text-xs text-slate-600">
            <Icon name="ai-warning" className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" />
            <span>{summarizeToolCall(c)}</span>
          </div>);
          })}
        </div>
        <div className="flex items-center justify-end gap-2">
          <button onClick={() => settleConfirm(false)} className="px-3 py-1.5 text-xs font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">取消</button>
          <button onClick={() => settleConfirm(true)} className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-lg transition-colors">确认执行</button>
        </div>
      </div>
    </div>)}
  </>);
};
