/**
 * 对话里的笔记引用块：在 content 字符串里的序列化、解析与各条旁路的降级表示。
 *
 * 标记形如 <note-ref>{"noteId":3,"noteTitle":"…","from":3,"to":5,"text":"…"}</note-ref>。
 * JSON 里的 "<" 统一转义成 \u003c（JSON 合法转义），因此闭合标签不可能出现在正文里，
 * 按标签边界解析没有歧义；模型读到的就是这段 JSON 本身。
 *
 * 界面用 splitContent 把它还原成块；不需要块的旁路（会话标题、上下文压缩、复制）
 * 用 stripNoteRefs / expandRefs / flattenNoteRefs 转成纯文本，避免把 JSON 漏给用户或模型。
 */

import type { ChatNoteRef } from "@/interface/aiChat";

const MARKER_OPEN = "<note-ref>";
const MARKER_CLOSE = "</note-ref>";
const MARKER_PATTERN = "<note-ref>([\\s\\S]*?)</note-ref>";

/** "<" 只可能出现在 JSON 字符串值里，转义后仍是合法 JSON */
const escapePayload = (json: string): string => json.replace(/</g, "\\u003c");

export const serializeNoteRef = (ref: ChatNoteRef): string =>
  `${MARKER_OPEN}${escapePayload(JSON.stringify({
    noteId: ref.noteId ?? null,
    noteTitle: ref.noteTitle,
    from: ref.from,
    to: ref.to,
    text: ref.text,
  }))}${MARKER_CLOSE}`;

/** 解析失败返回 null（历史数据被外部改坏时按普通文本处理，不抛异常） */
export const parseNoteRef = (payload: string): ChatNoteRef | null => {
  try {
    const data = JSON.parse(payload) as Record<string, unknown>;
    if (!data || typeof data !== "object") return null;
    if (typeof data.text !== "string") return null;
    if (typeof data.from !== "number" || typeof data.to !== "number") return null;
    return {
      noteId: typeof data.noteId === "number" ? data.noteId : null,
      noteTitle: typeof data.noteTitle === "string" ? data.noteTitle : "",
      from: data.from,
      to: data.to,
      text: data.text,
    };
  } catch {
    return null;
  }
};

export type ContentSegment =
  | { kind: "text"; text: string }
  | { kind: "ref"; ref: ChatNoteRef };

export const splitContent = (content: string): ContentSegment[] => {
  const segments: ContentSegment[] = [];
  const re = new RegExp(MARKER_PATTERN, "g");
  let last = 0;
  for (let match = re.exec(content); match; match = re.exec(content)) {
    if (match.index > last) segments.push({ kind: "text", text: content.slice(last, match.index) });
    const ref = parseNoteRef(match[1]);
    // 解析不了就当作原文，宁可显示一段 JSON 也绝不丢用户内容
    segments.push(ref ? { kind: "ref", ref } : { kind: "text", text: match[0] });
    last = match.index + match[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
};

/** 块上显示的文本：选区首行去掉 markdown 记号，超宽由 CSS 省略号收尾 */
export const refLabel = (ref: ChatNoteRef): string => {
  const line = ref.text.split("\n").map((s) => s.trim()).find(Boolean) || ref.text.trim() || ref.noteTitle;
  const cleaned = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/^([-*+]|\d+[.)])\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || ref.noteTitle || "…";
};

export const refRangeLabel = (ref: ChatNoteRef): string =>
  ref.from === ref.to ? `${ref.from}` : `${ref.from}-${ref.to}`;

/** 块上的悬浮提示：笔记名 + 行区间 */
export const refTitle = (ref: ChatNoteRef): string =>
  ref.noteTitle ? `${ref.noteTitle} · ${refRangeLabel(ref)}` : refRangeLabel(ref);

/** 去掉所有引用块，只留用户自己打的字（会话标题生成用） */
export const stripNoteRefs = (content: string): string =>
  splitContent(content).map((seg) => (seg.kind === "text" ? seg.text : "")).join("");

/** 把引用块展开成它引用的正文（复制消息、字数、token 估算用） */
export const expandRefs = (content: string): string =>
  splitContent(content).map((seg) => (seg.kind === "text" ? seg.text : seg.ref.text)).join("");

/** 压缩上下文时用的可读降级：保留出处与正文，压缩方再照常截断 */
export const flattenNoteRefs = (content: string): string =>
  splitContent(content)
    .map((seg) =>
      seg.kind === "text"
        ? seg.text
        : `【引用《${seg.ref.noteTitle || "笔记"}》${refRangeLabel(seg.ref)} 行】${seg.ref.text}`,
    )
    .join("");
