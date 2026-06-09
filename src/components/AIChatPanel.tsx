import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import * as api from "../api";
import { AiChatMessage, AiChatSession, AiProvider } from "../types";
import { useToast } from "./Toast";
import { MdPreview } from "md-editor-rt";
import "md-editor-rt/lib/style.css";

interface AIChatPanelProps { isOpen: boolean; noteTitle: string; noteContent: string; onInsertText: (text: string) => void; onReplaceContent: (text: string) => void; onOpenProviderSettings: () => void; }

const MIN_PANEL_WIDTH = 350; const MAX_PANEL_WIDTH = 640; const DEFAULT_PANEL_WIDTH = 400;

const TOOL_DEFS = [
  { name: "searchNotes", desc: "搜索笔记标题", args: {"query":"搜索关键词"}, needsConfirm: false },
  { name: "getNoteContent", desc: "获取笔记全文", args: {"noteId":"笔记ID"}, needsConfirm: false },
  { name: "getCategories", desc: "获取所有分组", args: {}, needsConfirm: false },
  { name: "createNote", desc: "创建笔记", args: {"title":"标题","content":"内容(可选)","categoryName":"分组名(可选)"}, needsConfirm: true },
  { name: "updateNote", desc: "修改笔记", args: {"noteId":"笔记ID","title":"新标题(可选)","content":"新内容(可选)","categoryName":"新分组名(可选)"}, needsConfirm: true },
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
- updateNote: 修改笔记，参数：{"noteId":"笔记ID","title":"新标题(可选)","content":"新内容(可选)","categoryName":"新分组名(可选)"}
- deleteNote: 删除笔记(移到回收站)，参数：{"noteId":"笔记ID"}
- createCategory: 创建分组，参数：{"name":"分组名"}
- renameCategory: 重命名分组，参数：{"categoryId":"分组ID","name":"新名称"}
- deleteCategory: 删除分组，参数：{"categoryId":"分组ID"}
- moveNote: 移动笔记到其他分组，参数：{"noteId":"笔记ID","categoryId":"目标分组ID"}
- selectNote: 选择并打开指定笔记以查看或编辑内容，参数：{"noteId":"笔记ID"}

## 核心规则：每次回复都必须包含 <thinking> 标签
即使不需要工具，也要先思考再回答。格式要求极其严格：

### 需要调用工具时：
<thinking>你的推理过程...</thinking>
<tool_calls>[{"name":"工具名","args":{"参数名":"参数值"}}]</tool_calls>

### 不需要工具时（直接回答）：
<thinking>你的推理过程...</thinking>
你的回复内容

## ⚠️ 你必须严格遵守的格式 - 特别注意：
1. **思考不代表执行。** 在 <thinking> 中分析"我需要搜索xx"，这仅仅是思考。你必须同时输出 <tool_calls> 标签才能让系统实际执行工具。只思考不输出 <tool_calls> = 工具不会运行。
2. <thinking> 和 <tool_calls> 标签必须独立成行，不能嵌套在 markdown 代码块中
3. <tool_calls> 内必须是纯 JSON 数组，不要加 \`\`\`json 包裹
4. 一次可以调用多个工具，但需要注意依赖关系，先查询再操作
5. 用户不知道笔记和分组的 ID，必须先通过 searchNotes/getCategories 查询获取 ID

## 示例对话
用户：帮我打开标题含有读书的笔记
助手：<thinking>用户想打开一篇笔记，我需要先搜索"读书"找到笔记ID，再打开它。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"读书"}}]</tool_calls>

用户：帮我创建一个叫读书的新分类
助手：<thinking>用户想创建新分组，直接调用 createCategory。</thinking>
<tool_calls>[{"name":"createCategory","args":{"name":"读书"}}]</tool_calls>

用户：帮我打开《兄弟》那篇笔记
助手：<thinking>用户要打开一篇特定的笔记，我先搜索"兄弟"找到对应的笔记ID，然后通过 selectNote 打开它。</thinking>
<tool_calls>[{"name":"searchNotes","args":{"query":"兄弟"}}]</tool_calls>

用户：今天天气怎么样？
助手：<thinking>用户询问天气，这是一个与笔记无关的简单问题，我直接回答。</thinking>
今天天气情况我无法直接查询，建议你看天气预报。`;

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
      return `修改笔记${parts.length > 0 ? `（${parts.join("，")}）` : ""}`;
    }
    case "deleteNote":
      return `删除笔记`;
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

