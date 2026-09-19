import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "../api";
import { AiChatMessage, AiChatSession, AiProvider } from "../types";
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

const TOOL_DEFS = [
  { name: "searchNotes", desc: "搜索笔记标题", args: {"query":"搜索关键词"}, needsConfirm: false },
  { name: "getNoteContent", desc: "获取笔记全文", args: {"noteId":"笔记ID"}, needsConfirm: false },
  { name: "getCategories", desc: "获取所有分组", args: {}, needsConfirm: false },
  { name: "createNote", desc: "创建笔记", args: {"title":"标题","content":"内容(可选)","categoryName":"分组名(可选)"}, needsConfirm: true },
  { name: "updateNote", desc: "按 ID 修改指定笔记", args: {"noteId":"笔记ID","title":"新标题(可选)","content":"新内容(可选)","categoryName":"新分组名(可选)"}, needsConfirm: true },
  { name: "updateCurrentNote", desc: "修改当前打开的笔记（无需 ID，精确作用于用户正在看的那一篇）", args: {"title":"新标题(可选)","content":"新内容(覆盖正文)","categoryName":"新分组名(可选)"}, needsConfirm: true },
  { name: "deleteNote", desc: "删除笔记(移到回收站)", args: {"noteId":"笔记ID"}, needsConfirm: true },
  { name: "createCategory", desc: "创建分组", args: {"name":"分组名"}, needsConfirm: true },
  { name: "renameCategory", desc: "重命名分组", args: {"categoryId":"分组ID","name":"新名称"}, needsConfirm: true },
  { name: "deleteCategory", desc: "删除分组", args: {"categoryId":"分组ID"}, needsConfirm: true },
  { name: "moveNote", desc: "移动笔记到其他分组", args: {"noteId":"笔记ID","categoryId":"目标分组ID"}, needsConfirm: true },
  { name: "selectNote", desc: "选择并打开指定笔记", args: {"noteId":"笔记ID"}, needsConfirm: false },
];

