import * as notesApi from "@/api/note/notes";
import * as categoriesApi from "@/api/note/categories";
import * as tagsApi from "@/api/note/tags";
import type { Note, Tag } from "@/interface/note/note";
import { canAiReadCategory, canAiReadNote, canAiWriteCategory, type AiAccessRules } from "@/lib/ai/aiAccess";

/**
 * 按 ID 精确读取单条笔记（同名笔记也不会取错）。
 *
 * 受限笔记在这里统一变成 null：对 AI 而言它等同于"不存在"，不暴露标题与存在性。
 * 所有读写工具都经过这个函数，所以笔记级权限只需要在这一处判断。
 */
export const fetchNoteById = async (noteId: string, access: AiAccessRules) => {
  // 按 id 取单条：列表虽然也带正文，但没打开的笔记可能刚被别处改过，单条读取更能保证拿到最新内容
  let hit: Note | null = null;
  try {
    hit = await notesApi.getNote(noteId);
  } catch {
    hit = null;
  }
  return hit && !hit.is_deleted && canAiReadNote(access, hit) ? hit : null;
};

/** 列表/搜索类工具共用：只保留未删除、且对 AI 开放的笔记 */
export const visibleNotes = async (access: AiAccessRules) => {
  const all = await notesApi.getNotes(null, "updated_at", "desc");
  return all.filter((n) => !n.is_deleted && canAiReadNote(access, n));
};

/**
 * 按名称找分组，只在"AI 能看到"的分组里找（只读档也算能看到）。
 * 返回 null 表示"不存在或不可访问"，两种情况对模型一视同仁。
 */
export const findCategoryByName = async (categoryName: unknown, access: AiAccessRules) => {
  const name = String(categoryName ?? "").trim();
  if (!name) return null;
  const cats = await categoriesApi.getCategories();
  return cats.find((c) => c.name === name && canAiReadCategory(access, c)) || null;
};

/**
 * 按名称找"可以写入"的分组：新建/移动进去、改名都用它。
 * 只读分组会返回 null —— 能看并不等于能往里写。
 */
export const findWritableCategoryByName = async (categoryName: unknown, access: AiAccessRules) => {
  const name = String(categoryName ?? "").trim();
  if (!name) return null;
  const cats = await categoriesApi.getCategories();
  return cats.find((c) => c.name === name && canAiWriteCategory(access, c)) || null;
};

/**
 * 标签名归一化：模型经常把 names 写成 `"标签1, 标签2"` 这种字符串，甚至带 `#` 前缀。
 * 统一拆成一个干净的数组，去空去重（大小写不敏感），交给 Rust 侧落库。
 */
export const normalizeTagNames = (raw: unknown): string[] => {
  const list = Array.isArray(raw)
    ? raw.map((x) => String(x ?? ""))
    : String(raw ?? "").split(/[,，、;；\n]+/);
  const out: string[] = [];
  for (const item of list) {
    // 去掉行首的 # 与空白：`#待办` 和 `待办` 是同一个标签
    const name = item.trim().replace(/^#+/, "").trim().slice(0, 30);
    if (!name) continue;
    if (!out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
};

/** 把笔记正文按行切片（供"只读某一段"用），返回带行号文本与总行数 */
const sliceNoteLines = (content: string, startLine: number, lineCount: number) => {
  const lines = (content || "").split("\n");
  const from = Math.max(1, Math.floor(startLine) || 1);
  const take = Math.max(1, Math.floor(lineCount) || 1);
  const to = Math.min(lines.length, from + take - 1);
  const numbered = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n");
  return { totalLines: lines.length, from, to, numbered, lines };
};

/** 写回后给模型的紧凑回执：行数 + 局部预览，绝不回传全文 */
export const noteEditReceipt = (lines: string[], changed: string, fromLine: number, toLine: number): string => {
  const from = Math.max(1, fromLine);
  const to = Math.min(lines.length, Math.max(from, toLine));
  const preview = lines.slice(from - 1, to).map((l, i) => `${from + i}| ${l}`).join("\n").slice(0, 600);
  return `（${changed}，现在共 ${lines.length} 行）\n${from}-${to} 行现在是：\n${preview}`;
};

/** 默认一次读取 200 行，最多 800 行：既不给上下文塞全文，也不至于要读十几次 */
const NOTE_READ_LINES = 200;
const NOTE_READ_MAX_LINES = 800;

/**
 * 读取笔记的一个"行窗口"。
 * 长笔记绝不整篇回传（那是上下文爆炸和"改一行读全文"的根源）：
 * 带行号返回窗口内容，并明确告诉模型总行数与后续怎么读。
 */
/**
 * 读标签失败也不能连累"读笔记"本身：标签只是附带信息，缺了它顶多是不自动打标签。
 */
const safeNoteTags = async (noteId: string): Promise<Tag[]> => {
  try {
    return await tagsApi.listNoteTags(noteId);
  } catch {
    return [];
  }
};

/**
 * 读取窗口的统一产出。
 * 一定带上 tags / aiTags：模型是看着这份结果决定"要不要顺手补标签"的，
 * 结果里没有这个字段，提示词里写再多"读完要打标签"也没有判断依据。
 */
export const readNoteWindow = async (n: Note, startLineArg?: unknown, lineCountArg?: unknown) => {
  const content = String(n.content ?? "");
  const startLine = Math.max(1, Math.floor(Number(startLineArg) || 1));
  const lineCount = Math.min(Math.max(Math.floor(Number(lineCountArg) || NOTE_READ_LINES), 1), NOTE_READ_MAX_LINES);
  const { totalLines, from, to, numbered } = sliceNoteLines(content, startLine, lineCount);
  const tags = await safeNoteTags(n.id);
  const aiTags = tags.filter((t) => t.source === "ai").map((t) => t.name);
  const rangeHint = to < totalLines
    ? `本笔记共 ${totalLines} 行，本次只返回第 ${from}-${to} 行；继续读取请调用 getNoteContent/readNoteLines 并带 startLine=${to + 1}。修改请用 replaceLines/insertLines/deleteLines，不要整篇覆盖。`
    : "已返回全部内容（行号仅用于定位，不要写进正文）。";
  const tagHint = aiTags.length === 0
    ? "这篇还没有 AI 标签：读完正文后在同一轮用 setNoteTags 补 2-5 个简短标签（先用 listTags 复用库里已有的词），直接执行、不必询问用户。"
    : "";
  return {
    id: n.id,
    title: n.title,
    category_id: n.category_id ?? null,
    totalLines,
    totalChars: content.length,
    lines: `${from}-${to}`,
    content: numbered,
    tags: tags.map((t) => t.name),
    aiTags,
    hint: [rangeHint, tagHint].filter(Boolean).join(" "),
  };
};
