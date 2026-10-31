/**
 * AI 输出协议解析：把模型原始文本拆成 thinking / toolCalls / reply。
 *
 * 协议约定模型先输出 <thinking>…</thinking>，再输出
 * <tool_calls>[{"name":"…","args":{…}}]</tool_calls>，最后写正文；
 * 实际输出经常缺标签、写错标签或 JSON 被截断，这里统一容错。
 *
 * 产物消费方（AIChatPanel）：
 *   - thinking         主要用于判定「思考是否够深」，回复为空时也当标题素材
 *   - thinkingDisplay  思考区展示文本（推理 + 工具调用原文）
 *   - toolCalls        交给工具执行器逐条执行
 *   - reply            气泡正文，永远不含协议标签
 *   - truncated        供调用方判断是否需要「截断后重试」
 *
 * 全部为纯函数、无副作用：同一输入必得同一输出，流式预览与最终消息共用。
 */

import type { ParsedResponse, ToolCall } from "@/interface/aiOutput";

import { stripTaggedBlocks } from "./text";

/* ---------- 标签归一化 ---------- */

/**
 * 归一化标签别名：thought / think / thinking → thinking，
 * tool_call / toolcall / function_call 及其复数 → tool_calls。
 * 大小写不敏感，开标签上的属性会被丢弃；后续规则只认标准写法。
 */
export const normalizeAiTags = (text: string): string =>
  text
    // 思考类：<thought>/<think>/<thinking ...> → <thinking>
    .replace(/<\/?(?:thought|think|thinking)\b[^>]*>/gi, (m) => (m.startsWith("</") ? "</thinking>" : "<thinking>"))
    // 工具类：<tool_call>/<toolcall>/<function_call> 及其复数 → <tool_calls>
    .replace(/<\/?(?:tool_?calls?|toolcalls?|function_?calls?)\b[^>]*>/gi, (m) => (m.startsWith("</") ? "</tool_calls>" : "<tool_calls>"));

/* ---------- 正文提取 ---------- */

/**
 * 是否存在「只有开标签、没有闭标签」的片段，这是输出被长度上限截断的典型信号。
 * 以最后一个开标签为基准：它之后找不到闭标签才算未闭合，
 * 因此「先正常闭合、后面又开了一个」也能识别。
 */
const hasUnclosedTag = (text: string, tag: string): boolean => {
  const open = text.lastIndexOf(`<${tag}>`);
  return open !== -1 && text.indexOf(`</${tag}>`, open) === -1;
};

/**
 * 去掉完整思考块后的文本，用于定位工具调用。
 * 思考内容里常出现对标签本身的讨论（如「这里不需要 <tool_calls>」），
 * 若直接在原文里找，会把后续正文误当载荷，并让本轮误判为截断而多跑一轮纠错。
 */
const bodyWithoutThinking = (text: string): string => text.replace(/<thinking>[\s\S]*?<\/thinking>/g, "");

/**
 * 读取思考内容，优先级：
 *   1. 完整的 <thinking>…</thinking>；
 *   2. 否则从第一个 <thinking> 起截到文本结尾（覆盖未闭合/流式的情况）；
 *   3. 模型原生思维链 reasoning（如 reasoning_content）。
 * 结果已 trim；完全找不到 <thinking> 时退回 reasoning，仍没有则为空串。
 */
const readThinking = (text: string, reasoning?: string): string =>
  text.match(/<thinking>([\s\S]*?)<\/thinking>/)?.[1]?.trim()
  || text.match(/<thinking>([\s\S]*)/)?.[1]?.trim()
  || (reasoning || "").trim();

/**
 * 读取正文：有思考标签时只保留最后一个 </thinking> 之后的内容。
 * hasThinking 表示原文是否出现过 <thinking>（未闭合也算）；
 * 完全没有 </thinking> 时视为正文尚未开始，返回空串。
 * 思考前抢答的半句会被丢弃：既避免「先闪一句再被覆盖」，也避免与正式回答重复。
 */
const readReply = (text: string): { hasThinking: boolean; reply: string } => {
  const hasThinking = text.includes("<thinking>");
  if (!hasThinking) return { hasThinking, reply: stripTaggedBlocks(text) };
  const closeAt = text.lastIndexOf("</thinking>");
  if (closeAt === -1) return { hasThinking, reply: "" }; // 思考还没写完，正文尚未开始
  return { hasThinking, reply: stripTaggedBlocks(text.slice(closeAt + "</thinking>".length)) };
};

/** 思考区展示文本：推理与工具调用原文用 `---` 分隔；任一侧为空时只返回另一侧 */
const composeThinkingDisplay = (thinking: string, toolText: string): string => {
  const reasoning = thinking.trim();
  const tools = toolText.trim();
  if (!tools) return reasoning;
  return reasoning ? `${reasoning}\n\n---\n${tools}` : tools;
};

/* ---------- 工具调用解析 ---------- */

/**
 * 工具调用数组的「起始特征」：`[{"name":"…"`（允许空白）。
 * 用于兜底识别模型漏写 <tool_calls> 开标签、把 JSON 直接写进正文的情况。
 * 只认双引号 name；单引号写法不会被当作工具调用。
 */
