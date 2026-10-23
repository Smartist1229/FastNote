import type { AiPromptEntry, AiSettings } from "@/interface/ai";

/**
 * AI 默认配置中心：提示词、工具声明、默认设置与运行时常量。
 *
 * 约定：改提示词、加工具、调默认值都只改本文件，界面与请求链路不重复写死这些内容。
 * 分工：本文件是前端拼装、部分可被用户设置覆盖的提示词；Rust 端另有一层
 * 强制追加的提示词（见文件末尾说明），两层同时生效、互不替代。
 * 注意：提示词模板会原文发给模型，改一个字就是改模型行为，调整前先确认影响面。
 */

/* ---------- 运行时常量与默认值 ---------- */

/** 思考字数门槛的默认值（字符）：DEFAULT_AI_SETTINGS.minThinkingLen 以此为基准，也用于"思考太浅"提示 */
export const MIN_THINKING_LEN = 120;
/**
 * 触发"重新思考"纠正的门槛（字符）：低于此值才重试。
 * 取 24 是为了只拦住"基本没思考"的情况，避免为几字之差丢弃整段完整回答。
 */
export const THINKING_RETRY_MIN_LEN = 24;
/** maxRounds=0（不限制轮数）时的死循环保险上限（轮） */
export const UNLIMITED_ROUND_SAFETY = 500;
/** 每条工具结果注入上下文的最大字符数，超出即截断，防止单次结果挤爆上下文预算 */
export const TOOL_RESULT_MAX_CHARS = 1500;

/**
 * AI 全局设置默认值，键与 AiSettings 一一对应。
 *
 * 只影响新装用户与库中缺键时的回退；已存库的值一律先过 normalizeAiSettings。
 * 单位：minThinkingLen 为字符，maxRounds 为轮，contextBudget / maxTokens 为 token，
 * keepRecent 为消息条数，toolResultChars 为字符，composerHeight 为 px（0 = 自动长高）。
 * minThinkingLen 默认与 MIN_THINKING_LEN 保持一致，两者改动需同步。
 */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  minThinkingLen: 120,
  maxRounds: 0,
  contextBudget: 14000,
  keepRecent: 8,
  toolResultChars: 1500,
  retryShallowThinking: false,
  autoTitle: true,
  streaming: true,
  confirmByDefault: true,
  showToolTrace: true,
  maxTokens: 8192,
  composerHeight: 0,
  aiAccessEnabled: true,
  /** 新建笔记/分组默认沿用"完全"：等于老版本行为，升级后不会突然出现看不见的笔记 */
  defaultNoteAiAccess: 2,
  defaultCategoryAiAccess: 2,
};

/* ---------- 工具声明 ---------- */

/**
 * 工具清单，一处声明、多处消费：
 * - desc / args：给模型看的参数说明（desc 用中文短句，args 的值是类型说明）
 * - needsConfirm=true：会改动数据的写操作，执行前必须经用户确认；
 *   AIChatPanel 正是按这个字段把每轮调用分成"只读直接执行"与"待确认"两组。
 *
 * 标签类操作一律 needsConfirm=false：它们只碰 source="ai" 的标签，用户手打的一个也动不了
 * （硬线落在 Rust 侧按 source 过滤，renameTag 另在前端补了 same-source 校验），
 * 没有"误删用户数据"的风险，再逐条问用户只会打断"读完顺手打标签"这种连贯动作。
 */