const parseResponse = (text: string): ParsedResponse => {
  const thinking = text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim() || "";
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
const parseStreamContent = (text: string): { thinking: string; reply: string } => {
  // Extract complete thinking tag
  const fullThinking = text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim() || "";
  // Extract complete tool_calls tag
  const fullTc = text.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/)?.[1]?.trim() || "";
  // Partial tags (still streaming)
  const partialThinking = !fullThinking ? text.match(/<thinking>([\s\S]*)/)?.[1]?.trim() || "" : "";
  const partialTc = !fullTc ? text.match(/<tool_calls>([\s\S]*)/)?.[1]?.trim() || "" : "";

  const thinking = fullThinking || partialThinking;
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

const TOOL_EXECUTORS: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
  searchNotes: async (args) => { const all = await api.getNotes(null, "updated_at", "desc"); const q = String(args.query||"").toLowerCase(); return all.filter((n:any) => (n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q)) && !n.is_deleted).slice(0,15).map((n:any) => ({ id: n.id, title: n.title, content: n.content ? n.content.substring(0,100) : "", category_id: n.category_id })); },
  getNoteContent: async (args) => { const all = await api.getNotes(null, "updated_at", "desc"); const n = all.find((x:any) => x.id === Number(args.noteId)); return n ? { id: n.id, title: n.title, content: n.content, category_id: n.category_id } : null; },
  getCategories: async () => { const cats = await api.getCategories(); return cats.map((c:any) => ({ id: c.id, name: c.name })); },
  createNote: async (args) => { let cid: number|null = null; if (args.categoryName) { const cats = await api.getCategories(); const f = cats.find((c:any) => c.name === String(args.categoryName)); if (f) cid = f.id; } const r = await api.createNote(String(args.title||""), String(args.content||""), cid); return { id: r.id, title: r.title }; },
  updateNote: async (args) => { const nid = Number(args.noteId); let cid: number|undefined; if (args.categoryName) { const cats = await api.getCategories(); const f = cats.find((c:any) => c.name === String(args.categoryName)); cid = f?.id; } const all = await api.getNotes(null, "updated_at", "desc"); const n = all.find((x:any) => x.id === nid); await api.updateNote(nid, String(args.title??n?.title??""), String(args.content??n?.content??""), cid??n?.category_id??null); return { id: nid }; },
  deleteNote: async (args) => { await api.moveToTrash(Number(args.noteId)); return { deleted: true }; },
  createCategory: async (args) => { const r = await api.createCategory(String(args.name)); return { id: r.id, name: r.name }; },
  renameCategory: async (args) => { await api.updateCategory(Number(args.categoryId), String(args.name)); return { id: Number(args.categoryId), name: args.name }; },
  deleteCategory: async (args) => { await api.deleteCategory(Number(args.categoryId), false); return { deleted: true }; },
  moveNote: async (args) => { const nid = Number(args.noteId); const all = await api.getNotes(null, "updated_at", "desc"); const n = all.find((x:any) => x.id === nid); await api.updateNote(nid, n?.title||"", n?.content||"", Number(args.categoryId)); return { moved: true }; },
  selectNote: async (args) => { window.dispatchEvent(new CustomEvent('fastnote-select-note', { detail: { noteId: Number(args.noteId) } })); return { selected: true, noteId: Number(args.noteId) }; },
};


