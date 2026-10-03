import { useEffect, useMemo, useRef, useState, useCallback, memo } from "react";
import * as api from "../api";
import { AiChatMessage, AiChatSession, AiProvider } from "../types";
import {
  buildFinalContent,
  cleanSessionTitle,
  finalReplyText,
  firstLine,
  formatError,
  hasActionClaim,
  isThinkingDeepEnough,
  parseResponse,
  parseStreamContent,
  shouldRetryForShallowThinking,
  streamStartsWithThinking,
  stripAiTags,
  type ToolCall,
  type ToolTrace,
} from "../aiChatParse";
import { useToast } from "./Toast";
import { MdPreview } from "md-editor-rt";
import "md-editor-rt/lib/style.css";

interface AIChatPanelProps {
  isOpen: boolean;
  noteTitle: string;
  noteContent: string;
  /** 当前打开笔记的 ID：AI 用它精确定位"这篇笔记"，避免同名笔记歧义 */
  currentNoteId?: number | null;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
  onOpenProviderSettings: () => void;
  /** 关闭面板 */
  onClose?: () => void;
}

const MIN_PANEL_WIDTH = 350; const MAX_PANEL_WIDTH = 640; const DEFAULT_PANEL_WIDTH = 400;
/** 距底部小于该像素即视为"贴底"，此时才自动跟随最新回复 */
const STICK_BOTTOM_THRESHOLD = 48;
/** 阅读线：容器顶部往下这么多像素以内的最后一条用户消息，就是"当前所在的历史段落" */
const ANCHOR_READING_LINE = 40;
/** 点击锚点后目标消息距容器顶部的留白 */
const ANCHOR_JUMP_OFFSET = 8;
/** 单条锚点提示最多显示的字数 */
const ANCHOR_PREVIEW_LEN = 80;

const TOOL_DEFS = [
  { name: "searchNotes", desc: "搜索笔记标题", args: {"query":"搜索关键词"}, needsConfirm: false },
  { name: "listNotes", desc: "列出笔记（可按分组/数量）", args: {"categoryName":"分组名(可选)","limit":"条数(可选)"}, needsConfirm: false },
  { name: "getNoteContent", desc: "获取笔记全文", args: {"noteId":"笔记ID"}, needsConfirm: false },
  { name: "getCurrentNote", desc: "读取当前打开的笔记", args: {}, needsConfirm: false },
  { name: "getCategories", desc: "获取所有分组", args: {}, needsConfirm: false },
  { name: "listTrash", desc: "查看回收站", args: {}, needsConfirm: false },
  { name: "createNote", desc: "创建笔记", args: {"title":"标题","content":"内容(可选)","categoryName":"分组名(可选)"}, needsConfirm: true },
  { name: "createNotes", desc: "批量创建多篇笔记", args: {"notes":"[{title,content?,categoryName?}]"}, needsConfirm: true },
  { name: "appendToNote", desc: "在笔记末尾追加内容（不覆盖）", args: {"noteId":"笔记ID(可选)","text":"要追加的正文"}, needsConfirm: true },
  { name: "updateNote", desc: "按 ID 修改指定笔记", args: {"noteId":"笔记ID","title":"新标题(可选)","content":"新内容(可选)","categoryName":"新分组名(可选)"}, needsConfirm: true },
  { name: "updateCurrentNote", desc: "修改当前打开的笔记（无需 ID，精确作用于用户正在看的那一篇）", args: {"title":"新标题(可选)","content":"新内容(覆盖正文)","categoryName":"新分组名(可选)"}, needsConfirm: true },
  { name: "deleteNote", desc: "删除笔记(移到回收站)", args: {"noteId":"笔记ID"}, needsConfirm: true },
  { name: "restoreNote", desc: "从回收站还原笔记", args: {"noteId":"笔记ID"}, needsConfirm: true },
  { name: "deleteFromTrash", desc: "彻底删除回收站中的笔记(不可恢复)", args: {"noteId":"笔记ID"}, needsConfirm: true },
  { name: "emptyTrash", desc: "清空回收站(不可恢复)", args: {}, needsConfirm: true },
  { name: "createCategory", desc: "创建分组", args: {"name":"分组名"}, needsConfirm: true },
  { name: "renameCategory", desc: "重命名分组", args: {"categoryId":"分组ID","name":"新名称"}, needsConfirm: true },
  { name: "deleteCategory", desc: "删除分组", args: {"categoryId":"分组ID","deleteNotes":"是否同时把组内笔记移入回收站(可选)"}, needsConfirm: true },
  { name: "moveNote", desc: "移动笔记到其他分组", args: {"noteId":"笔记ID","categoryId":"目标分组ID"}, needsConfirm: true },
  { name: "selectNote", desc: "选择并打开指定笔记", args: {"noteId":"笔记ID"}, needsConfirm: false },
];

