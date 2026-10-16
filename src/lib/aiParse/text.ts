/* 标签剥离、会话标题清洗、文案/错误格式化，以及最终回复的事实校验纯函数。 */

import type { ToolTrace } from "@/interface/aiOutput";

/* ---------------- 标签剥离 ---------------- */

/**
 * 剥离 <thinking>/<tool_calls> 块——包含未闭合的尾部片段与孤立的闭合标签。
 * 模型被长度限制截断、或漏写开标签时，半截的 <tool_calls>[{"name":... 以及
 * 孤零零的 </tool_calls> 绝不能被当成正文渲染出来。
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

/** 供界面侧（如标题生成）复用的标签剥离 */
export const stripAiTags = stripTaggedBlocks;

/** 思考行折叠态显示的一行预览 */
export const firstLine = (text: string, max = 90): string => {
  const line = text.split("\n").map(s => s.trim()).find(Boolean) || "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** 把（Tauri 返回的）错误转成可读文案 */
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

/* ---------------- 会话标题清洗 ---------------- */

/**
 * 把模型返回的标题文本洗干净。
 * 标题生成这次调用同样会命中"必须深度思考"的系统提示，模型可能回 <thinking>…</thinking>；
 * 早期实现只删掉了尖括号，于是 <thinking>用</thinking> 变成了标题"thinking用"。
 * 这里先整块剥掉思考/工具标签，再去 markdown 记号、引号书名号，只取第一行。
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

/* ---------------- 事实校验 ---------------- */

/**
 * 去掉"引用来的内容"，只保留模型对自己动作的陈述。
 *
 * 事实校验以前直接在整段正文上匹配，于是两类误报：
 *   1. 总结/翻译笔记时，**笔记原文里**写着"已移动到读书分组"被当成模型自己的动作；
 *   2. 代码块、引用块里同样会出现这类句式。
 * 这里把引号内、代码块内、引用行内、书名号内的内容先抹掉再判断。
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

/**
 * "模型声称已完成的动作" ↔ "必须真实执行过的工具"。
 * 用于最终回复的事实校验：说了"已打开"就必须真的调过 selectNote。
 *
 * 规则要点：
 *   - "移入回收站"属于**删除**（deleteNote/deleteCategory），不属于移动；
 *     移动规则里用负向断言把这个说法排除掉，否则删完笔记会误报"没有执行移动笔记"。
 *   - 只在去掉引用内容后的文本上匹配（见 stripQuotedText）。
 */
/**
 * 声称前缀："已/已经/成功"之后允许接"为/把/将 + 它/其/这条笔记…"，
 * 这样"已将其移入回收站""已把它删除了"这类说法也能识别到。
 */
const CLAIM_PREFIX = "(?:已|已经|成功)\\s*(?:为[你您]|把|将)?\\s*(?:它|其|这条笔记|该笔记|这条分组|该分组)?\\s*";
const claimRe = (verbs: string) => new RegExp(`${CLAIM_PREFIX}(?:${verbs})`);

const ACTION_CLAIM_RULES: { label: string; re: RegExp; tools: string[] }[] = [
  { label: "打开笔记", re: claimRe("打开"), tools: ["selectNote"] },
  { label: "创建笔记/分组", re: claimRe("创建|新建|添加"), tools: ["createNote", "createNotes", "createCategory"] },
  // 修改类补上口语说法："已改好 / 已改完 / 已改动" —— 模型谎报时常常就是这么说的
  { label: "修改笔记/分组", re: claimRe("修改|更新|改成|改为|重命名|改名|改好|改完|改动|调整"), tools: ["updateNote", "updateCurrentNote", "renameCategory"] },
  // "移入回收站"属于删除动作；移动规则里用负向断言排除它，
  // 否则删完笔记会被误报成"没有执行移动笔记"。
  { label: "删除笔记/分组", re: claimRe("删除|移除|清空|移入回收站"), tools: ["deleteNote", "deleteCategory", "deleteFromTrash", "emptyTrash"] },
  { label: "移动笔记", re: claimRe("移动|移到|移至|移入(?!回收站)"), tools: ["moveNote"] },
  { label: "还原笔记", re: claimRe("还原"), tools: ["restoreNote"] },
  { label: "追加内容", re: claimRe("追加"), tools: ["appendToNote"] },
];

/** 正文里是否出现了"已完成某操作"的表述（用于纠正"谎报操作"的回复） */
export const hasActionClaim = (reply: string): boolean => {
  const clean = stripQuotedText(reply);
  return ACTION_CLAIM_RULES.some(rule => rule.re.test(clean));
};

/**
 * 组装最终正文：保留工具轮里已经写给用户的正文，并对"声称已完成但没执行"做事实校验。
 * 纯函数，便于单独推演/测试。
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