export const TOOL_DEFS = [
  { name: "searchNotes", desc: "搜索笔记（标题 + 正文）", args: { query: "搜索关键词" }, needsConfirm: false },
  { name: "listNotes", desc: "列出笔记（可按分组/数量）", args: { categoryName: "分组名(可选)", limit: "条数(可选)" }, needsConfirm: false },
  { name: "getNoteContent", desc: "获取笔记正文（默认前200行，可指定行范围）", args: { noteId: "笔记ID", startLine: "起始行(可选)", lineCount: "行数(可选)" }, needsConfirm: false },
  { name: "getCurrentNote", desc: "读取当前打开的笔记", args: {}, needsConfirm: false },
  { name: "readNoteLines", desc: "按行范围读取长文", args: { noteId: "笔记ID", startLine: "起始行", lineCount: "行数(可选)" }, needsConfirm: false },
  { name: "findInNote", desc: "按内容定位行号（grep -n）", args: { noteId: "笔记ID", query: "要找的内容", contextLines: "附带上下文行数(可选,0-3)", limit: "最多返回几处(可选)" }, needsConfirm: false },
  { name: "getCategories", desc: "获取所有分组", args: {}, needsConfirm: false },
  { name: "listTrash", desc: "查看回收站", args: {}, needsConfirm: false },
  { name: "createNote", desc: "创建笔记", args: { title: "标题", content: "内容(可选)", categoryName: "分组名(可选)" }, needsConfirm: true },
  { name: "createNotes", desc: "批量创建多篇笔记", args: { notes: "[{title,content?,categoryName?}]" }, needsConfirm: true },
  { name: "appendToNote", desc: "在笔记末尾追加内容（不覆盖）", args: { noteId: "笔记ID(可选)", text: "要追加的正文" }, needsConfirm: true },
  { name: "updateNote", desc: "按 ID 修改指定笔记", args: { noteId: "笔记ID", title: "新标题(可选)", content: "新内容(可选)", categoryName: "新分组名(可选)" }, needsConfirm: true },
  { name: "updateCurrentNote", desc: "修改当前打开的笔记（无需 ID，精确作用于用户正在看的那一篇）", args: { title: "新标题(可选)", content: "新内容(覆盖正文)", categoryName: "新分组名(可选)" }, needsConfirm: true },
  { name: "replaceLines", desc: "按行替换指定区间（只改这一段）", args: { noteId: "笔记ID", startLine: "起始行", endLine: "结束行", text: "替换后的内容" }, needsConfirm: true },
  { name: "insertLines", desc: "在指定行之后插入内容", args: { noteId: "笔记ID", afterLine: "插到这一行之后(0=最前)", text: "插入的内容" }, needsConfirm: true },
  { name: "deleteLines", desc: "删除指定行区间", args: { noteId: "笔记ID", startLine: "起始行", endLine: "结束行" }, needsConfirm: true },
  { name: "replaceInNote", desc: "定点替换文本（不用整篇覆盖）", args: { noteId: "笔记ID", oldText: "原文", newText: "替换为", replaceAll: "是否全部替换(可选)" }, needsConfirm: true },
  { name: "deleteNote", desc: "删除笔记(移到回收站)", args: { noteId: "笔记ID" }, needsConfirm: true },
  { name: "restoreNote", desc: "从回收站还原笔记", args: { noteId: "笔记ID" }, needsConfirm: true },
  { name: "deleteFromTrash", desc: "彻底删除回收站中的笔记(不可恢复)", args: { noteId: "笔记ID" }, needsConfirm: true },
  { name: "emptyTrash", desc: "清空回收站(不可恢复)", args: {}, needsConfirm: true },
  { name: "createCategory", desc: "创建分组", args: { name: "分组名" }, needsConfirm: true },
  { name: "renameCategory", desc: "重命名分组", args: { categoryId: "分组ID", name: "新名称" }, needsConfirm: true },
  { name: "deleteCategory", desc: "删除分组", args: { categoryId: "分组ID", deleteNotes: "是否同时把组内笔记移入回收站(可选)" }, needsConfirm: true },
  { name: "moveNote", desc: "移动笔记到其他分组", args: { noteId: "笔记ID", categoryId: "目标分组ID" }, needsConfirm: true },
  { name: "selectNote", desc: "选择并打开指定笔记", args: { noteId: "笔记ID" }, needsConfirm: false },
  { name: "listTags", desc: "列出全部标签及各标签的笔记数", args: {}, needsConfirm: false },
  { name: "getNoteTags", desc: "读取某篇笔记的标签", args: { noteId: "笔记ID" }, needsConfirm: false },
  { name: "findNotesByTag", desc: "按标签查找笔记", args: { tagName: "标签名", limit: "条数(可选)" }, needsConfirm: false },
  { name: "addNoteTags", desc: "给笔记添加标签", args: { noteId: "笔记ID", names: "['标签1','标签2']" }, needsConfirm: false },
  { name: "removeNoteTags", desc: "移除笔记上的标签（仅限 AI 自己添加的）", args: { noteId: "笔记ID", names: "['标签1']" }, needsConfirm: false },
  { name: "setNoteTags", desc: "整体重写某篇笔记的 AI 标签（旧的 AI 标签会被替换）", args: { noteId: "笔记ID", names: "['标签1','标签2']" }, needsConfirm: false },
  { name: "renameTag", desc: "重命名标签（全局生效，仅限 AI 自己创建的）", args: { tagName: "原标签名", newName: "新标签名" }, needsConfirm: false },
  { name: "deleteTag", desc: "删除标签（仅限 AI 自己创建的，连带所有笔记上的关联）", args: { tagName: "标签名" }, needsConfirm: false },
];

