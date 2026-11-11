import type { ToolContext } from "@/interface/ai/aiChat";

/** 工具执行器签名：args 来自模型输出的 <tool_calls>，ctx 携带本轮访问规则与当前笔记。 */
export type ToolExecutor = (args: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

/** 按工具名索引的执行器集合。 */
export type ToolExecutors = Record<string, ToolExecutor>;
