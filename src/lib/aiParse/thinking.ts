/* 思考深度/重试判定，以及流式"抢答"抑制的判定。 */

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

/**
 * 本轮流式内容是否"以思考开头"（协议要求的形态）。
 * 不是的话，正文先按住不显示：模型可能先抢答一整段再补思考、甚至被重来覆盖，
 * 显示出来就是"闪一下又消失"。被按住的那一版用户永远看不到。
 */
export const streamStartsWithThinking = (text: string): boolean => /^\s*<thinking>/.test(text);