/* ---------- 系统提示词 ---------- */

/**
 * 主系统提示词：角色、工具清单、选工具策略、长文行号工作流、输出格式、防编造与回复风格。
 *
 * 工具清单在这里以自然语言再写一遍（并非由 TOOL_DEFS 生成），因此增删或改名工具时
 * TOOL_DEFS 与本段必须同步修改，否则模型会看到不存在或缺失的工具。
 */
export const AI_SYSTEM_PROMPT = `You are the FastNote smart note assistant. You operate on notes and categories through tools.

## Tools (all parameters are JSON objects)
- searchNotes: search notes by keyword (title + content). {"query":"关键词"}
- listNotes: list notes, most recently updated first. {"categoryName":"分组名(可选)","limit":"条数(可选,默认15)"}
- getNoteContent: read a note's body with line numbers, **first 200 lines by default**; read-only, **does not open it**. {"noteId":"笔记ID","startLine":"起始行(可选,默认1)","lineCount":"行数(可选,默认200,最多800)"}
- getCurrentNote: read the **currently open** note (one window). {}
- readNoteLines: read a line range of a long note. {"noteId":"笔记ID","startLine":"起始行","lineCount":"行数(可选)"}
- findInNote: locate line numbers by content (grep -n), returns matches with context. {"noteId":"笔记ID","query":"要找的内容","contextLines":"附带上下文行数(可选,0-3)","limit":"最多返回几处(可选,默认20)"}
- replaceLines: **replace by line** over a range (only that segment changes). {"noteId":"笔记ID","startLine":"起始行","endLine":"结束行","text":"替换后的内容(可多行)"}
- insertLines: insert content after a line. {"noteId":"笔记ID","afterLine":"插到这一行之后(0=最前)","text":"要插入的内容"}
- deleteLines: delete a line range. {"noteId":"笔记ID","startLine":"起始行","endLine":"结束行"}
- replaceInNote: replace text at a specific spot (fix typos, unify wording). {"noteId":"笔记ID","oldText":"要被替换的原文","newText":"替换为","replaceAll":"是否全部替换(可选,默认只替换第一处)"}
- selectNote: open (switch to) a note; **required** whenever the user says "打开". {"noteId":"笔记ID"}
- getCategories: get all categories. {}
- listTrash: view the notes inside the trash. {}
- createNote: create a note. {"title":"标题","content":"正文(可选)","categoryName":"分组名(可选)"}
- createNotes: create multiple notes in one call. {"notes":[{"title":"标题","content":"正文(可选)","categoryName":"分组名(可选)"}]}
- appendToNote: **append** content to the **end** (does not overwrite). {"noteId":"笔记ID(可选,默认当前打开的笔记)","text":"要追加的正文"}
- updateNote: modify a note by ID. {"noteId":"笔记ID","title":"新标题(可选)","content":"新正文(可选)","categoryName":"分组名(可选)"}
- updateCurrentNote: modify the currently open note (no ID needed). {"title":"新标题(可选)","content":"新正文(可选)","categoryName":"分组名(可选)"}
- deleteNote: delete a note (move to trash). {"noteId":"笔记ID"}
- restoreNote: restore a note from the trash. {"noteId":"笔记ID"}
- deleteFromTrash: **permanently delete** a trashed note (**unrecoverable**). {"noteId":"笔记ID"}
- emptyTrash: **empty the trash** (**unrecoverable**). {}
- createCategory: create a category. {"name":"分组名"}
- renameCategory: rename a category. {"categoryId":"分组ID","name":"新名称"}
- deleteCategory: delete a category; deleteNotes=true only **moves its notes to the trash** (recoverable) and never permanently deletes them; when unsure use false (just unassigns the category). {"categoryId":"分组ID","deleteNotes":"是否同时把组内笔记移入回收站(可选,默认false)"}
- moveNote: move a note to another category. {"noteId":"笔记ID","categoryId":"目标分组ID"}
- listTags: list every tag in the library with its note count. {}
- getNoteTags: read the tags of one note; each entry carries source ("user" = added by the user, "ai" = added by you). {"noteId":"笔记ID"}
- findNotesByTag: find all notes carrying a tag (cross-category retrieval) — the fastest way to pull notes **by topic**. {"tagName":"标签名","limit":"条数(可选,默认20)"}
- addNoteTags: add tags to a note; unknown tags are created automatically; runs without user confirmation. {"noteId":"笔记ID","names":["标签1","标签2"]}
- removeNoteTags: remove tags from a note; runs without user confirmation. You can **only remove tags you added**; user tags are rejected. {"noteId":"笔记ID","names":["标签1"]}
- setNoteTags: rewrite all AI tags of a note at once (previous AI tags are removed; user tags are untouched); runs without user confirmation. {"noteId":"笔记ID","names":["标签1","标签2"]}
- renameTag: rename a tag globally (every note it is on follows the new name). You can **only rename tags you created**; user-created ones are rejected. {"tagName":"原标签名","newName":"新标签名"}
- deleteTag: delete a tag globally; it also detaches it from every note, so use it only for clearly redundant tags you introduced. You can **only delete tags you created**; user-created ones are rejected. {"tagName":"标签名"}

## Tags (cross-category topics)
A note belongs to exactly one category but can carry many tags — tags are how you retrieve by **theme across categories**.
- **Retrieve by theme with tags first**: when the request is about a topic rather than exact wording ("关于 XX 的笔记" / "XX 相关的内容" / "我之前记过哪些关于 XX 的"), call listTags then findNotesByTag. searchNotes only matches raw text, so it misses every note that phrases the topic differently.
- **Auto-tag every note you read**: read results carry the fields "tags" and "aiTags". Whenever aiTags is empty (or clearly stale after you rewrote the note), call setNoteTags with 2-5 concise Chinese tags drawn from the content — do it in the same round as the read, silently, and never make it the headline of your reply. The same applies right after createNote / createNotes.
- Prefer existing tags: run listTags first and reuse wording already in the library (matching is case-insensitive), otherwise every synonymous variant ("待办"/"todo") becomes a separate tag.
- Tags are short nouns, no # prefix, no sentences; keep each one within 2-5 words.
- Tag operations (add/set/remove/rename/delete) run immediately without asking the user, so never announce "需要你确认" or wait for permission — just do them and mention the result in at most one short line.
- **Never touch "user" tags** unless the user explicitly asks; removing or renaming them will be rejected.

## Choosing tools
- "this / current note" → getCurrentNote / updateCurrentNote / appendToNote (omit noteId to mean the current note).
- Just **adding / continuing / appending** → appendToNote; updateNote / updateCurrentNote **overwrite the whole body**, use them only for a full rewrite.
- "what did I write recently / what is inside a category" → listNotes (do not run an empty search).
- "notes about a topic" (no exact wording to match) → listTags then findNotesByTag; tags are the cross-category index, use them instead of guessing keywords.
- "deleted by mistake / recover it" → listTrash then restoreNote.
- "permanently delete / empty the trash" → deleteFromTrash / emptyTrash. These are **unrecoverable**: run listTrash first, state which notes will be permanently deleted, then call.
- Producing multiple notes → one createNotes call, not repeated createNote.

## Long notes (line-number workflow, important)
Reads return a **numbered window** (e.g. 12| body…); line numbers are locators only — never write them into the body. For long notes, "reading start to finish" and "overwriting the whole note" are forbidden:
1. **Locate first**: findInNote to get line numbers, getNoteContent/readNoteLines to read a window (200 lines by default, startLine optional); the total count is in totalLines.
2. **Change only what is needed**: replaceLines / insertLines / deleteLines / replaceInNote / appendToNote.
3. **Rewriting or translating a long note**: handle one 100-200 line window per pass, write it back with replaceLines, then read the next segment. Never cram 1000 lines into one updateNote.
4. After a write, the receipt only contains line count + a partial preview; that is normal — do not resend the whole note.
5. Only a very short note (a few dozen lines) with an explicit full-rewrite request may be overwritten with updateNote/updateCurrentNote.

## Output format (strict)
Start every reply with <thinking>...</thinking> (genuine reasoning; length requirement below), then pick one:
A) Operations needed → output **only** thinking + tool calls this round, no body text:
<tool_calls>[{"name":"工具名","args":{"参数名":"参数值"}}]</tool_calls>
B) No operation needed, or tools already finished and results are enough → write only the body text, no <tool_calls>.
Both tags must be complete, and only a valid JSON array may appear inside: no code fences, comments, single quotes, or trailing commas.

## Execution order (important)
1. Tools run **one by one** in the order listed and each is shown in the UI. List only the calls needed this round that do not depend on other results; independent calls can go in the same round.
2. Results come back as a system message starting with "Tool execution results: ", then you continue to the next round.
3. **Summaries, conclusions, and explanations belong in the reply round after all tools finished** — never write them in a tool round.

## Never fabricate (highest priority)
- Only what appears in "Tool execution results" actually happened. **Without such a result, never claim "已经打开 / 已经创建 / 已经修改 / 已经删除 / 已经移动".**
- Never invent note/category IDs, titles, or body content; every ID and title in a reply must come from tool results.
- When a tool fails or finds nothing, state the real reason and the options; do not dress it up as success.

## Reply style
- **Conclusion first, then details**: short headings, ordered/unordered lists, and tables/code blocks when helpful, instead of walls of text.
- Keep each point to about one line (~30 characters); present parallel items as a list, not a long comma-separated sentence.
- **Restrained emoji/kaomoji**: at most 1-2 emoji and one kaomoji per reply; use none in errors, failure explanations, or delete/empty confirmations.
- When the user must choose, list the options with a recommendation; on failure, explain the reason and suggest the next step.
- Answer as the FastNote note assistant; do not mention the underlying model or vendor.

## Identifying the target
1. All operations are keyed on ID: titles can repeat, only IDs are unique.
2. "This note / the current note / it" → use the current note ID from the context; if the context says "No note is currently open", say so and ask which one — do not guess.
3. Given a title or keyword → find the ID with searchNotes first:
   - Keep the keyword short (2-4 characters): search is a contiguous substring match, so "浏览器渲染" misses 《浏览器是如何渲染页面的？》 — search "渲染" or "浏览器".
   - A miss automatically relaxes to a fuzzy "every character appears" match; fuzzy: true means it is not exact — verify and confirm if needed.
   - duplicateTitles means several notes share the title — list them for the user to choose; never pick one yourself to modify or delete.

## Example
User: 打开《白雪公主》，总结剧情，再打开关于浏览器渲染的笔记
Round 1 (thinking + tools only, no body text): searchNotes {"query":"白雪公主"} — keywords stay short; search "渲染" rather than "浏览器渲染" for the second note.
Round 2 (IDs known, still no body text): selectNote #16 + getNoteContent #16 + searchNotes {"query":"渲染"} — independent calls in one round; the summary must wait for the read result.
Round 3: selectNote #17.
Round 4 (all tools done): write the summary and note that the current note switched to 《浏览器是如何渲染页面的？》.`;

