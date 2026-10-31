/**
 * 上下文管理：token 估算、单条消息瘦身、滑动窗口选择、摘要兜底与摘要输入生成。
 *
 * 调用方在每次请求前用它决定「哪些历史发给模型」；界面历史始终完整，压缩只作用于请求。
 * 全部为纯函数。token 是估算值，适合阈值判断与粗略展示，不适合精确计费。
 */

import { buildLocalSummaryFallback } from "@/config/aiDefaults";
import type { ContextMessage } from "@/interface/aiOutput";
import { flattenNoteRefs } from "@/lib/aiParse/noteRef";

/**
 * 粗略估算 token：CJK（假名/汉字/韩文）按 1 字 1 token，其余按 4 字符 1 token 向上取整。
 * 口径偏保守：宁可早一点触发压缩，也不要让请求超出上下文窗口；
 * 与真实 BPE 分词存在误差，只用于阈值判断与界面上的粗略用量。
 */
export const estimateTokens = (text: string): number => {
  if (!text) return 0;
  const cjk = text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g);
  const cjkCount = cjk ? cjk.length : 0;
  const rest = text.length - cjkCount;
  return cjkCount + Math.ceil(rest / 4);
};

/**
 * 单条消息瘦身：超长时保留头 head 字与尾 tail 字，中间替换为省略提示。
 * 提示里带省略字数并引导模型「按范围读取」，与工具协议配合；
 * head+tail+40 以内原样返回，避免短消息被无谓改动。
 */
export const shrinkMessage = (text: string, head = 1200, tail = 400): string => {
  if (!text || text.length <= head + tail + 40) return text;
  const cut = text.length - head - tail;
  return `${text.slice(0, head)}\n\n…（此处省略 ${cut} 字，需要细节请用工具按范围读取）…\n\n${text.slice(-tail)}`;
};

/**
 * 选择本轮发给模型的消息窗口（滑动窗口 + 摘要）。
 *
 * 做法：先逐条 shrinkMessage，再从最新往回累加估算成本（每条另加 4 token 的角色/格式开销）；
 * 遇到放不下的消息即停止，不会跳过它去保留更早的消息，保证窗口是连续的后缀。
 * 最近 keepRecent 条无条件保留（仍会瘦身），即使已超出预算，确保模型看得到刚发生的事。
 *
 * @returns kept    按时间正序的窗口消息（已瘦身，只含 role/content）
 *          dropped 更早的消息，交给调用方摘要或本地兜底
 * 不修改入参；预算很小时也会保留最近 keepRecent 条（消息不足则全部保留）。
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

/**
 * 摘要不可用时的本地兜底：至少让模型知道「前面还有 dropped.length 条对话被省略」。
 * 取第一条 user 消息前 60 字作为话题线索；dropped 为空时返回空串。
 * 文案模板来自 config/aiDefaults，调用方以 system 消息注入。
 */
export const localSummaryFallback = (dropped: ContextMessage[]): string => {
  if (dropped.length === 0) return "";
  const firstUser = flattenNoteRefs(dropped.find((m) => m.role === "user")?.content || "")
    .replace(/\s+/g, " ")
    .slice(0, 60) || "";
  return buildLocalSummaryFallback(dropped.length, firstUser);
};

/**
 * 生成摘要请求的对话正文：`User:` / `Assistant:` 前缀，换行与连续空白折叠为单空格。
 * 超过 maxChars（默认 6000 字符）硬截断并追加 `...(rest omitted)`，
 * 防止「摘要请求本身又超长」；非 user 角色一律标为 Assistant。
 */
export const compressTranscript = (dropped: ContextMessage[], maxChars = 6000): string => {
  // 引用块先展开成「出处 + 正文」：否则硬截断可能切出半个 JSON，摘要模型会读到残缺协议
  const lines = dropped.map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${flattenNoteRefs(m.content).replace(/\s+/g, " ").trim()}`);
  const text = lines.join("\n");
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...(rest omitted)` : text;
};
