import { describe, expect, it } from "vitest";
import type { Note, NoteHistoryEntry } from "@/interface/note/note";
import {
  externalTabKey,
  historyTabKey,
  neighborOf,
  noteTabKey,
  planBatchClose,
  planTabMove,
  removeTab,
  tabByKey,
  tabToNote,
  tabTitleOf,
  tempTabKey,
  type EditorTab,
  type NoteTab,
  type TabsState,
} from "./types";

const note = (id: string, patch: Partial<Note> = {}): Note => ({
  id,
  title: `笔记 ${id}`,
  content: `正文 ${id}`,
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

const noteTab = (id: string): NoteTab => ({
  kind: "note",
  key: noteTabKey(id),
  title: `笔记 ${id}`,
  note: note(id),
});

const historyEntry: NoteHistoryEntry = {
  id: 7,
  note_id: "a",
  title: "旧标题",
  content: "旧正文",
  category_id: null,
  is_pinned: false,
  kind: "auto",
  pinned: false,
  saved_at: "2026-01-02T03:04:05Z",
};

const state = (keys: string[], activeKey: string | null): TabsState => ({
  tabs: keys.map((key) => ({ ...noteTab(key), key }) as EditorTab),
  activeKey,
});

describe("标签 key", () => {
  it("按身份生成：笔记用 id、电脑文件用路径、历史版本用版本 id", () => {
    expect(noteTabKey("a")).toBe("note:a");
    expect(externalTabKey("C:/x/readme.md")).toBe("external:C:/x/readme.md");
    // 同一篇笔记的两个历史版本必须是两个标签：saved_at 会撞秒，只能用版本 id
    expect(historyTabKey(historyEntry)).toBe("history:7");
    expect(historyTabKey({ ...historyEntry, id: 8 })).not.toBe(historyTabKey(historyEntry));
    expect(tempTabKey(1)).not.toBe(tempTabKey(2));
  });
});

describe("removeTab 的激活项规则", () => {
  it("关掉激活项时优先激活右边邻居，标签位置不动", () => {
    const next = removeTab(state(["a", "b", "c"], "b"), "b");
    expect(next.tabs.map((tab) => tab.key)).toEqual(["a", "c"]);
    expect(next.activeKey).toBe("c");
  });

  it("关掉最后一个（没有右邻）时退回左边", () => {
    expect(removeTab(state(["a", "b"], "b"), "b").activeKey).toBe("a");
  });

  it("关掉唯一一个标签时回到欢迎页", () => {
    expect(removeTab(state(["a"], "a"), "a")).toEqual({ tabs: [], activeKey: null });
  });

  it("关掉的不是激活项时激活项保持不变", () => {
    expect(removeTab(state(["a", "b", "c"], "c"), "a").activeKey).toBe("c");
  });

  it("key 不存在时原样返回（避免无意义的重渲染）", () => {
    const current = state(["a"], "a");
    expect(removeTab(current, "missing")).toBe(current);
  });

  it("neighborOf 与 removeTab 选中的是同一个", () => {
    const tabs = state(["a", "b", "c"], "b").tabs;
    expect(neighborOf(tabs, "b")?.key).toBe("c");
    expect(neighborOf(tabs, "c")?.key).toBe("b");
    expect(neighborOf(tabs, "missing")).toBeNull();
  });
});

describe("tabByKey", () => {
  it("activeKey 为 null 或已失效时返回 null", () => {
    const current = state(["a"], "a");
    expect(tabByKey(current, null)).toBeNull();
    expect(tabByKey(current, "gone")).toBeNull();
    expect(tabByKey(current, "a")?.key).toBe("a");
  });
});

describe("tabToNote 伪笔记", () => {
  it("笔记标签直接给真实笔记（同一对象，不复制）", () => {
    const tab = noteTab("a");
    expect(tabToNote(tab)).toBe(tab.note);
  });

  it("电脑文件：标题=文件名、正文=文件内容、不带分组与加密态", () => {
    const pseudo = tabToNote({
      kind: "external",
      key: externalTabKey("D:/a.md"),
      title: "a",
      file: { id: "external:1", path: "D:/a.md", name: "a", content: "磁盘内容" },
    });
    expect(pseudo).toMatchObject({
      id: "external:1",
      title: "a",
      content: "磁盘内容",
      category_id: null,
      enc_mode: 0,
      is_locked: false,
    });
  });

  it("历史版本：保留原分组与置顶态、时间取版本保存时间", () => {
    const pseudo = tabToNote({
      kind: "history",
      key: historyTabKey(historyEntry),
      title: historyEntry.title,
      entry: { ...historyEntry, category_id: "c1", is_pinned: true },
    });
    expect(pseudo).toMatchObject({
      id: "history-preview",
      title: "旧标题",
      category_id: "c1",
      is_pinned: true,
      updated_at: "2026-01-02T03:04:05Z",
    });
  });

  it("AI 预览沿用 temp: 前缀，编辑器据此拦掉落库", () => {
    const pseudo = tabToNote({
      kind: "temp",
      key: tempTabKey(3),
      title: "AI 回复",
      preview: { id: "temp:3", title: "AI 回复", content: "生成的内容" },
      sourceNoteId: "a",
    });
    expect(pseudo?.id).toBe("temp:3");
    expect(pseudo?.content).toBe("生成的内容");
  });

  it("没有标签时返回 null（编辑器显示空白提示）", () => {
    expect(tabToNote(null)).toBeNull();
  });
});

describe("tabTitleOf", () => {
  it("按类型取标题，电脑文件用去扩展名的文件名", () => {
    expect(tabTitleOf(noteTab("a"))).toBe("笔记 a");
    expect(
      tabTitleOf({
        kind: "external",
        key: externalTabKey("D:/a.md"),
        title: "a",
        file: { id: "external:1", path: "D:/a.md", name: "a", content: "" },
      }),
    ).toBe("a");
  });
});

describe("planBatchClose 批量关闭", () => {
  it("激活项没被关掉时继续看它（关别的标签不影响当前）", () => {
    const plan = planBatchClose(state(["a", "b", "c"], "c"), ["a", "b"]);
    expect(plan.survivors.map((tab) => tab.key)).toEqual(["c"]);
    expect(plan.nextActiveKey).toBe("c");
  });

  it("激活项被关掉时优先接上右键命中的那个标签", () => {
    // 在 b 上右键「关闭左侧」→ a 被关掉，激活项 b 仍在，保持 b
    const plan = planBatchClose(state(["a", "b", "c"], "a"), ["a"], "b");
    expect(plan.survivors.map((tab) => tab.key)).toEqual(["b", "c"]);
    expect(plan.nextActiveKey).toBe("b");
  });

  it("命中的标签也被关掉时退回最后一个存活项", () => {
    const plan = planBatchClose(state(["a", "b", "c"], "b"), ["a", "b", "c"]);
    expect(plan.survivors).toEqual([]);
    expect(plan.nextActiveKey).toBeNull();
  });

  it("全部关闭 → 回欢迎页", () => {
    const plan = planBatchClose(state(["a", "b"], "a"), ["a", "b"]);
    expect(plan.nextActiveKey).toBeNull();
  });
});

describe("planTabMove 拖拽重排", () => {
  const keys = (tabs: EditorTab[]) => tabs.map((tab) => tab.key);

  it("往后拖：插到第 3 项之前 = 落在第 2 位（先摘自己再插，下标要回退一位）", () => {
    // [a,b,c] 把 a 拖到 c 的右半边 → 插入缝 3（末尾）
    expect(keys(planTabMove(state(["a", "b", "c"], "a").tabs, "a", 3))).toEqual(["b", "c", "a"]);
  });

  it("往前拖：插入缝 0 → 落到最前", () => {
    expect(keys(planTabMove(state(["a", "b", "c"], "a").tabs, "c", 0))).toEqual(["c", "a", "b"]);
  });

  it("插到自己原位置（前后两个缝）都算没动，返回原引用", () => {
    const tabs = state(["a", "b", "c"], "a").tabs;
    expect(planTabMove(tabs, "b", 1)).toBe(tabs);
    expect(planTabMove(tabs, "b", 2)).toBe(tabs);
  });

  it("相邻往后挪一格真的会动", () => {
    expect(keys(planTabMove(state(["a", "b", "c"], "a").tabs, "a", 2))).toEqual(["b", "a", "c"]);
  });

  it("越界下标被夹到两端，不抛错", () => {
    const tabs = state(["a", "b"], "a").tabs;
    expect(keys(planTabMove(tabs, "a", 99))).toEqual(["b", "a"]);
    expect(keys(planTabMove(tabs, "b", -5))).toEqual(["b", "a"]);
  });

  it("找不到来源标签时原样返回", () => {
    const tabs = state(["a", "b"], "a").tabs;
    expect(planTabMove(tabs, "zzz", 0)).toBe(tabs);
  });
});
