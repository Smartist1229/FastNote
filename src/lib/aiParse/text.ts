/**
 * 文本后处理纯函数：剥离协议标签、清洗会话标题、格式化错误、校验「声称已完成」。
 *
 * 与 parse.ts 的分工：parse 把一次输出拆成结构化字段；本文件负责展示前清洗与最终事实校验。
 * 供 AIChatPanel 及标题/摘要等旁路调用；所有函数都不抛异常，空输入按各自的空值语义处理。
 */

import type { ToolTrace } from "@/interface/aiOutput";

/* ---------- 标签剥离 ---------- */

/**
 * 剥离标准 <thinking>/<tool_calls> 块，顺序即容错策略：
 *   1. 先删完整块；
 *   2. 再删从开标签到结尾的未闭合片段（被输出上限截断时）；
 *   3. 最后删孤立的闭合标签（漏写开标签时会剩下）。
 * 只认标准标签；别名请先用 parse.ts 的 normalizeAiTags 归一化。
 */
export const stripTaggedBlocks = (text: string): string =>
  text
    .replace(/<thinking>[\s\S]*?<\/thinking>/g, "")
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, "")
    .replace(/<thinking>[\s\S]*/g, "")
    .replace(/<tool_calls>[\s\S]*/g, "")
    // 漏写开标签时会留下孤立的闭合标签
    .replace(/<\/?thinking>/g, "")
    .replace(/<\/?tool_calls>/g, "");

/** 供界面侧复用的别名（标题生成、摘要清洗），行为与 stripTaggedBlocks 相同 */
export const stripAiTags = stripTaggedBlocks;