/** 工具调用的中文短标签：回复上方以紧凑轨迹展示，一眼能看清到底做了什么 */
const TOOL_LABELS: Record<string, string> = {
  searchNotes: "搜索笔记",
  listNotes: "列出笔记",
  getNoteContent: "读取笔记",
  getCurrentNote: "读取当前笔记",
  getCategories: "读取分组",
  listTrash: "查看回收站",
  createNote: "创建笔记",
  createNotes: "批量创建笔记",
  appendToNote: "追加内容",
  updateNote: "修改笔记",
  updateCurrentNote: "修改当前笔记",
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

/** 工具轨迹右侧的目标信息：优先用执行结果里的标题，其次用入参 */
const toolDetail = (name: string, args: Record<string, unknown>, result: unknown): string => {
  const r = (result && typeof result === "object" ? result : {}) as Record<string, unknown>;
  const title = typeof r.title === "string" && r.title ? `《${r.title}》` : "";
  const clip = (v: unknown, n = 22) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  switch (name) {
    case "selectNote":
    case "getNoteContent":
    case "appendToNote": {
      // 形如 "#16 · 《白雪公主》"：执行前只有 ID，执行后用结果里的标题补全
      const id = args.noteId !== undefined ? `#${args.noteId}` : "";
      return [id, title].filter(Boolean).join(" · ");
    }
    case "getCurrentNote":
      return title;
    case "listNotes":
      return args.categoryName ? `「${clip(args.categoryName)}」` : `最近 ${args.limit || 15} 篇`;
    case "createNotes":
      return Array.isArray(args.notes) ? `${(args.notes as unknown[]).length} 篇` : "";
    case "listTrash":
      return "";
    case "restoreNote":
    case "deleteNote":
    case "deleteFromTrash":
      return args.noteId !== undefined ? `#${args.noteId}` : "";
    case "emptyTrash":
      return "";
    case "searchNotes":
      return args.query ? `「${clip(args.query)}」` : "";
    case "createNote":
    case "updateNote":
    case "updateCurrentNote": {
      const id = args.noteId !== undefined ? `#${args.noteId}` : "";
      return [id, title].filter(Boolean).join(" · ") || "";
    }
    case "createCategory":
    case "renameCategory":
      return args.name ? `「${clip(args.name)}」` : "";
    case "moveNote":
      return args.noteId !== undefined ? `#${args.noteId}` : "";
    default:
      return "";
  }
};


const TOOLS_PROMPT = `你是 FastNote 智能笔记助手，通过工具操作笔记与分组。

## 可用工具（参数都是 JSON 对象）
- searchNotes: 按关键词搜索笔记（标题 + 内容），参数：{"query":"关键词"}
- listNotes: 列出笔记，按更新时间倒序，参数：{"categoryName":"分组名(可选)","limit":"条数(可选,默认15)"}
- getNoteContent: 读取某篇笔记的完整正文，参数：{"noteId":"笔记ID"} —— 只读取，**不会打开**
- getCurrentNote: 读取**当前打开的**笔记（无需 ID），参数：{}
- selectNote: 打开（切换到）某篇笔记，参数：{"noteId":"笔记ID"} —— 用户说"打开"时**必须**用它
- getCategories: 获取所有分组，参数：{}
- listTrash: 查看回收站里的笔记，参数：{}
- createNote: 创建笔记，参数：{"title":"标题","content":"正文(可选)","categoryName":"分组名(可选)"}
- createNotes: 一次创建多篇笔记，参数：{"notes":[{"title":"标题","content":"正文(可选)","categoryName":"分组名(可选)"}]}
- appendToNote: 在笔记**末尾追加**内容（不覆盖原正文），参数：{"noteId":"笔记ID(可选,默认当前打开的笔记)","text":"要追加的正文"}
- updateNote: 按 ID 修改笔记，参数：{"noteId":"笔记ID","title":"新标题(可选)","content":"新正文(可选)","categoryName":"分组名(可选)"}
- updateCurrentNote: 修改当前打开的笔记（无需 ID），参数：{"title":"新标题(可选)","content":"新正文(可选)","categoryName":"分组名(可选)"}
- deleteNote: 删除笔记（移入回收站），参数：{"noteId":"笔记ID"}
- restoreNote: 把笔记从回收站还原，参数：{"noteId":"笔记ID"}
- deleteFromTrash: 把回收站里的某篇笔记**彻底删除**（不可恢复），参数：{"noteId":"笔记ID"}
- emptyTrash: **清空回收站**（不可恢复），参数：{}
- createCategory: 创建分组，参数：{"name":"分组名"}
- renameCategory: 重命名分组，参数：{"categoryId":"分组ID","name":"新名称"}
- deleteCategory: 删除分组，参数：{"categoryId":"分组ID","deleteNotes":"是否同时把组内笔记移入回收站(可选,默认false)"}
  - deleteNotes=true 只是把笔记**移入回收站**（可还原），**不会彻底删除**；不确定时用 false，只解除归类。
- moveNote: 移动笔记到其他分组，参数：{"noteId":"笔记ID","categoryId":"目标分组ID"}

选工具的要点：
- "这篇/当前笔记" → getCurrentNote / updateCurrentNote / appendToNote（不传 noteId 即当前笔记）。
- 只是**补充、续写、加一段** → 用 appendToNote；**整篇改写**才用 updateNote / updateCurrentNote（会覆盖正文）。
- "我最近记了什么 / 某分组里有什么" → listNotes（不要用 searchNotes 空搜）。
- "误删了 / 找回" → listTrash 查看、restoreNote 还原。
- "从回收站彻底删掉 / 清空回收站" → deleteFromTrash / emptyTrash。这两个**不可恢复**：必须先 listTrash 确认到底是哪几篇，并在回复里说明将要彻底删除哪些，再调用。
- 要产出多篇笔记（如把一份内容拆成几篇）→ 一次 createNotes，而不是反复 createNote。

## 输出格式（必须严格遵守）
每次回复先写 <thinking>...</thinking>（真实推理，不少于 120 字），然后二选一：

A) 需要操作数据时，本轮**只**输出思考 + 工具调用，不要写正文：
<tool_calls>[{"name":"工具名","args":{"参数名":"参数值"}}]</tool_calls>

B) 不需要操作、或工具已经执行完且结果足够回答时，只写正文，不要输出 <tool_calls>。

格式硬要求：开标签 <tool_calls> 和闭标签 </tool_calls> **必须都写全**；标签内只能是合法 JSON 数组，不要用 \`\`\`json 代码块包裹，不要写注释、单引号或多余逗号。

## 执行顺序（重要）
1. 系统会按你列出的顺序**逐个**执行工具，并在界面上逐条显示动作（例如"打开笔记 #16 · 《白雪公主》"）。所以：
   - 只列本轮真正需要、且不依赖其他工具结果的调用；需要依赖前一步结果时，先只调用前一步。
   - 多个互不依赖的调用（例如同时"打开 A + 读取 A + 搜索 B"）可以在同一轮一起列出。
2. 工具结果会以"工具执行结果：..."的 system 消息返回给你，然后你再进入下一轮。
3. **总结、结论、说明必须放在所有工具都执行完之后的那一轮回复里**，不要提前写、也不要在工具轮里预告结论。

## 绝对不要编造（最高优先级）
- 只有出现在"工具执行结果"里的事情才真正发生了。**没有对应的工具执行结果，就绝对不能声称"已经打开 / 已经创建 / 已经修改 / 已经删除 / 已经移动"。**
- 严禁编造笔记 ID、分组 ID、标题或正文内容；回复里提到的标题、ID 必须来自工具结果本身。
- 工具失败或没找到时，如实说明失败原因和可选方案，不要把它粉饰成成功。
- 用户要"打开"，就必须真的调用 selectNote 并看到成功结果，才能说"已打开"。

## 回复风格（让回答好看又好读）
- **结构化**：先给结论/结果，再给细节；用短标题、有序/无序列表分点，必要时用表格或代码块。避免整段文字墙。
- **易读**：段落之间留空行；每个要点尽量控制在一行内、不超过 30 字；并列信息用列表而不是逗号长句。
- **少用 emoji**：整条回复最多 1~2 个，只用在小标题或关键结论处；不要在每个列表项、每句正文前都挂 emoji。
- **适量来点颜文字**：问候、鼓励、轻松闲聊或收尾时可以自然带一个，例如 (๑•̀ㅂ•́)و✧ ٩(๑•̀ω•́๑)۶ (´▽｀) (・ω・) (￣▽￣) (๑¯ω¯๑)；一条回复最多一个，别每段都放。
- **严肃场合要克制**：报错、失败说明、删除/清空确认、数据风险提示等场景，不要颜文字，也不要卖萌的 emoji。
- 需要用户做选择时，把选项列成清单并给出推荐；操作失败要说明原因和下一步建议。
- 直接以 FastNote 笔记助手的身份回答，不必强调底层模型或厂商。

## 定位对象的规则
1. 一切操作以 ID 为准：标题可以重复，ID 才唯一。
2. 用户说"这篇笔记 / 当前笔记 / 它"→ 用上下文里给出的当前笔记 ID；若上下文显示"当前没有打开任何笔记"，就直接说明并请用户指明是哪一篇，不要猜。
3. 用户给的是标题或关键词 → 先 searchNotes 查 ID：
   - 关键词要短（2~4 个字）。搜索是连续子串匹配：搜"浏览器渲染"会漏掉《浏览器是如何渲染页面的？》，应该搜"渲染"或"浏览器"。
   - 未命中时会自动放宽为"每个字都出现"的模糊匹配，结果带 fuzzy: true 时说明不是精确匹配，必须核对标题、必要时向用户确认。
   - 结果带 duplicateTitles（存在同名笔记）时，必须把候选列给用户确认，禁止自行挑一条修改或删除。

## 示例
用户：打开《白雪公主》笔记，总结剧情，然后再打开关于浏览器渲染的笔记
助手（第 1 轮：只调用工具，不写正文）
<thinking>用户要三件事：打开白雪公主笔记、总结剧情、再打开浏览器渲染那篇。我没有 ID，必须先 searchNotes 查白雪公主；浏览器渲染那篇也一样要先搜，而且关键词要短（"浏览器渲染"这种连续长串很可能搜不到，应该搜"渲染"或"浏览器"）。本轮先搜白雪公主。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"白雪公主"}}]</tool_calls>

助手（第 2 轮：拿到 ID 后打开并读取，同时搜第二篇；仍然不写正文）
<thinking>搜索返回《白雪公主》ID=16。现在打开它、读取正文以便待会儿总结，同时搜索第二篇。这三个调用互不依赖，可以一起列出；总结要等读取结果返回后再写，所以本轮不输出正文。</thinking>
<tool_calls>[{"name":"selectNote","args":{"noteId":"16"}},{"name":"getNoteContent","args":{"noteId":"16"}},{"name":"searchNotes","args":{"query":"渲染"}}]</tool_calls>

助手（第 3 轮：打开第二篇，仍然不写正文）
<thinking>搜索"渲染"命中《浏览器是如何渲染页面的？》ID=17。用户要求最后打开它，所以本轮只调用 selectNote 打开，正文留到下一轮。</thinking>
<tool_calls>[{"name":"selectNote","args":{"noteId":"17"}}]</tool_calls>

助手（第 4 轮：所有工具都已执行完，此时才写正文）
<thinking>selectNote 16、getNoteContent 16、selectNote 17 都成功，正文也已拿到。现在给出剧情总结，并说明当前已切换到《浏览器是如何渲染页面的？》。这些都是工具结果里真实发生的事，可以放心陈述。</thinking>
《白雪公主》剧情总结：……
另外，已为您打开《浏览器是如何渲染页面的？》。

用户：今天天气怎么样？
助手：<thinking>用户询问天气，与笔记、分组都无关，没有任何工具能查实时天气，因此不调用任何工具，直接说明即可。</thinking>
我无法获取实时天气，建议查看手机自带的天气应用或天气预报网站。`;


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
    return n ? { id: n.id, title: n.title, content: n.content, category_id: n.category_id } : null;
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
    return n ? { id: n.id, title: n.title, content: n.content, category_id: n.category_id } : { error: `未找到 ID 为 ${nid} 的笔记` };
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
    await api.restoreNote(nid);
    return { success: true, id: nid };
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
    await api.moveToTrash(nid);
    return { deleted: true, id: nid };
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
    await api.deleteCategory(cid, withNotes);
    return {
      deleted: true,
      notesMovedToTrash: withNotes,
      note: withNotes ? "组内笔记已移入回收站（可还原，未被彻底删除）" : "组内笔记已变为未分类",
    };
  },
  moveNote: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    await api.updateNote(nid, n.title, n.content, Number(args.categoryId));
    return { moved: true, id: nid };
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