const TOOLS_PROMPT = `你是 FastNote 智能笔记助手。你可以使用工具来帮助用户操作笔记和分组。

可用工具：
- searchNotes: 搜索笔记标题和内容，参数：{"query":"搜索关键词"}
- getNoteContent: 获取笔记全文，参数：{"noteId":"笔记ID"}
- getCategories: 获取所有分组，参数：{}
- createNote: 创建笔记，参数：{"title":"标题","content":"内容(可选)","categoryName":"分组名(可选)"}
- updateNote: 按 ID 修改指定笔记，参数：{"noteId":"笔记ID","title":"新标题(可选)","content":"新内容(可选)","categoryName":"新分组名(可选)"}
- updateCurrentNote: 修改**当前打开的笔记**，不需要 noteId，参数：{"title":"新标题(可选)","content":"新内容(覆盖整篇正文)","categoryName":"新分组名(可选)"}
- deleteNote: 删除笔记(移到回收站)，参数：{"noteId":"笔记ID"}
- createCategory: 创建分组，参数：{"name":"分组名"}
- renameCategory: 重命名分组，参数：{"categoryId":"分组ID","name":"新名称"}
- deleteCategory: 删除分组，参数：{"categoryId":"分组ID"}
- moveNote: 移动笔记到其他分组，参数：{"noteId":"笔记ID","categoryId":"目标分组ID"}
- selectNote: 选择并打开指定笔记以查看或编辑内容，参数：{"noteId":"笔记ID"}

## 核心规则（不可违反）
1. **每次回复都必须包含 <thinking> 标签，且必须先思考再输出任何内容。**
2. **<thinking> 必须是真实、深入的推理，不得少于 120 个字符**，不能写"我需要帮助用户"这类敷衍句子；必须分析用户意图、指代对象、所需信息、工具选择与执行顺序、破坏性操作的风险。
3. **思考不等于执行。** 在 <thinking> 中分析"我需要搜索xx"只是思考。必须同时输出 <tool_calls> 标签，工具才会真正执行。只思考、不输出 <tool_calls> = 工具不会运行。
4. **判断意图必须调用工具：** 只要用户的要求涉及"打开/查看/搜索/查找/创建/新建/修改/更新/删除/移动/重命名/整理/归类"笔记或分组，或者询问"有哪些笔记/分组"，你就必须调用工具，禁止只用文字回答。
5. **一次可以调用多个工具**，但要注意依赖关系：用户不知道 ID，所以要么用"当前上下文"里给出的当前笔记 ID，要么先用 searchNotes/getCategories 查出 ID，再做后续操作。
6. **一切操作都要基于笔记 ID，绝不能只靠标题定位。** 标题可以重复，只有 ID 唯一。
   - 用户说"这篇笔记 / 当前笔记 / 现在打开的 / 它"等指代，指的就是下面"当前打开的笔记"里给出的 noteId。此时**不要按标题搜索**，直接使用该 noteId，或直接用 updateCurrentNote。
   - 用户明确给出标题、而标题可能重复时，先 searchNotes；如果返回多条同名笔记，**必须停下来列出候选项并请用户确认**，禁止随便挑一条修改或删除。
   - 如果参考信息里显示"当前没有打开任何笔记"，那么用户说"这篇笔记"时应当直接说明没有打开的笔记，请他指出具体是哪一篇，禁止凭空猜测。
7. 标签必须独立成行，不能包在 markdown 代码块里；<tool_calls> 内必须是纯 JSON 数组，不要用 \`\`\`json 包裹。

### 需要调用工具时：
<thinking>至少 120 字的深入推理...</thinking>
<tool_calls>[{"name":"工具名","args":{"参数名":"参数值"}}]</tool_calls>

### 确认不需要工具时（仅有疑问、闲聊、写作润色类请求）：
<thinking>至少 120 字的深入推理...</thinking>
你的回复内容

## 示例对话
用户：帮我打开标题含有读书的笔记
助手：<thinking>用户要"打开一篇笔记"，这是操作请求而不是普通提问。关键词是"读书"，但我没有笔记 ID，用户也不会知道 ID。所以第一步必须调用 searchNotes 搜索"读书"来获取候选笔记；拿到结果后，如果只有一条匹配就调用 selectNote 打开它，如果有多条则先列出让用户选择，避免打开错误的笔记。因此本轮先调用 searchNotes。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"读书"}}]</tool_calls>

用户：帮我创建一个叫读书的新分类
助手：<thinking>用户明确要求"创建一个新分组"，这是一个可直接执行的操作，不需要先查询任何 ID。分组名是"读书"，属于新增而非重命名，因此应当调用 createCategory 并传入 name="读书"。这个操作是新增操作，不会覆盖既有数据，风险较低，但仍需执行后才算完成，不能只用文字回复。</thinking>
<tool_calls>[{"name":"createCategory","args":{"name":"读书"}}]</tool_calls>

用户：帮我打开《兄弟》那篇笔记
助手：<thinking>用户要打开一篇特定标题的笔记。我并不知道《兄弟》对应的笔记 ID，必须先通过 searchNotes 用关键词"兄弟"检索；如果检索到唯一结果，下一步再用 selectNote 打开。本轮先执行 searchNotes，拿到结果后要在思考中确认确实是用户所指的那一篇，避免误开同名的其它笔记。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"兄弟"}}]</tool_calls>

用户：把这篇笔记的标题改成《读书笔记》
助手：<thinking>用户说"这篇笔记"，属于指代而非标题。当前上下文中已经给出了打开笔记的 ID，因此我不需要也不应该去按标题搜索——标题可能重复，搜索出来的结果未必是用户正在看的那一篇。我应该直接使用该 ID，或直接调用 updateCurrentNote 作用于当前打开的笔记，这样即使库里有多篇同名笔记也不会改错。本次是修改正文标题，属于覆盖性操作，需要用户在确认框里确认。</thinking>
<tool_calls>[{"name":"updateCurrentNote","args":{"title":"读书笔记"}}]</tool_calls>

用户：把《会议记录》那篇笔记删掉
助手：<thinking>用户给的是标题"会议记录"，不是指代当前笔记，而且没有给出 ID，所以我必须先调用 searchNotes 查出候选。这里存在一个风险：如果库里有不止一篇《会议记录》，按标题删除就可能删错。因此我要先看搜索结果里的 duplicateTitles，如果发现同名笔记超过一篇，就必须停下来把候选的 ID 和内容摘要列出来请用户确认，绝不能自行挑一条删除。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"会议记录"}}]</tool_calls>

用户：今天天气怎么样？
助手：<thinking>用户询问天气，这与笔记和分组完全无关，没有任何工具能够查询实时天气，因此不应该调用任何工具。我应该直接说明我无法获取实时天气，并建议用户查看天气预报。这是一个纯问答场景，不需要改动任何笔记数据。</thinking>
我无法直接获取实时天气，建议你查看手机自带的天气应用或天气预报网站。`;

