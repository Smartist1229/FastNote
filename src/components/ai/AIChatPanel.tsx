/**
 * AI 对话面板：流式回复、工具调用与确认弹窗、会话管理、滚动锚点、上下文压缩。
 *
 * 数据流：handleSend → agentLoop 逐轮请求模型 → parseResponse 解析 <tool_calls>
 * → TOOL_EXECUTORS 执行 → 结果回灌上下文进入下一轮 → 最终答复写入 messages 并落库。
 * 副作用：写 chat_sessions / chat_messages；派发 fastnote-select-note、fastnote-data-changed。
 *
 * 关键约束：
 * - 流式内容按 50ms 合并刷新，否则每个 token 都触发整棵消息树重渲染。
 * - ChatMessageRow / AnchorRail 依赖 memo 隔离，传入回调必须引用稳定。
 * - abortRef + runIdRef 标识轮次：旧循环在检查点静默退出，且不能释放新一轮的发送锁。
 * - 确认弹窗的 Promise 必须 settle（按钮、关面板、切会话、停止、超时），否则整轮卡死。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import { Icon } from "@/components/common/Icon";
import { AiConfirmCard } from "@/components/ai/AiConfirmCard";
import * as notesApi from "@/api/notes";
import * as categoriesApi from "@/api/categories";
import * as tagsApi from "@/api/tags";
import * as aiApi from "@/api/ai";
import * as semanticApi from "@/api/semantic";
import type { AiChatMessage, AiChatSession, AiProvider } from "@/interface/ai";
import type { Tag } from "@/interface/note";
import type { AIChatPanelProps, ToolContext, ToolResult } from "@/interface/aiChat";
import type { ToolCall, ToolTrace } from "@/interface/aiOutput";
import type { EditorSettings } from "@/interface/settings";
import { finalReplyText, parseResponse, parseStreamContent } from "@/lib/aiParse/parse";
import { isThinkingDeepEnough, shouldRetryForShallowThinking, streamStartsWithThinking } from "@/lib/aiParse/thinking";
import { compressTranscript, estimateTokens, localSummaryFallback, selectContextWindow } from "@/lib/aiParse/context";
import { buildFinalContent, cleanSessionTitle, firstLine, formatError, hasActionClaim, stripAiTags } from "@/lib/aiParse/text";
import {
  AI_ACCESS_DENIED_NOTE,
  AI_ACCESS_DISABLED_NOTE,
  AI_READ_ONLY_NOTE,
  buildAiAccessRules,
  canAiReadCategory,
  canAiReadNote,
  canAiWriteCategory,
  canAiWriteNote,
  type AiAccessLevel,
  type AiAccessRules,
} from "@/lib/aiAccess";
import { useToast } from "@/components/common/Toast";
import { AiMarkdown } from "@/components/ai/AiMarkdown";
import {
  AI_ACCESS_DENIED_PROMPT,
  AI_ACCESS_RESTRICTED_PROMPT,
  AI_READ_ONLY_PROMPT,
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
} from "@/config/aiDefaults";

const MIN_PANEL_WIDTH = 350; const MAX_PANEL_WIDTH = 640; const DEFAULT_PANEL_WIDTH = 400;
/** 内容区保底宽度：面板宽度上限 = 父容器宽度 − 该值，窗口越宽面板越能放宽到 MAX_PANEL_WIDTH */
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
  searchNotesSemantic: "语义搜索",
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
  listTags: "列出标签",
  getNoteTags: "读取标签",
  findNotesByTag: "按标签查找",
  addNoteTags: "添加标签",
  removeNoteTags: "移除标签",
  setNoteTags: "重写标签",
  renameTag: "重命名标签",
  deleteTag: "删除标签",
};

/**
 * 工具轨迹右侧的目标信息：执行前用入参拼，执行后用结果补得更具体。
 * 只负责展示，不做业务校验；未知工具走 default 分支，保证轨迹永远有内容可显示。
 */
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
    case "searchNotesSemantic": {
      const q = args.query ? `「${clip(args.query, 14)}」` : "";
      const total = num(r.total);
      return [q, Number.isFinite(total) ? `命中 ${total} 篇` : "", failure].filter(Boolean).join(" · ");
    }
    case "listNotes": {
      const scope = args.categoryName ? `「${clip(args.categoryName)}」` : "全部";
      const total = num(r.total);
      const shown = Array.isArray(r.notes) ? r.notes.length : NaN;
      return [scope, Number.isFinite(total) ? `${total} 篇${Number.isFinite(shown) ? `（列出 ${shown}）` : ""}` : ""].filter(Boolean).join(" · ");
    }
    /* ---- 标签：轨迹要能看出"加了哪几个词"，光一个数字看不出做了什么 ---- */
    case "listTags": {
      const total = num(r.total);
      const list = Array.isArray(r.tags) ? (r.tags as { name?: unknown }[]) : [];
      const names = list.slice(0, 3).map((t) => clip(t.name, 8)).join("、");
      return [Number.isFinite(total) ? `${total} 个标签` : "", names ? `：${names}${list.length > 3 ? "…" : ""}` : ""].filter(Boolean).join("");
    }
    case "getNoteTags": {
      const list = Array.isArray(r.tags) ? (r.tags as { name?: unknown }[]) : [];
      return [target, list.length > 0 ? list.slice(0, 4).map((t) => clip(t.name, 8)).join("、") : "暂无标签"].filter(Boolean).join(" · ");
    }
    case "findNotesByTag": {
      const tag = args.tagName ? `「${clip(args.tagName, 14)}」` : "";
      const total = num(r.total);
      return [tag, Number.isFinite(total) ? `${total} 篇` : ""].filter(Boolean).join(" · ") || failure;
    }
    case "addNoteTags": {
      const added = Array.isArray(r.added) ? (r.added as unknown[]) : [];
      return [target, added.length > 0 ? `加「${added.slice(0, 4).map((t) => clip(t, 8)).join("、")}」` : "未新增"].filter(Boolean).join(" · ");
    }
    case "setNoteTags": {
      const tags = Array.isArray(r.aiTags) ? (r.aiTags as unknown[]) : [];
      return [target, tags.length > 0 ? `标签：${tags.slice(0, 4).map((t) => clip(t, 8)).join("、")}` : "已清空"].filter(Boolean).join(" · ");
    }
    case "removeNoteTags": {
      const removed = Array.isArray(r.removed) ? (r.removed as unknown[]) : [];
      const skipped = Array.isArray(r.skipped) ? (r.skipped as unknown[]) : [];
      const parts = [target, removed.length > 0 ? `移除「${removed.slice(0, 4).map((t) => clip(t, 8)).join("、")}」` : "没有可移除的"];
      if (skipped.length > 0) parts.push(`${skipped.length} 个跳过（用户标签）`);
      return parts.filter(Boolean).join(" · ");
    }
    case "renameTag":
      return args.tagName ? `「${clip(args.tagName, 10)}」→「${clip(args.newName, 10)}」` : failure;
    case "deleteTag":
      return [args.tagName ? `「${clip(args.tagName, 14)}」` : "", "已删除（连带所有笔记）"].filter(Boolean).join(" ") || failure;
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


/** 确认弹窗里的一句话说明：让用户在点"确认执行"前看懂这批写操作会改什么 */
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

/**
 * 按 ID 精确读取单条笔记（同名笔记也不会取错）。
 *
 * 受限笔记在这里统一变成 null：对 AI 而言它等同于"不存在"，不暴露标题与存在性。
 * 所有读写工具都经过这个函数，所以笔记级权限只需要在这一处判断。
 */
const fetchNoteById = async (noteId: number, access: AiAccessRules) => {
  // 按 id 取单条：列表虽然也带正文，但没打开的笔记可能刚被别处改过，单条读取更能保证拿到最新内容
  let hit: any = null;
  try {
    hit = await notesApi.getNote(noteId);
  } catch {
    hit = null;
  }
  return hit && !hit.is_deleted && canAiReadNote(access, hit) ? hit : null;
};

/** 列表/搜索类工具共用：只保留未删除、且对 AI 开放的笔记 */
const visibleNotes = async (access: AiAccessRules) => {
  const all = await notesApi.getNotes(null, "updated_at", "desc");
  return all.filter((n: any) => !n.is_deleted && canAiReadNote(access, n));
};

/**
 * 按名称找分组，只在"AI 能看到"的分组里找（只读档也算能看到）。
 * 返回 null 表示"不存在或不可访问"，两种情况对模型一视同仁。
 */