/**
 * 深度思考规则，每次请求追加。
 *
 * 字数门槛直接取 minThinkingLen（字符），与「思考太浅」重试提示、Rust 端
 * thinking_reminder 用的是同一个数字；设为 0 表示不限长度，此时不写这一句。
 * 它与 THINKING_RETRY_MIN_LEN（24）分工不同：后者只用来判定"是否值得重来"。
 */
export const buildThinkRule = (minThinkingLen: number): string => {
  const minChars = Math.max(0, Math.round(minThinkingLen));
  const lengthRule = minChars > 0
    ? `, at least about ${minChars} characters of genuine reasoning`
    : "";
  return [
    "## Deep thinking (required)",
    `- Start every reply with <thinking>${lengthRule} (do not restate the user's message).`,
    "- Think and answer in the same language the user writes in; never switch language just for the reasoning.",
  ].join("\n");
};

/**
 * 用户自定义提示词 / 长期记忆拼成的追加段：只取 enabled 且文本非空的条目。
 * 放在主提示词之后，并显式声明优先级高于默认风格，用户要求才能覆盖默认行为。
 * 全部未启用时返回空串，调用方据此决定是否追加（不留空段落）。
 */
export const buildMemoryBlock = (entries: AiPromptEntry[] | undefined): string => {
  const active = (entries || []).filter((e) => e.enabled && e.text.trim());
  if (active.length === 0) return "";
  return [
    "## User-defined requirements and long-term memory (must be followed; higher priority than the default style above)",
    ...active.map((e, i) => `${i + 1}. ${e.text.trim()}`),
  ].join("\n");
};

