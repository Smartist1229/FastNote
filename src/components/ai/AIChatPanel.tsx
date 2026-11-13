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
import { logAction } from "@/lib/app/actionLog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useCallback } from "react";
import { emitAppEvent, onAppEvent } from "@/shared/bus";
import { t as translate, useI18n } from "@/i18n";
import * as aiApi from "@/api/ai/ai";
import type { AiChatMessage, AiChatSession, AiProvider } from "@/interface/ai/ai";
import type { AIChatPanelProps, ToolResult } from "@/interface/ai/aiChat";
import { TOOL_EXECUTORS, fetchNoteById, toolDetail, summarizeToolCall } from "@/lib/ai/tools";
import { semanticSearch } from "@/api/ai/semantic";
import { pluginContributions } from "@/plugins/contributions";
import { getNote } from "@/api/note/notes";
import type { ToolCall, ToolTrace } from "@/interface/ai/aiOutput";
import { finalReplyText, parseResponse, parseStreamContent } from "@/lib/ai/aiParse/parse";
import { isThinkingDeepEnough, shouldRetryForShallowThinking, streamStartsWithThinking } from "@/lib/ai/aiParse/thinking";
import { compressTranscript, estimateTokens, localSummaryFallback, selectContextWindow } from "@/lib/ai/aiParse/context";
import { expandRefs, stripNoteRefs } from "@/lib/ai/aiParse/noteRef";
import { buildFinalContent, cleanSessionTitle, formatError, hasActionClaim, stripAiTags } from "@/lib/ai/aiParse/text";
import type { ChatComposerHandle } from "@/components/ai/ChatComposer";
import {
  AI_ACCESS_DISABLED_NOTE,
  buildAiAccessRules,
  type AiAccessLevel,
  type AiAccessRules,
} from "@/lib/ai/aiAccess";
import { useToast } from "@/components/common/Toast";
import { ChatHeader } from "@/components/ai/chat/ChatHeader";
import { MessageList } from "@/components/ai/chat/MessageList";
import { ChatInput } from "@/components/ai/chat/ChatInput";
import { SessionPicker } from "@/components/ai/chat/SessionPicker";
import { RAIL_ITEM_H, RAIL_MIN_GAP, RAIL_MAX_GAP } from "@/components/ai/chat/AnchorRail";
import { CONFIRM_CANCELLED, renderUiNotice } from "@/components/ai/chat/utils";
import type { UiChatMessage, UiNotice } from "@/components/ai/chat/types";
import {
  AI_ACCESS_DENIED_PROMPT,
  AI_ACCESS_RESTRICTED_PROMPT,
  AI_READ_ONLY_PROMPT,
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
  buildPluginToolsBlock,
  buildShallowThinkingNotice,
  buildStableSystemPrompt,
  buildSummaryUserMessage,
  buildTitlePrompt,
  buildToolResultMessage,
} from "@/config/ai/aiDefaults";

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







/** 等待确认的上限时间：超时按"取消"结算，避免 agentLoop 永久挂起 */
const CONFIRM_TIMEOUT_MS = 180000;





/* ---------- 自动语义召回 ---------- */

/** 召回条数上限：多了会挤占上下文，而且模型也看不过来 */
const RECALL_LIMIT = 5;
/** 检索时多取一些候选：受限笔记会被过滤掉，留点余量 */
const RECALL_CANDIDATES = 20;
/** 相似度下限：低于这个值的命中通常是"词面沾边、主题无关"，塞给模型只会干扰 */
const RECALL_MIN_SCORE = 0.45;
/** 单条片段最多带多少字 */
const RECALL_SNIPPET_CHARS = 240;

/**
 * 用本地向量库召回与当前提问相关的旧笔记，整理成一段可注入提示词的文本。
 *
 * 为什么值得做：模型只能"想起来"才去调 searchNotesSemantic，而它经常想不起来，
 * 于是先跑一轮 searchNotes 试探、再读、再改——多两三趟往返，既慢又烧 token。
 * 本地召回是纯 CPU 的（bge 小模型），不花钱不出网，把第一步替模型做掉。
 *
 * 返回空串表示不注入：开关关闭、AI 无笔记权限、语义模型没下载、索引没建、
 * 或没有足够相关的命中。任何一种都不该影响正常对话，因此整体 try/catch。
 *
 * 权限：检索本身不做过滤（不传 noteIds 就不限范围），改为对命中逐条走
 * fetchNoteById —— 它对受限笔记返回 null，所以"看不见的笔记"不会漏进提示词。
 * 这样比"先拉全库笔记列表再传 noteIds"轻得多（那是一次可能几十 MB 的 IPC）。
 */
const buildSemanticRecall = async (
  query: string,
  access: AiAccessRules,
  options: { enabled: boolean; excludeNoteId: string | null },
): Promise<string> => {
  if (!options.enabled || !access.enabled) return "";
  // 引用块是 JSON 包装，先剥掉再检索，否则 query 会被一堆字段名污染
  const text = stripNoteRefs(query).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  // 太短的输入（"继续""好的"）没有检索价值，纯属浪费一次推理
  if (text.length < 6) return "";
  try {
    const hits = await semanticSearch(text, RECALL_CANDIDATES);
    const candidates = hits.filter((hit) => hit.score >= RECALL_MIN_SCORE);
    if (candidates.length === 0) return "";
    const resolved = await Promise.all(
      candidates.map(async (hit) => ({ hit, note: await fetchNoteById(hit.note_id, access) })),
    );
    const lines = resolved
      .filter((item): item is { hit: typeof item.hit; note: NonNullable<typeof item.note> } => Boolean(item.note))
      .filter((item) => item.hit.note_id !== options.excludeNoteId)
      .slice(0, RECALL_LIMIT)
      .map(({ hit, note }) => {
        const snippet = hit.snippet.replace(/\s+/g, " ").slice(0, RECALL_SNIPPET_CHARS);
        return `- 《${note.title || "(untitled)"}》 (id=${hit.note_id}, similarity ${hit.score.toFixed(2)})\n  ${snippet}`;
      });
    if (lines.length === 0) return "";
    return [
      "## Possibly relevant notes (auto-retrieved from the local vector index)",
      "Recalled by semantic similarity, not chosen by the user. Treat them as leads only:",
      "quote or edit one only after reading it with getNoteContent — never assume the rest.",
      ...lines,
    ].join("\n");
  } catch {
    // 语义模型未下载 / 索引未建 / Rust 侧忙：全部静默跳过
    return "";
  }
};