export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, onInsertText, onReplaceContent, onOpenProviderSettings }) => {
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number>(0);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number>(0);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [panelWidth, setPanelWidth] = useState(DEFAULT_PANEL_WIDTH);
  const [models, setModels] = useState<string[]>([]);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
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

  useEffect(() => { if (!isOpen) return; loadProviders(); loadSessions(); }, [isOpen]);
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
  useEffect(() => { if (!activeProvider) { setModels([]); return; } setIsFetchingModels(true); let cancelled = false; api.fetchAiModels(activeProvider).then(f => { if (cancelled) return; if (f.length > 0) setModels([...new Set(f)]); else if (activeProvider.enabled_model) setModels([activeProvider.enabled_model]); }).catch(() => { if (cancelled) return; if (activeProvider.enabled_model) setModels([activeProvider.enabled_model]); }).finally(() => { if (!cancelled) setIsFetchingModels(false); }); return () => { cancelled = true; }; }, [activeProvider]);

  const selectedProviderIdRef = useRef(selectedProviderId);
  useEffect(() => { selectedProviderIdRef.current = selectedProviderId; }, [selectedProviderId]);
  const loadProviders = async () => { try { const list = await api.getAiProviders(); setProviders(list); if (list.length > 0 && !selectedProviderIdRef.current) setSelectedProviderId(list[0].id); } catch {} };
  const loadSessions = async () => { try { setSessions(await api.getChatSessions()); } catch {} };
  const loadSessionMessages = async (sid: number) => { try { const m = await api.getChatMessages(sid); setMessages(m.map(x => { const p = parseResponse(x.content); return { role: x.role as "user"|"assistant", content: p.reply || x.content, thinking: p.thinking }; })); } catch {} };
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await api.createChatSession("新对话", selectedProviderId, activeProvider?.enabled_model || ""); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; setActiveSessionId(sid); setStreamingContent(''); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { const s = await api.createChatSession("新对话", selectedProviderId, activeProvider?.enabled_model || ""); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setStreamingContent(""); titleGenRef.current = false; };
  const handleDeleteSession = async () => { if (!activeSessionId) return; try { await api.deleteChatSession(activeSessionId); setSessions(p => p.filter(x => x.id !== activeSessionId)); const r = sessions.filter(x => x.id !== activeSessionId); if (r.length > 0) { setActiveSessionId(r[0].id); titleGenRef.current = false; await loadSessionMessages(r[0].id); } else { setActiveSessionId(0); setMessages([]); } } catch { showToast('删除失败', 'error'); } };
  const genTitle = async (sid: number, up: string, ar: string) => { if (titleGenRef.current || !activeProvider) return; titleGenRef.current = true; try { const session = sessions.find(s => s.id === sid); if (!session || session.title !== "新对话") { titleGenRef.current = false; return; } const t = await api.sendAiChat(activeProvider.id, [{ role: "system", content: `I will give you some dialogue content in the <content> block.\nYou need to summarize the conversation between user and assistant into a short title.\n1. The title language should be consistent with the user's primary language\n2. Do not use punctuation or other special symbols\n3. Reply directly with the title\n4. The title should not exceed 10 characters\n5. Do not include any JSON, tags, or technical details\n\n<content>\nUser: ${up}\nAssistant: ${ar.replace(/<[^>]+>/g, "")}\n</content>` }, { role: "user", content: "Generate title" }], "", ""); const ct = t.replace(/["「」『』<>]/g, "").trim().slice(0, 10) || "新对话"; await api.updateChatSessionTitle(sid, ct); await loadSessions(); } catch { titleGenRef.current = false; } };
  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await api.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(''); await loadSessions(); } catch { showToast('重命名失败', 'error'); } };
  const agentLoop = async (sid: number, msgs: AiChatMessage[], prompt: string): Promise<void> => {
    placeholderRef.current = null;
    let roundMsgs = [...msgs];
    for (let round = 0; round < 5; round++) {
      if (abortRef.current) return;
      setIsSending(true);
      setStreamingContent('');
      try {
        const full = await api.sendAiChatStream(activeProvider!.id, [{ role: 'system', content: TOOLS_PROMPT }, ...roundMsgs], noteTitle||'', noteContent, c => { if (!abortRef.current) setStreamingContent(c); });
        if (abortRef.current) return;
        const { thinking, toolCalls, reply } = parseResponse(full);
        if (toolCalls.length === 0) {
          // No tools needed - show final reply
          // 替换 roundMsgs 中最后一条消息占位（如有），否则追加
          setIsSending(false);
          setStreamingContent('');
          setMessages(m => {
            const idx = placeholderRef.current ? m.findIndex(x => x === placeholderRef.current) : -1;
            placeholderRef.current = null;
            if (idx >= 0) return [...m.slice(0, idx), { role: 'assistant', content: reply, thinking }];
            // 没有占位时，尝试替换 roundMsgs 中的最后一条
            const lastMsg = roundMsgs[roundMsgs.length - 1];
            const idx2 = m.findIndex(x => x === lastMsg);
            if (idx2 >= 0) return [...m.slice(0, idx2 + 1), { role: 'assistant', content: reply, thinking }];
            return [...m, { role: 'assistant', content: reply, thinking }];
          });
          try { await api.saveChatMessage(sid, 'assistant', full); } catch {}
          if (!titleGenRef.current) genTitle(sid, prompt, reply || full);
          return;
        }
        // Tool calls found - show thinking first
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
        roundMsgs = [...roundMsgs, { role: 'assistant', content: full }, { role: 'system', content: '工具执行结果：' + resultSummary + '\n请根据结果继续处理或给用户最终回复' }];
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

  const handleSend = async () => { const prompt = input.trim(); if (!prompt || isSending) return; if (!activeProvider?.id || !activeProvider.enabled_model) { showToast("请先选择模型", "error"); return; } abortRef.current = false; 
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

  const onResize = useCallback(() => { dragRef.current = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; const mm = (e: MouseEvent) => { if (!dragRef.current) return; setPanelWidth(Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, window.innerWidth - e.clientX))); }; const mu = () => { dragRef.current = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; document.removeEventListener('mousemove', mm); document.removeEventListener('mouseup', mu); }; document.addEventListener('mousemove', mm); document.addEventListener('mouseup', mu); }, []);

  const activeModel = activeProvider?.enabled_model || '';
  if (!isOpen) return null;
  const allMsgs = streamingContent
    ? (() => {
        const p = parseStreamContent(streamingContent);
        return [...messages, { role: 'assistant' as const, content: p.reply, thinking: p.thinking }];
      })()
    : messages;

  return (<>
    <aside className="flex-shrink-0 border-l border-slate-200/80 bg-white flex flex-col h-full animate-slideInRight relative" style={{ width: panelWidth }}>
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
        <button className="toolbar-btn !w-7 !h-7 flex-shrink-0" title="" onClick={onOpenProviderSettings}><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"/><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg></button>
      </div>
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 chat-scrollbar">
        {!activeProvider ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg></div><p className="empty-state-title">暂无配置</p><p className="empty-state-desc">请先配置 AI 服务商</p><button onClick={onOpenProviderSettings} className="btn-primary px-4 py-2 text-xs">立即配置</button></div>
        ) : allMsgs.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon"><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/></svg></div><p className="empty-state-title">{activeModel ? "开始对话" : "请选择模型"}</p><p className="empty-state-desc">{activeModel ? "输入你的问题" : "在配置中选择模型"}</p></div>
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
            <select value={activeModel} onChange={e => { if (e.target.value && activeProvider) { const u = { ...activeProvider, enabled_model: e.target.value }; api.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x))); } }} className="bg-transparent text-xs text-slate-500 cursor-pointer min-w-[60px] max-w-[140px] w-auto px-1 py-1 truncate outline-none focus:outline-none focus:ring-0" disabled={!activeProvider || isFetchingModels}>
              <option value="">{isFetchingModels ? "加载中..." : activeProvider ? activeModel || "选择模型" : "无可用模型"}</option>
              {models.map(m => (<option key={m} value={m}>{m}</option>))}
              {activeProvider?.enabled_model && !models.includes(activeProvider.enabled_model) && (<option value={activeProvider.enabled_model}>{activeProvider.enabled_model}</option>)}
            </select>
          </div>
          <button onClick={() => setConfirmMode(!confirmMode)} className={"inline-flex items-center gap-1 px-2 py-1.5 rounded-xl text-xs font-medium border transition-all flex-shrink-0 " + (confirmMode ? "border-amber-200 bg-amber-50 text-amber-600 hover:bg-amber-100" : "border-slate-200 bg-white text-slate-400 hover:bg-slate-50")} title={confirmMode ? "操作需确认" : "自动执行"}>
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z"/></svg>
            <span>{confirmMode ? "需确认" : "自动"}</span>
          </button>
          {isSending ? (
            <button onClick={handleStop} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium text-white bg-red-500 hover:bg-red-600 shadow-sm transition-all active:scale-[0.97]"><svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24"><path d="M6 6h12v12H6z"/></svg>停止</button>
          ) : (
            <button onClick={handleSend} disabled={!input.trim() || !activeProvider?.enabled_model} className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl text-xs font-medium text-white bg-gradient-to-r from-primary-500 to-primary-600 shadow-md hover:shadow-lg hover:from-primary-600 hover:to-primary-700 transition-all active:scale-[0.97] disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100 flex-shrink-0 whitespace-nowrap"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>发送</button>
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