/**
 * 单条消息（用户气泡 / AI 无气泡回复）。
 * 用 memo 隔离是非常关键的性能优化：流式输出时 streamingContent 每 50ms 变一次，
 * 若不隔离，历史消息里的每一个 MdPreview（markdown 重解析）都会被重新渲染一遍，界面就会卡。
 */
const ChatMessageRow = memo(function ChatMessageRow({
  msg, index, expanded, toolOpen, isSending, onToggleThinking, onToggleTool, onInsertText, onReplaceContent,
}: {
  msg: AiChatMessage & { thinking?: string; tools?: ToolTrace[]; at?: number };
  index: number;
  expanded: boolean;
  /** 这一行自己的工具展开状态（按行传入，切换某一行不会让整列重渲染） */
  toolOpen: Record<string, boolean>;
  isSending: boolean;
  onToggleThinking: (i: number) => void;
  onToggleTool: (key: string) => void;
  onInsertText: (text: string) => void;
  onReplaceContent: (text: string) => void;
}) {
  const msgThinking = msg.thinking;
  const msgTools = msg.tools;
  const delay = `${Math.min(index, 5) * 15}ms`;

  if (msg.role === 'user') {
    // 用户消息：浅色气泡、右对齐（对齐主流编程 Agent 的样式）
    return (
      <div data-chat-anchor="true" className="flex flex-col items-end animate-fade-in" style={{ animationDelay: delay }}>
        <div className="rounded-2xl px-3.5 py-2 text-[13px] leading-relaxed whitespace-pre-wrap bg-slate-100 text-slate-700 max-w-[85%]">{msg.content}</div>
        {msg.at ? <div className="mt-0.5 mr-1 text-[10.5px] text-slate-300 tabular-nums select-none">{formatMessageTime(msg.at)}</div> : null}
      </div>
    );
  }

  // AI 回复：无气泡、无头像、无名字，整段正文直接铺在面板上（同主流编程 Agent）
  return (
    <div className="group/msg animate-fade-in space-y-0.5" style={{ animationDelay: delay }}>
      {msgThinking ? (
        <div>
          <button
            onClick={() => onToggleThinking(index)}
            className="flex w-full items-center gap-1.5 text-left text-[11.5px] text-slate-400 hover:text-slate-600 transition-colors py-0.5"
            title={expanded ? "收起思考过程" : "展开思考过程"}
          >
            <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" /></svg>
            <span className="flex-shrink-0">思考</span>
            {expanded ? (
              <>
                <span className="text-slate-300 flex-shrink-0">·</span>
                <span className="flex-shrink-0">收起</span>
              </>
            ) : (
              <>
                <span className="text-slate-300 flex-shrink-0">·</span>
                <span className="min-w-0 flex-1 truncate">{firstLine(msgThinking)}</span>
              </>
            )}
            <svg className={"w-3 h-3 flex-shrink-0 transition-transform " + (expanded ? "rotate-90" : "")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
          </button>
          {expanded && (<div className="thinking-body chat-scrollbar mt-0.5 px-3 py-2 bg-slate-50 rounded-lg text-xs text-slate-500 leading-relaxed whitespace-pre-wrap border border-slate-100">{msgThinking}</div>)}
        </div>
      ) : null}
      {/* 实际执行过的工具：一条工具一行，点击展开可看调用 JSON 与执行结果 */}
      {msgTools?.length ? msgTools.map((tool, ti) => {
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
                <svg className="w-3 h-3 flex-shrink-0 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              ) : (
                <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19h13.86a2 2 0 001.73-3L13.73 4a2 2 0 00-3.46 0L3.34 16a2 2 0 001.73 3z" /></svg>
              )}
              <span className="flex-shrink-0">{TOOL_LABELS[tool.name] || tool.name}</span>
              {tool.detail ? (<><span className="text-slate-300 flex-shrink-0">·</span><span className="truncate">{tool.detail}</span></>) : null}
              {running ? <span className="flex-shrink-0 text-slate-300">执行中…</span> : null}
              <svg className={"w-3 h-3 flex-shrink-0 text-slate-300 transition-transform " + (open ? "rotate-90" : "")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
            {open && (
              <pre className="mt-0.5 mb-1 ml-[18px] px-2 py-1.5 rounded-lg bg-slate-50 border border-slate-100 text-[10.5px] leading-relaxed text-slate-500 whitespace-pre-wrap break-all">{`调用 ${JSON.stringify({ name: tool.name, args: tool.args })}　结果 ${
                running ? '（执行中）' : JSON.stringify(tool.result ?? null).slice(0, 400)
              }`}</pre>
            )}
          </div>
        );
      }) : null}
      {msg.content ? (
        <div className="text-[13px] leading-[1.75] text-slate-700 ai-markdown">
          <MdPreview modelValue={msg.content} theme="light" previewTheme="github" codeTheme="github" noMermaid={false} noKatex={false} noHighlight={false}/>
          {!isSending && (<div className="mt-1 -ml-1 flex gap-0.5 opacity-0 group-hover/msg:opacity-100 focus-within:opacity-100 transition-opacity duration-150">
            <button onClick={() => onInsertText(msg.content)} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-slate-400 hover:text-primary-500 hover:bg-primary-50 transition-colors active:scale-95" title="插入到当前笔记"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>插入</button>
            <button onClick={() => onReplaceContent(msg.content)} className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-slate-400 hover:text-amber-600 hover:bg-amber-50 transition-colors active:scale-95" title="替换当前笔记正文"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>替换</button>
          </div>)}
        </div>
      ) : null}
      {/* 时间：与用户消息对称，AI 这条在左下角 */}
      {msg.at ? <div className="pt-0.5 text-[10.5px] text-slate-300 tabular-nums select-none">{formatMessageTime(msg.at)}</div> : null}
    </div>
  );
});