/** 判断用户消息是否属于需要执行工具的请求 */
const ACTION_INTENT_PATTERN =
  /打开|查看|显示|搜索|查找|找一?下|找到|新建|创建|添加|新增|修改|更新|改成|编辑|删除|移除|移到|移动|归类|整理|重命名|改名|分组|标签|有哪些|列出|列一下|帮我|把.*(改|删|移|加)/;

const looksLikeActionRequest = (text: string): boolean =>
  ACTION_INTENT_PATTERN.test(text.replace(/\s/g, ""));

/** thinking 是否达到"深度思考"的最低要求 */
const isThinkingDeepEnough = (thinking: string, minLen: number): boolean =>
  thinking.replace(/\s/g, "").length >= minLen;

interface ToolCall { name: string; args: Record<string, unknown>; }
interface ParsedResponse { thinking: string; toolCalls: ToolCall[]; reply: string; }

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
    case "createCategory":
      return `创建分组「${String(c.args.name || "").substring(0, 20)}」`;
    case "renameCategory":
      return `重命名分组为「${String(c.args.name || "").substring(0, 20)}」`;
    case "deleteCategory":
      return `删除分组`;
    case "moveNote":
      return `移动笔记到其他分组`;
    default:
      return c.name;
  }
};

const parseResponse = (text: string, reasoning?: string): ParsedResponse => {
  // 模型原生思维链（reasoning_content / thought）优先用于 thinking 展示
  const nativeReasoning = (reasoning || "").trim();
  let thinking = text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim() || "";
  if (!thinking && nativeReasoning) {
    thinking = nativeReasoning;
  }
  const tcMatch = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
  let toolCalls: ToolCall[] = [];
  if (tcMatch) {
    let raw = tcMatch[1].trim();
    // 移除 markdown 代码块包裹（```json ... ``` 或 ``` ... ```）
    raw = raw.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    try { const arr = JSON.parse(raw); if (Array.isArray(arr)) toolCalls = arr; } catch {}
  }
  const reply = text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "").trim();
  return { thinking, toolCalls, reply };
};

/** Parse streaming text to extract thinking (supports partial tags) and visible reply */
const parseStreamContent = (text: string, reasoning?: string): { thinking: string; reply: string } => {
  // Extract complete thinking tag
  const fullThinking = text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim() || "";
  // Extract complete tool_calls tag
  const fullTc = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/)?.[1]?.trim() || "";
  // Partial tags (still streaming)
  const partialThinking = !fullThinking ? text.match(/<thinking>([\s\S]*)/)?.[1]?.trim() || "" : "";
  const partialTc = !fullTc ? text.match(/<tool_calls>([\s\S]*)/)?.[1]?.trim() || "" : "";

  // 模型原生思维链作为 thinking 的兜底来源
  const thinking = fullThinking || partialThinking || (reasoning || "").trim();
  const tcContent = fullTc || partialTc;

  // If there's tool_calls content, fold it into thinking
  const combinedThinking = tcContent
    ? (thinking ? `${thinking}\n\n---\n${tcContent}` : tcContent)
    : thinking;

  // Reply = text with thinking and tool_calls tags stripped
  const reply = text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<thinking>[\s\S]*/g, "")  // partial thinking
    .replace(/<tool_calls>[\s\S]*/g, "")  // partial tool_calls
    .trim();

  return { thinking: combinedThinking, reply };
};

/**
 * 当前打开笔记的 ID。工具执行器定义在组件外层，通过这个 ref 读取最新值，
 * 这样 updateCurrentNote 永远作用于用户此刻正在看的那一篇。
 */
