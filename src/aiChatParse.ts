/**
 * AI 对话「模型输出解析层」——纯函数，不依赖 React / Tauri / 业务 API。
 *
 * 这里集中了 <thinking> / <tool_calls> 协议的全部规则：
 * 标签剥离、思考与正文提取、工具调用的三种兜底形态、被截断的判定、
 * 事实校验文案、标题清洗、错误文案格式化。
 *
 * 之所以单独成模块：流式渲染与最终消息必须走同一套规则。
 * 以前两条路径各写一份，结果出现"流式显示的和最终落地的不一致"（闪烁、正文重复、工具被静默丢弃）。
 * 纯函数也便于直接用 Node 单测（见 tmp 脚本 / 后续可加正式测试）。
 */

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ParsedResponse {
  /** 纯推理内容：只用于"思考是否足够深入"的校验，不掺工具调用原文 */
  thinking: string;
  /** 思考区展示内容：推理 + 工具调用原文（工具调用只允许出现在这里） */
  thinkingDisplay: string;
  toolCalls: ToolCall[];
  reply: string;
  /** 生成被截断（<thinking>/<tool_calls> 只有开标签）或工具调用 JSON 非法 */
  truncated: boolean;
}

/** 一次工具执行的轨迹（挂在消息上，用于界面展示与事实校验） */
export interface ToolTrace {
  name: string;
  args?: Record<string, unknown>;
  /** null = 正在执行 */
  ok: boolean | null;
  detail?: string;
  result?: unknown;
}

/** thinking 是否达到"深度思考"的最低要求 */
export const isThinkingDeepEnough = (thinking: string, minLen: number): boolean =>
  thinking.replace(/\s/g, "").length >= minLen;

/**
 * 是否需要对这一轮做"思考太浅，重新思考"的纠正。
 *
 * 硬约束：**只有本轮正文没有显示给用户时才能重来**。
 * 曾经只看思考字数，于是模型第 1 轮直接给出的回答（例如"扩写"的结果）会被第 2 轮
 * 重来的思考顶掉——用户看到"回答一次 → 所有文字瞬间消失 → 又出一个回答"，
 * 而且两版内容还不一样。所以：
 *   - 正文已经显示过（replyShown）→ 不再重来，直接采纳；
 *   - 本轮有工具调用 → 不再重来（动作优先，别耽误执行）。
 * 正文被"按住"没显示过的那些轮（模型没写思考直接抢答）则可以重来，
 * 用户全程看不到被丢弃的那一版。
 */
export const shouldRetryForShallowThinking = (params: {
  correctionUsed: boolean;
  /** 本轮正文是否已经显示给用户 */
  replyShown: boolean;
  toolCallCount: number;
  thinking: string;
  minLen: number;
}): boolean =>
  !params.correctionUsed &&
  !params.replyShown &&
  params.toolCallCount === 0 &&
  !isThinkingDeepEnough(params.thinking, params.minLen);

