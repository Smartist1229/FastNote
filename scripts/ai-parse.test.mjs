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
  stripQuotedText,
  cleanSessionTitle,
  compressTranscript,
  estimateTokens,
  finalReplyText,
  hasActionClaim,
  localSummaryFallback,
  parseAssistantText,
  parseStreamContent,
  selectContextWindow,
  shrinkMessage,
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

console.log("\n[8] 标签兼容（模型写歪的标签）");
{
  // 实测故障：模型写 <tool_call>（少个 s），旧代码既不执行也剥不掉，
  // 用户看到的是一段自说自话 + 裸标签，然后对话结束。
  const p1 = parseAssistantText("<thinking>要读笔记。</thinking>\n<tool_call>[{\"name\":\"getNoteContent\",\"args\":{\"noteId\":\"89\"}}]</tool_call>");
  check("单数 <tool_call> 能解析执行", p1.toolCalls.map(c => c.name), ["getNoteContent"]);
  check("单数 <tool_call> 不会残留在正文", /tool_call/.test(p1.reply), false);

  const p2 = parseAssistantText("<Thought>先看看。</Thought>\n好的，我来回答。<tool_calls>[{\"name\":\"getCategories\",\"args\":{}}]</tool_calls>");
  check("<Thought> 被当作思考", p2.thinking, "先看看。");
  check("<Thought> 不会残留正文", /Thought/.test(p2.reply), false);

  const p3 = parseAssistantText("<thinking>查一下。</thinking>\n<function_call>[{\"name\":\"listNotes\",\"args\":{}}]</function_call>");
  check("<function_call> 能解析", p3.toolCalls.map(c => c.name), ["listNotes"]);

  const p4 = parseAssistantText("<thinking>单个对象写法。</thinking>\n<tool_calls>{\"name\":\"getCategories\",\"args\":{}}</tool_calls>");
  check("工具调用写成单个对象也能解析", p4.toolCalls.map(c => c.name), ["getCategories"]);

  const p5 = parseAssistantText("<thinking>截断。</thinking>\n<tool_call>[{\"name\":\"getNoteContent\",\"args\":{\"noteId\":\"89\"}}");
  check("单数标签写到一半 → 识别为截断（触发重试）", p5.truncated, true);
  check("单数标签写到一半 → 正文无标签残留", /tool_call/.test(p5.reply), false);
}

console.log("\n[9] 上下文压缩（记忆管理）");
{
  check("token 估算：中文按字数", estimateTokens("中".repeat(100)), 100);
  check("token 估算：英文按 4 字符 1 token", estimateTokens("a".repeat(400)), 100);

  const long = "甲".repeat(5000);
  const shrunk = shrinkMessage(long);
  check("超长消息被折叠（远小于原文）", shrunk.length < 2000, true);
  check("折叠后保留头部内容", shrunk.startsWith("甲".repeat(100)), true);

  const msgs = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `第${i}条 ` + "乙".repeat(500) }));
  const { kept, dropped } = selectContextWindow(msgs, 3000, 8);
  check("超预算时确实丢弃了更早的消息", dropped.length > 0, true);
  check("至少保留最近 8 条完整消息", kept.length >= 8, true);
  check("保留的必然是最后若干条", kept[kept.length - 1].content.includes("第39条"), true);
  check("丢弃的必然在更早的位置", dropped[dropped.length - 1].content.includes(`第${dropped.length - 1}条`), true);

  const small = [{ role: "user", content: "你好" }, { role: "assistant", content: "在的" }];
  check("远低于预算时不丢任何消息", selectContextWindow(small, 3000, 8).dropped.length, 0);

  check("本地兜底说明会提到省略条数", localSummaryFallback([{ role: "user", content: "最早的提问" }]).includes("1 条对话"), true);
  check("摘要输入不会超长", compressTranscript(dropped, 500).length <= 500 + 20, true);
}

console.log("\n[10] 事实校验不得误报（引用内容 / 移入回收站 ≠ 移动）");
{
  // 误报 1：删除笔记后，回复里说"已移入回收站"，被当成"没有执行移动笔记"
  const delReply = "已把《山居遇友记》移入回收站，可以随时还原。";
  check("删除后说'已移入回收站'且删过笔记 → 不提示", buildFinalContent(delReply, "", [{ name: "deleteNote", ok: true }]).includes("并没有实际执行"), false);

  // 误报 2：总结/翻译时，笔记原文里的话被当成模型的动作
  const summaryReply = "这篇笔记里写着「已经移动到读书分组」，另外还提到「已删除旧稿」。以下是总结：……";
  check("总结里引用笔记原文 → 不提示", buildFinalContent(summaryReply, "", [{ name: "getNoteContent", ok: true }]).includes("并没有实际执行"), false);
  check("代码块里的动作句式 → 不算声称", hasActionClaim("```\n已经删除了所有文件\n```"), false);
  check("引用行里的动作句式 → 不算声称", hasActionClaim("> 已经移动了笔记"), false);

  // 该报的还得报：真的谎报
  check("谎报'已删除'且没执行 → 提示", buildFinalContent("已删除该笔记。", "", []).includes("并没有实际执行"), true);
  check("谎报'已移入回收站'且没执行 → 提示", buildFinalContent("已将其移入回收站。", "", []).includes("并没有实际执行"), true);
  check("谎报'已移动'且没执行 → 提示", buildFinalContent("已移动到读书分组。", "", []).includes("并没有实际执行"), true);
  check("真的移动过 → 不提示", buildFinalContent("已移动到读书分组。", "", [{ name: "moveNote", ok: true }]).includes("并没有实际执行"), false);
  check("hasActionClaim：'已移动到分组'为真", hasActionClaim("已移动到读书分组"), true);
  check("hasActionClaim：'已移入回收站'属于删除而非移动", hasActionClaim("已移入回收站"), true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