/* ---------- 上下文瘦身（记忆管理） ---------- */

/** 结构化裁剪的深度上限：工具的返回值都是浅层 JSON，超过这个深度基本可以判定是脏数据 */
const SHRINK_MAX_DEPTH = 6;
/** 数组最多保留的条目数：搜索结果/列表类工具通常按相关度排序，前 20 条足够模型决策 */
const SHRINK_MAX_ITEMS = 20;

/**
 * 递归裁剪工具结果：长字符串按字符截断、数组保留前若干项并标注剩余数量、对象保留全部键名。
 *
 * 为什么不直接 slice 文本：硬切会把 JSON 切成半截（`{"id":12,"tit` ），模型读到残协议后
 * 要么解析失败、要么误判成"工具坏了"再重试一次，等于一次调用付两遍钱。
 * 结构化裁剪之后仍然是合法 JSON，模型能看懂"哪部分被省略了、怎么拿到细节"。
 */
const shrinkStructure = (value: unknown, budget: number, depth = 0): unknown => {
  if (typeof value === "string") {
    // 单个字段最多占预算的一半：避免一段正文把同级的 id / title 全挤掉
    const cap = Math.max(80, Math.floor(budget * 0.5));
    return value.length > cap
      ? `${value.slice(0, cap)}…(this field was truncated; read the rest by range if needed)`
      : value;
  }
  if (typeof value !== "object" || value === null) return value;
  if (depth >= SHRINK_MAX_DEPTH) return "(nested too deep, omitted)";
  if (Array.isArray(value)) {
    const kept = value.slice(0, SHRINK_MAX_ITEMS).map((item) => shrinkStructure(item, budget, depth + 1));
    if (value.length > SHRINK_MAX_ITEMS) {
      kept.push(`… ${value.length - SHRINK_MAX_ITEMS} more items omitted; narrow the query to see them`);
    }
    return kept;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = shrinkStructure(item, budget, depth + 1);
  }
  return out;
};

/**
 * 工具结果进上下文前的瘦身。
 * getNoteContent 会把整篇笔记原样回传，一次就是几千 token；多轮工具调用下来，
 * 上下文增长的主要来源就是这些回传。这里做结构化裁剪并明确告诉模型
 * "需要细节请按范围读"，而不是把 JSON 切成无法解析的半截。
 */