/** 思考行折叠态显示的一行预览 */
export const firstLine = (text: string, max = 90): string => {
  const line = text.split("\n").map(s => s.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** 把（Tauri 返回的）错误转成可读文案 */
export const formatError = (error: unknown): string => {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/* ---------------- 标签归一化 ---------------- */

/**
 * 把模型写歪的标签统一成标准写法。
 * 实测模型经常写成 <tool_call>（少个 s）、<function_call>、<Thought> 等。
 * 旧实现只认 <tool_calls>，于是这类标签既没被执行、也没被剥掉，
 * 用户看到的就是"一段自说自话 + 一个裸的 <tool_call>"，然后对话就结束了。
 */
export const normalizeAiTags = (text: string): string =>
  text
    // 思考类：<thought>/<think>/<thinking ...> → <thinking>
    .replace(/<\/?(?:thought|think|thinking)\b[^>]*>/gi, (m) => (m.startsWith("</") ? "</thinking>" : "<thinking>"))
    // 工具类：<tool_call>/<toolcall>/<function_call> 及其复数 → <tool_calls>
    .replace(/<\/?(?:tool_?calls?|toolcalls?|function_?calls?)\b[^>]*>/gi, (m) => (m.startsWith("</") ? "</tool_calls>" : "<tool_calls>"));

/* ---------------- 标签剥离与正文提取 ---------------- */

/** 标签只有开标签、没有闭标签 → 模型输出被截断 */
const hasUnclosedTag = (text: string, tag: string): boolean => {
  const open = text.lastIndexOf(`<${tag}>`);
  return open !== -1 && text.indexOf(`</${tag}>`, open) === -1;
};

/**
 * 剥离 <thinking>/<tool_calls> 块——包含未闭合的尾部片段与孤立的闭合标签。
 * 模型被长度限制截断、或漏写开标签时，半截的 <tool_calls>[{"name":... 以及
 * 孤零零的 </tool_calls> 绝不能被当成正文渲染出来。
 */
const stripTaggedBlocks = (text: string): string =>
  text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<thinking>[\s\S]*/g, "")
    .replace(/<tool_calls>[\s\S]*/g, "")
    // 漏写开标签时会留下孤立的闭合标签
    .replace(/<\/?thinking>/g, "")
    .replace(/<\/?tool_calls>/g, "");

/** 供界面侧（如标题生成）复用的标签剥离 */
export const stripAiTags = stripTaggedBlocks;

/**
 * 去掉完整思考块后的正文。
 * 模型经常在思考里"提到"标签本身（例如"我应该直接回答，不需要 <tool_calls>"），
 * 若直接在原文里找 <tool_calls>，会把后面的整段正文误当成工具载荷：
 * 既污染思考区，又会把正常回复误判为"截断"而多跑一轮纠正。
 */
const bodyWithoutThinking = (text: string): string => text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

/** 读思考内容：完整 <thinking>…</thinking> 优先，其次写到一半的片段，最后退回模型原生思维链 */
const readThinking = (text: string, reasoning?: string): string =>
  text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim()
  || text.match(/<thinking>([\s\S]*)/)?.[1]?.trim()
  || (reasoning || "").trim();

/**
 * 读正文：只取最后一个 </thinking> 之后的内容。
 * 协议要求"先思考、再回答"，模型偶尔会先抢答半句（"你好"）才开始写 <thinking>，
 * 那半句既会造成"先闪一句、随后被思考覆盖"，也会和真正的回答重复，因此必须丢弃。
 */
const readReply = (text: string): { hasThinking: boolean; reply: string } => {
  const hasThinking = text.includes("<thinking>");
  if (!hasThinking) return { hasThinking, reply: stripTaggedBlocks(text) };
  const closeAt = text.lastIndexOf("</thinking>");
  if (closeAt === -1) return { hasThinking, reply: "" }; // 思考还没写完，正文尚未开始
  return { hasThinking, reply: stripTaggedBlocks(text.slice(closeAt + "</thinking>".length)) };
};

/** 思考区展示文本：推理 + 工具调用原文，用分隔线隔开 */
const composeThinkingDisplay = (thinking: string, toolText: string): string => {
  const reasoning = thinking.trim();
  const tools = toolText.trim();
  if (!tools) return reasoning;
  return reasoning ? `${reasoning}\n\n---\n${tools}` : tools;
};

/* ---------------- 工具调用解析 ---------------- */

/** 工具调用数组的起始特征（模型漏写 <tool_calls> 开标签时，正文里会直接出现它） */
const LOOSE_TOOL_CALL_HEAD_RE = /\[\s*\{\s*"name"\s*:\s*"[^"]*"\s*(?:,|\})/;

/** 宽松校验一条工具调用；args 缺失时补空对象，避免执行器拿到 undefined */
const normalizeToolCall = (value: unknown): ToolCall | null => {
  if (!value || typeof value !== "object") return null;
  const call = value as { name?: unknown; args?: unknown };
  if (typeof call.name !== "string" || !call.name) return null;
  return {
    name: call.name,
    args: call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {},
  };
};

/** 从 start 处扫描 JSON 数组的配对闭合位置（忽略字符串内的括号）；未闭合返回 -1 */
const findJsonArrayEnd = (text: string, start: number): number => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
};

/** 解析工具调用数组；容忍常见的多余逗号写法、以及"只给一个对象而不是数组"的写法 */
const parseToolCallArray = (raw: string): ToolCall[] => {
  for (const candidate of [raw, raw.replace(/,\s*([\]}])/g, "$1")]) {
    try {
      const parsed = JSON.parse(candidate);
      // 有的模型把 <tool_calls> 里写成单个对象 {"name":…,"args":…}
      const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && "name" in parsed ? [parsed] : null);
      if (arr && arr.length > 0) {
        const calls = arr.map(normalizeToolCall);
        if (calls.every((c): c is ToolCall => c !== null)) return calls;
      }
    } catch {
      // 换一种写法再试
    }
  }
  return [];
};