const LOOSE_TOOL_CALL_HEAD_RE = /\[\s*\{\s*"name"\s*:\s*"[^"]*"\s*(?:,|\})/;

/**
 * 宽松校验单条工具调用：name 必须是非空字符串；
 * args 缺失或不是对象时补 {}，避免执行器解构 undefined。
 * 不校验工具名是否存在，未知工具由执行层处理。
 */
const normalizeToolCall = (value: unknown): ToolCall | null => {
  if (!value || typeof value !== "object") return null;
  const call = value as { name?: unknown; args?: unknown };
  if (typeof call.name !== "string" || !call.name) return null;
  return {
    name: call.name,
    args: call.args && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {},
  };
};

/**
 * 从 start 处的 `[` 开始扫描，返回配对 `]` 的下标；未闭合返回 -1。
 * 扫描时跳过字符串内部（含反斜杠转义），args 里的括号不会打乱层级。
 */
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

/**
 * 解析工具调用数组，两轮尝试：原文 → 去掉尾逗号（`,]` / `,}`）后。
 * 也接受「单个对象而非数组」的写法；任一元素不合法则整体判为失败并返回 []，
 * 宁可让上层按「无调用/截断」处理，也不执行半套 JSON。
 */
const parseToolCallArray = (raw: string): ToolCall[] => {
  for (const candidate of [raw, raw.replace(/,\s*([\]}])/g, "$1")]) {
    try {
      const parsed = JSON.parse(candidate);
      // 兼容模型只写一个对象（而非数组）的情况
      const arr = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === "object" && "name" in parsed ? [parsed] : null);
      if (arr && arr.length > 0) {
        const calls = arr.map(normalizeToolCall);
        if (calls.every((c): c is ToolCall => c !== null)) return calls;
      }
    } catch {
      // 两种写法都解析失败
    }
  }
  return [];
};

/**
 * 在一段文本里定位工具调用数组。
 * 数组完整 → 返回解析结果；数组未闭合（写到一半）→ calls 为空，
 * 只返回 payloadText，由上层据此判定截断。
 */
const readToolCallArray = (text: string): { calls: ToolCall[]; payloadText: string } => {
  const head = text.search(LOOSE_TOOL_CALL_HEAD_RE);
  if (head === -1) return { calls: [], payloadText: "" };
  const end = findJsonArrayEnd(text, head);
  if (end === -1) return { calls: [], payloadText: text.slice(head).trim() };
  const payloadText = text.slice(head, end + 1).trim();
  return { calls: parseToolCallArray(payloadText), payloadText };
};

/**
 * 兜底解析「漏写 <tool_calls> 开标签」的工具调用。三条判定：
 *   1. 出现 `[{"name":…` 这类数组起始特征；
 *   2. 数组必须在文本结尾结束（其后只允许空白或代码围栏），
 *      否则只是正文里正常出现的 JSON，原样保留；
 *   3. 数组未闭合视为写到一半，照样剥掉，绝不当正文显示。
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
 * 提取工具调用，覆盖三种形态：
 *   a) 标准闭合 <tool_calls>…</tool_calls>（内部允许 ```json 围栏）；
 *   b) 只有开标签、没有闭标签；
 *   c) 连开标签都没有，正文末尾裸着一个数组。
 * bodyText 必须是「尚未剥离标签」的文本，否则 b/c 会被提前丢掉；
 * replyBase 是已剔除思考的正文，用于 c) 中把数组从正文里切走。
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

/* ---------- 统一解析入口 ---------- */

/**
 * 统一解析入口：流式预览与最终消息共用同一套规则。
 *
 * @param rawText   模型完整输出，可含别名标签、缺失闭标签、代码围栏
 * @param reasoning 模型原生思维链，仅在缺少 <thinking> 时作为兜底
 * @returns 各字段语义见文件头；空输入返回全空且 truncated=false
 *
 * truncated 的三个来源：<tool_calls> 未闭合、<thinking> 未闭合、
 * 或拿到了工具载荷却一条都解析不出来（JSON 非法）。
 */
export const parseAssistantText = (rawText: string, reasoning?: string): ParsedResponse => {
  // 先归一化别名标签，后续规则才只需面对标准写法
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

/** 最终消息解析的语义化别名，行为与 parseAssistantText 完全一致 */
export const parseResponse = parseAssistantText;

/**
 * 流式阶段只取「思考区展示文本 + 正文」，参数同 parseAssistantText。
 * 注意返回的 thinking 是 thinkingDisplay（含工具原文），不用于深度判定。
 */
export const parseStreamContent = (text: string, reasoning?: string): { thinking: string; reply: string } => {
  const parsed = parseAssistantText(text, reasoning);
  return { thinking: parsed.thinkingDisplay, reply: parsed.reply };
};

/**
 * 正文兜底：保证气泡永远有内容，避免半截协议标签直接露给用户。
 * 优先级：reply → 截断提示 → 仅有工具调用 → 思考区文本 → 空回复提示。
 * 截断提示会引导用户调大「最大输出长度」，或改用分段/按行编辑工具。
 */
export const finalReplyText = (p: ParsedResponse, t: (source: string) => string = (source) => source): string => {
  if (p.reply) return p.reply;
  if (p.truncated) return t("（这次回复写到一半就到头了，通常是输出长度上限被用完——一次性写整篇长文、或把整篇内容塞进工具参数最容易触发。可在「AI 设置 → 对话行为」调大「最大输出长度」，或让模型分段写：先给一段再说「继续」；长笔记改用按行编辑工具。）");
  if (p.toolCalls.length > 0) return t("（已发起工具调用，没有正文。）");
  if (p.thinkingDisplay) return p.thinkingDisplay;
  return t("（模型没有返回内容，请重试）");
};
