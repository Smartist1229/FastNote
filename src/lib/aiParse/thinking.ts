/**
 * 回复质量门槛：思考深度、浅思考重试、流式抢答抑制。
 * 只做布尔判定，不解析文本；输入来自 parse.ts 或流式原文，
 * 输出由 AIChatPanel 决定是否丢弃当前这版回复重新请求。纯函数，无副作用。
 */

/** 去掉所有空白后按字符数计（中文一字算一个），阈值通常取 aiSettings.minThinkingLen */
export const isThinkingDeepEnough = (thinking: string, minLen: number): boolean =>
  thinking.replace(/\s/g, "").length >= minLen;

/**
 * 是否需要「思考太浅，重新思考」的纠正。四个条件同时成立才重试：
 *   - 本轮还没纠正过（correctionUsed），避免死循环；
 *   - 正文没有显示给用户（replyShown），这是硬约束：
 *     否则用户会看到「回答 → 消失 → 另一个回答」；
 *   - 本轮没有工具调用，动作优先执行；
 *   - 思考字数不足 minLen。
 * replyShown 由调用方综合原生 reasoning、是否以 <thinking> 开头、模型是否写过思考来判定；
 * 被按住未显示的轮次可以安全重来，用户看不到被丢弃的那一版。
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

/**
 * 本轮流式文本是否「以 <thinking> 开头」（允许前导空白），即协议要求的形态。
 * 返回 false 时调用方会先按住正文不显示：模型可能先抢答一整段再补思考，
 * 那段内容随后会被覆盖或重来，提前显示就是「闪一下又消失」。
 */
export const streamStartsWithThinking = (text: string): boolean => /^\s*<thinking>/.test(text);