const findCategoryByName = async (categoryName: unknown, access: AiAccessRules) => {
  const name = String(categoryName ?? "").trim();
  if (!name) return null;
  const cats = await categoriesApi.getCategories();
  return cats.find((c: any) => c.name === name && canAiReadCategory(access, c)) || null;
};

/**
 * 按名称找"可以写入"的分组：新建/移动进去、改名都用它。
 * 只读分组会返回 null —— 能看并不等于能往里写。
 */
const findWritableCategoryByName = async (categoryName: unknown, access: AiAccessRules) => {
  const name = String(categoryName ?? "").trim();
  if (!name) return null;
  const cats = await categoriesApi.getCategories();
  return cats.find((c: any) => c.name === name && canAiWriteCategory(access, c)) || null;
};

/**
 * 标签名归一化：模型经常把 names 写成 `"标签1, 标签2"` 这种字符串，甚至带 `#` 前缀。
 * 统一拆成一个干净的数组，去空去重（大小写不敏感），交给 Rust 侧落库。
 */
const normalizeTagNames = (raw: unknown): string[] => {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x ?? ""))
    : String(raw ?? "").split(/[,，、;；\n]+/);
  const out: string[] = [];
  for (const item of list) {
    // 去掉行首的 # 与空白：`#待办` 和 `待办` 是同一个标签
    const name = item.trim().replace(/^#+/, "").trim().slice(0, 30);
    if (!name) continue;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
};

/**
 * 工具名 → 执行器。args 来自模型输出的 <tool_calls>，ctx 只携带 currentNoteId。
 * 约定：可预期的业务失败用 { error } 或 { success: false, error } 返回，交给模型自我纠正；
 * 未捕获的异常由 runTool 转成失败轨迹。写操作在此直接落库，确认流程在上层 agentLoop。
 */
const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>> = {
  searchNotes: async (args, ctx) => {
    // 只搜对 AI 开放的笔记：受限内容连"命中数量"都不该出现在结果里
    const visible = await visibleNotes(ctx.access);
    const q = String(args.query || "").trim().toLowerCase();
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
      // 关键词只在标题/正文里找。用户说的常常是主题而不是原话，这时换标签检索才对路，
      // 否则模型只会换个词再硬搜一次。
      ...(hits.length === 0
        ? { hint: "没有命中。关键词只在标题与正文里匹配：若用户说的是主题（而不是原文用词），改用 listTags 看库里有哪些标签，再用 findNotesByTag 检索；也可以换成 2-4 个字的短关键词再搜一次。" }
        : {}),
    };
  },
  searchNotesSemantic: async (args, ctx) => {
    const query = String(args.query ?? "").trim();
    if (!query) return { error: "query 不能为空" };
    // 未开启或模型没下载时直接说明，否则模型会反复换关键词重试
    try {
      const status = await semanticApi.getSemanticStatus();
      if (!status.enabled) {
        return {
          matches: [],
          total: 0,
          error: "语义搜索未开启",
          hint: "用户没有在设置里开启语义搜索。改用 searchNotes（精确关键词）或 listTags + findNotesByTag。",
        };
      }
      if (!status.model_ready) {
        return {
          matches: [],
          total: 0,
          error: "语义模型尚未下载",
          hint: "语义模型还没下载，无法按语义检索。改用 searchNotes 或 listTags + findNotesByTag。",
        };
      }
    } catch (e) {
      return {
        matches: [],
        total: 0,
        error: `无法读取语义搜索状态：${formatError(e)}`,
        hint: "改用 searchNotes 或 listTags + findNotesByTag。",
      };
    }

    // 权限过滤在 Rust 侧完成：只传可见笔记 id，受限笔记的标题与片段不会进入返回值
    const visible = await visibleNotes(ctx.access);
    const byId = new Map<number, any>(visible.map((n: any) => [n.id as number, n]));
    if (byId.size === 0) return { matches: [], total: 0 };

    try {
      const hits = await semanticApi.semanticSearch(query, 15, [...byId.keys()]);
      const matches = hits
        .filter((hit) => byId.has(hit.note_id))
        .map((hit) => ({
          id: hit.note_id,
          title: byId.get(hit.note_id)!.title,
          content: hit.snippet,
          score: Number(hit.score.toFixed(4)),
        }));
      return {
        matches,
        total: matches.length,
        ...(matches.length === 0
          ? { hint: "没有语义命中。可以换一句更自然的描述，或改用 searchNotes / listTags + findNotesByTag。" }
          : {}),
      };
    } catch (e) {
      return {
        matches: [],
        total: 0,
        error: `语义检索失败：${formatError(e)}`,
        hint: "模型可能未就绪。改用 searchNotes 或 listTags + findNotesByTag。",
      };
    }
  },
  getNoteContent: async (args, ctx) => {
    const n: any = await fetchNoteById(Number(args.noteId), ctx.access);
    if (!n) return null;
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /** 列出笔记（按更新时间倒序，可限定分组与条数）：回答"我最近记了什么/某个分组里有什么" */
  listNotes: async (args, ctx) => {
    let list = await visibleNotes(ctx.access);
    if (args.categoryName) {
      const cat = await findCategoryByName(args.categoryName, ctx.access);
      if (!cat) return { error: `未找到分组「${String(args.categoryName)}」` };
      list = list.filter((n: any) => n.category_id === cat.id);
    }
    const limit = Math.min(Math.max(Number(args.limit) || 15, 1), 50);
    const categories = await categoriesApi.getCategories();
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
    const n: any = await fetchNoteById(nid, ctx.access);
    return n ? readNoteWindow(n) : { error: `未找到 ID 为 ${nid} 的笔记` };
  },
  /**
   * 按行范围读取（长文的关键工具）。
   * 1000 行的笔记不必从头读到尾：只取需要的窗口，带行号返回，方便随后按行修改。
   */
  readNoteLines: async (args, ctx) => {
    const nid = Number(args.noteId ?? args.id);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "缺少 noteId" };
    const n: any = await fetchNoteById(nid, ctx.access);
    if (!n) return { error: `未找到 ID 为 ${nid} 的笔记` };
    return readNoteWindow(n, args.startLine, args.lineCount);
  },
  /**
   * 在笔记里按内容定位行号（相当于 grep -n）。
   * 解决"这段话在第几行"：返回命中行号（可带上下文行），拿到行号后就能直接用
   * replaceLines/deleteLines 精确定位修改，完全不用把全文读进来。
   */
  findInNote: async (args, ctx) => {
    const nid = Number(args.noteId ?? args.id);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "缺少 noteId" };
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
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
  /** 查看回收站（受限笔记不出现：连"回收站里有几篇"都不该暴露给它） */
  listTrash: async (_args, ctx) => {
    const notes: any[] = (await notesApi.getTrashNotes()).filter((n) => canAiReadNote(ctx.access, n));
    return {
      total: notes.length,
      notes: notes.slice(0, 20).map((n) => ({ id: n.id, title: n.title, deleted_at: n.deleted_at })),
    };
  },
  /** 从回收站还原笔记 */
  restoreNote: async (args, ctx) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    // 从回收站列表里取标题（回收站里的笔记用 get_note_content 不一定可靠）
    let title = "";
    try {
      const trashed: any[] = await notesApi.getTrashNotes();
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
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    const trashed: any[] = await notesApi.getTrashNotes();
    const target = trashed.find(n => n.id === nid);
    if (!target) return { success: false, error: `回收站里没有 ID 为 ${nid} 的笔记（先用 listTrash 确认）` };
    if (!canAiReadNote(ctx.access, target)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
    if (!canAiWriteNote(ctx.access, target)) return { success: false, error: AI_READ_ONLY_NOTE };
    await notesApi.deleteNotePermanently(nid);
    return { success: true, id: nid, title: target.title, permanent: true };
  },
  /** 清空回收站（不可恢复） */
  emptyTrash: async (_args, ctx) => {
    const trashed: any[] = await notesApi.getTrashNotes();
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
  /** 一次创建多篇笔记（例如把一段内容拆成若干篇） */
  createNotes: async (args, ctx) => {
    const raw = Array.isArray(args.notes) ? (args.notes as any[]) : [];
    if (raw.length === 0) return { success: false, error: "notes 为空，需要 [{title, content?, categoryName?}]" };
    const created: { id: number; title: string }[] = [];
    for (const item of raw.slice(0, 10)) {
      const it: any = item || {};
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
        String(it.title ?? "无标题"),
        String(it.content ?? ""),
        cat?.id ?? null,
        ctx.defaultNoteAiAccess,
      );
      created.push({ id: r.id, title: r.title });
    }
    return { success: true, count: created.length, created };
  },
  getCategories: async (_args, ctx) => {
    const cats = await categoriesApi.getCategories();
    return cats.filter((c: any) => canAiReadCategory(ctx.access, c)).map((c: any) => ({ id: c.id, name: c.name }));
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
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId，无法定位笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    const cat = args.categoryName ? await findWritableCategoryByName(args.categoryName, ctx.access) : null;
    if (args.categoryName && !cat) return { success: false, error: `分组「${String(args.categoryName)}」不存在，或对 AI 不可写（可能被设为只读/禁止）` };
    await notesApi.updateNote(nid, String(args.title ?? n.title), String(args.content ?? n.content), cat?.id ?? n.category_id ?? null);
    return { success: true, id: nid, title: String(args.title ?? n.title) };
  },
  updateCurrentNote: async (args, ctx) => {
    const nid = Number(ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) {
      return { success: false, error: "当前没有打开的笔记，无法执行 updateCurrentNote" };
    }
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid)) return { success: false, error: "缺少有效的 noteId" };
    // 先取出标题：轨迹里要能显示"删除笔记 #16 · 《XX》"，只有一个 ID 用户看不出删了什么
    // 顺带拦下受限笔记：取不到就直接拒，绝不先删再说
    const before: any = await fetchNoteById(nid, ctx.access);
    if (!before) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    if (!canAiWriteNote(ctx.access, before)) return { success: false, error: AI_READ_ONLY_NOTE };
    await notesApi.moveToTrash(nid);
    return { deleted: true, id: nid, title: before?.title ?? "", toTrash: true };
  },
  createCategory: async (args, ctx) => {
    const r = await categoriesApi.createCategory(String(args.name), ctx.defaultCategoryAiAccess);
    return { id: r.id, name: r.name };
  },
  renameCategory: async (args, ctx) => {
    const cid = Number(args.categoryId);
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
    const cid = Number(args.categoryId);
    if (!Number.isFinite(cid)) return { success: false, error: "缺少有效的 categoryId" };
    const withNotes = args.deleteNotes === true || args.deleteNotes === "true";
    // 先取分组名与组内笔记数：轨迹要显示"删除分组「读书」· 组内 3 篇移入回收站"
    let name = "";
    let noteCount = 0;
    try {
      const cats: any[] = await categoriesApi.getCategories();
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
  moveNote: async (args, ctx) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid, ctx.access);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    // 只读档：读得到但改不了，明确告诉模型原因，别让它反复重试
    if (!canAiWriteNote(ctx.access, n)) return { success: false, error: AI_READ_ONLY_NOTE };
    // 目标分组同样要过权限：不能把笔记搬进 AI 无权访问的分组（等于顺手解锁）
    const rawTarget = args.categoryId;
    const targetId = rawTarget === null || rawTarget === undefined || rawTarget === "" ? null : Number(rawTarget);
    let category = "";
    if (targetId !== null) {
      if (!Number.isFinite(targetId)) return { success: false, error: "缺少有效的 categoryId" };
      const cats = await categoriesApi.getCategories();
      const target = cats.find((c: any) => c.id === targetId);
      if (!target) return { success: false, error: `未找到 ID 为 ${targetId} 的分组` };
      if (!canAiWriteCategory(ctx.access, target)) return { success: false, error: AI_ACCESS_DENIED_NOTE };
      category = target.name || "";
    }
    await notesApi.updateNote(nid, n.title, n.content, targetId);
    return { moved: true, id: nid, title: n.title, category: category || "未分类" };
  },
  selectNote: async (args, ctx) => {
    const nid = Number(args.noteId);
    if (!Number.isFinite(nid) || nid <= 0) return { selected: false, error: "缺少有效的 noteId" };
    // 先确认笔记存在再打开：否则"s打开成功"只是谎报，模型会以为已经打开而继续往下说
    const note: any = await fetchNoteById(nid, ctx.access);
    if (!note) return { selected: false, error: `未找到 ID 为 ${nid} 的笔记，请先用 searchNotes 确认 ID` };
    window.dispatchEvent(new CustomEvent('fastnote-select-note', { detail: { noteId: nid } }));
    return { selected: true, noteId: nid, title: note.title };
  },

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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
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
    let all: any[] = await tagsApi.listNotesByTag(name);
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
        for (const n of notes) if (!all.some((x: any) => x.id === n.id)) all.push(n);
      }
      if (matchedTags.length > 0) {
        all.sort((a: any, b: any) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
      }
    }
    // 与别处一致：未授权的笔记连出现在结果里都不行
    const visible = all.filter((n: any) => canAiReadNote(ctx.access, n));
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 50);
    const categories = await categoriesApi.getCategories();
    const nameOf = (id: number | null) => categories.find((c) => c.id === id)?.name || "未分类";
    return {
      tag: name,
      ...(matchedTags.length > 0 ? { matchedTags } : {}),
      total: visible.length,
      notes: visible.slice(0, limit).map((n: any) => ({
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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
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
    const nid = Number(args.noteId ?? ctx.currentNoteId);
    if (!Number.isFinite(nid) || nid <= 0) return { success: false, error: "缺少 noteId，且当前没有打开的笔记" };
    const n: any = await fetchNoteById(nid, ctx.access);
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



/** 消息操作按钮：只有小图标、不带文字 */
const MSG_ACTION_BTN =
  "inline-flex items-center justify-center p-1 rounded-lg text-faint hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-95";

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
 * 单条消息：用户消息用浅色气泡右对齐，AI 回复无气泡、正文直接铺在面板上。
 * memo 是性能关键——流式输出时 streamingContent 每 50ms 变一次，若父组件重渲染穿透下来，
 * 历史消息里每条 AI 回复都要重新解析 markdown，滚动就会卡。
 * 因此父组件传入的回调都做了稳定化，工具展开状态也按行拆分（toolOpen）。
 */
const ChatMessageRow = memo(function ChatMessageRow({
  msg, index, expanded, thoughtOpen, toolOpen, live, isSending, showToolTrace, editorSettings, onToggleGroup, onToggleThought, onToggleTool, onInsertText, onReplaceContent, onCopyText, onOpenInEditor,
}: {
  msg: AiChatMessage & { thinking?: string; tools?: ToolTrace[]; at?: number; thinkMs?: number };
  index: number;
  /** 「深度思考」父折叠是否展开（思考中默认展开，回答结束后默认收起） */
  expanded: boolean;
  /** 父折叠里的「思考」子折叠是否展开（默认收起） */
  thoughtOpen: boolean;
  /** 这一行自己的工具展开状态（按行传入，切换某一行不会让整列重渲染） */
  toolOpen: Record<string, boolean>;
  /** 这一行是否正处在"思考/执行中"，用于父折叠上的状态提示 */
  live: boolean;
  isSending: boolean;
  /** 是否显示工具执行轨迹（设置里可关） */
  showToolTrace: boolean;
  /** 「编辑器」分区的设置：传给 AiMarkdown，让代码块外观与笔记一致 */
  editorSettings?: EditorSettings;
  onToggleGroup: (i: number, open: boolean) => void;
  onToggleThought: (i: number) => void;
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
  /** 实际展示的工具轨迹（设置里关掉就当作没有） */
  const traceTools = showToolTrace && msgTools ? msgTools : [];
  /** 还有工具没跑完：父折叠上直接标"执行中…" */
  const toolRunning = traceTools.some((t) => t.ok === null || t.ok === undefined);
  /** 只要思考或工具轨迹存在，就把它们统一收进一个「深度思考」父折叠 */
  const hasTrace = !!msgThinking || traceTools.length > 0;
  /** 底部元信息：时间 · 用时 · token（AI 回复的 token 含思考过程与工具调用） */
  const metaText = [
    msg.at ? formatMessageTime(msg.at) : "",
    msg.thinkMs ? `用时 ${(msg.thinkMs / 1000).toFixed(1)}s` : "",
    `${formatTokens(msgTokens(msg))} tok`,
  ].filter(Boolean).join(" · ");

  if (msg.role === 'user') {
    return (
      <div data-chat-anchor="true" className="group/msg flex flex-col items-end animate-fade-in" style={{ animationDelay: delay }}>
        <div className="selectable rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap bg-surface-alt text-body max-w-[85%]">{msg.content}</div>
        <div className="mt-0.5 mr-1 flex items-center gap-0.5">
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-faint-soft tabular-nums select-none" title="整条消息的估算 token">{msg.at ? `${formatMessageTime(msg.at)} · ` : ""}{formatTokens(msgTokens(msg))} tok</span>
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

  // AI 回复不画气泡、头像和名字，正文直接铺开（对齐主流编程 Agent 的视觉）
  return (
    <div className="group/msg animate-fade-in space-y-0.5" style={{ animationDelay: delay }}>
      {hasTrace ? (
        <div className="group/depth">
          {/* 父折叠：思考 + 所有工具调用统一收在这里，思考时展开、回答结束后收起 */}
          <button
            onClick={() => onToggleGroup(index, !expanded)}
            className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-body transition-colors py-0.5"
            title={expanded ? "收起思考与工具调用" : "展开思考与工具调用"}
          >
            <Icon name="ai-lightbulb" className="w-3 h-3 flex-shrink-0" />
            <span className="flex-shrink-0">分析</span>
            {/* 父折叠只留标题，不带思考预览：过程内容都在展开后的子折叠里 */}
            <span className="min-w-0 flex-1" />
            {live || toolRunning ? (
              <span className="flex-shrink-0 text-[10.5px] text-primary-400">{toolRunning ? "执行中…" : "思考中…"}</span>
            ) : null}
            <span className="flex-shrink-0 text-[10.5px] text-faint-soft opacity-0 group-hover/depth:opacity-100 transition-opacity">
              {expanded ? "收起" : "展开"}
            </span>
            <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 transition-transform " + (expanded ? "rotate-90" : "")} />
          </button>
          {expanded && (
            <div className="mt-0.5 ml-[18px] pl-2 border-l border-line-soft space-y-0.5">
              {/* 子折叠 1：思考正文，默认不展开 */}
              {msgThinking ? (
                <div className="group/thinking">
                  <button
                    onClick={() => onToggleThought(index)}
                    className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-faint hover:text-body transition-colors py-0.5"
                    title={thoughtOpen ? "收起思考过程" : "展开思考过程"}
                  >
                    <Icon name="ai-lightbulb" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
                    <span className="flex-shrink-0">思考</span>
                    {/* 预览始终保留：展开/收起只靠右侧箭头旋转表示，不要把内容换成"收起"两个字 */}
                    <span className="text-faint-soft flex-shrink-0">·</span>
                    <span className="min-w-0 flex-1 truncate">{firstLine(msgThinking)}</span>
                    <span className="flex-shrink-0 text-[10.5px] text-faint-soft opacity-0 group-hover/thinking:opacity-100 transition-opacity">
                      {thoughtOpen ? "收起" : "展开"}
                    </span>
                    <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 transition-transform " + (thoughtOpen ? "rotate-90" : "")} />
                  </button>
                  {thoughtOpen && (<div className="thinking-body chat-scrollbar mt-0.5 px-3 py-2 bg-app rounded-lg text-xs text-muted leading-relaxed whitespace-pre-wrap border border-line-soft">{msgThinking}</div>)}
                </div>
              ) : null}
              {/* 子折叠 2…N：每次工具调用一条，默认不展开，点击可看调用 JSON 与执行结果 */}
              {traceTools.map((tool, ti) => {
                const traceKey = `${index}-${ti}`;
                const open = !!toolOpen[traceKey];
                const running = tool.ok === null || tool.ok === undefined;
                return (
                  <div key={traceKey}>
                    <button
                      type="button"
                      onClick={() => onToggleTool(traceKey)}
                      className={`flex w-full items-center gap-1.5 text-left text-[11.5px] transition-colors py-0.5 ${
                        tool.ok === false ? 'text-danger hover:text-danger-strong' : 'text-faint hover:text-body'
                      }`}
                      title="展开查看调用参数与结果"
                    >
                      {running ? (
                        <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-primary-400 animate-pulse" />
                        </span>
                      ) : tool.ok ? (
                        <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
                      ) : (
                        <Icon name="ai-alert-triangle" className="w-3 h-3 flex-shrink-0" />
                      )}
                      <span className="flex-shrink-0">{TOOL_LABELS[tool.name] || tool.name}</span>
                      {tool.detail ? (<><span className="text-faint-soft flex-shrink-0">·</span><span className="truncate" title={tool.detail}>{tool.detail}</span></>) : null}
                      {running ? <span className="flex-shrink-0 text-faint-soft">执行中…</span> : null}
                      <Icon name="ai-chevron-right" className={"w-3 h-3 flex-shrink-0 text-faint-soft transition-transform " + (open ? "rotate-90" : "")} />
                    </button>
                    {open && (
                      <pre className="mt-0.5 mb-1 ml-[18px] px-2 py-1.5 rounded-lg bg-app border border-line-soft text-[10.5px] leading-relaxed text-muted whitespace-pre-wrap break-all max-h-48 overflow-y-auto">{`调用 ${JSON.stringify({ name: tool.name, args: tool.args })}　结果 ${
                        running ? '（执行中）' : JSON.stringify(tool.result ?? null).slice(0, 400)
                      }`}</pre>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
      {msg.content ? (
        <div className="text-[13px] leading-[1.75] text-body">
          <AiMarkdown content={msg.content} editorSettings={editorSettings} />
        </div>
      ) : null}
      {/* 时间 + 操作按钮：同一行固定展示（与用户消息对称，AI 这条在左下角） */}
      {(msg.content || msg.at || msg.thinkMs) ? (
        <div className="pt-0.5 flex items-center gap-0.5">
          {msg.content && !isSending && (
            <>
              <button onClick={() => onInsertText(msg.content)} className={MSG_ACTION_BTN} title="将内容插入到光标处"><Icon name="ai-plus" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onReplaceContent(msg.content)} className={`${MSG_ACTION_BTN} hover:!text-warning hover:!bg-warning-soft`} title="覆盖当前打开的笔记"><Icon name="ai-replace" className="w-3.5 h-3.5" /></button>
              <button onClick={() => onCopyText(msg.content)} className={MSG_ACTION_BTN} title="复制消息"><CopyIcon /></button>
              <button onClick={() => onOpenInEditor(msg.content)} className={`${MSG_ACTION_BTN} hover:!text-info hover:!bg-info-soft`} title="在编辑器中打开（临时预览，不会保存为笔记）"><Icon name="open-in-editor" className="w-3.5 h-3.5" /></button>
            </>
          )}
          <span className="inline-flex h-[22px] items-center text-[10.5px] leading-none text-faint-soft tabular-nums select-none" title="整条回复的估算 token（含思考过程与工具调用）">{metaText}</span>
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
/**
 * 悬浮波浪：离鼠标越近的横线越长越粗（0 = 鼠标正下方）。
 * 系数刻意保守：放大后仍落在 24px 点击热区内，不会盖到正文；纵向倍率更低，避免线条显粗。
 */
const RAIL_WAVE_SCALE_X = [1.3, 1.16, 1.06, 1.02];
const RAIL_WAVE_SCALE_Y = [1.4, 1.18, 1.06, 1.02];

/**
 * 右侧历史锚点导轨（横线样式），每条横线对应一条用户消息。
 * memo 同样是为了流式性能：父组件每 50ms 刷新一次，不隔离的话几十条横线
 * 会跟着重渲染，滚动与悬停都会顿。
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

/** 用户点了"取消"时写进工具结果的固定文案 */
const CONFIRM_CANCELLED = "用户已取消";
/** 等待确认的上限时间：超时按"取消"结算，避免 agentLoop 永久挂起 */
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

/* ---------- 上下文瘦身（记忆管理） ---------- */

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
/**
 * 读标签失败也不能连累"读笔记"本身：标签只是附带信息，缺了它顶多是不自动打标签。
 */
const safeNoteTags = async (noteId: number): Promise<Tag[]> => {
  try {
    return await tagsApi.listNoteTags(noteId);
  } catch {
    return [];
  }
};

/**
 * 读取窗口的统一产出。
 * 一定带上 tags / aiTags：模型是看着这份结果决定"要不要顺手补标签"的，
 * 结果里没有这个字段，提示词里写再多"读完要打标签"也没有判断依据。
 */
const readNoteWindow = async (n: any, startLineArg?: unknown, lineCountArg?: unknown) => {
  const content = String(n.content ?? "");
  const startLine = Math.max(1, Math.floor(Number(startLineArg) || 1));
  const lineCount = Math.min(Math.max(Math.floor(Number(lineCountArg) || NOTE_READ_LINES), 1), NOTE_READ_MAX_LINES);
  const { totalLines, from, to, numbered } = sliceNoteLines(content, startLine, lineCount);
  const tags = await safeNoteTags(Number(n.id));
  const aiTags = tags.filter((t) => t.source === "ai").map((t) => t.name);
  const rangeHint = to < totalLines
    ? `本笔记共 ${totalLines} 行，本次只返回第 ${from}-${to} 行；继续读取请调用 getNoteContent/readNoteLines 并带 startLine=${to + 1}。修改请用 replaceLines/insertLines/deleteLines，不要整篇覆盖。`
    : "已返回全部内容（行号仅用于定位，不要写进正文）。";
  const tagHint = aiTags.length === 0
    ? "这篇还没有 AI 标签：读完正文后在同一轮用 setNoteTags 补 2-5 个简短标签（先用 listTags 复用库里已有的词），直接执行、不必询问用户。"
    : "";
  return {
    id: n.id,
    title: n.title,
    category_id: n.category_id ?? null,
    totalLines,
    totalChars: content.length,
    lines: `${from}-${to}`,
    content: numbered,
    tags: tags.map((t) => t.name),
    aiTags,
    hint: [rangeHint, tagHint].filter(Boolean).join(" "),
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

/**
 * 右侧 AI 对话面板。isOpen=false 时直接返回 null：消息 state 保留，滚动 DOM 与会话视图重建。
 *
 * noteTitle / noteContent 是当前笔记，attachNote 开启时随请求发送；currentNoteId 供
 * updateCurrentNote / appendToNote 等工具定位"用户此刻正在看的那一篇"。
 * aiPrompts / aiSettings 决定系统提示词、上下文预算、轮数上限与流式开关。
 *
 * 访问控制：categories + aiSettings.aiAccessEnabled 合成 AiAccessRules，每次发送时快照一次，
 * 工具执行全部按它过滤（详见 lib/aiAccess.ts）。currentNoteAiLevel 是"用户正在看的这篇"
 * 的生效档位：0 不附正文，1 可以读但不能改，2 无限制。
 *
 * 副作用：写 chat_sessions / chat_messages，并派发 fastnote-data-changed、
 * fastnote-select-note 通知外部刷新列表与切换笔记。
 */
export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, currentNoteId, categories = [], currentNoteAiLevel = 2, onInsertText, onReplaceContent, onOpenInEditor, onOpenProviderSettings, onOpenAiMemory, aiPrompts, aiSettings, onAiSettingsChange, editorSettings, onClose, enableAI, isExternalFile }) => {
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
  /** 模型下拉菜单的位置（fixed 定位，点击按钮时计算） */
  const [modelMenuPos, setModelMenuPos] = useState<{ bottom: number; left: number; width: number } | null>(null);
  /** 模型下拉菜单触发按钮的 DOM 引用 */
  const modelChipRef = useRef<HTMLButtonElement>(null);
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
  /**
   * 本轮对话是否"还没正式结束"。
   *
   * 与 isSending 分工不同：isSending 只表示"有流式请求在飞"，工具执行与三类纠错重来
   * 期间它会短暂变 false（流已经停了、下一轮还没发），但那一轮**并没有结束**。
   * 「分析」折叠要看的是后者——否则多轮工具调用时它会每一轮闪一下收起再展开。
   * 只有最终答复落地 / 报错收尾 / 用户点停止，才置 false（那时折叠自动收起）。
   */
  const [turnActive, setTurnActive] = useState(false);
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
  /** 「深度思考」父折叠的手动展开状态（key = 消息序号）：没点过就走默认值（思考中展开、结束后收起） */
  const [groupOpen, setGroupOpen] = useState<Record<number, boolean>>({});
  /** 父折叠里的「思考」子折叠是否展开（key = 消息序号），默认不展开 */
  const [thoughtOpen, setThoughtOpen] = useState<Record<number, boolean>>({});
  /** 工具轨迹行的展开状态（key = 消息序号-工具序号），展开可看调用 JSON 与结果 */
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  /**
   * 待确认的写操作：一次只问一条，`index/total` 就是右上角的「1/2」。
   * 逐条问是为了保证执行顺序——用户不能跳着看，点「执行」才会走到下一条。
   */
  const [pendingConfirm, setPendingConfirm] = useState<{
    call: ToolCall;
    index: number;
    total: number;
    resolve: (v: boolean) => void;
  } | null>(null);
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
  /** 模型下拉菜单的 DOM 引用：用于点击外部时关闭 */
  const modelMenuRef = useRef<HTMLDivElement>(null);
  /** 已经生成过标题的会话 ID；用 ref 记住具体会话，避免"新对话"标题反复生成 */
  const titleGenRef = useRef<number | null>(null);
  /** 已请求停止：agentLoop 在各检查点据此提前返回，不再改 UI */
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
   * 的 Markdown 渲染）都要重新 diff 一次，界面就会卡。这里按 50ms 合并刷新一次。
   */
  const streamGenRef = useRef(0);
  const streamPendingRef = useRef<string | null>(null);
  const streamTimerRef = useRef<number | null>(null);
  /** 本轮流式开始的时间：作为流式预览消息的时间戳，避免中途跳成当前时刻 */
  const streamStartedAtRef = useRef(0);
  /** 本轮唯一的助手占位气泡：思考与工具轨迹都挂在它上面，null 表示本轮尚未创建 */
  const placeholderRef = useRef<AiChatMessage | null>(null);
  /** 当前打开笔记的 ID（组件内持有，工具执行时作为上下文传入） */
  const currentNoteIdRef = useRef<number | null>(null);
  /**
   * AI 访问规则快照：分组开关 + 总开关合成，随 categories / 设置变化重建。
   * 一轮对话内保持不变，工具执行期间用户即使去改了权限，也只影响下一轮。
   */
  const accessRules = useMemo(
    () => buildAiAccessRules(aiSettings.aiAccessEnabled, categories),
    [aiSettings.aiAccessEnabled, categories],
  );
  const accessRef = useRef<AiAccessRules>(accessRules);
  useEffect(() => { accessRef.current = accessRules; }, [accessRules]);
  /**
   * 新建笔记 / 分组默认档位的快照：与 accessRef 同样在发送时读一次，
   * 这样一轮工具执行到一半用户去改设置，也只影响下一轮。
   */
  const defaultAccessRef = useRef({
    note: aiSettings.defaultNoteAiAccess,
    category: aiSettings.defaultCategoryAiAccess,
  });
  useEffect(() => {
    defaultAccessRef.current = {
      note: aiSettings.defaultNoteAiAccess,
      category: aiSettings.defaultCategoryAiAccess,
    };
  }, [aiSettings.defaultNoteAiAccess, aiSettings.defaultCategoryAiAccess]);
  /** 是否存在任何限制：用于决定要不要给模型加"看不见 / 改不了是正常的"说明 */
  const accessRestricted = useMemo(
    () => !accessRules.enabled || [...accessRules.categoryLevels.values()].some((lv) => lv < 2),
    [accessRules],
  );
  /** 当前笔记的生效档位（总开关关闭即 0） */
  const currentLevel: AiAccessLevel = aiSettings.aiAccessEnabled ? currentNoteAiLevel : 0;
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
  /** 选中的模型写回服务商的 enabled_model 并持久化，保证重启后选中项不丢 */
  const persistActiveModel = useCallback((model: string) => {
    if (!activeProvider || !model || activeProvider.enabled_model === model) return;
    const next = { ...activeProvider, enabled_model: model };
    setProviders((prev) => prev.map((p) => (p.id === next.id ? next : p)));
    aiApi.updateAiProvider(next).catch(() => {});
  }, [activeProvider]);

  // 工具执行时作为 ToolContext 传入，让 updateCurrentNote / appendToNote 始终作用于当前笔记
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
  // 服务商在设置弹窗里增删改后，重新拉取列表
  useEffect(() => {
    const handler = () => { loadProviders(); };
    window.addEventListener('fastnote-providers-changed', handler);
    return () => window.removeEventListener('fastnote-providers-changed', handler);
  }, []);
  // 在设置弹窗里切换了服务商：同步为本面板的当前选择
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
   * 询问用户是否执行某个破坏性工具（逐条问，保持顺序）。
   * 返回的 Promise 一定会 settle（执行/取消按钮、关闭面板、切换会话、点停止、超时），
   * 否则 agentLoop 永不返回、发送锁永不释放，之后所有发送都会被静默吞掉。
   */
  const confirmDestructive = useCallback(
    (call: ToolCall, index: number, total: number): Promise<boolean> => {
      beginConfirm();
      return new Promise<boolean>((resolve) => {
        confirmResolveRef.current = resolve;
        setPendingConfirm({ call, index, total, resolve: settleConfirm });
        confirmTimerRef.current = window.setTimeout(() => settleConfirm(false), CONFIRM_TIMEOUT_MS);
      });
    },
    [beginConfirm, settleConfirm],
  );

  /** 把一段结果说明写回对话：优先就地替换占位气泡，没有占位就追加 */
  const commitNotice = useCallback(async (sid: number, text: string, leftover: any) => {
    const usedMs = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;
    setMessages(m => {
      const msg = { role: 'assistant' as const, content: text, thinking: leftover?.thinking, tools: leftover?.tools, at: leftover?.at ?? Date.now(), thinkMs: usedMs || undefined } as any;
      const idx = leftover ? m.findIndex(x => x === leftover) : -1;
      return idx >= 0 ? [...m.slice(0, idx), msg] : [...m, msg];
    });
    try { await aiApi.saveChatMessage(sid, 'assistant', text); } catch {}
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
   * 贴底保险：流式结束、消息落地后，Markdown 的代码高亮/表格/KaTeX 仍在异步渲染，
   * 内容还会继续长高；只靠 messages / streamingContent 变化触发滚动会漏掉这次增长。
   * 这里观察内容层尺寸，一变就重新贴底（仅在跟随模式下，用户上滑查历史时不打扰）。
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

  // 点击外部关闭模型下拉菜单
  useEffect(() => {
    if (!modelMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 点击菜单本身或模型 chip 按钮时不关闭
      if (modelMenuRef.current?.contains(target)) return;
      const chip = (e.target as HTMLElement)?.closest?.('.composer-chip');
      if (chip) return;
      setModelMenuOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [modelMenuOpen]);

  const selectedProviderIdRef = useRef(selectedProviderId);
  useEffect(() => { selectedProviderIdRef.current = selectedProviderId; }, [selectedProviderId]);
  const loadProviders = async () => {
    try {
      const list = await aiApi.getAiProviders();
      setProviders(list);
      setProvidersError("");
      if (list.length > 0 && !selectedProviderIdRef.current) setSelectedProviderId(list[0].id);
    } catch (error) {
      console.error("读取 AI 服务商失败:", error);
      setProvidersError(formatError(error));
    }
  };
  const loadSessions = async () => { try { setSessions(await aiApi.getChatSessions()); } catch {} };
  /**
   * 加载历史消息：只对 assistant 消息做标签解析。
   * 用户消息原样展示——他可能自己粘贴了含 <tool_calls> 字样的文本，不能被剥离；
   * assistant 消息也绝不回退到原始文本，否则截断的半截工具调用会再次被显示出来。
   */
  const loadSessionMessages = async (sid: number) => {
    try {
      const m = await aiApi.getChatMessages(sid);
      resetToLatest();
      // 折叠状态是按消息序号存的，换会话必须清空，否则会把上一段对话的展开状态套到新消息上
      setGroupOpen({});
      setThoughtOpen({});
      setExpandedTools({});
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
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await aiApi.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; settleConfirm(false); draftsRef.current[activeSessionId] = input; setActiveSessionId(sid); setInput(draftsRef.current[sid] || ''); resetStreaming(); setTurnActive(false); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { settleConfirm(false); draftsRef.current[activeSessionId] = input; const s = await aiApi.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setInput(''); resetStreaming(); resetToLatest(); setTurnActive(false); setGroupOpen({}); setThoughtOpen({}); setExpandedTools({}); titleGenRef.current = null; };
  /**
   * 自动生成对话标题，只对仍叫"新对话"的会话生效。
   * titleGenRef 记住已生成过的会话 ID，保证每个会话只请求一次标题模型；
   * 生成前重新拉取会话列表核对标题，避免覆盖用户手动改过的名字。
   * 输入先去标签并截断到 300 字，防止 <thinking> 推理或工具 JSON 混进标题。
   */
  const genTitle = async (sid: number, up: string, ar: string) => {
    if (titleGenRef.current === sid || !activeProvider) return;
    titleGenRef.current = sid;
    try {
      const list = await aiApi.getChatSessions();
      const session = list.find(s => s.id === sid);
      if (!session || session.title !== "新对话") return;
      // 送进去的内容也要先去标签：否则整段 <thinking> 推理会被当成"对话内容"喂给标题模型
      const userText = stripAiTags(up).replace(/<[^>]+>/g, "").trim().slice(0, 300);
      const assistantText = stripAiTags(ar).replace(/<[^>]+>/g, "").trim().slice(0, 300);
      const t = await aiApi.sendAiChat(activeProvider.id, [{ role: "system", content: buildTitlePrompt(userText, assistantText) }, { role: "user", content: TITLE_USER_MESSAGE }], "", "");
      const ct = cleanSessionTitle(t);
      // 洗不出有效标题就不写库，并允许下次重试
      if (!ct) { titleGenRef.current = null; return; }
      await aiApi.updateChatSessionTitle(sid, ct);
      await loadSessions();
    } catch (error) {
      console.error("生成对话标题失败:", error);
      titleGenRef.current = null; // 失败时允许下次重试
    }
  };
  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await aiApi.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(''); await loadSessions(); } catch { showToast('重命名失败', 'error'); } };
  /**
   * 工具循环主体：反复"请求模型 → 解析 → 执行工具 → 回灌结果"，直到模型给出纯文本回复。
   * - 每轮只维护一个占位气泡（placeholderRef），工具轨迹逐条回填，避免"深度思考"重复出现。
   * - 每次请求与工具执行前都检查 isStale()：被停止或被新消息取代后不再改 UI、不再动数据。
   * - 三类纠错（思考过浅、声称完成却无工具、工具调用被截断）各自只重试一次。
   * - 上下文在进循环前压缩一次（摘要 + 滑动窗口），循环内只压缩旧工具结果。
   */
  const agentLoop = async (sid: number, msgs: AiChatMessage[], prompt: string): Promise<void> => {
    placeholderRef.current = null;
    executedCallKeys.current = new Set();
    /** 本轮的编号：一旦被"停止"或被新消息取代，旧循环必须立刻安静退出，绝不再改界面 */
    const myRun = runIdRef.current;
    const isStale = () => abortRef.current || runIdRef.current !== myRun;
    /** 系统提示词 = 工具协议 + 深度思考要求 + 用户自定义的前置提示词/记忆（每次请求都带上） */
    const memoryBlock = buildMemoryBlock(aiPrompts);
    // 访问受限时补一段说明：模型才知道"搜不到"是设置导致的，不会反复换关键词重试
    const accessBlock = !aiSettings.aiAccessEnabled
      ? AI_ACCESS_DENIED_PROMPT
      : [accessRestricted ? AI_ACCESS_RESTRICTED_PROMPT : "", currentLevel === 1 ? AI_READ_ONLY_PROMPT : ""]
          .filter(Boolean)
          .join("\n\n");
    const systemPrompt = [AI_SYSTEM_PROMPT, buildThinkRule(aiSettings.minThinkingLen), accessBlock, memoryBlock].filter(Boolean).join("\n\n");
    /** 当前笔记能否作为上下文：手动关闭附带、笔记受限、总开关关闭，任一情况都不发 */
    const canAttachNote = attachNote && currentLevel > 0;
    let roundMsgs = [...msgs];

    /* ---------- 上下文压缩（滑动窗口 + 摘要） ----------
     * 对话变长后，把更早的部分压成要点，只把"摘要 + 最近若干条"发给模型。
     * 界面上的历史保持完整，压缩只作用于本次请求；同一段只摘要一次，结果缓存在 ref。
     */
    {
      const { kept, dropped } = selectContextWindow(msgs, aiSettings.contextBudget, aiSettings.keepRecent);
      const cache = contextSummaryRef.current;
      let summary = cache && cache.sid === sid ? cache.text : "";
      let covered = cache && cache.sid === sid ? cache.covered : 0;
      if (covered > dropped.length) { summary = ""; covered = 0; }              // 换会话或历史被清空
      // 每新增 6 条被丢弃的消息才重算一次摘要：摘要请求本身也耗 token 与时间
      const needsSummary = dropped.length > 0 && (!summary || dropped.length - covered >= 6);
      if (needsSummary && activeProvider?.id) {
        try {
          const text = await aiApi.sendAiChat(
            activeProvider.id,
            [
              { role: "system", content: CONTEXT_SUMMARY_PROMPT },
              { role: "user", content: buildSummaryUserMessage(summary, compressTranscript(dropped)) },
            ],
            // noteTitle / noteContent 都传空：摘要是纯文本压缩，不该把当前笔记或模型名
            // 当作上下文塞进去（模型由 provider 自己的 enabled_model 决定）
            "",
            "",
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
    /** 三个纠错各记一次，互不挤占，否则前一次重试会屏蔽后一次 */
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
          ? await aiApi.sendAiChatStream(
              activeProvider!.id,
              [{ role: 'system', content: systemPrompt }, ...roundMsgs],
              canAttachNote ? noteTitle || '' : '',
              canAttachNote ? noteContent : '',
              (c, r) => {
                nativeReasoning = r;
                if (!isStale()) pushStreamContent(c, roundGen);
              },
              aiSettings.minThinkingLen,
              // 受限笔记连 ID 都不告诉模型：否则它会以为"当前笔记可用"，反复调用后再失败。
              // 用户只是手动取消「附笔记」时不在此列——那时内容仍可通过工具读取。
              currentLevel === 0 ? null : currentNoteId ?? null,
              aiSettings.maxTokens,
            )
          : await aiApi.sendAiChat(
              activeProvider!.id,
              [{ role: 'system', content: systemPrompt }, ...roundMsgs],
              canAttachNote ? noteTitle || '' : '',
              canAttachNote ? noteContent : '',
              aiSettings.maxTokens,
            );
        if (isStale()) return;
        const parsed = parseResponse(full, nativeReasoning);
        // thinking 为纯推理（用于校验深度），thinkingDisplay 才是思考区展示文本（含工具调用原文）
        const { thinking, thinkingDisplay, toolCalls, truncated } = parsed;

        // ---------- 纠错 1：思考过浅，要求重新深入思考 ----------
        // 仅当本轮正文还没显示给用户时才重试，否则用户会看到"回答 → 消失 → 再回答"。
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
                buildShallowThinkingNotice(
                  thinking.replace(/\s/g, '').length,
                  aiSettings.minThinkingLen || MIN_THINKING_LEN,
                ),
            },
          ];
          continue;
        }

        // ---------- 纠错 2：声称已完成，却没有调用任何工具 ----------
        // 只在回复出现完成声明（hasActionClaim）且本轮零工具调用时纠正一次；
        // 不按用户措辞判断，避免"帮我总结"这类正常提问被误判、回答被整段丢弃重来。
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

        // ---------- 工具调用被截断：先给一次纠正机会 ----------
        // 被输出长度限制截断时，半截的 <tool_calls> 既不能当正文，也不能当"已完成"。
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
          // 这一轮到此为止：最终答复落地，「分析」折叠随即收起
          setTurnActive(false);
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
          try { await aiApi.saveChatMessage(sid, 'assistant', full); } catch {}
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
        genTitle(sid, prompt, parsed.reply || thinking);
        setIsSending(false);
        resetStreaming();
        // 同一轮里完全相同的调用只执行一次：模型常把"先打开 A"再说一遍，
        // 不跳过就会把刚打开的 B 又切回 A，最终看起来像没打开 B。
        const freshCalls = toolCalls.filter(tc => {
          const key = `${tc.name}:${JSON.stringify(tc.args ?? {})}`;
          if (executedCallKeys.current.has(key)) return false;
          executedCallKeys.current.add(key);
          return true;
        });
        const skippedCount = toolCalls.length - freshCalls.length;
        // 按 TOOL_DEFS.needsConfirm 分成"只读"与"需确认"两组
        const readOnly = freshCalls.filter(tc => !TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        const destructive = freshCalls.filter(tc => TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        // 执行单条工具并记录轨迹：异常统一转成失败结果，一条报错不打断整轮
        let results: ToolResult[] = [];
        const runTool = async (tc: { name: string; args: Record<string, unknown> }) => {
          appendToolTrace(tc);
          let result: unknown;
          let success = true;
          try {
            const access = accessRef.current;
            // 总开关关闭时所有笔记工具一律不执行：不光是"看不到"，写操作也不能穿透
            result = access.enabled
              ? await TOOL_EXECUTORS[tc.name](tc.args, {
                  currentNoteId: currentNoteIdRef.current,
                  access,
                  defaultNoteAiAccess: defaultAccessRef.current.note,
                  defaultCategoryAiAccess: defaultAccessRef.current.category,
                })
              : { error: AI_ACCESS_DISABLED_NOTE };
            if (!access.enabled) success = false;
          } catch (e) {
            result = formatError(e);
            success = false;
          }
          finishToolTrace({ name: tc.name, args: tc.args, result, success });
          results.push({ name: tc.name, args: tc.args, result, success });
        };
        // 只读工具直接跑；需要确认的写操作逐条问（右上角 1/N 跟着走，用户不能跳序）
        // 每条执行前都检查轮次：用户点了停止就不再继续动数据
        for (const tc of readOnly) {
          if (isStale()) return;
          await runTool(tc);
        }
        if (destructive.length > 0) {
          // 总开关关闭时不必再弹确认：这些调用注定被拒，问了用户也只能看到失败
          const ask = confirmMode && accessRef.current.enabled;
          for (let i = 0; i < destructive.length; i += 1) {
            const tc = destructive[i];
            if (isStale()) return;
            const confirmed = ask ? await confirmDestructive(tc, i + 1, destructive.length) : true;
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
        // 失败原因必须写进对话：只 console.error 的话，用户只会看到"没反应"并反复重发
        console.error(e);
        setIsSending(false);
        setTurnActive(false);
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

    // ---------- 循环结束仍未产出最终回复（多半是轮数用完） ----------
    // 必须留下可见结论，否则工具跑了一堆、界面却没有一句话，用户不知道是否结束。
    setIsSending(false);
    setTurnActive(false);
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

  /** 父折叠：用户点了就记住他的选择（之后不再被"思考中/已结束"的默认值覆盖） */
  const toggleGroup = useCallback((i: number, open: boolean) => { setGroupOpen(p => ({ ...p, [i]: open })); }, []);
  /** 子折叠（思考正文）：默认收起，点一下展开 */
  const toggleThought = useCallback((i: number) => { setThoughtOpen(p => ({ ...p, [i]: !p[i] })); }, []);
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

  /** 回填最后一条轨迹的执行结果，与 appendToolTrace 成对使用（按顺序一一对应） */
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
       * 手动高度直接照用，不再按"消息区高度"二次夹紧：
       * 输入框变高 → 消息区变矮 → 夹紧值变小 → 输入框被压回去，会形成反馈回路。
       * 上限交给 CSS max-height 兜底。
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

  /** 发送入口：加同步锁并递增 runId，落用户消息后交给 agentLoop；解锁前须确认自己仍是最新一轮 */
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
     * 每轮新提问都重置"这个模型会不会写思考"的判断。
     * 该判断一旦为 false 就不再按住抢答、也不再重试；但模型表现会随上下文变化，
     * 永久锁定会让长会话再也纠正不回来，按轮复位最坏只多花一次纠正。
     */
    thinkingCapableRef.current = true;
    sendLockRef.current = true;
    try {
      abortRef.current = false;
      // 先把用户消息落到界面，"思考中"指示由 isSending 驱动
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
      // 本轮开始：从这一刻到"正式结束"之间，「分析」折叠保持展开（中间的工具轮不再闪）
      setTurnActive(true);
      const sid = await ensureSession();
      try { await aiApi.saveChatMessage(sid, "user", prompt); } catch {}
      await agentLoop(sid, [...messages, userMsg], prompt);
      await loadSessions();
      try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); } catch {}
    } finally {
      // 只有"自己仍是当前轮次"时才释放锁：旧循环收尾不能把新一轮的锁放掉
      if (runIdRef.current === myRun) {
        sendLockRef.current = false;
        // 兜底复位：agentLoop 的每个出口都会自己置 false，这里是"无论如何都要收起"的保险，
        // 例如中途抛到 agentLoop 之外的异常。新一轮已经开跑时不能动它。
        setTurnActive(false);
      }
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
    // 用户点了停止：这一轮到此为止，「分析」折叠收起
    setTurnActive(false);
    resetStreaming();
    if (activeSessionId) aiApi.saveChatMessage(activeSessionId, 'assistant', '已停止').catch(()=>{});
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

  /* ---------- 派生数据（必须全部在 isOpen 早退之前） ----------
   * React 要求每次渲染的 hook 顺序一致：这些 useMemo 若放到 `if (!isOpen) return null`
   * 之后，开关面板时 hook 数量会变化，整棵树报错卸载（表现为点任何按钮整页空白）。
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
   * 本轮对话是否还在进行。
   * 「深度思考」父折叠用它决定默认状态：进行中就一直展开，等这一轮**正式结束**
   * （最终答复落地 / 报错收尾 / 用户停止）才自动收起 —— 不需要额外的定时器或手动清理。
   *
   * 判据必须是 turnActive 而不是 isSending：多轮工具调用时，每轮之间流式已停、
   * 下一轮请求还没发，isSending 会短暂变 false，用它会看到「分析」反复展开又收起。
   * isSending 仍保留在判据里，只是给"turnActive 尚未置位时已经开始流式"兜底。
   */
  const turnInProgress = turnActive || isSending;
  /** 正在进行中的那一行：它的父折叠默认展开 */
  const liveRowIndex = turnInProgress ? allMsgs.length - 1 : -1;

  /**
   * 右侧历史锚点：每条用户消息对应一条横线。
   *
   * index 是"第几个锚点"（0 起），不是它在 messages 里的下标。jumpToAnchor 用
   * querySelectorAll('[data-chat-anchor]')[index] 取节点，syncScrollState 算出的
   * activeAnchor 也是锚点序号，两处必须同口径，否则跳错位置、高亮对不上。
   *
   * 只从 messages 派生：流式气泡永远是 assistant，不产生锚点，所以流式期间该数组
   * 保持同一引用，AnchorRail 的 memo 不会被每 50ms 一次的刷新打破。
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
      className="ai-panel relative flex-shrink-0 border-l border-line/80 bg-surface flex flex-col h-full"
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
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[12.5px] font-medium text-body">{activeSession?.title || "新对话"}</span>
            <span className="block truncate text-[10.5px] text-faint">
              {activeProvider ? `${activeProvider.name}${activeModel ? ` · ${activeModel}` : " · 未选模型"}` : "未配置服务商"}
            </span>
          </span>
          <Icon name="ai-chevron-down" className="w-3 h-3 flex-shrink-0 text-faint-soft" />
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
        <div className="selectable mx-3 mt-2 px-3 py-2 rounded-lg bg-danger-soft border border-danger-line text-[11px] text-danger-strong leading-relaxed break-all">
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
        ) : enableAI && isExternalFile ? (
          <div className="ai-empty">
            <div className="ai-empty-icon"><Icon name="ai-file-text" className="w-5 h-5" /></div>
            <p className="ai-empty-title">AI 无法读取内容</p>
            <p className="ai-empty-desc">
              请先保存该文件到分组，再使用 AI 功能。
            </p>
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
            expanded={groupOpen[i] ?? (i === liveRowIndex)}
            thoughtOpen={!!thoughtOpen[i]}
            toolOpen={toolOpenByRow[i] || NO_OPEN_TOOLS}
            live={i === liveRowIndex}
            isSending={isSending}
            showToolTrace={aiSettings.showToolTrace}
            editorSettings={editorSettings}
            onToggleGroup={toggleGroup}
            onToggleThought={toggleThought}
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

      {/* ---------- 输入区（Composer） ----------
          圆角卡片包住输入框与底部操作条：聚焦时整卡描边，输入变多自动长高，
          到达上限后内部滚动，上边缘可拖动调整高度。 */}
      <div className={"composer-wrap relative flex-shrink-0" + (composerDragging ? " is-resizing" : "")}>
        {pendingConfirm && (
          <AiConfirmCard
            call={pendingConfirm.call}
            index={pendingConfirm.index}
            total={pendingConfirm.total}
            summary={summarizeToolCall(pendingConfirm.call)}
            onRun={() => settleConfirm(true)}
            onCancel={() => settleConfirm(false)}
          />
        )}
        <div
          className={"composer-resize" + (composerDragging ? " is-dragging" : "")}
          onMouseDown={(e) => {
            e.preventDefault();
            const el = inputRef.current;
            if (!el) return;
            const startY = e.clientY;
            /*
             * 基准取"当前实际高度"而不是存下来的手动高度：自动模式下两者可能不同，
             * 用存储值会出现拖动前段没反应、跨过临界点又突然跳一截。
             * 拖动过程中直接改 DOM 不 setState，避免每个 mousemove 都重渲染而不跟手。
             */
            const startH = el.clientHeight;
            const areaH = messagesAreaRef.current?.clientHeight || 600;
            /*
             * 上限不能低于当前高度：输入框变高会让消息区变矮，按新消息区算出的上限
             * 可能比当前输入框还低，直接夹紧会在第一次 mousemove 时瞬间矮一截。
             * 取 max(startH, 计算上限) 后，向下拖全程跟手，向上拖最多到 startH 或该上限。
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

        {/* 模型下拉：fixed 定位，紧贴在模型 chip 按钮上方 */}
        {modelMenuOpen && modelMenuPos && (
          <div
            className="fixed composer-menu chat-scrollbar"
            ref={modelMenuRef}
            style={{
              bottom: modelMenuPos.bottom,
              left: Math.max(8, modelMenuPos.left),
              minWidth: modelMenuPos.width,
              maxWidth: 280,
            }}
          >
            {models.length === 0 ? (
              <div className="px-3 py-2 text-[11.5px] text-faint">还没有勾选可用模型</div>
            ) : models.map((m) => (
              <button
                key={m}
                className={"composer-menu-item" + (m === activeModel ? " is-active" : "")}
                onClick={() => {
                  setModelMenuOpen(false);
                  if (!activeProvider) return;
                  const u = { ...activeProvider, enabled_model: m };
                  aiApi.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x)));
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
              ref={modelChipRef}
              className={"composer-chip is-shrinkable" + (modelMenuOpen ? " is-on" : "")}
              onClick={() => {
                if (modelChipRef.current) {
                  const r = modelChipRef.current.getBoundingClientRect();
                  setModelMenuPos({ bottom: window.innerHeight - r.top+5, left: r.left-13 , width: r.width });
                }
                setModelMenuOpen(v => !v);
              }}
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
              currentLevel === 0 ? (
                // 禁止档不提供"附笔记"开关：开关本身没有意义，只会误导用户以为点了就能附上
                <span
                  className={"composer-chip is-warn" + (compact ? " is-compact" : "")}
                  title={
                    aiSettings.aiAccessEnabled
                      ? "当前笔记对 AI 禁止访问，正文不会作为上下文发送（可在「笔记属性」或设置 → AI 访问权限里改）"
                      : "已关闭「允许 AI 访问笔记」，正文不会作为上下文发送（设置 → AI 访问权限）"
                  }
                >
                  <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
                  {!compact && <span>未授权</span>}
                </span>
              ) : (
                <>
                  <button
                    className={"composer-chip" + (attachNote ? " is-on" : "") + (compact ? " is-compact" : "")}
                    onClick={() => setAttachNote(v => !v)}
                    title={attachNote ? `已附上当前笔记《${noteTitle || "未命名"}》作为上下文（点击取消）` : "不附上当前笔记（点击改为附上）"}
                  >
                    <Icon name="ai-file-text" className="w-3 h-3 flex-shrink-0" />
                    {!compact && <span>附笔记</span>}
                  </button>
                  {/* 只读档：能读不能改，提前告知，省得模型反复尝试写入后失败 */}
                  {currentLevel === 1 && (
                    <span
                      className={"composer-chip is-warn" + (compact ? " is-compact" : "")}
                      title="当前笔记对 AI 只读：可以阅读和总结，但不会替用户修改（在「笔记属性」里可改为完全）"
                    >
                      <Icon name="ai-shield-check" className="w-3 h-3 flex-shrink-0" />
                      {!compact && <span>只读</span>}
                    </span>
                  )}
                </>
              )
            ) : null}
            </div>

            {/* 右：字数（够宽才显示）+ 清空 + 发送/停止。固定不压缩，保证永远点得到 */}
            {showCount && input.length > 0 && (
              <span className={"text-[10.5px] tabular-nums flex-shrink-0 " + (input.length > 2000 ? "text-warning" : "text-faint-soft")} title={input.length > 2000 ? "内容较长，发送前会先做瘦身" : ""}>
                {input.length > 2000 ? `${input.length} 字 · 较长` : `${input.length} 字`}
              </span>
            )}
            {messages.length > 0 && !isSending && (
              <button
                className="p-1.5 rounded-lg text-faint-soft hover:text-danger hover:bg-danger-soft transition-colors"
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
      <div className="ai-modal-overlay">
        <div className="ai-modal">
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
              <Icon name="ai-search" className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-faint-soft" />
              <input
                autoFocus
                value={sessionQuery}
                onChange={(e) => setSessionQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setShowSessionPicker(false); }}
                placeholder="搜索对话标题…"
                className="w-full pl-7 pr-2.5 py-1.5 text-xs rounded-lg border border-line bg-app/60 focus:bg-surface focus:border-primary-300 outline-none transition-colors"
              />
            </div>
          </div>

          <div className="ai-modal-list chat-scrollbar">
            {sessionGroups.length === 0 ? (
              <div className="py-8 text-center text-[11.5px] text-faint">
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
                            await aiApi.deleteChatSession(s.id);
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
  </>);
};
