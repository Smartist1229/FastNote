import type { AiChatMessage } from "@/interface/ai/ai";
import type { ToolTrace } from "@/interface/ai/aiOutput";

/** 仅应用自己生成的通知携带标记；聊天正文、模型输出与持久化历史不按文本猜测翻译。 */
export interface UiNotice {
  kind: "failure" | "no-progress" | "limit" | "empty" | "stopped" | "reply";
  error?: string;
  prefix?: string;
  source?: string;
  unverified?: string[];
}

/**
 * 面板里的一条消息：协议字段之外还带渲染用的状态（思考过程、工具轨迹、时间戳）。
 * 持久化到库里时只保留 AiChatMessage 的字段。
 */
export type UiChatMessage = AiChatMessage & {
  thinking?: string;
  tools?: ToolTrace[];
  at?: number;
  thinkMs?: number;
  uiNotice?: UiNotice;
};
