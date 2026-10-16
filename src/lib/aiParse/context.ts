/* 上下文压缩（记忆管理）：token 估算、消息瘦身、窗口选择、摘要兜底与对话文本生成。 */

import { buildLocalSummaryFallback } from "@/config/aiDefaults";
import type { ContextMessage } from "@/interface/aiOutput";

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
  return buildLocalSummaryFallback(dropped.length, firstUser);
};

/** 生成摘要时喂给模型的对话文本（带角色和条数上限，避免摘要请求本身又超长） */
export const compressTranscript = (dropped: ContextMessage[], maxChars = 6000): string => {
  const lines = dropped.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content.replace(/\s+/g, " ").trim()}`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...(rest omitted)` : text;
};