/** 空对象常量：给"这一行没有展开任何工具"的行用，保证 props 引用稳定、memo 不失效 */
const NO_OPEN_TOOLS: Record<string, boolean> = {};

/**
 * 右侧历史锚点导轨。
 * memo 化很关键：流式输出时父组件每 50ms 刷新一次，若不隔离，几十个圆点和 tooltip
 * 会跟着一起重渲染，滚动/悬停都会顿。
 */
const AnchorRail = memo(function AnchorRail({
  anchors, activeIndex, onJump, onHover, onLeave, onScroll,
}: {
  anchors: { index: number; preview: string }[];
  activeIndex: number;
  onJump: (i: number) => void;
  onHover: (i: number, el: HTMLElement) => void;
  onLeave: () => void;
  onScroll: () => void;
}) {
  if (anchors.length < 2) return null;
  return (
    <nav className="chat-anchor-rail" aria-label="对话历史" onScroll={onScroll}>
      <div className="chat-anchor-rail-inner">
        {anchors.map((anchor, i) => (
          <button
            key={anchor.index}
            type="button"
            className={"chat-anchor-dot" + (activeIndex === i ? " is-active" : "")}
            onClick={() => onJump(i)}
            onMouseEnter={(e) => onHover(i, e.currentTarget)}
            onMouseLeave={onLeave}
            onFocus={(e) => onHover(i, e.currentTarget)}
            onBlur={onLeave}
            aria-label={`跳到第 ${i + 1} 条提问：${anchor.preview}`}
            aria-current={activeIndex === i ? "true" : undefined}
          >
            <span className="chat-anchor-pin" />
          </button>
        ))}
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

/** 工具轨迹的中文一句话摘要：写进正文，让用户/模型都能看清做了什么 */
const describeTools = (tools: ToolTrace[] | undefined): string[] =>
  (tools || []).map(t => `${TOOL_LABELS[t.name] || t.name}${t.detail ? ` · ${t.detail}` : ""}`);

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

export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, currentNoteId, onInsertText, onReplaceContent, onOpenProviderSettings, onClose }) => {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number>(0);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number>(0);
  /** 读取服务商失败时的错误文案（用于界面提示，便于定位问题） */
  const [providersError, setProvidersError] = useState("");
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [models, setModels] = useState<string[]>([]);
  const [showSessionPicker, setShowSessionPicker] = useState(false);
  const [editingSessionId, setEditingSessionId] = useState<number | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [expandedThinking, setExpandedThinking] = useState<Record<number, boolean>>({});
  /** 工具轨迹行的展开状态（key = 消息序号-工具序号），展开可看调用 JSON 与结果 */
  const [expandedTools, setExpandedTools] = useState<Record<string, boolean>>({});
  const [pendingConfirm, setPendingConfirm] = useState<{calls: ToolCall[]; resolve: (v: boolean) => void} | null>(null);
  /** 确认弹窗的 resolver 与超时定时器：保证"等待确认"一定会有结果，不会卡死发送锁 */
  const confirmResolveRef = useRef<((v: boolean) => void) | null>(null);
  const confirmTimerRef = useRef<number | null>(null);
  const confirmSettledRef = useRef(false);
  const [confirmMode, setConfirmMode] = useState(true);
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 是否贴底跟随最新回复：滚轮上滑查看历史时置 false，回到底部自动恢复 */
  const stickToBottomRef = useRef(true);
  /** 供界面使用的贴底状态（控制"回到最新"按钮） */
  const [atBottom, setAtBottom] = useState(true);
  /** 当前视口所处的历史锚点（第几条用户消息） */
  const [activeAnchor, setActiveAnchor] = useState(0);
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
  // 窗口变窄时收缩面板宽度，避免挤压编辑器到不可用
  useEffect(() => {
    if (!isOpen) return;
    const clamp = () => {
      const maxByViewport = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, Math.round(window.innerWidth * 0.55)));
      setPanelWidth((w) => Math.min(w, maxByViewport));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [isOpen]);
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
    setMessages(m => {
      const msg = { role: 'assistant' as const, content: text, thinking: leftover?.thinking, tools: leftover?.tools, at: leftover?.at ?? Date.now() } as any;
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
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; settleConfirm(false); setActiveSessionId(sid); resetStreaming(); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { settleConfirm(false); const s = await api.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); resetStreaming(); resetToLatest(); titleGenRef.current = null; };
  const handleDeleteSession = async () => { if (!activeSessionId) return; try { await api.deleteChatSession(activeSessionId); setSessions(p => p.filter(x => x.id !== activeSessionId)); const r = sessions.filter(x => x.id !== activeSessionId); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = null; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } catch { showToast('删除失败', 'error'); } };
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
      const t = await api.sendAiChat(activeProvider.id, [{ role: "system", content: `I will give you some dialogue content in the <content> block.\nYou need to summarize the conversation between user and assistant into a short title.\n1. The title language should be consistent with the user's primary language\n2. Do not use punctuation or other special symbols\n3. Reply directly with the title\n4. The title should not exceed 10 characters\n5. Do not include any JSON, tags, or technical details\n6. Do not output <thinking> or any reasoning process, and never mention words like "thinking" — reply with the title only\n\n<content>\nUser: ${userText}\nAssistant: ${assistantText}\n</content>` }, { role: "user", content: "Generate title" }], "", "");
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
    let roundMsgs = [...msgs];
    /** 交给 Rust 端提示词的最小思考字数 */
    const MIN_THINKING_LEN = 120;
    /**
     * 触发"重新思考"纠正的门槛。
     * 只处理"基本没思考"的情况：为了一百来字和一百二十字的差别就丢弃一整段已经写好的回答，
     * 会让界面出现"先回复一大段 → 清空 → 再思考 → 又回复一遍同样的内容"，还白烧一遍 token。
     */
    const THINKING_RETRY_MIN_LEN = 24;
    /** 每轮允许的一次"强制思考/工具使用"纠正机会 */
    let correctionUsed = false;

    for (let round = 0; round < 8; round++) {
      if (isStale()) return;
      setIsSending(true);
      const roundGen = bumpStreamGen();
      let nativeReasoning = '';
      try {
        const full = await api.sendAiChatStream(
          activeProvider!.id,
          [{ role: 'system', content: TOOLS_PROMPT }, ...roundMsgs],
          noteTitle || '',
          noteContent,
          (c, r) => {
            nativeReasoning = r;
            if (!isStale()) pushStreamContent(c, roundGen);
          },
          MIN_THINKING_LEN,
          currentNoteId ?? null,
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
        } else if (correctionUsed) {
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
        if (shouldRetryForShallowThinking({
          correctionUsed,
          replyShown,
          toolCallCount: toolCalls.length,
          thinking,
          minLen: THINKING_RETRY_MIN_LEN,
        })) {
          correctionUsed = true;
          setIsSending(false);
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content:
                `你的 <thinking> 过于简略（当前 ${thinking.replace(/\s/g, '').length} 字，要求至少 ${MIN_THINKING_LEN} 字），本次回复无效。` +
                '请重新深入思考：分析用户的真实意图、缺少哪些信息、应调用哪个工具及参数来源、是否有破坏性风险，然后重新输出完整回复。',
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
        if (!correctionUsed && claimedWithoutTools && !isStale()) {
          correctionUsed = true;
          setIsSending(false);
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content:
                '你的回复里声称已经完成了某个操作（例如"已打开/已创建/已修改/已删除"），但本轮没有任何 <tool_calls>，' +
                '因此这些操作实际上并没有发生。请二选一：\n' +
                '1. 如果确实需要执行操作：同时输出 <thinking> 与 <tool_calls>（用户不知道 ID，先用 searchNotes / listNotes 或 getCategories 查询）；\n' +
                '2. 如果不需要操作：删掉"已完成"之类的表述，直接如实回答。',
            },
          ];
          continue;
        }

        // ---------- 工具调用被截断 / JSON 非法：先给一次纠正机会 ----------
        // 模型被输出长度限制截断时，半截的 <tool_calls> 既不能当正文，也不能当"已完成"。
        if (truncated && toolCalls.length === 0 && !correctionUsed && !isStale()) {
          correctionUsed = true;
          setIsSending(false);
          resetStreaming();
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content:
                '你上一条回复的工具调用格式不合法：<tool_calls> 缺少开标签、没有闭合，或里面的 JSON 无法解析（内容过长时会被截断），本次回复无效，没有任何工具被执行。' +
                '请重新输出：必须写成 <tool_calls>[{"name":"工具名","args":{...}}]</tool_calls>，开闭标签齐全、JSON 完整，且不要用 ```json 代码块包裹；' +
                '如果内容太长，请精简，或拆成几步分次完成。',
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
          setMessages(m => {
            const msg = { role: 'assistant' as const, content: finalContent, thinking: thinkingDisplay, tools: carriedTools, at: finalAt };
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
          genTitle(sid, prompt, finalReply);
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
        // 工具轨迹已在每条工具执行时逐条写入气泡，这里不再批量补写
        // Build result message and continue loop
        const resultParts = results.map(r => `${r.name}: ${r.success ? JSON.stringify(r.result) : '失败: ' + r.result}`);
        if (skippedCount > 0) resultParts.push(`已跳过 ${skippedCount} 个重复调用（本次回答中执行过，未重复执行）`);
        const resultSummary = resultParts.join('; ');
        if (results.length > 0) { try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); await loadSessions(); } catch {} }
        roundMsgs = [...roundMsgs, { role: 'assistant', content: full }, { role: 'system', content: '工具执行结果：' + resultSummary + '\n请根据结果继续处理或给用户最终回复（仍需先输出 <thinking>）。如果上一轮你已经写好了要展示给用户的正文，本轮不要重复它，只需补充工具执行后的说明。' }];
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
      ? `（本次操作步骤已达上限，先停在这里。已完成的操作为：\n${doneTools.map(d => `- ${d}`).join("\n")}\n\n还需要继续的话，回一句「继续」就行。）`
      : "（模型没有返回有效内容，请重试，或把需求说得更具体一些。）";
    await commitNotice(sid, notice, leftover);
  };

  const toggleThinking = useCallback((i: number) => { setExpandedThinking(p => ({ ...p, [i]: !p[i] })); }, []);
  const toggleToolTrace = useCallback((key: string) => { setExpandedTools(p => ({ ...p, [key]: !p[key] })); }, []);

  // 让 ChatMessageRow 的 memo 真正生效：外部传入的回调每次渲染都是新函数，
  // 这里用 ref 固定住，包装成永不变化的引用。
  const insertTextRef = useRef(onInsertText);
  const replaceContentRef = useRef(onReplaceContent);
  useEffect(() => {
    insertTextRef.current = onInsertText;
    replaceContentRef.current = onReplaceContent;
  });
  const insertTextStable = useCallback((text: string) => insertTextRef.current(text), []);
  const replaceContentStable = useCallback((text: string) => replaceContentRef.current(text), []);

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
    sendLockRef.current = true;
    try {
      abortRef.current = false;
      // Show user message and thinking indicator immediately
      const userMsg: AiChatMessage & { at: number } = { role: "user", content: prompt, at: Date.now() };
      setMessages(m => [...m, userMsg]);
      setInput("");
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
      setPanelWidth(Math.round(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - ev.clientX))));
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
  }, []);

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
  const allMsgs: (AiChatMessage & { thinking?: string; tools?: ToolTrace[]; at?: number })[] = streamingPreview
    ? [...messages, {
        role: 'assistant' as const,
        content: holdEarlyReply ? '' : streamingPreview.reply,
        thinking: streamingPreview.thinking,
        at: streamStartedAtRef.current || undefined,
      }]
    : messages;
  /** 正在等模型吐出第一个有效内容（含"正文被暂时按住"的情况）：显示"思考中"而不是空气泡 */
  const waitingFirstContent =
    isSending && (!streamingPreview || (!streamingPreview.reply && !streamingPreview.thinking) || holdEarlyReply);

  /**
   * 右侧历史锚点：每条用户消息对应一个点（顺序与 DOM 中 [data-chat-anchor] 一致）。
   * 刻意只用 messages 派生：流式气泡永远是最后一条 assistant 消息，不会产生锚点，
   * 因此流式期间这个数组保持同一引用，AnchorRail 的 memo 才不会被每 50ms 打破。
   */
  const userAnchors = useMemo(
    () => messages.reduce<{ index: number; preview: string }[]>((acc, msg, index) => {
      if (msg.role === 'user') {
        const plain = (msg.content || '').replace(/\s+/g, ' ').trim();
        acc.push({
          index,
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

  if (!isOpen) return null;

  return (<>
    <aside
      className="ai-panel relative flex-shrink-0 border-l border-slate-200/80 bg-white flex flex-col h-full"
      style={{ width: panelWidth }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-200/50 active:bg-primary-300/50 transition-colors z-10" onMouseDown={onResize}/>
      <div className="px-3 py-2.5 border-b border-slate-100 flex items-center justify-between gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          <button onClick={() => { setShowSessionPicker(true); setEditingSessionId(null); setEditTitle(''); }} className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600 hover:border-slate-300 transition-colors max-w-[180px] truncate text-left flex items-center gap-1.5 flex-1">
            <svg className="w-3 h-3 flex-shrink-0 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16"/></svg>
            <span className="truncate">{sessions.find(s => s.id === activeSessionId)?.title || "新对话"}</span>
          </button>
          <button onClick={handleNewSession} className="toolbar-btn !w-6 !h-6 flex-shrink-0" title=""><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4"/></svg></button>
          {activeSessionId > 0 && (<button onClick={handleDeleteSession} className="toolbar-btn !w-6 !h-6 flex-shrink-0 hover:!text-red-500" title=""><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>)}
        </div>
        <button className="toolbar-btn !w-7 !h-7 flex-shrink-0" title="服务商设置" onClick={onOpenProviderSettings}><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg></button>
        {/* 面板内也放一个关闭入口，鼠标离工具栏较远时更顺手 */}
        {onClose && (
          <button className="toolbar-btn !w-7 !h-7 flex-shrink-0" title="关闭 AI 对话" onClick={onClose}>
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/></svg>
          </button>
        )}
      </div>
      {providersError && (
        <div className="mx-3 mt-2 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-[11px] text-red-600 leading-relaxed break-all">
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
        className="flex-1 min-h-0 overflow-y-auto pl-3 py-3 pr-6 space-y-4 chat-scrollbar [overflow-anchor:none]"
      >
        {!activeProvider ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div><p className="empty-state-title">暂无配置</p><p className="empty-state-desc">请先配置 AI 服务商</p><button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs">立即配置</button></div>
        ) : allMsgs.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><p className="empty-state-title">{activeModel ? "开始对话" : "还没有可用模型"}</p><p className="empty-state-desc">{activeModel ? "输入你的问题" : "请在设置里获取并勾选模型"}</p></div>
        ) : (allMsgs.map((msg, i) => (
          <ChatMessageRow
            key={i}
            msg={msg as AiChatMessage & { thinking?: string; tools?: ToolTrace[] }}
            index={i}
            expanded={!!expandedThinking[i]}
            toolOpen={toolOpenByRow[i] || NO_OPEN_TOOLS}
            isSending={isSending}
            onToggleThinking={toggleThinking}
            onToggleTool={toggleToolTrace}
            onInsertText={insertTextStable}
            onReplaceContent={replaceContentStable}
          />
        )))}
        {waitingFirstContent && (
          <div className="flex items-center gap-2 py-1 text-xs text-slate-400">
            <span className="thinking-dots"><span/><span/><span/></span>思考中
          </div>
        )}
      </div>

      {/* 右侧垂直居中的历史锚点：一眼看出发过几次提问，点一下跳到那次提问 */}
      {userAnchors.length >= 2 && (
        <>
          <AnchorRail
            anchors={userAnchors}
            activeIndex={activeDotIndex}
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
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
          </svg>
        </button>
      )}
      </div>

      <div className="border-t border-slate-200/60 bg-white px-4 py-2.5 space-y-2 flex-shrink-0">
        <div className="relative">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === "Enter" && e.ctrlKey) { const t = inputRef.current; if (t) { const s = t.selectionStart; setInput(input.slice(0, s) + "\n" + input.slice(t.selectionEnd)); } return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); isSendingRef.current ? handleStop() : handleSend(); } }} placeholder="" rows={2} className="w-full resize-none px-3 py-2 text-xs input-modern bg-slate-50/50 focus:bg-white transition-colors" style={{ minHeight: "56px", maxHeight: "100px" }}/>
          {messages.length > 0 && (<button onClick={() => { setMessages([]); resetStreaming(); resetToLatest(); }} className="absolute top-1 right-1 p-1 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors z-10" title="清空对话"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>)}
        </div>
        <div className="flex items-center gap-1.5 justify-end flex-nowrap">
          <div className="flex-shrink-1 min-w-0">
            {/* 只列出设置中已勾选的模型 */}
            <select
              value={activeModel}
              onChange={e => {
                if (!e.target.value || !activeProvider) return;
                const u = { ...activeProvider, enabled_model: e.target.value };
                api.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x)));
              }}
              className="bg-transparent text-xs text-slate-500 cursor-pointer min-w-[60px] max-w-[140px] w-auto px-1 py-1 truncate outline-none focus:outline-none focus:ring-0"
              disabled={!activeProvider || models.length === 0}
              title={models.length === 0 ? "请先在设置中勾选可用模型" : "选择本次对话使用的模型"}
            >
              {models.length === 0 && (
                <option value="">{activeProvider ? "未勾选模型" : "无可用模型"}</option>
              )}
              {models.map(m => (<option key={m} value={m}>{m}</option>))}
            </select>
            {/* 没勾选任何模型时，给一个直达设置的入口 */}
            {activeProvider && models.length === 0 && (
              <button
                onClick={onOpenProviderSettings}
                className="ml-1 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium text-amber-600 bg-amber-50 border border-amber-200 hover:bg-amber-100 transition-colors flex-shrink-0"
                title="前往设置勾选可用模型"
              >
                未勾选模型 · 去设置
              </button>
            )}
          </div>
          <button onClick={() => setConfirmMode(!confirmMode)} className={"inline-flex items-center gap-1 px-2 py-1.5 rounded-xl text-xs font-medium border transition-all flex-shrink-0 " + (confirmMode ? "border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100" : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50")} title={confirmMode ? "操作需确认" : "自动执行"}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            <span>{confirmMode ? "需确认" : "自动"}</span>
          </button>
          {isSending ? (
            <button onClick={handleStop} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-white bg-red-500 hover:bg-red-600 shadow-sm transition-all active:scale-[0.97]"><svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>停止</button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || !activeModel} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-primary-500 to-primary-600 shadow-md hover:shadow-lg hover:from-primary-600 hover:to-primary-700 transition-all active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex-shrink-0 whitespace-nowrap"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>发送</button>
          )}
        </div>
      </div>
    </aside>
    {showSessionPicker && (<div className="fixed inset-0 z-50 flex items-start justify-center pt-[15vh]" onClick={() => setShowSessionPicker(false)}>
      <div className="absolute inset-0 bg-black/20 backdrop-blur-sm" />
      <div className="relative bg-white rounded-xl shadow-2xl border border-slate-200/80 w-72 max-h-[50vh] overflow-y-auto p-2 animate-fade-in" onClick={e => e.stopPropagation()}>
        {sessions.length === 0 ? (<div className="text-xs text-slate-400 text-center py-6">暂无对话</div>) : sessions.map(s => (
          <div key={s.id} className={"flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors " + (s.id === activeSessionId ? "bg-primary-50 text-primary-600" : "hover:bg-slate-50 text-slate-600")} onClick={() => { switchSession(s.id); setShowSessionPicker(false); }}>
            <div className="flex-1 min-w-0">
              {editingSessionId === s.id ? (
                <input autoFocus className="w-full border border-primary-300 rounded px-1.5 py-0.5 text-xs outline-none focus:ring-2 focus:ring-primary-500/20" value={editTitle} onChange={e => setEditTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleRenameSession(s.id); if (e.key === "Escape") { setEditingSessionId(null); setEditTitle(""); } }} onBlur={() => { setEditingSessionId(null); setEditTitle(""); }}/>
              ) : (
                <span className="truncate block">{s.title || "新对话"}</span>
              )}
            </div>
            <div className="flex items-center gap-0.5">
              <button onClick={e => { e.stopPropagation(); setEditingSessionId(s.id); setEditTitle(s.title); }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-primary-500 hover:bg-primary-50 transition-colors" title="重命名"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg></button>
              <button onClick={async e => { e.stopPropagation(); try { await api.deleteChatSession(s.id); setSessions(p => p.filter(x => x.id !== s.id)); if (activeSessionId === s.id) { const r = sessions.filter(x => x.id !== s.id); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = null; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } } catch { showToast("删除失败", "error"); } }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="删除"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
            </div>
          </div>
        ))}
      </div>
    </div>)}
    {pendingConfirm && (<div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => settleConfirm(false)}>
      <div className="absolute inset-0 bg-black/30 backdrop-blur-sm" />
      <div className="relative bg-white rounded-xl shadow-2xl border border-slate-200 w-80 p-4 animate-fade-in" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-medium text-slate-700 mb-3">确认操作</h3>
        <div className="space-y-1.5 mb-4">
          {pendingConfirm.calls.map((c, i) => {
            return (<div key={i} className="flex items-center gap-2 text-xs text-slate-600">
            <svg className="w-3.5 h-3.5 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"/></svg>
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