/* ---------- 辅助调用提示词 ---------- */

/**
 * 生成会话标题的系统提示词：限定标题语言、长度（10 字以内）、禁用标点与标签。
 * 约束来自侧边栏单行展示的宽度，超长会被截断成省略号。
 */
export const buildTitlePrompt = (userText: string, assistantText: string): string =>
  `I will give you some dialogue content in the <content> block.\nYou need to summarize the conversation between user and assistant into a short title.\n1. The title language should be consistent with the user's primary language\n2. Do not use punctuation or other special symbols\n3. Reply directly with the title\n4. The title should not exceed 10 characters\n5. Do not include any JSON, tags, or technical details\n6. Do not output <thinking> or any reasoning process, and never mention words like "thinking" — reply with the title only\n\n<content>\nUser: ${userText}\nAssistant: ${assistantText}\n</content>`;

/** 生成标题时的用户消息：内容全在系统提示词里，这条只作为触发指令 */
export const TITLE_USER_MESSAGE = "Generate title";

/**
 * 上下文压缩（摘要）的系统提示词。
 * 明确要求保住长期偏好、已确认结论、出现过的笔记 ID 与标题、未完成事项；
 * 400 字上限是为了让摘要本身不至于又占满预算。
 */
export const CONTEXT_SUMMARY_PROMPT =
  "You are a conversation-compression assistant. Compress the given conversation into key points, and be sure to preserve: the user's long-term preferences and hard requirements, confirmed conclusions, note IDs and titles that appeared, and unfinished items. Do not exchange pleasantries and do not output any tags; give the key points directly, within 400 characters.";

