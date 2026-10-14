/* <thinking>/<tool_calls> 协议解析：标签归一化、正文提取、工具调用解析与统一解析入口。 */

import type { ParsedResponse, ToolCall } from "@/interface/aiOutput";

import { stripTaggedBlocks } from "./text";

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

/* ---------------- 正文提取 ---------------- */

/** 标签只有开标签、没有闭标签 → 模型输出被截断 */
const hasUnclosedTag = (text: string, tag: string): boolean => {
  const open = text.lastIndexOf(`<${tag}>`);
  return open !== -1 && text.indexOf(`</${tag}>`, open) === -1;
};

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
