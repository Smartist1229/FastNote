import { describe, expect, it } from "vitest";
import type { Note } from "@/interface/note";
import {
  buildMatchSnippet,
  buildNoteMatcher,
  collapseWhitespace,
  findMatchRanges,
  searchNotes,
} from "./noteSearch";

const note = (patch: Partial<Note> = {}): Note => ({
  id: 1,
  title: "标题",
  content: "",
  category_id: null,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  is_deleted: false,
  deleted_at: null,
  is_pinned: false,
  ai_access: 2,
  enc_mode: 0,
  is_locked: false,
  enc_hint: null,
  ...patch,
});

describe("collapseWhitespace", () => {
  it("折叠换行与连续空白", () => {
    expect(collapseWhitespace("  a\n\nb\t c ")).toBe("a b c");
  });
});

describe("buildNoteMatcher", () => {
  it("空查询返回 null", () => {
    expect(buildNoteMatcher("", false)).toBeNull();
  });

  it("普通模式转义正则元字符", () => {
    const matcher = buildNoteMatcher("a+b", false);
    expect(matcher?.pattern.test("a+b")).toBe(true);
    expect(matcher?.pattern.test("aab")).toBe(false);
  });

  it("非法正则返回 null 而不是抛错", () => {
    expect(buildNoteMatcher("(", true)).toBeNull();
    expect(buildNoteMatcher("[", true)).toBeNull();
  });
});

describe("findMatchRanges", () => {
  it("返回全部命中区间", () => {
    const matcher = buildNoteMatcher("ab", true);
    expect(findMatchRanges(matcher, "ab-ab")).toEqual([
      { start: 0, end: 2 },
      { start: 3, end: 5 },
    ]);
  });

  it("零宽命中不会死循环", () => {
    const matcher = buildNoteMatcher("x*", true);
    expect(findMatchRanges(matcher, "abc")).toEqual([]);
  });

  it("matcher 为 null 时返回空数组", () => {
    expect(findMatchRanges(null, "abc")).toEqual([]);
  });
});

describe("buildMatchSnippet", () => {
  it("没有命中时从开头截断", () => {
    const snippet = buildMatchSnippet("a".repeat(100), []);
    expect(snippet.text.endsWith("…")).toBe(true);
    expect(snippet.ranges).toEqual([]);
  });

  it("围绕第一处命中截取上下文", () => {
    const content = `${"前".repeat(80)}关键词${"后".repeat(80)}`;
    const start = content.indexOf("关键词");
    const snippet = buildMatchSnippet(content, [{ start, end: start + 3 }]);
    expect(snippet.text).toContain("关键词");
    const [range] = snippet.ranges;
    expect(snippet.text.slice(range.start, range.end)).toBe("关键词");
  });

  it("区间坐标与片段文本一致（省略号计入偏移）", () => {
    const content = `${"a".repeat(200)}needle`;
    const start = content.indexOf("needle");
    const snippet = buildMatchSnippet(content, [{ start, end: start + 6 }]);
    expect(snippet.text.startsWith("…")).toBe(true);
    const [range] = snippet.ranges;
    expect(snippet.text.slice(range.start, range.end)).toBe("needle");
  });
});

describe("searchNotes", () => {
  const notes = [
    note({ id: 1, title: "React 入门", content: "正文提到 hook" }),
    note({ id: 2, title: "Rust 笔记", content: "REACT 只出现在正文" }),
    note({ id: 3, title: "无关", content: "什么也没有" }),
  ];

  it("标题与正文都不区分大小写", () => {
    const { hits, invalid } = searchNotes(notes, "react", false);
    expect(invalid).toBe(false);
    expect(hits.map((h) => h.note.id)).toEqual([1, 2]);
  });

  it("只有正文命中时标记 titleOnly 为 false 并给出片段", () => {
    const { hits } = searchNotes(notes, "react", false);
    const bodyHit = hits.find((h) => h.note.id === 2)!;
    expect(bodyHit.titleOnly).toBe(false);
    expect(bodyHit.snippet).toContain("REACT");
    const [range] = bodyHit.snippetRanges;
    expect(bodyHit.snippet.slice(range.start, range.end)).toBe("REACT");
  });

  it("只有标题命中时 titleOnly 为 true", () => {
    const { hits } = searchNotes(notes, "入门", false);
    expect(hits).toHaveLength(1);
    expect(hits[0].titleOnly).toBe(true);
    const [range] = hits[0].titleRanges;
    expect(hits[0].note.title.slice(range.start, range.end)).toBe("入门");
  });

  it("正则不合法时返回 invalid 且没有命中", () => {
    expect(searchNotes(notes, "(", true)).toEqual({ hits: [], invalid: true });
  });

  it("正则模式可用，且保留原始大小写", () => {
    const { hits } = searchNotes(notes, "R[ae]act", true);
    expect(hits.map((h) => h.note.id)).toEqual([1, 2]);
  });

  it("空查询返回空结果且不算错误", () => {
    expect(searchNotes(notes, "   ", false)).toEqual({ hits: [], invalid: false });
  });
});
