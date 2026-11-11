/**
 * AI 输出解析层的协议类型。
 *
 * 这里描述的是「模型文本 → 结构化结果」的前端内部协议，由 lib/aiParse 产出：
 * 模型被要求先输出 <thinking>，再输出 <tool_calls> JSON 数组或正文。
 * 协议字段名（<thinking> / <tool_calls> / name / args）与提示词严格绑定，
 * 改动需同步 config/aiDefaults.ts；本层不涉及数据库，也不与 Rust 结构体对应。
 */

/** 一条工具调用：name 必须命中 TOOL_DEFS，args 为自由对象，由执行器按工具签名校验 */
export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

/** parseAssistantText 的解析结果（流式渲染与最终消息共用同一套规则） */
export interface ParsedResponse {
  /** 纯推理内容：只用于"思考是否足够深入"的校验，不掺工具调用原文 */
  thinking: string;
  /** 思考区展示内容：推理 + 工具调用原文（工具调用只允许出现在这里） */
  thinkingDisplay: string;
  toolCalls: ToolCall[];
  /** 最后一个 </thinking> 之后的正文，已剥离标签与工具块 */
  reply: string;
  /** 输出被截断或工具载荷非法：标签只有开标签，或解析出载荷却得不到合法调用 */
  truncated: boolean;
}

/** 一次工具执行的轨迹（挂在消息上，用于界面展示与事实校验） */
export interface ToolTrace {
  name: string;
  args?: Record<string, unknown>;
  /** 执行状态：true = 成功，false = 失败或用户取消，null = 正在执行 */
  ok: boolean | null;
  /** 界面上的简短摘要（如行数、命中条数），不参与业务判断 */
  detail?: string;
  result?: unknown;
}

/** 会话里能进上下文的最小消息形状（不依赖业务类型；role 原样透传，含工具结果消息） */
export interface ContextMessage {
  role: string;
  content: string;
}