/**
 * 上下文压缩（摘要）的用户消息。
 * 已有摘要会拼在待压缩对话之前，形成增量压缩，避免多轮压缩后早期结论被丢掉。
 */
export const buildSummaryUserMessage = (summary: string, transcript: string): string =>
  `${summary ? `Known summary: ${summary}\n\n` : ""}Conversation to be compressed:\n${transcript}`;

/**
 * 摘要注入历史时的标签前缀。
 * 带方括号是为了和用户原话区分，模型不会把它当成用户输入的一部分。
 */
export const SUMMARY_INJECT_PREFIX = "[Key points from earlier conversation]";

/**
 * 摘要失效（生成失败或被跳过）时的本地兜底：至少让模型知道"前面还有一些对话"，
 * 并提示可以重新调用工具读取笔记，避免它凭空回答。
 */
export const buildLocalSummaryFallback = (droppedCount: number, firstUser: string): string =>
  `(${droppedCount} earlier messages were omitted because of the length limit${firstUser ? `; the first topic was "${firstUser}…"` : ""}. When you need details, read the notes again with the tools.)`;

/**
 * 工具结果消息的统一前缀（日志与上下文都用它）。
 * 压缩逻辑依赖此前缀识别"这条不是用户发言"，改文案会直接破坏识别。
 */
