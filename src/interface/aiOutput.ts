/* AI 输出解析层的协议类型（<thinking>/<tool_calls> 解析结果与上下文消息）。 */

/* ---------- AI 输出解析（lib/aiChatParse 的 <thinking>/<tool_calls> 协议） ---------- */

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

/** 会话里能进上下文的最小消息形状（不依赖业务类型） */
export interface ContextMessage {
  role: string;
  content: string;
}