const compactToolResult = (result: unknown, max = TOOL_RESULT_MAX_CHARS): string => {
  let text: string;
  try { text = JSON.stringify(result ?? null); } catch { text = ""; }
  if (!text) return "";
  if (text.length <= max) return text;
  // 逐级收紧预算，直到落在上限内；结构化裁剪本身就能覆盖绝大多数工具返回值
  let budget = max;
  for (let attempt = 0; attempt < 3; attempt++) {
    let shrunk = "";
    try { shrunk = JSON.stringify(shrinkStructure(result, budget)); } catch { shrunk = ""; }
    if (shrunk && shrunk.length <= max) return shrunk;
    budget = Math.floor(budget / 2);
  }
  // 极端情况（成千上万个键）：宁可给一句合法的提示，也不塞半截 JSON
  return JSON.stringify({
    truncated: true,
    note: "This result is too large and was omitted. Retry with narrower arguments (smaller line range, shorter keyword, lower limit).",
  });
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



/**
 * 把输入框滚到光标所在的位置。
 *
 * 为什么需要手动做：`.composer-input` 的滚动条本来由 contenteditable 自己管，
 * 但我们在外面用 JS 改它的 `height`（自动长高）——每次重设高度都会让元素重排，
 * 浏览器随即把 `scrollTop` 归零。于是出现"内容明明换行了、光标已经跑到底部，
 * 视口却还停在第一行"的现象：滚动条位置不再跟着光标走。
 *
 * 这里按 caret 的实际矩形把滚动位置补回来；caret 落在行尾换行符之后拿不到矩形时，
 * 直接贴底（这是 Shift+Enter 最常见的情形）。
 */
const revealComposerCaret = (el: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  if (!el.contains(range.startContainer)) return;
  const caret = range.cloneRange();
  caret.collapse(true);
  const rect = caret.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    el.scrollTop = el.scrollHeight;
    return;
  }
  const pad = 8;
  if (rect.bottom > box.bottom - pad) {
    el.scrollTop += rect.bottom - (box.bottom - pad);
  } else if (rect.top < box.top + pad) {
    el.scrollTop -= box.top + pad - rect.top;
  }
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
export const AIChatPanel: React.FC<AIChatPanelProps> = ({ isOpen, noteTitle, noteContent, currentNoteId, categories = [], currentNoteAiLevel = 2, onInsertText, onReplaceContent, onOpenInEditor, onOpenProviderSettings, onOpenAiMemory, aiPrompts, aiSettings, onAiSettingsChange, editorSettings, onClose, enableAI, isExternalFile, pendingNoteRef }) => {
  const { t } = useI18n();
  const [providers, setProviders] = useState<AiProvider[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<number>(0);
  const [sessions, setSessions] = useState<AiChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<number>(0);
  /** 读取服务商失败时的错误文案（用于界面提示，便于定位问题） */
  const [providersError, setProvidersError] = useState("");
  const [messages, setMessages] = useState<UiChatMessage[]>([]);
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
  const inputRef = useRef<ChatComposerHandle>(null);
  /** 模型下拉菜单的 DOM 引用：用于点击外部时关闭 */
  const modelMenuRef = useRef<HTMLDivElement>(null);
  /** 已经生成过标题的会话 ID；用 ref 记住具体会话，避免"新对话"标题反复生成 */
  const titleGenRef = useRef<number | null>(null);
  /** 已请求停止：agentLoop 在各检查点据此提前返回，不再改 UI */
  const abortRef = useRef(false);
  /**
   * 当前在飞请求的取消控制器。
   * 点"停止"时必须经它通知 Rust 真正断流：只置 abortRef 的话前端只是不再渲染，
   * 后端的流会继续跑到模型说完，token 照样计费。
   */
  const roundAbortRef = useRef<AbortController | null>(null);
  /** 本会话累计用量（拿不到服务商 usage 时不累加，界面上就是 0） */
  const usageRef = useRef({ prompt: 0, completion: 0, cached: 0 });
  const [usageTotals, setUsageTotals] = useState({ prompt: 0, completion: 0, cached: 0 });
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
  const placeholderRef = useRef<UiChatMessage | null>(null);
  /** 当前打开笔记的 ID（组件内持有，工具执行时作为上下文传入） */
  const currentNoteIdRef = useRef<string | null>(null);
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
  /**
   * 辅助任务（上下文摘要、会话标题）用的服务商：设置里指定了就用自己的，否则跟随主服务商。
   * 这类任务对模型能力要求低，指一个小模型能省掉相当一部分开销。
   */
  const helperProviderId = aiSettings.helperProviderId > 0 ? aiSettings.helperProviderId : activeProvider?.id ?? 0;
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
    return onAppEvent('fastnote-providers-changed', () => { loadProviders(); });
  }, []);
  // 在设置弹窗里切换了服务商：同步为本面板的当前选择
  useEffect(() => {
    return onAppEvent('fastnote-provider-selected', ({ providerId }) => {
      if (providerId) {
        setSelectedProviderId(providerId);
      }
    });
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
  const commitNotice = useCallback(async (sid: number, uiNotice: UiNotice, leftover: UiChatMessage | null) => {
    // 全局 t 在异步请求结束时读取当前语言；渲染时仍通过 uiNotice 订阅切换。
    const text = renderUiNotice(uiNotice, leftover?.tools, translate);
    const usedMs = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;
    setMessages(m => {
      const msg: UiChatMessage = { role: 'assistant', content: text, uiNotice, thinking: leftover?.thinking, tools: leftover?.tools, at: leftover?.at ?? Date.now(), thinkMs: usedMs || undefined };
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

  /**
   * 累计本轮请求的 token 用量。
   * 数据来自服务商返回的 usage（OpenAI 需要 stream_options、Gemini 在 usageMetadata、
   * Claude 在 message_start/message_delta）。拿不到时字段为 0，不参与累加，
   * 界面显示的就是"未知"——不要用本地估算冒充真实计费。
   */
  const recordUsage = useCallback((usage?: { prompt_tokens?: number; completion_tokens?: number; cached_tokens?: number }) => {
    if (!usage) return;
    const prompt = usage.prompt_tokens || 0;
    const completion = usage.completion_tokens || 0;
    if (!prompt && !completion) return;
    usageRef.current = {
      prompt: usageRef.current.prompt + prompt,
      completion: usageRef.current.completion + completion,
      cached: usageRef.current.cached + (usage.cached_tokens || 0),
    };
    setUsageTotals({ ...usageRef.current });
  }, []);

  useEffect(() => () => {
    if (streamTimerRef.current !== null) window.clearTimeout(streamTimerRef.current);
  }, []);

  /**
   * 消息区被挤矮时补一次贴底。
   * 输入框长高（自动长高 / 拖上边缘）会让视口变矮，而 scrollTop 仍停在原值，
   * 表现就是底部几条消息被输入框吞掉。跟随模式下必须重新滚到底。
   */
  const pinScrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
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
   * 视口本身变矮（拖动输入框、窗口缩放）也要贴底：
   * 内容尺寸没变时上面的观察器不会触发，这里补一个只看容器尺寸的。
   */
  useEffect(() => {
    if (!isOpen) return;
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => pinScrollToBottom());
    ro.observe(el);
    return () => ro.disconnect();
  }, [isOpen, pinScrollToBottom]);

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
      // 用量也是按会话累计的：切会话必须归零，否则显示的是上一段对话的消耗
      usageRef.current = { prompt: 0, completion: 0, cached: 0 };
      setUsageTotals({ prompt: 0, completion: 0, cached: 0 });
      setMessages(m.map(x => {
        const p = x.role === "assistant" ? parseResponse(x.content) : null;
        // 历史消息用数据库里的真实时间（created_at 是 RFC3339）
        const at = Date.parse(x.created_at);
        return {
          role: x.role as "user" | "assistant",
          content: p ? finalReplyText(p, translate) : x.content,
          thinking: p?.thinkingDisplay,
          at: Number.isNaN(at) ? undefined : at,
        };
      }));
    } catch {}
  };
  const ensureSession = async (): Promise<number> => { if (activeSessionId) return activeSessionId; const s = await aiApi.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); return s.id; };
  const switchSession = async (sid: number) => { if (sid === activeSessionId) return; settleConfirm(false); draftsRef.current[activeSessionId] = input; setActiveSessionId(sid); setInput(draftsRef.current[sid] || ''); resetStreaming(); setTurnActive(false); await loadSessionMessages(sid); const s = sessions.find(x => x.id === sid); if (s) setSelectedProviderId(s.provider_id); };
  const handleNewSession = async () => { settleConfirm(false); draftsRef.current[activeSessionId] = input; const s = await aiApi.createChatSession("新对话", selectedProviderId, activeModel); setSessions(p => [s, ...p]); setActiveSessionId(s.id); setMessages([]); setInput(''); resetStreaming(); resetToLatest(); setTurnActive(false); setGroupOpen({}); setThoughtOpen({}); setExpandedTools({}); titleGenRef.current = null; usageRef.current = { prompt: 0, completion: 0, cached: 0 }; setUsageTotals({ prompt: 0, completion: 0, cached: 0 }); };
  /**
   * 自动生成对话标题，只对仍叫"新对话"的会话生效。
   * titleGenRef 记住已生成过的会话 ID，保证每个会话只请求一次标题模型；
   * 生成前重新拉取会话列表核对标题，避免覆盖用户手动改过的名字。
   * 输入先去标签并截断到 300 字，防止 <thinking> 推理或工具 JSON 混进标题。
   */
  const genTitle = async (sid: number, up: string, ar: string) => {
    // 辅助任务可以走单独指定的小模型：标题/摘要这类活儿用主模型纯属浪费
    if (titleGenRef.current === sid || !helperProviderId) return;
    titleGenRef.current = sid;
    try {
      const list = await aiApi.getChatSessions();
      const session = list.find(s => s.id === sid);
      if (!session || session.title !== "新对话") return;
      // 送进去的内容也要先去标签：否则整段 <thinking> 推理会被当成"对话内容"喂给标题模型；
      // 引用块是 JSON 包装，先剥掉，只留用户自己打的字（纯引用时给一句占位）
      const userText = (stripNoteRefs(stripAiTags(up)).replace(/<[^>]+>/g, "").trim() || translate("引用了笔记片段")).slice(0, 300);
      const assistantText = stripAiTags(ar).replace(/<[^>]+>/g, "").trim().slice(0, 300);
      const t = await aiApi.sendAiChat(
        helperProviderId,
        [{ role: "system", content: buildTitlePrompt(userText, assistantText) }, { role: "user", content: TITLE_USER_MESSAGE }],
        "",
        "",
        256,
        aiSettings.helperModel.trim() || undefined,
      );
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
  const handleRenameSession = async (sid: number) => { const title = editTitle.trim(); if (!title) return; try { await aiApi.updateChatSessionTitle(sid, title); setEditingSessionId(null); setEditTitle(''); await loadSessions(); } catch { showToast(translate('重命名失败'), 'error'); } };
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
    /** 系统提示词 = 插件前置片段 + 工具协议（含插件工具）+ 深度思考要求 + 用户自定义的前置提示词/记忆 + 插件追加片段（每次请求都带上） */
    const memoryBlock = buildMemoryBlock(aiPrompts);
    // 访问受限时补一段说明：模型才知道"搜不到"是设置导致的，不会反复换关键词重试
    const accessBlock = !aiSettings.aiAccessEnabled
      ? AI_ACCESS_DENIED_PROMPT
      : [accessRestricted ? AI_ACCESS_RESTRICTED_PROMPT : "", currentLevel === 1 ? AI_READ_ONLY_PROMPT : ""]
          .filter(Boolean)
          .join("\n\n");
    // 每次发消息都实时取注册表：插件启停后工具清单与提示词片段立即反映，不缓存静态值
    const pluginToolsBlock = buildPluginToolsBlock(
      pluginContributions.aiTools().map((t) => ({ name: t.id, desc: t.description, args: t.args })),
    );
    const pluginPrompts = pluginContributions.aiPrompts();
    const pluginPrependBlock = pluginPrompts
      .filter((p) => p.position === "prepend")
      .map((p) => p.text)
      .join("\n\n");
    const pluginAppendBlock = pluginPrompts
      .filter((p) => p.position !== "prepend")
      .map((p) => p.text)
      .join("\n\n");
    /** 当前笔记能否作为上下文：手动关闭附带、笔记受限、总开关关闭，任一情况都不发 */
    const canAttachNote = attachNote && currentLevel > 0;
    /*
     * 自动召回：发请求前先用本地向量库找"可能相关的旧笔记"。
     * 走本机 ONNX（bge 小模型），不花钱不出网；模型没下载/索引没建时返回空串，不影响对话。
     */
    const recallBlock = await buildSemanticRecall(prompt, accessRef.current, {
      enabled: aiSettings.semanticRecall,
      excludeNoteId: currentLevel === 0 ? null : currentNoteId ?? null,
    });
    /* ---------- 系统提示词：稳定段 / 动态段 ----------
     * 拆成两段是为了让服务商的前缀缓存真正生效（OpenAI/DeepSeek 自动、Claude 显式
     * cache_control、Gemini 隐式）。稳定段只有常量，任何一轮、任何对话都完全相同；
     * 动态段接在它后面，即使每轮变化也不影响前缀命中。
     * 过去笔记正文、记忆、访问限制全混在 system 里，前缀每轮都变 → 缓存一次都打不中，
     * 多轮工具调用等于把同一段提示词按原价买 N 遍。
     */
    const stablePrompt = [pluginPrependBlock, buildStableSystemPrompt(aiSettings.minThinkingLen)]
      .filter(Boolean)
      .join("\n\n");
    /** 当前笔记上下文：短笔记内联全文，长笔记只给规模和首段预览，细节交给 readNoteLines */
    const noteContext = (() => {
      if (!canAttachNote) {
        return "## Current context\n- The body of the currently open note is NOT shared with you (either the user turned off \"attach note\" or this note is not shared with AI). Do not guess its content.";
      }
      const body = noteContent || "";
      const totalLines = body ? body.split("\n").length : 0;
      const idLine = currentLevel === 0
        ? "- No note ID is shared"
        : currentNoteId
          ? `- ID of the currently open note: ${currentNoteId} (when the user says "this note / the current note / it", this is the ID they mean)`
          : "- No note is currently open (if the user refers to \"this note\", first point out which one)";
      const head = `## Current context\n${idLine}\n- Current note title: ${noteTitle || "(untitled)"}`;
      if (!body.trim()) return `${head}\n- Current note content: (empty)`;
      // 内联预算：超过这个规模就不再整篇塞进 system。整篇每次请求都要重算输入 token，
      // 而模型真正需要的往往只是一两段——让它用工具按行读，既省钱也更准。
      const inlineBudget = 2500;
      if (estimateTokens(body) <= inlineBudget) {
        return `${head}\n- Total lines: ${totalLines}\n\nCurrent note content:\n${body}`;
      }
      const preview = body.split("\n").slice(0, 30).join("\n");
      return [
        head,
        `- Total lines: ${totalLines} (about ${estimateTokens(body)} tokens — too long to inline in full)`,
        "- Only the first 30 lines are shown below. Read other parts with getCurrentNote / readNoteLines / findInNote; never assume the rest.",
        "",
        "Current note content (first 30 lines):",
        preview,
      ].join("\n");
    })();
    const dynamicPrompt = [
      noteContext,
      // 自动召回：本地向量比对的"可能相关旧笔记"，让模型不必先跑一轮 searchNotes 试探
      recallBlock,
      pluginToolsBlock,
      accessBlock,
      memoryBlock,
      pluginAppendBlock,
    ].filter(Boolean).join("\n\n");
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
      if (needsSummary && helperProviderId) {
        try {
          const text = await aiApi.sendAiChat(
            helperProviderId,
            [
              { role: "system", content: CONTEXT_SUMMARY_PROMPT },
              { role: "user", content: buildSummaryUserMessage(summary, compressTranscript(dropped)) },
            ],
            // noteTitle / noteContent 都传空：摘要是纯文本压缩，不该把当前笔记或模型名
            // 当作上下文塞进去（模型由 helperModel / provider 的 enabled_model 决定）
            "",
            "",
            // 摘要产物只有 400 字，256~1024 的输出上限足够，没必要按主对话的 8192 来
            1024,
            aiSettings.helperModel.trim() || undefined,
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
      // 每轮一个控制器：点停止只断当前这一轮（历史轮次早已结束）
      const roundAbort = new AbortController();
      roundAbortRef.current = roundAbort;
      let nativeReasoning = '';
      try {
        // 设置里关掉流式时走一次性请求：个别服务商的流式不稳定，这时界面先显示"思考中"，
        // 拿到完整结果再一次性呈现（解析与后续流程完全一致）。
        let full: string;
        if (aiSettings.streaming) {
          /*
           * 增量累积：Rust 现在只推 delta（过去每个 chunk 都发完整累计文本，
           * 长回复的总传输量是平方级）。这里自己拼，并保留"停下来就不再渲染"的判断。
           * 最终内容以返回值 result.content 为准：事件是异步投递的，
           * 最后几个 chunk 可能在 invoke resolve 之后才到。
           */
          let streamed = '';
          const result = await aiApi.sendAiChatStream(
            {
              providerId: activeProvider!.id,
              messages: roundMsgs,
              // 稳定段（常量）与动态段（笔记上下文/记忆/访问限制）分开传，前缀缓存才能命中
              systemStable: stablePrompt,
              systemDynamic: dynamicPrompt,
              // 笔记已经在 systemDynamic 里按规模分级注入过了，这里不再重复传
              noteTitle: '',
              noteContent: '',
              // 受限笔记连 ID 都不告诉模型：否则它会以为"当前笔记可用"，反复调用后再失败。
              // 用户只是手动取消「附笔记」时不在此列——那时内容仍可通过工具读取。
              currentNoteId: currentLevel === 0 ? null : currentNoteId ?? null,
              maxTokens: aiSettings.maxTokens,
              signal: roundAbort.signal,
            },
            (deltaText, deltaReasoning) => {
              if (deltaText) {
                streamed += deltaText;
                if (!isStale()) pushStreamContent(streamed, roundGen);
              }
              if (deltaReasoning) nativeReasoning += deltaReasoning;
            },
          );
          if (result.reasoning) nativeReasoning = result.reasoning;
          recordUsage(result.usage);
          full = result.content;
        } else {
          full = await aiApi.sendAiChat(
            activeProvider!.id,
            [{ role: 'system', content: `${stablePrompt}\n\n${dynamicPrompt}` }, ...roundMsgs],
            '',
            '',
            aiSettings.maxTokens,
          );
        }
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
          const finalReply = finalReplyText(parsed, translate);
          // 先把占位对象抓成局部变量、并清空 ref，再调用 setMessages：
          // updater 必须是纯函数——StrictMode 在开发模式下会执行两次，
          // 若在里面改 ref，第二次就会找不到占位而"追加"出一条重复消息。
          const placeholderAtFinal = placeholderRef.current;
          placeholderRef.current = null;
          // 工具调用之前已经写给用户的正文（如"先总结剧情，再打开下一篇"里的总结）要保留；
          // 并对"声称已完成却没执行"做事实校验（见 buildFinalContent）。
          const carriedTools = placeholderAtFinal?.tools as ToolTrace[] | undefined;
          const finalContent = buildFinalContent(finalReply, String(placeholderAtFinal?.content || ''), carriedTools || [], translate);
          // 时间沿用占位气泡（这一轮开始的时间），没有占位就用此刻
          const finalAt: number = placeholderAtFinal?.at ?? Date.now();
          // 本轮总用时：从按下发送到出结果（含工具执行），显示在消息时间旁边
          const usedMs = turnStartedAtRef.current ? Date.now() - turnStartedAtRef.current : 0;
          setMessages(m => {
            const msg = { role: 'assistant' as const, content: finalContent, thinking: thinkingDisplay, tools: carriedTools, at: finalAt, thinkMs: usedMs || undefined };
            const idx = placeholderAtFinal ? m.findIndex(x => x === placeholderAtFinal) : -1;
            if (idx >= 0) return [...m.slice(0, idx), msg];
            // 兜底：末尾若残留了"内容为空但有思考"的空壳助手消息，直接替换掉，
            // 否则它会和最终回复各带一份深度思考，看起来又是重复。
            const last = m[m.length - 1] as { role?: string; content?: string } | undefined;
            if (last && last.role === 'assistant' && !last.content) {
              return [...m.slice(0, -1), msg];
            }
            return [...m, msg];
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
          const nextPlaceholder: UiChatMessage = {
            ...existingPlaceholder,
            // 本轮若同时给了正文（例如"先总结剧情，再打开下一篇"），要留在气泡里，
            // 否则下一轮把它替换掉时，这段正文就凭空消失了。
            content: roundReply || existingPlaceholder.content || '',
            thinking: thinkingDisplay,
          };
          placeholderRef.current = nextPlaceholder;
          setMessages(m => m.map(x => (x === existingPlaceholder ? nextPlaceholder : x)));
        } else {
          const createdPlaceholder: UiChatMessage = { role: 'assistant', content: roundReply, thinking: thinkingDisplay, at: Date.now() };
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
        // 合并插件 AI 工具到内置清单：插件工具一律只读，needsConfirm=false
        const pluginTools = pluginContributions.aiTools();
        const effectiveDefs = TOOL_DEFS.concat(
          pluginTools.map((t) => ({ name: t.id, desc: t.desc, args: t.args, needsConfirm: false })),
        );
        const effectiveExecutors: Record<string, (args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>> = {
          ...(TOOL_EXECUTORS as Record<string, (args: Record<string, unknown>, ...rest: unknown[]) => Promise<unknown>>),
        };
        for (const pt of pluginTools) {
          effectiveExecutors[pt.id] = async (args) => {
            // 插件 AI tool 只读 ctx：只有 notes.getContent
            return pt.handler(args, {
              notes: {
                getContent: async (id: string) => (await getNote(id)).content,
              },
            });
          };
        }
        // 按 TOOL_DEFS.needsConfirm 分成"只读"与"需确认"两组
        const readOnly = freshCalls.filter(tc => !effectiveDefs.find(td => td.name === tc.name)?.needsConfirm);
        const destructive = freshCalls.filter(tc => effectiveDefs.find(td => td.name === tc.name)?.needsConfirm);
        // 执行单条工具并记录轨迹：异常统一转成失败结果，一条报错不打断整轮
        let results: ToolResult[] = [];
        const runTool = async (tc: { name: string; args: Record<string, unknown> }) => {
          appendToolTrace(tc);
          let result: unknown;
          let success = true;
          try {
            const access = accessRef.current;
            const exec = effectiveExecutors[tc.name];
            const hasExec = typeof exec === "function";
            // 总开关关闭时所有笔记工具一律不执行：不光是"看不到"，写操作也不能穿透
            result = access.enabled && hasExec
              ? await exec!(tc.args, {
                  currentNoteId: currentNoteIdRef.current,
                  access,
                  defaultNoteAiAccess: defaultAccessRef.current.note,
                  defaultCategoryAiAccess: defaultAccessRef.current.category,
                })
              : hasExec ? { error: AI_ACCESS_DISABLED_NOTE } : { error: `未知工具：${tc.name}` };
            if (!access.enabled || !hasExec) success = false;
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
          try { emitAppEvent('fastnote-data-changed'); await loadSessions(); } catch {}
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
        const leftover = placeholderRef.current;
        placeholderRef.current = null;
        await commitNotice(sid, { kind: "failure", error: e == null ? undefined : formatError(e) }, leftover);
        return;
      }
    }

    // ---------- 循环结束仍未产出最终回复（多半是轮数用完） ----------
    // 必须留下可见结论，否则工具跑了一堆、界面却没有一句话，用户不知道是否结束。
    setIsSending(false);
    setTurnActive(false);
    resetStreaming();
    const leftover = placeholderRef.current;
    placeholderRef.current = null;
    // 这份清单同时是给模型看的上下文：工具调用记录只存在于界面，不在对话历史里，
    // 写进正文用户下次说"继续"时模型才知道自己刚做了什么。
    const notice: UiNotice = { kind: leftover?.tools?.length
      ? (noProgressRounds >= 2 ? "no-progress" : "limit")
      : "empty" };
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
      .replace(/^(?:【|\[)(.+?)(?:】|\])$/, "$1")         // 整体被括号包裹
      .replace(/[。：:，,、；;！!？?~～·]+$/, "")         // 结尾标点
      .trim();

    const title = cleaned.length > 20 ? `${cleaned.slice(0, 20)}…` : cleaned;
    openInEditorRef.current(title || t("AI 回复 {time}", { time: stamp }), content);
  }, [t]);
  const copyTextStable = useCallback((text: string) => {
    navigator.clipboard.writeText(text).then(
      () => showToast(t("已复制"), "success"),
      () => showToast(t("复制失败"), "error")
    );
  }, [showToast, t]);

  /**
   * 工具执行是逐个进行的，这里把"正在执行"的一条轨迹立刻追加到当前助手气泡上，
   * 执行完再回填状态与结果——界面上就能看到 打开笔记 #16 ▸ 读取笔记 #16 ▸ … 依次出现。
   */
  const appendToolTrace = useCallback((call: { name: string; args: Record<string, unknown> }) => {
    const target = placeholderRef.current;
    if (!target) return;
    const traced: UiChatMessage = {
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
    const target = placeholderRef.current;
    if (!target?.tools?.length) return;
    const tools = [...target.tools];
    tools[tools.length - 1] = {
      ...tools[tools.length - 1],
      ok: done.success,
      result: done.result,
      detail: toolDetail(done.name, done.args, done.result),
    };
    const traced: UiChatMessage = { ...target, tools };
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
    const el = inputRef.current?.element;
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
      pinScrollToBottom();
      return;
    }
    // 必须在改 height 之前读：置成 auto 的那一刻 scrollTop 就已经被浏览器清零了
    const prevScrollTop = el.scrollTop;
    el.style.height = "auto";
    const contentH = el.scrollHeight;
    const autoMax = Math.max(44, Math.min(320, Math.round(areaH * 0.45)));
    const nextH = Math.min(Math.max(contentH, 44), autoMax);
    el.style.height = `${nextH}px`;
    /*
     * 上面把 height 设成 auto 的一瞬间，元素展开到完整高度，浏览器的 scrollTop 就被归零了；
     * 再压回 nextH 之后它仍然停在 0——这就是"换行后画面还在第一行、光标在底部"的直接原因。
     * 所以先还原滚动位置，再把光标行滚进视野（内容没溢出时没有滚动可言）。
     */
    if (contentH > nextH) {
      // 用实际可滚动距离夹紧：height 是 border-box，scrollHeight 与 clientHeight 的差
      // 才是真正的上限，直接拿 contentH - nextH 会少算 padding 那一截
      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      el.scrollTop = Math.min(prevScrollTop, maxScroll);
      revealComposerCaret(el);
    } else {
      el.scrollTop = 0;
    }
    pinScrollToBottom();
  }, [input, aiSettings.composerHeight, activeSessionId, isOpen, pinScrollToBottom]);

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

  /**
   * 选区工具条投递的引用块：追加到草稿末尾，不发送。
   * 润色/翻译/总结会再跟一句指令；块与指令一起放进同一条消息。
   */
  const injectedRefRef = useRef(0);
  useEffect(() => {
    if (!isOpen || !pendingNoteRef || pendingNoteRef.id === injectedRefRef.current) return;
    injectedRefRef.current = pendingNoteRef.id;
    inputRef.current?.insertRef(pendingNoteRef.ref);
    if (pendingNoteRef.prompt) inputRef.current?.insertText(pendingNoteRef.prompt);
    inputRef.current?.focus();
  }, [isOpen, pendingNoteRef]);

  /** 发送入口：加同步锁并递增 runId，落用户消息后交给 agentLoop；解锁前须确认自己仍是最新一轮 */
  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt) return;
    // 同步锁：isSending 是 state，要等下一次渲染才生效；连按两次回车（中文输入法提交候选词
    // 的 Enter 尤其容易触发）会在它生效之前把同一条消息发两遍，AI 也就回答两遍。
    if (sendLockRef.current || isSendingRef.current) {
      // 正常流式输出时按钮是"停止"，不会走到这里；能走到这里说明是异常态
      // （例如上一轮卡在等待确认）——必须明确告诉用户，否则就是"点了发送没反应"。
      if (!isSendingRef.current) showToast(t("上一条请求还没结束（可能在等待确认），本次发送已忽略"), "error");
      return;
    }
    if (!activeProvider?.id || !activeModel) { showToast(t("请先在设置中勾选可用模型"), "error"); return; }
    const myRun = ++runIdRef.current;
    turnStartedAtRef.current = Date.now();
    // 只记「谁 + 多长」，不记提问内容：日志可能被用户发出来，正文不该出现在里面
    logAction("ai.send", `${activeProvider?.name ?? ""}/${activeModel} · ${prompt.length} chars`, {
      throttleMs: 0,
    });
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
      try { emitAppEvent('fastnote-data-changed'); } catch {}
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
    logAction("ai.stop", undefined, { throttleMs: 0 });
    abortRef.current = true;
    // 真正断开后端的流：不 abort 的话 Rust 会一直读到模型说完，token 照常计费
    roundAbortRef.current?.abort();
    roundAbortRef.current = null;
    // 停止 = 立即作废当前轮次并解锁：正在飞的那次流式请求可能还要一会儿才返回，
    // 不能让它卡住下一次发送（否则就会出现"上一条请求还没结束，本次发送已忽略"）。
    runIdRef.current += 1;
    sendLockRef.current = false;
    isSendingRef.current = false;
    // 若正卡在"等待确认"，把它按取消结算，agentLoop 才能立刻退出
    settleConfirm(false);
    // 中断时把"空壳占位气泡"就地替换成"已停止"，避免它带着一份思考留在对话里
    const placeholder = placeholderRef.current;
    placeholderRef.current = null;
    setMessages(m => {
      const stopped = {
        role: 'assistant' as const,
        content: renderUiNotice({ kind: "stopped", prefix: placeholder?.content }, undefined, t),
        uiNotice: { kind: "stopped", prefix: placeholder?.content } as UiNotice,
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
    if (activeSessionId) aiApi.saveChatMessage(activeSessionId, 'assistant', t('已停止')).catch(()=>{});
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

  const handleComposerResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const el = inputRef.current?.element;
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
      // 同步补贴底：等 ResizeObserver 回调会晚一帧，拖动时能看见底部内容被裁一下
      pinScrollToBottom();
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
  };

  const handleSelectModel = (m: string) => {
    setModelMenuOpen(false);
    if (!activeProvider) return;
    const u = { ...activeProvider, enabled_model: m };
    aiApi.updateAiProvider(u).then(() => setProviders(p => p.map(x => x.id === u.id ? u : x)));
  };

  const handleDeleteSession = async (s: AiChatSession) => {
    try {
      await aiApi.deleteChatSession(s.id);
      setSessions(p => p.filter(x => x.id !== s.id));
      if (activeSessionId === s.id) {
        const rest = sessions.filter(x => x.id !== s.id);
        if (rest.length > 0) { setActiveSessionId(rest[0].id); titleGenRef.current = null; await loadSessionMessages(rest[0].id); }
        else { setActiveSessionId(0); setMessages([]); }
      }
    } catch { showToast(translate("删除失败"), "error"); }
  };

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
  const lastMsg = messages[messages.length - 1];
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
  const allMsgs: UiChatMessage[] = streamingPreview
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
            : t('（空消息）'),
        });
      }
      return acc;
    }, []),
    [messages, t]
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
      ? sessions.filter(s => (!s.title || s.title === "新对话" ? t("新对话") : s.title).toLowerCase().includes(sessionQueryValue))
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

  /** 字数按可见文本算：引用块的 JSON 包装只是协议开销，不计入 */
  const inputLength = expandRefs(input).length;

  if (!isOpen) return null;

  return (<>
    <aside
      ref={panelRef}
      className="ai-panel relative flex-shrink-0 border-l border-line/80 bg-surface flex flex-col h-full"
      style={{ width: effectivePanelWidth }}
    >
      <div className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-primary-200/50 active:bg-primary-300/50 transition-colors z-10" onMouseDown={onResize}/>
      <ChatHeader
        sessionTitle={activeSession?.title}
        hasProvider={!!activeProvider}
        providerName={activeProvider?.name}
        activeModel={activeModel}
        providersError={providersError}
        usage={usageTotals}
        onOpenSessionPicker={() => { setShowSessionPicker(true); setEditingSessionId(null); setEditTitle(''); setSessionQuery(''); }}
        onNewSession={handleNewSession}
        onOpenAiMemory={onOpenAiMemory}
        onOpenProviderSettings={onOpenProviderSettings}
        onClose={onClose}
      />
      {/* 消息视口：右侧锚点导轨与"回到最新"按钮都相对这一层定位，因此不会跟着内容滚动 */}
      <MessageList
        messagesAreaRef={messagesAreaRef}
        scrollRef={scrollRef}
        scrollContentRef={scrollContentRef}
        onScroll={handleChatScroll}
        onReleaseJumpTarget={releaseJumpTarget}
        hasProvider={!!activeProvider}
        enableAI={enableAI}
        isExternalFile={isExternalFile}
        activeModel={activeModel}
        onOpenProviderSettings={onOpenProviderSettings}
        onPickSuggestion={(source) => { setInput(source); inputRef.current?.focus(); }}
        allMsgs={allMsgs}
        groupOpen={groupOpen}
        thoughtOpen={thoughtOpen}
        toolOpenByRow={toolOpenByRow}
        liveRowIndex={liveRowIndex}
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
        streamingReply={streamingPreview?.reply}
        elapsedSec={elapsedSec}
        userAnchors={userAnchors}
        visibleAnchors={visibleAnchors}
        activeDotIndex={activeDotIndex}
        railGap={railGap}
        onJump={jumpToAnchor}
        onHover={showAnchorTip}
        onLeave={hideAnchorTip}
        anchorTip={anchorTip}
        atBottom={atBottom}
        onJumpLatest={jumpToLatest}
      />

      {/* ---------- 输入区（Composer） ----------
          圆角卡片包住输入框与底部操作条：聚焦时整卡描边，输入变多自动长高，
          到达上限后内部滚动，上边缘可拖动调整高度。 */}
      <ChatInput
        pendingConfirm={pendingConfirm ? { call: pendingConfirm.call, index: pendingConfirm.index, total: pendingConfirm.total } : null}
        confirmSummary={pendingConfirm ? summarizeToolCall(pendingConfirm.call, t) : ""}
        onConfirmRun={() => settleConfirm(true)}
        onConfirmCancel={() => settleConfirm(false)}
        composerDragging={composerDragging}
        onComposerResizeMouseDown={handleComposerResizeMouseDown}
        onComposerResizeDoubleClick={() => onAiSettingsChange?.({ composerHeight: 0 })}
        modelMenuOpen={modelMenuOpen}
        modelMenuPos={modelMenuPos}
        modelMenuRef={modelMenuRef}
        models={models}
        activeModel={activeModel}
        hasProvider={!!activeProvider}
        onSelectModel={handleSelectModel}
        onCloseModelMenu={() => setModelMenuOpen(false)}
        onOpenProviderSettings={onOpenProviderSettings}
        modelChipRef={modelChipRef}
        onToggleModelMenu={() => {
          if (modelChipRef.current) {
            const r = modelChipRef.current.getBoundingClientRect();
            setModelMenuPos({ bottom: window.innerHeight - r.top+5, left: r.left-13 , width: r.width });
          }
          setModelMenuOpen(v => !v);
        }}
        input={input}
        onInputChange={setInput}
        onSend={() => { void handleSend(); }}
        onStop={handleStop}
        isSending={isSending}
        canRecall={!input && sentHistoryRef.current.length > 0}
        onRecall={() => setInput(sentHistoryRef.current[sentHistoryRef.current.length - 1])}
        placeholder={t("输入消息…（Enter 发送 / Shift+Enter 换行）")}
        compact={compact}
        showCount={showCount}
        inputLength={inputLength}
        confirmMode={confirmMode}
        onToggleConfirmMode={() => setConfirmMode(!confirmMode)}
        attachNote={attachNote}
        onToggleAttachNote={() => setAttachNote(v => !v)}
        noteContent={noteContent}
        noteTitle={noteTitle}
        currentLevel={currentLevel}
        aiAccessEnabled={aiSettings.aiAccessEnabled}
        messagesCount={messages.length}
        onClear={() => { setMessages([]); resetStreaming(); resetToLatest(); }}
        inputRef={inputRef}
      />
    </aside>
    {showSessionPicker && (
      <SessionPicker
        sessions={sessions}
        activeSessionId={activeSessionId}
        editingSessionId={editingSessionId}
        editTitle={editTitle}
        sessionQuery={sessionQuery}
        sessionGroups={sessionGroups}
        onClose={() => setShowSessionPicker(false)}
        onNewSession={() => { setShowSessionPicker(false); handleNewSession(); }}
        onQueryChange={setSessionQuery}
        onQueryEscape={() => setShowSessionPicker(false)}
        onSwitch={(sid) => { void switchSession(sid); setShowSessionPicker(false); }}
        onStartEdit={(s) => { setEditingSessionId(s.id); setEditTitle(s.title); }}
        onEditTitleChange={setEditTitle}
        onRename={(sid) => { void handleRenameSession(sid); }}
        onCancelEdit={() => { setEditingSessionId(null); setEditTitle(""); }}
        onDelete={(s) => { void handleDeleteSession(s); }}
      />
    )}
  </>);
};