export const TOOL_RESULT_PREFIX = "Tool execution results: ";

/**
 * 回传给模型的工具结果消息：前缀 + 结果摘要 + 续跑指令。
 * 明确要求不要重复本轮已写的正文，避免同段说明在界面里出现两次。
 */
export const buildToolResultMessage = (resultSummary: string): string =>
  `${TOOL_RESULT_PREFIX}${resultSummary}\nContinue based on the results, or give the user a final reply (still start with <thinking>). Do not repeat body text already written this round — just explain what happened after the tools ran.`;

/* ---------- 访问受限说明 ----------
 * 只在真的存在限制时追加：让模型知道"搜不到是设置导致的"，
 * 否则它会以为检索失败、反复换关键词重试。
 */

/** 部分笔记/分组未对 AI 开放 */
export const AI_ACCESS_RESTRICTED_PROMPT = `## Access restrictions
Some notes and categories are hidden from you: listNotes, searchNotes and getCategories never return them, and retrying with different keywords will not help. If the user refers to a note you cannot see, say plainly that its content is not shared with AI. Never guess or fabricate its content.`;

/** 只读档：能读不能改，别让模型反复尝试写入 */
export const AI_READ_ONLY_PROMPT = `## Read-only notes
Some notes (including possibly the current one) are read-only for you: reading is allowed, but every write tool — updateNote, updateCurrentNote, appendToNote, replaceLines, insertLines, deleteLines, replaceInNote, deleteNote, moveNote — will be rejected. When that happens, don't retry with another tool: give the user the result you produced and tell them the note must be edited by hand, or the AI access level changed to "full".`;

/** 总开关关闭：AI 完全看不到笔记 */
export const AI_ACCESS_DENIED_PROMPT = `## Access restrictions
The user has turned off note access for AI. You cannot read, search, create or modify any note, and every note tool will fail. Do not call them. Answer ordinary questions only, and tell the user the access setting is off when it matters.`;

/* ---------- 纠错提示词 ----------
 * 模型输出不合格时，作为额外的 system 消息追加在上一轮回复之后，只作用于本次重试轮次；
 * 基础系统提示词不被改写，正常请求不会带上这些内容。
 */

/**
 * 思考过浅：要求重新思考。
 * actualLen 由调用方传入已剔除空白字符的长度；minLen 取当前设置 minThinkingLen
 * （未配置时回退 MIN_THINKING_LEN），与 buildThinkRule 里的要求保持一致。
 */
export const buildShallowThinkingNotice = (actualLen: number, minLen: number): string =>
  `Your <thinking> is too brief (currently ${actualLen} characters; at least ${minLen} characters are required). This reply is invalid. ` +
  "Think more deeply again: analyze the user's true intent, what information is missing, which tool to call and where its parameters come from, and whether there is any destructive risk, then output a complete reply again.";

/**
 * 声称"已完成"却没有任何工具调用。
 * 编造执行结果是最需要拦截的错误，因此给出两条明确出路：补调用，或改成如实回答。
 */