/** 在给定文本里定位工具调用数组：能解析出调用就返回 calls，只写了一半则只返回 payloadText */
const readToolCallArray = (text: string): { calls: ToolCall[]; payloadText: string } => {
  const head = text.search(LOOSE_TOOL_CALL_HEAD_RE);
  if (head === -1) return { calls: [], payloadText: "" };
  const end = findJsonArrayEnd(text, head);
  if (end === -1) return { calls: [], payloadText: text.slice(head).trim() };
  const payloadText = text.slice(head, end + 1).trim();
  return { calls: parseToolCallArray(payloadText), payloadText };
};

/**
 * 兜底解析"漏写 <tool_calls> 开标签"的工具调用。判定标准：
 * 1. 开头是 [{"name": ... 这类工具调用数组特征；
 * 2. 数组必须在文本结尾结束（后面只剩空白/代码围栏），否则视为正文里的普通 JSON，不做处理；
 * 3. 数组没闭合 = 写到一半（流式或被截断），照样剥掉，绝不能显示成正文。
 */
const extractLooseToolCall = (text: string): { reply: string; payloadText: string; calls: ToolCall[] } => {
  const head = text.search(LOOSE_TOOL_CALL_HEAD_RE);
  if (head === -1) return { reply: text, payloadText: "", calls: [] };
  const end = findJsonArrayEnd(text, head);
  // 数组之后还有正文 → 只是正文里正常出现的 JSON 片段，原样保留
  if (end !== -1 && text.slice(end + 1).replace(/[`\s]/g, "")) return { reply: text, payloadText: "", calls: [] };
  const { calls, payloadText } = readToolCallArray(text);
  return { reply: text.slice(0, head), payloadText, calls };
};

/**
 * 读工具调用，三种形态都救回来：
 * a) 标准写法 <tool_calls>[…]</tool_calls>
 * b) 漏写闭标签 <tool_calls>[…]
 * c) 漏写开标签，正文里裸着一个 […]
 * 注意必须传"剥离标签前"的 bodyText，否则 (b)(c) 会被当成正文丢掉。
 */
const readToolCalls = (bodyText: string, replyBase: string): { calls: ToolCall[]; toolText: string; reply: string } => {
  const closed = bodyText.match(/<tool_calls>([\s\S]*?)<\/tool_calls>/);
  if (closed) {
    const payload = closed[1].trim();
    const raw = payload.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    return { calls: parseToolCallArray(raw), toolText: payload, reply: replyBase };
  }
  const afterOpen = bodyText.match(/<tool_calls>([\s\S]*)/)?.[1] ?? "";
  if (afterOpen) {
    const found = readToolCallArray(afterOpen);
    return { calls: found.calls, toolText: found.payloadText || afterOpen.trim(), reply: replyBase };
  }
  const loose = extractLooseToolCall(replyBase);
  return { calls: loose.calls, toolText: loose.payloadText, reply: loose.payloadText ? loose.reply : replyBase };
};

/* ---------------- 统一解析入口 ---------------- */

/** 统一的解析入口：流式渲染与最终消息共用同一套规则 */
export const parseAssistantText = (rawText: string, reasoning?: string): ParsedResponse => {
  // 先把模型写歪的标签（<tool_call>、<Thought> 等）归一化，后面所有规则才吃得准
  const text = normalizeAiTags(rawText || "");
  const thinking = readThinking(text, reasoning);
  const bodyOnly = bodyWithoutThinking(text); // 思考里"提到"的 <tool_calls> 字样不算调用
  const { calls, toolText, reply } = readToolCalls(bodyOnly, readReply(text).reply);
  const truncated =
    hasUnclosedTag(bodyOnly, "tool_calls") ||
    hasUnclosedTag(text, "thinking") ||
    (toolText.length > 0 && calls.length === 0);
  return {
    thinking,
    thinkingDisplay: composeThinkingDisplay(thinking, toolText),
    toolCalls: calls,
    reply: reply.trim(),
    truncated,
  };
};

export const parseResponse = parseAssistantText;

/** 流式阶段只需要"思考区展示文本 + 正文" */
export const parseStreamContent = (text: string, reasoning?: string): { thinking: string; reply: string } => {
  const parsed = parseAssistantText(text, reasoning);
  return { thinking: parsed.thinkingDisplay, reply: parsed.reply };
};

/** 正文兜底：任何情况下都不能把 <thinking>/<tool_calls> 原文当正文显示 */
export const finalReplyText = (p: ParsedResponse): string => {
  if (p.reply) return p.reply;
  if (p.truncated) return "（这次回复写到一半就到头了，通常是输出长度上限被用完——一次性写整篇长文、或把整篇内容塞进工具参数最容易触发。可在「AI 设置 → 对话行为」调大「最大输出长度」，或让模型分段写：先给一段再说「继续」；长笔记改用按行编辑工具。）";
  if (p.toolCalls.length > 0) return "（已发起工具调用，没有正文。）";
  if (p.thinkingDisplay) return p.thinkingDisplay;
  return "（模型没有返回内容，请重试）";
};

/* ---------------- 流式"抢答"抑制 ---------------- */

/**
 * 本轮流式内容是否"以思考开头"（协议要求的形态）。
 * 不是的话，正文先按住不显示：模型可能先抢答一整段再补思考、甚至被重来覆盖，
 * 显示出来就是"闪一下又消失"。被按住的那一版用户永远看不到。
 */
export const streamStartsWithThinking = (text: string): boolean => /^\s*<thinking>/.test(text);

/* ---------------- 上下文压缩（记忆管理） ---------------- */

/** 会话里能进上下文的最小消息形状（不依赖业务类型） */
export interface ContextMessage {
  role: string;
  content: string;
}

/**
 * 粗略估算 token 数。中日韩字符按 1 token/字，其余按 4 字符 1 token 计。
 * 不追求精确，只用于"什么时候该压缩"的阈值判断——上下文失控比估算误差危险得多。
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkCount = cjk ? cjk.length : 0;
  const rest = text.length - cjkCount;
  return cjkCount + Math.ceil(rest / 4);
};

/**
 * 单条消息的瘦身：超长内容保留头尾、中间折叠。
 * 用户粘贴整篇长文、或工具回传整篇笔记时，靠它把单条消息从几万 token 压到几百。
 */
export const shrinkMessage = (text: string, head = 1200, tail = 400): string => {
  if (!text || text.length <= head + tail + 40) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…（此处省略 ${cut} 字，需要细节请用工具按范围读取）…\n\n${text.slice(-tail)}`;
};

/**
 * 选出要送进模型的消息窗口（主流的"滑动窗口 + 摘要"策略）。
 *
 * 规则：
 *   1. 从最新往回放，直到预算用完；至少保留 keepRecent 条完整消息；
 *   2. 超预算的更早消息不直接丢弃，而是交给调用方做摘要（returned 的 dropped）；
 *   3. 每条消息都先瘦身，避免一条超长消息吃掉整个预算。
 * 界面上的历史始终是完整的，这里只影响"发给模型的内容"。
 */
export const selectContextWindow = (
  msgs: ContextMessage[],
  budgetTokens: number,
  keepRecent = 8,
): { kept: ContextMessage[]; dropped: ContextMessage[] } => {
  const prepared = msgs.map((m) => ({ role: m.role, content: shrinkMessage(m.content) }));
  let used = 0;
  let cutAt = prepared.length;
  for (let i = prepared.length - 1; i >= 0; i--) {
    const cost = estimateTokens(prepared[i].content) + 4;
    const mustKeep = prepared.length - i <= keepRecent;
    if (!mustKeep && used + cost > budgetTokens) break;
    used += cost;
    cutAt = i;
  }
  return { kept: prepared.slice(cutAt), dropped: prepared.slice(0, cutAt) };
};

/** 摘要失效时的本地兜底：至少让模型知道"前面还有一些对话" */
export const localSummaryFallback = (dropped: ContextMessage[]): string => {
  if (dropped.length === 0) return "";
  const firstUser = dropped.find((m) => m.role === "user")?.content.replace(/\s+/g, " ").slice(0, 60) || "";
  return `（更早的 ${dropped.length} 条对话因长度限制已省略${firstUser ? `，最初的话题是「${firstUser}…」` : ""}。需要细节时请用工具重新读取笔记。）`;
};

/** 生成摘要时喂给模型的对话文本（带角色和条数上限，避免摘要请求本身又超长） */
export const compressTranscript = (dropped: ContextMessage[], maxChars = 6000): string => {
  const lines = dropped.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content.replace(/\s+/g, " ").trim()}`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（后续省略）` : text;
};

/* ---------------- 会话标题清洗 ---------------- */

/**
 * 把模型返回的标题文本洗干净。
 * 标题生成这次调用同样会命中"必须深度思考"的系统提示，模型可能回 <thinking>…</thinking>；
 * 早期实现只删掉了尖括号，于是 <thinking>用</thinking> 变成了标题"thinking用"。
 * 这里先整块剥掉思考/工具标签，再去 markdown 记号、引号书名号，只取第一行。
 */
export const cleanSessionTitle = (raw: string): string => {
  const text = stripTaggedBlocks(raw || "")
    .replace(/<[^>]*>/g, "")                    // 其它残留标签
    .replace(/^#+\s*/, "")                      // markdown 标题记号
    .replace(/[*#`_~]/g, "")
    .replace(/["'「」『』《》【】]/g, "")
    .replace(/^\s*(?:标题|title)\s*[:：]\s*/i, "")
    .split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const title = text.replace(/[。！？!?，,、：:；;.\s]+$/g, "").trim();
  // 仍然夹带 "thinking / reasoning" 字样的一律判为无效，宁可保持"新对话"
  if (!title || /thinking|reasoning|<|>/i.test(title)) return "";
  return title.slice(0, 12);
};

/* ---------------- 事实校验 ---------------- */

/**
 * 去掉"引用来的内容"，只保留模型对自己动作的陈述。
 *
 * 事实校验以前直接在整段正文上匹配，于是两类误报：
 *   1. 总结/翻译笔记时，**笔记原文里**写着"已移动到读书分组"被当成模型自己的动作；
 *   2. 代码块、引用块里同样会出现这类句式。
 * 这里把引号内、代码块内、引用行内、书名号内的内容先抹掉再判断。
 */
export const stripQuotedText = (text: string): string =>
  (text || "")
    .replace(/```[\s\S]*?```/g, " ")      // 代码块
    .replace(/`[^`\n]*`/g, " ")            // 行内代码
    .replace(/^[ \t]*>.*$/gm, " ")         // 引用行
    .replace(/「[^」]*」/g, " ")
    .replace(/『[^』]*』/g, " ")
    .replace(/《[^》]*》/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"\n]{0,200}"/g, " ")
    .replace(/‘[^’]*’/g, " ");

/**
 * "模型声称已完成的动作" ↔ "必须真实执行过的工具"。
 * 用于最终回复的事实校验：说了"已打开"就必须真的调过 selectNote。
 *
 * 规则要点：
 *   - "移入回收站"属于**删除**（deleteNote/deleteCategory），不属于移动；
 *     移动规则里用负向断言把这个说法排除掉，否则删完笔记会误报"没有执行移动笔记"。
 *   - 只在去掉引用内容后的文本上匹配（见 stripQuotedText）。
 */
/**
 * 声称前缀："已/已经/成功"之后允许接"为/把/将 + 它/其/这条笔记…"，
 * 这样"已将其移入回收站""已把它删除了"这类说法也能识别到。
 */
const CLAIM_PREFIX = "(?:已|已经|成功)\\s*(?:为[你您]|把|将)?\\s*(?:它|其|这条笔记|该笔记|这条分组|该分组)?\\s*";
const claimRe = (verbs: string) => new RegExp(`${CLAIM_PREFIX}(?:${verbs})`);

const ACTION_CLAIM_RULES: { label: string; re: RegExp; tools: string[] }[] = [
  { label: "打开笔记", re: claimRe("打开"), tools: ["selectNote"] },
  { label: "创建笔记/分组", re: claimRe("创建|新建|添加"), tools: ["createNote", "createNotes", "createCategory"] },
  // 修改类补上口语说法："已改好 / 已改完 / 已改动" —— 模型谎报时常常就是这么说的
  { label: "修改笔记/分组", re: claimRe("修改|更新|改成|改为|重命名|改名|改好|改完|改动|调整"), tools: ["updateNote", "updateCurrentNote", "renameCategory"] },
  // "移入回收站"属于删除动作；移动规则里用负向断言排除它，
  // 否则删完笔记会被误报成"没有执行移动笔记"。
  { label: "删除笔记/分组", re: claimRe("删除|移除|清空|移入回收站"), tools: ["deleteNote", "deleteCategory", "deleteFromTrash", "emptyTrash"] },
  { label: "移动笔记", re: claimRe("移动|移到|移至|移入(?!回收站)"), tools: ["moveNote"] },
  { label: "还原笔记", re: claimRe("还原"), tools: ["restoreNote"] },
  { label: "追加内容", re: claimRe("追加"), tools: ["appendToNote"] },
];

/** 正文里是否出现了"已完成某操作"的表述（用于纠正"谎报操作"的回复） */
export const hasActionClaim = (reply: string): boolean => {
  const clean = stripQuotedText(reply);
  return ACTION_CLAIM_RULES.some(rule => rule.re.test(clean));
};

/**
 * 组装最终正文：保留工具轮里已经写给用户的正文，并对"声称已完成但没执行"做事实校验。
 * 纯函数，便于单独推演/测试。
 */
export const buildFinalContent = (finalReply: string, carriedContent: string, tools: ToolTrace[]): string => {
  const carried = carriedContent.trim();
  const base = carried && !finalReply.includes(carried) ? `${carried}\n\n${finalReply}` : finalReply;
  const ranTools = new Set(tools.filter(t => t.ok).map(t => t.name));
  // 同样只在"去掉引用内容"后的文本上判断，避免把笔记原文当成模型的动作
  const claimText = stripQuotedText(base);
  const unverified = ACTION_CLAIM_RULES.filter(rule => rule.re.test(claimText) && !rule.tools.some(t => ranTools.has(t)));
  if (unverified.length === 0) return base;
  return `${base}\n\n> ⚠️ 提示：本次回答里并没有实际执行「${unverified.map(r => r.label).join("、")}」，上面的相关表述未经工具结果确认，请以左侧笔记列表的实际状态为准。`;
};