/** 取第一个非空行（逐行 trim），超过 max 字截断并加省略号；用于思考折叠态预览 */
export const firstLine = (text: string, max = 90): string => {
  const line = text.split("\n").map(s => s.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/**
 * 把 Tauri 的 reject 值转成可读文案：null/undefined → 「未知错误」，
 * 字符串原样返回，Error 取 message，其余对象尝试 JSON.stringify。
 * Tauri 命令的 Err(String) 会以字符串 reject，因此字符串分支是常见路径。
 */
export const formatError = (error: unknown): string => {
  if (error == null) return "未知错误";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
};

/* ---------- 会话标题清洗 ---------- */

/**
 * 清洗模型返回的会话标题；无效时返回空串（调用方据此保留「新对话」并允许重试）。
 *
 * 步骤：剥协议标签 → 去残余标签 → 去 markdown 记号/引号书名号 → 去「标题:」前缀 →
 * 取第一行 → 去尾部标点 → 仍含 thinking/reasoning/尖括号则判为无效。
 * 最长 12 字；空串与无效值都表示「不要写库」。
 */
export const cleanSessionTitle = (raw: string): string => {
  const text = stripTaggedBlocks(raw || "")
    .replace(/<[^>]*>/g, "")                    // 其它残留标签
    .replace(/^#+\s*/, "")                      // markdown 标题记号
    .replace(/[*#`_~]/g, "")
    .replace(/["'「」『』《》【】]/g, "")
    .replace(/^\s*(?:标题|title)\s*[:：]\s*/i, "")
    .split("\n").map(s => s.trim()).filter(Boolean)[0] || "";
  const title = text.replace(/[。！？!?，,、：:；;.\s]+$/g, "").trim();
  // 仍然夹带 "thinking / reasoning" 字样的一律判为无效，宁可保持"新对话"
  if (!title || /thinking|reasoning|<|>/i.test(title)) return "";
  return title.slice(0, 12);
};

/* ---------- 事实校验 ---------- */

/**
 * 抹掉「引用内容」，只留模型对自己动作的陈述，供事实校验使用。
 * 依次去掉围栏代码块、行内代码、引用行、中日文书名/引号、最多 200 字的英文双引号片段。
 * 目的：总结或翻译笔记时，笔记原文里的「已移动到读书分组」不能被当成模型的动作。
 * 局限：不处理嵌套引号；超长的英文引号段落可能残留（正则限长以避免回溯失控）。
 */
export const stripQuotedText = (text: string): string =>
  (text || "")
    .replace(/```[\s\S]*?```/g, " ")      // 代码块
    .replace(/`[^`\n]*`/g, " ")            // 行内代码
    .replace(/^[ \t]*>.*$/gm, " ")         // 引用行
    .replace(/「[^」]*」/g, " ")
    .replace(/『[^』]*』/g, " ")
    .replace(/《[^》]*》/g, " ")
    .replace(/“[^”]*”/g, " ")
    .replace(/"[^"\n]{0,200}"/g, " ")
    .replace(/‘[^’]*’/g, " ");

/** 声称前缀：「已/已经/成功」后可接「为/把/将 + 它/其/这条笔记…」 */
const CLAIM_PREFIX = "(?:已|已经|成功)\\s*(?:为[你您]|把|将)?\\s*(?:它|其|这条笔记|该笔记|这条分组|该分组)?\\s*";
/** 把动词表拼成完整规则（不加 ^，允许出现在句中） */
const claimRe = (verbs: string) => new RegExp(`${CLAIM_PREFIX}(?:${verbs})`);

/**
 * 「声称已完成的动作」→「必须真实执行过的工具」。label 用于最终提示。
 *
 * - tools 语义是「任一成功即视为已执行」；
 * - 匹配范围必须限定在 stripQuotedText 之后，否则笔记原文里的句子会被误判；
 * - 「移入回收站」归入删除，移动规则用 (?!回收站) 排除，
 *   否则删完笔记会误报「没有执行移动笔记」。
 */
const ACTION_CLAIM_RULES: { label: string; re: RegExp; tools: string[] }[] = [
  { label: "打开笔记", re: claimRe("打开"), tools: ["selectNote"] },
  { label: "创建笔记/分组", re: claimRe("创建|新建|添加"), tools: ["createNote", "createNotes", "createCategory"] },
  // 口语说法同样常见：「已改好 / 已改完 / 已改动」
  { label: "修改笔记/分组", re: claimRe("修改|更新|改成|改为|重命名|改名|改好|改完|改动|调整"), tools: ["updateNote", "updateCurrentNote", "renameCategory"] },
  { label: "删除笔记/分组", re: claimRe("删除|移除|清空|移入回收站"), tools: ["deleteNote", "deleteCategory", "deleteFromTrash", "emptyTrash"] },
  // (?!回收站)：移入回收站属于删除，不算移动
  { label: "移动笔记", re: claimRe("移动|移到|移至|移入(?!回收站)"), tools: ["moveNote"] },
  { label: "还原笔记", re: claimRe("还原"), tools: ["restoreNote"] },
  { label: "追加内容", re: claimRe("追加"), tools: ["appendToNote"] },
];

/** 正文里是否出现「已完成某操作」的声称（先抹掉引用内容）；调用方据此触发一次重来 */
export const hasActionClaim = (reply: string): boolean => {
  const clean = stripQuotedText(reply);
  return ACTION_CLAIM_RULES.some(rule => rule.re.test(clean));
};

/**
 * 组装最终正文并做事实校验。
 * 1. carriedContent（调工具前已写给用户的正文）非空且未被 finalReply 包含时前置拼接，
 *    避免工具轮里展示过的内容凭空消失，也避免重复；
 * 2. 只把 ok === true 的工具计入「已执行」；
 * 3. 有声称但对应工具都没成功 → 末尾追加引用块提示，列出未验证的动作。
 * 只加标注、不改原文。纯函数，便于单独推演与测试。
 */
export const buildFinalContent = (finalReply: string, carriedContent: string, tools: ToolTrace[]): string => {
  const carried = carriedContent.trim();
  const base = carried && !finalReply.includes(carried) ? `${carried}\n\n${finalReply}` : finalReply;
  const ranTools = new Set(tools.filter(t => t.ok).map(t => t.name));
  // 同样只在"去掉引用内容"后的文本上判断，避免把笔记原文当成模型的动作
  const claimText = stripQuotedText(base);
  const unverified = ACTION_CLAIM_RULES.filter(rule => rule.re.test(claimText) && !rule.tools.some(t => ranTools.has(t)));
  if (unverified.length === 0) return base;
  return `${base}\n\n> ⚠️ 提示：本次回答里并没有实际执行「${unverified.map(r => r.label).join("、")}」，上面的相关表述未经工具结果确认，请以左侧笔记列表的实际状态为准。`;
};