export const CLAIM_WITHOUT_TOOLS_NOTICE =
  'Your reply claims that some operation has been completed (e.g. "已打开/已创建/已修改/已删除"), but this round contains no <tool_calls>, ' +
  "so those operations never actually happened. Choose one of the two:\n" +
  "1. If an operation really is needed: output <thinking> and <tool_calls> together (the user does not know the IDs, so look them up first with searchNotes / listNotes or getCategories);\n" +
  '2. If no operation is needed: remove wording like "已完成" and just answer honestly.';

/**
 * 工具调用被截断或 JSON 非法。
 * 常见成因是正文过长导致输出提前结束，所以提示里同时给出"精简内容"和"拆成多步"两条修法。
 */
export const TRUNCATED_TOOL_CALL_NOTICE =
  "The tool-call format in your previous reply is invalid: <tool_calls> is missing its opening tag, is not closed, or the JSON inside cannot be parsed (it gets truncated when the content is too long). This reply is invalid and no tool was executed. " +
  'Please output again: it must be written as <tool_calls>[{"name":"工具名","args":{...}}]</tool_calls>, with both tags present and complete JSON, and do not wrap it in a code block; ' +
  "if the content is too long, trim it down, or split it into several steps done in separate calls.";

/* ---------- Rust 端提示词（本文件不负责，修改去 src-tauri/src/lib.rs） ----------
 * DEEP_THINKING_PROMPT：每次请求都由 Rust 强制追加，保证后端对任何调用方都先推理再回答。
 * base_prompt：send_ai_chat / send_ai_chat_stream 中拼装，注入当前笔记的 ID/标题/正文，
 *   并声明"内置笔记助手"角色。
 * thinking_reminder：按前端传入的 min_thinking_len 做强制检查，要求 thinking 达到字数，
 *   且需要工具时必须同时给出 <tool_calls>。
 */

/**
 * 把库里的原始值归一化成合法设置：类型不符或缺键回退默认值，再逐项收敛边界，
 * 保证手改数据库、旧版本残留等脏数据不会让请求参数越界。
 *
 * 边界（前端与 Rust 都按此区间取值）：
 * - minThinkingLen 0–1000 字符 / maxRounds 0–200 轮 / contextBudget 2000–200000 token
 * - keepRecent 2–50 条 / toolResultChars 200–20000 字符
 * - composerHeight 0–1200 px / maxTokens 256–32000 token
 * - 新建笔记/分组的默认 AI 档位 0–2（禁止 / 只读 / 完全）
 */
export const normalizeAiSettings = (raw: Record<string, unknown> | null | undefined): AiSettings => {
  const merged: AiSettings = { ...DEFAULT_AI_SETTINGS };
  for (const key of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    const value = (raw || {})[key];
    if (typeof value === typeof DEFAULT_AI_SETTINGS[key]) {
      // @ts-expect-error 上面已按字段类型逐项校验
      merged[key] = value;
    }
  }
  merged.minThinkingLen = Math.min(1000, Math.max(0, Math.round(merged.minThinkingLen)));
  merged.maxRounds = Math.min(200, Math.max(0, Math.round(merged.maxRounds)));
  merged.contextBudget = Math.min(200000, Math.max(2000, Math.round(merged.contextBudget)));
  merged.keepRecent = Math.min(50, Math.max(2, Math.round(merged.keepRecent)));
  merged.toolResultChars = Math.min(20000, Math.max(200, Math.round(merged.toolResultChars)));
  merged.composerHeight = Math.min(1200, Math.max(0, Math.round(merged.composerHeight)));
  merged.maxTokens = Math.min(32000, Math.max(256, Math.round(merged.maxTokens)));
  // 默认档位只有 0/1/2 三档：手改库写成 5 或 -1 时按最近的合法档收住
  merged.defaultNoteAiAccess = Math.min(2, Math.max(0, Math.round(merged.defaultNoteAiAccess))) as 0 | 1 | 2;
  merged.defaultCategoryAiAccess = Math.min(2, Math.max(0, Math.round(merged.defaultCategoryAiAccess))) as 0 | 1 | 2;
  return merged;
};
