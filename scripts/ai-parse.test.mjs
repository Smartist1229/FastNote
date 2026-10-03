/**
 * AI 解析层回归测试 —— 直接跑 src/aiChatParse.ts 的真实代码。
 * 运行：node scripts/ai-parse.test.mjs   （Node ≥ 22.6 原生支持剥离 TS 类型）
 *
 * 这些用例覆盖了历史上真实出现过的故障形态，改动解析逻辑前后都应跑一遍：
 *   1. 工具调用漏写开标签 / 漏写闭标签 / 写到一半
 *   2. 思考里"提到" <tool_calls> 被误判
 *   3. 模型先抢答半句再补思考（闪烁/重复）
 *   4. 流式渲染与最终消息不一致
 *   5. 会话标题被污染（"thinking用"）
 *   6. 谎报操作（声称已完成但没执行）
 */
import {
  buildFinalContent,
  cleanSessionTitle,
  finalReplyText,
  hasActionClaim,
  parseAssistantText,
  parseStreamContent,
  shouldRetryForShallowThinking,
  streamStartsWithThinking,
} from "../src/aiChatParse.ts";

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
};

const summary = "## 《白雪公主》剧情总结\n- 开端：王后去世\n- 结局：王子与公主结婚";

console.log("\n[1] 工具调用三种形态");
{
  const p = parseAssistantText(`<thinking>创建笔记。</thinking>\n<tool_calls>[{"name":"createNote","args":{"title":"标题"}}]</tool_calls>`);
  check("标准闭合：解析出 1 个调用", p.toolCalls.map((c) => c.name), ["createNote"]);
  check("标准闭合：正文为空", p.reply, "");
  check("标准闭合：未标记截断", p.truncated, false);
}
{
  const p = parseAssistantText(`<thinking>重新分析。</thinking>\n我注意到刚才出错了：\n[{"name":"selectNote","args":{"noteId":"17"}}]\n</tool_calls>`);
  check("漏写开标签：仍解析出调用", p.toolCalls.map((c) => c.name), ["selectNote"]);
  check("漏写开标签：正文无标签/JSON", /tool_calls|\{"name"/.test(p.reply), false);
  check("漏写开标签：正文保留说明文字", p.reply.includes("我注意到刚才出错了"), true);
}
{
  const p = parseAssistantText(`<thinking>执行。</thinking>\n${summary}\n现在为您打开：\n<tool_calls>[{"name": "selectNote", "args": {"noteId": "16"}}]`);
  check("漏写闭标签：解析出调用（曾被静默丢弃）", p.toolCalls.map((c) => c.name), ["selectNote"]);
  check("漏写闭标签：正文无 JSON", p.reply.includes("noteId"), false);
}
{
  const p = parseAssistantText(`<thinking>用户要写故事。</thinking>\n好的：\n<tool_calls>[{"name":"createNote","args":{"title":"小红帽","content":"很久很久`);
  check("工具调用写到一半：不解析为调用", p.toolCalls.length, 0);
  check("工具调用写到一半：标记截断（触发重试）", p.truncated, true);
}

console.log("\n[2] 思考区不得污染正文");
{
  const p = parseAssistantText(`<thinking>用户问好。我应该直接回答，不需要 <tool_calls> 标签。</thinking>\n你好！有什么可以帮您的？`);
  check("思考里提到 <tool_calls>：不误判为调用", p.toolCalls.length, 0);
  check("思考里提到 <tool_calls>：不误判为截断", p.truncated, false);
  check("思考里提到 <tool_calls>：正文完整", p.reply, "你好！有什么可以帮您的？");
}
{
  const p = parseAssistantText(`<thinking>测试。</thinking>\n这是正文。\n</tool_calls>`);
  check("孤立的 </tool_calls>：被清掉", p.reply, "这是正文。");
}

console.log("\n[3] 抢答型（先回一整段再补思考）");
{
  // 渲染层按住规则：本轮不是以 <thinking> 开头 且 模型被认定会写思考 → 正文不显示
  const shouldHold = (streamedText, capable = true) =>
    capable && !streamStartsWithThinking(streamedText);

  check("以思考开头 → 正常显示", shouldHold("<thinking>在想</thinking>\n正文"), false);
  check("抢答一整段（无思考块）→ 按住不显示", shouldHold("扩写后的整篇文章……".repeat(20)), true);
  check("抢答半句 → 同样按住", shouldHold("你好"), true);
  check("已确认模型不写思考 → 不再按住（保住逐字输出）", shouldHold("不写思考的模型的回答", false), false);

  const mid = parseStreamContent("你好\n<thinking>用户打招呼");
  check("思考未闭合时：正文为空", mid.reply, "");
  const done = parseStreamContent("<thinking>用户打招呼。</thinking>\n你好！有什么可以帮您的？");
  check("思考闭合后：正文只取之后的内容", done.reply, "你好！有什么可以帮您的？");
  const final = parseAssistantText("你好\n<thinking>用户打招呼。</thinking>\n你好！有什么可以帮您的？");
  check("最终正文不重复抢答的半句", final.reply, "你好！有什么可以帮您的？");
}

console.log("\n[3b] 重试判定：正文没显示过才允许重来");
{
  const base = { correctionUsed: false, replyShown: false, toolCallCount: 0, thinking: "", minLen: 24 };
  check("思考过浅 + 正文被按住 → 重来（用户看不到被丢弃的那版）", shouldRetryForShallowThinking(base), true);
  check("正文已显示 → 绝不重来", shouldRetryForShallowThinking({ ...base, replyShown: true }), false);
  check("有工具调用 → 不重来", shouldRetryForShallowThinking({ ...base, toolCallCount: 1 }), false);
  check("本轮已重来过 → 不重复重来", shouldRetryForShallowThinking({ ...base, correctionUsed: true }), false);
  check("思考足够深 → 不重来", shouldRetryForShallowThinking({ ...base, thinking: "想".repeat(40) }), false);
}

console.log("\n[3c] 完整复现「扩写」三步问题（修复后应只剩 思考 → 回答）");
{
  // 第 1 轮：模型不写思考，直接给出扩写结果（会被按住，用户看不到）
  const round1Text = "## 扩写后的文章\n" + "内容……".repeat(60);
  const round1 = parseAssistantText(round1Text);
  const round1Hold = !streamStartsWithThinking(round1Text);           // 渲染层按住
  const round1ReplyShown = !!round1.reply && streamStartsWithThinking(round1Text);
  const round1Retry = shouldRetryForShallowThinking({
    correctionUsed: false, replyShown: round1ReplyShown, toolCallCount: 0, thinking: round1.thinking, minLen: 24,
  });
  check("第 1 轮：内容被按住（用户看不到这一版）", round1Hold, true);
  check("第 1 轮：判定为可重来", round1Retry, true);

  // 第 2 轮：先思考，再给（思考后的）回答 —— 这是用户唯一会看到的内容
  const round2Text = "<thinking>用户要扩写这篇文章，我需要保持原意并补充细节，注意结构与语气。</thinking>\n## 扩写后的文章（正式版）\n内容……";
  const round2Hold = !streamStartsWithThinking(round2Text);
  const round2 = parseAssistantText(round2Text);
  const round2Retry = shouldRetryForShallowThinking({
    correctionUsed: true, replyShown: !!round2.reply, toolCallCount: 0, thinking: round2.thinking, minLen: 24,
  });
  check("第 2 轮：不按住，正常流式显示", round2Hold, false);
  check("第 2 轮：不再重来", round2Retry, false);
  check("第 2 轮：正文是思考之后的内容", round2.reply.startsWith("## 扩写后的文章（正式版）"), true);
  check("两轮正文确实不同（正是会被覆盖的那版）", round1.reply !== round2.reply, true);
}

console.log("\n[4] 流式与最终渲染必须一致");
{
  const text = `<thinking>推理内容。</thinking>\n### 标题\n正文内容 <tool_calls>[{"name":"searchNotes","args":{"query":"x"}}]</tool_calls>`;
  const s = parseStreamContent(text);
  const f = parseAssistantText(text);
  check("流式正文 === 最终正文", s.reply, f.reply);
  check("流式思考 === 最终思考区", s.thinking, f.thinkingDisplay);
}

console.log("\n[5] 正文兜底");
{
  check("有正文时原样返回", finalReplyText(parseAssistantText("普通回答")), "普通回答");
  check("只有工具调用时给提示", finalReplyText(parseAssistantText(`<tool_calls>[{"name":"getCategories","args":{}}]</tool_calls>`)), "（已发起工具调用，没有正文。）");
  check("完全空输出时给提示", finalReplyText(parseAssistantText("")), "（模型没有返回内容，请重试）");
}

console.log("\n[6] 会话标题清洗");
{
  check("思考标签包裹 → 无效（曾生成 thinking用）", cleanSessionTitle("<thinking>用</thinking>"), "");
  check("思考 + 标题 → 只留标题", cleanSessionTitle("<thinking>用户要生成标题。</thinking>小白帽的故事"), "小白帽的故事");
  check("markdown 前缀被去掉", cleanSessionTitle("## 标题：小红帽的故事"), "小红帽的故事");
  check("夹带 thinking 字样 → 无效", cleanSessionTitle("thinking用"), "");
  check("结尾标点被去掉", cleanSessionTitle("小红帽的故事。"), "小红帽的故事");
}

console.log("\n[7] 事实校验（谎报操作）");
{
  const tools = [{ name: "searchNotes", ok: true }];
  check("声称已打开但没调 selectNote → 提示", buildFinalContent("已为您打开《白雪公主》。", "", tools).includes("并没有实际执行"), true);
  check("真的调过 selectNote → 不提示", buildFinalContent("已为您打开《白雪公主》。", "", [{ name: "selectNote", ok: true }]).includes("并没有实际执行"), false);
  check("selectNote 执行失败 → 仍提示", buildFinalContent("已为您打开。", "", [{ name: "selectNote", ok: false }]).includes("并没有实际执行"), true);
  check("工具轮已写正文被保留", buildFinalContent("好的。", "这是工具轮已写的正文", []).includes("这是工具轮已写的正文"), true);
  check("普通表述不算谎报（已为您总结）", hasActionClaim("已为您总结如下"), false);
  check("明显谎报能识别（已为您删除）", hasActionClaim("已为您删除该笔记"), true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