/** 把（Tauri 返回的）错误转成可读文案 */
const formatError = (error: unknown): string => {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

const currentNoteIdRef: { current: number | null } = { current: null };

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

const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  searchNotes: async (args) => {
    const all = await api.getNotes(null, "updated_at", "desc");
    const q = String(args.query || "").toLowerCase();
    const hits = all.filter((n: any) => (n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)) && !n.is_deleted);
    // 同名笔记会让"按标题操作"产生歧义，显式提示模型并要求用户确认
    const titleCounts = new Map<string, number>();
    for (const n of hits) titleCounts.set(n.title, (titleCounts.get(n.title) || 0) + 1);
    const duplicateTitles = [...titleCounts.entries()].filter(([, c]) => c > 1).map(([t]) => t);
    return {
      matches: hits.slice(0, 15).map((n: any) => ({ id: n.id, title: n.title, content: n.content ? n.content.substring(0, 100) : "", category_id: n.category_id })),
      total: hits.length,
      duplicateTitles,
      ...(duplicateTitles.length > 0
        ? { warning: `存在同名笔记（${duplicateTitles.join("、")}）。标题无法唯一定位，必须让用户确认要操作哪一个 ID。` }
        : {}),
    };
  },
  getNoteContent: async (args) => {
    const n: any = await fetchNoteById(Number(args.noteId));
    return n ? { id: n.id, title: n.title, content: n.content, category_id: n.category_id } : null;
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
  updateCurrentNote: async (args) => {
    const nid = Number(currentNoteIdRef.current);
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
  deleteCategory: async (args) => { await api.deleteCategory(Number(args.categoryId), false); return { deleted: true }; },
  moveNote: async (args) => {
    const nid = Number(args.noteId);
    const n: any = await fetchNoteById(nid);
    if (!n) return { success: false, error: `未找到 ID 为 ${nid} 的笔记` };
    await api.updateNote(nid, n.title, n.content, Number(args.categoryId));
    return { moved: true, id: nid };
  },
  selectNote: async (args) => { const nid = Number(args.noteId); window.dispatchEvent(new CustomEvent('fastnote-select-note', { detail: { noteId: nid } })); return { selected: true, noteId: nid }; },
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
  const [pendingConfirm, setPendingConfirm] = useState<{calls: ToolCall[]; resolve: (v: boolean) => void} | null>(null);
  const [confirmMode, setConfirmMode] = useState(true);
  const { showToast } = useToast();
  const scrollRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const titleGenRef = useRef(false);
  const abortRef = useRef(false);
  const isSendingRef = useRef(false);
  const placeholderRef = useRef<AiChatMessage | null>(null);
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
  useEffect(() => { currentNoteIdRef.current = currentNoteId ?? null; }, [currentNoteId]);

  useEffect(() => { if (!isOpen) return; loadProviders(); loadSessions(); }, [isOpen]);
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
  // Only auto-scroll when user is already near the bottom (within 60px threshold)
  // 始终滚动到最新消息
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 使用 requestAnimationFrame 确保在 DOM 更新完成后滚动
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [messages, streamingContent]);
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
  const loadSessionMessages = async (sid: number) => { try { const m = await api.getChatMessages(sid); setMessages(m.map(x => { const p = parseResponse(x.content); return { role: x.role as "user"|"assistant", content: p.reply || x.content, thinking: p.thinking }; })); } catch {} };
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await api.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; setActiveSessionId(sid); setStreamingContent(''); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { const s = await api.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setStreamingContent(""); titleGenRef.current = false; };
  const handleDeleteSession = async () => { if (!activeSessionId) return; try { await api.deleteChatSession(activeSessionId); setSessions(p => p.filter(x => x.id !== activeSessionId)); const r = sessions.filter(x => x.id !== activeSessionId); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = false; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } catch { showToast('删除失败', 'error'); } };
  const genTitle = async (sid: number, up: string, ar: string) => { if (titleGenRef.current || !activeProvider) return; titleGenRef.current = true; try { const session = sessions.find(s => s.id === sid); if (!session || session.title !== "新对话") { titleGenRef.current = false; return; } const t = await api.sendAiChat(activeProvider.id, [{ role: "system", content: `I will give you some dialogue content in the <content> block.\nYou need to summarize the conversation between user and assistant into a short title.\n1. The title language should be consistent with the user's primary language\n2. Do not use punctuation or other special symbols\n3. Reply directly with the title\n4. The title should not exceed 10 characters\n5. Do not include any JSON, tags, or technical details\n\n<content>\nUser: ${up}\nAssistant: ${ar.replace(/<[^>]+>/g, "")}\n</content>` }, { role: "user", content: "Generate title" }], "", ""); const ct = t.replace(/["「」『』<>]/g, "").trim().slice(0, 10) || "新对话"; await api.updateChatSessionTitle(sid, ct); await loadSessions(); } catch { titleGenRef.current = false; } };
  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await api.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(''); await loadSessions(); } catch { showToast('重命名失败', 'error'); } };
  const agentLoop = async (sid: number, msgs: AiChatMessage[], prompt: string): Promise<void> => {
    placeholderRef.current = null;
    let roundMsgs = [...msgs];
    /** 本轮强制思考的最小字符数（与 Rust 端提示词保持一致） */
    const MIN_THINKING_LEN = 120;
    const hasToolResult = () => roundMsgs.some(m => (m.content || '').startsWith('工具执行结果'));
    /** 每轮允许的一次"强制思考/工具使用"纠正机会 */
    let correctionUsed = false;

    for (let round = 0; round < 6; round++) {
      if (abortRef.current) return;
      setIsSending(true);
      setStreamingContent('');
      let nativeReasoning = '';
      try {
        const full = await api.sendAiChatStream(
          activeProvider!.id,
          [{ role: 'system', content: TOOLS_PROMPT }, ...roundMsgs],
          noteTitle || '',
          noteContent,
          (c, r) => {
            nativeReasoning = r;
            if (!abortRef.current) setStreamingContent(c);
          },
          MIN_THINKING_LEN,
          currentNoteId ?? null,
        );
        if (abortRef.current) return;
        const { thinking, toolCalls, reply } = parseResponse(full, nativeReasoning);

        // ---------- 纠错 1：思考过浅，强制重新深度思考 ----------
        if (!correctionUsed && !isThinkingDeepEnough(thinking, MIN_THINKING_LEN)) {
          correctionUsed = true;
          setIsSending(false);
          setStreamingContent('');
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

        // ---------- 纠错 2：应当调用工具却直接作答，强制重新决策 ----------
        if (!correctionUsed && toolCalls.length === 0 && !abortRef.current && looksLikeActionRequest(prompt) && !hasToolResult()) {
          correctionUsed = true;
          setIsSending(false);
          setStreamingContent('');
          roundMsgs = [
            ...roundMsgs,
            { role: 'assistant', content: full },
            {
              role: 'system',
              content:
                '用户的请求明确要求对笔记或分组执行操作，但你的回复中没有 <tool_calls>，因此没有任何工具被执行。' +
                '请重新判断：如果确实需要执行操作，必须同时输出 <thinking> 与 <tool_calls>；用户不知道笔记或分组 ID，必须先用 searchNotes 或 getCategories 查询。' +
                '只有当你确认该请求完全不需要操作笔记数据时，才可以直接用文字回复。',
            },
          ];
          continue;
        }

        // ---------- 无工具调用：这是最终回复 ----------
        if (toolCalls.length === 0) {
          setIsSending(false);
          setStreamingContent('');
          const finalReply = reply || thinking || '（模型没有返回内容，请重试）';
          setMessages(m => {
            const idx = placeholderRef.current ? m.findIndex(x => x === placeholderRef.current) : -1;
            placeholderRef.current = null;
            if (idx >= 0) return [...m.slice(0, idx), { role: 'assistant', content: finalReply, thinking }];
            // 没有占位时，尝试替换 roundMsgs 中的最后一条
            const lastMsg = roundMsgs[roundMsgs.length - 1];
            const idx2 = m.findIndex(x => x === lastMsg);
            if (idx2 >= 0) return [...m.slice(0, idx2 + 1), { role: 'assistant', content: finalReply, thinking }];
            return [...m, { role: 'assistant', content: finalReply, thinking }];
          });
          try { await api.saveChatMessage(sid, 'assistant', full); } catch {}
          if (!titleGenRef.current) genTitle(sid, prompt, reply || full);
          return;
        }

        // ---------- 有工具调用：先展示思考，再执行工具 ----------
        const placeholderMsg = { role: 'assistant' as const, content: '', thinking } as any;
        placeholderRef.current = placeholderMsg;
        setMessages(m => [...m, placeholderMsg]);
        if (!titleGenRef.current) genTitle(sid, prompt, full);
        setIsSending(false);
        setStreamingContent('');
        // Separate read-only vs destructive tools
        const readOnly = toolCalls.filter(tc => !TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        const destructive = toolCalls.filter(tc => TOOL_DEFS.find(td => td.name === tc.name)?.needsConfirm);
        // Execute read-only tools immediately
        let results: { name: string; result: unknown; success: boolean }[] = [];
        for (const tc of readOnly) {
          try { const result = await TOOL_EXECUTORS[tc.name](tc.args); results.push({ name: tc.name, result, success: true }); } catch (e) { results.push({ name: tc.name, result: String(e), success: false }); }
        }
        // If destructive tools exist, ask user for confirmation (if confirmMode enabled)
        if (destructive.length > 0 && confirmMode) {
          const confirmed = await new Promise<boolean>(resolve => {
            setPendingConfirm({ calls: destructive, resolve });
          });
          if (!confirmed) {
            results.push(...destructive.map(tc => ({ name: tc.name, result: '用户已取消', success: false })));
          } else {
            for (const tc of destructive) {
              try { const result = await TOOL_EXECUTORS[tc.name](tc.args); results.push({ name: tc.name, result, success: true }); } catch (e) { results.push({ name: tc.name, result: String(e), success: false }); }
            }
          }
        } else if (destructive.length > 0) {
          for (const tc of destructive) {
            try { const result = await TOOL_EXECUTORS[tc.name](tc.args); results.push({ name: tc.name, result, success: true }); } catch (e) { results.push({ name: tc.name, result: String(e), success: false }); }
          }
        }
        // Build result message and continue loop
        const resultSummary = results.map(r => `${r.name}: ${r.success ? JSON.stringify(r.result) : '失败: ' + r.result}`).join('; ');
        if (results.length > 0) { try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); await loadSessions(); } catch {} }
        roundMsgs = [...roundMsgs, { role: 'assistant', content: full }, { role: 'system', content: '工具执行结果：' + resultSummary + '\n请根据结果继续处理或给用户最终回复（仍需先输出 <thinking>）' }];
      } catch (e) {
        console.error(e);
        setIsSending(false);
        setStreamingContent('');
        return;
      }
    }
    setIsSending(false);
  };

  const toggleThinking = (i: number) => { setExpandedThinking(p => ({ ...p, [i]: !p[i] })); };

  const handleSend = async () => { const prompt = input.trim(); if (!prompt || isSending) return; if (!activeProvider?.id || !activeModel) { showToast("请先在设置中勾选可用模型", "error"); return; } abortRef.current = false; 
    // Show user message and thinking indicator immediately
    const userMsg: AiChatMessage = { role: "user", content: prompt };
    setMessages(m => [...m, userMsg]);
    setInput("");
    setStreamingContent("");
    setIsSending(true);
    const sid = await ensureSession();
    try { await api.saveChatMessage(sid, "user", prompt); } catch {} 
    await agentLoop(sid, [...messages, userMsg], prompt); 
    await loadSessions(); try { window.dispatchEvent(new CustomEvent('fastnote-data-changed')); } catch {} };

  const handleStop = () => { abortRef.current = true; placeholderRef.current = null; setMessages(m => [...m, { role: 'assistant', content: '已停止' }]); setIsSending(false); setStreamingContent(''); if (activeSessionId) api.saveChatMessage(activeSessionId, 'assistant', '已停止').catch(()=>{}); };

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
      setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - ev.clientX)));
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

  if (!isOpen) return null;
  const allMsgs = streamingContent
    ? (() => {
        const p = parseStreamContent(streamingContent);
        return [...messages, { role: 'assistant' as const, content: p.reply, thinking: p.thinking }];
      })()
    : messages;

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
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 chat-scrollbar">
        {!activeProvider ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div><p className="empty-state-title">暂无配置</p><p className="empty-state-desc">请先配置 AI 服务商</p><button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs">立即配置</button></div>
        ) : allMsgs.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><p className="empty-state-title">{activeModel ? "开始对话" : "还没有可用模型"}</p><p className="empty-state-desc">{activeModel ? "输入你的问题" : "请在设置里获取并勾选模型"}</p></div>
        ) : (allMsgs.map((msg, i) => {
          const msgThinking = (msg as any).thinking;
          if (msg.role === 'user') {
            return (<div key={i} className="flex items-end gap-2.5 animate-fade-in flex-row-reverse will-change-transform" style={{ animationDelay: (Math.min(i, 5) * 15) + "ms" }}>
              <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center flex-shrink-0 shadow-sm mt-1 ring-2 ring-primary-100"><svg className="w-4 h-4 text-white" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg></div>
              <div className="rounded-2xl rounded-br-md px-3.5 py-2 text-xs leading-relaxed whitespace-pre-wrap bg-gradient-to-br from-primary-500 to-primary-600 text-white shadow-sm max-w-[85%]">{msg.content}</div>
            </div>);
          }
          return (<div key={i} className="animate-fade-in will-change-transform" style={{ animationDelay: (Math.min(i, 5) * 15) + "ms" }}>
            {(!allMsgs[i-1] || allMsgs[i-1].role !== "assistant") && (<div className="flex items-center gap-1.5 mb-1">
              <div className="w-5 h-5 rounded-lg bg-gradient-to-br from-primary-400 to-primary-600 flex items-center justify-center flex-shrink-0"><svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div>
              <span className="text-xs font-medium text-slate-500">FastNote 助手</span>
            </div>)}
            {msgThinking ? (
              <div className="mb-2">
                <button onClick={() => toggleThinking(i)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors px-1 py-0.5">
                  <svg className={"w-3 h-3 transition-transform " + (expandedThinking[i] ? "rotate-90" : "")} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7"/></svg>
                  <span>AI 深度思考</span>
                  <span className="text-slate-300">·</span>
                  <span className="text-slate-300">{expandedThinking[i] ? "收起" : "展开"}</span>
                </button>
                {expandedThinking[i] && (<div className="mt-1 px-3 py-2 bg-slate-50 rounded-lg text-xs text-slate-500 leading-relaxed whitespace-pre-wrap border border-slate-100">{msgThinking}</div>)}
              </div>
            ) : null}
            <div className="text-xs leading-relaxed text-slate-700 ai-markdown px-0.5">
              {msg.content ? (
                <><MdPreview modelValue={msg.content} theme="light" previewTheme="github" codeTheme="github" noMermaid={false} noKatex={false} noHighlight={false}/>
                {!isSending && (<div className="mt-2 pt-2 border-t border-slate-100 flex gap-1.5">
                  <button onClick={() => onInsertText(msg.content)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-slate-50 hover:bg-primary-50 hover:text-primary-500 transition-colors active:scale-95"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4"/></svg>插入</button>
                  <button onClick={() => onReplaceContent(msg.content)} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium text-slate-500 bg-slate-50 hover:bg-amber-50 hover:text-amber-600 transition-colors active:scale-95"><svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>替换</button>
                </div>)}</>
              ) : null}
            </div>
          </div>);
        }))}
        {isSending && !streamingContent && (<div className="flex justify-start"><div className="text-xs text-slate-400 px-3 py-2 bg-slate-50 rounded-xl inline-flex items-center gap-2"><span className="thinking-dots"><span/><span/><span/></span>思考中</div></div>)}
      </div>
      <div className="border-t border-slate-200/60 bg-white px-4 py-2.5 space-y-2 flex-shrink-0">
        <div className="relative">
          <textarea ref={inputRef} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && e.ctrlKey) { const t = inputRef.current; if (t) { const s = t.selectionStart; setInput(input.slice(0, s) + "\n" + input.slice(t.selectionEnd)); } return; } if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); isSendingRef.current ? handleStop() : handleSend(); } }} placeholder="" rows={2} className="w-full resize-none px-3 py-2 text-xs input-modern bg-slate-50/50 focus:bg-white transition-colors" style={{ minHeight: "56px", maxHeight: "100px" }}/>
          {messages.length > 0 && (<button onClick={() => { setMessages([]); setStreamingContent(""); }} className="absolute top-1 right-1 p-1 rounded-md text-slate-300 hover:text-red-500 hover:bg-red-50 transition-colors z-10" title="清空对话"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>)}
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
              <button onClick={async e => { e.stopPropagation(); try { await api.deleteChatSession(s.id); setSessions(p => p.filter(x => x.id !== s.id)); if (activeSessionId === s.id) { const r = sessions.filter(x => x.id !== s.id); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = false; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } } catch { showToast("删除失败", "error"); } }} className="flex-shrink-0 p-1 rounded-md text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors" title="删除"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg></button>
            </div>
          </div>
        ))}
      </div>
    </div>)}
    {pendingConfirm && (<div className="fixed inset-0 z-50 flex items-center justify-center" onClick={() => { pendingConfirm.resolve(false); setPendingConfirm(null); }}>
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
          <button onClick={() => { pendingConfirm.resolve(false); setPendingConfirm(null); }} className="px-3 py-1.5 text-xs font-medium text-slate-500 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors">取消</button>
          <button onClick={() => { pendingConfirm.resolve(true); setPendingConfirm(null); }} className="px-3 py-1.5 text-xs font-medium text-white bg-primary-500 hover:bg-primary-600 rounded-lg transition-colors">确认执行</button>
        </div>
      </div>
    </div>)}
  </>);
};
