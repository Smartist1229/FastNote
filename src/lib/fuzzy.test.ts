import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyTest, splitByRanges } from "./fuzzy";

const score = (text: string, query: string): number => {
  const hit = fuzzyMatch(text, query);
  if (!hit) throw new Error(`expected match: ${text} ~ ${query}`);
  return hit.score;
};

describe("fuzzyMatch 打分阶梯", () => {
  it("完全相同高于前缀，前缀高于词首，词首高于任意包含", () => {
    expect(score("react", "react")).toBeGreaterThan(score("react 入门", "react"));
    expect(score("react 入门", "react")).toBeGreaterThan(score("深入 React", "react"));
    expect(score("深入 React", "react")).toBeGreaterThan(score("深入React原理", "react"));
  });

  it("包含命中高于散落子序列", () => {
    expect(score("markdown", "md")).toBeLessThan(score("markdown", "mark"));
  });

  it("位置越靠后扣分越多", () => {
    expect(score("a react", "react")).toBeGreaterThan(score("aaaaaaaaaa react", "react"));
  });
});

describe("fuzzyMatch 命中判定", () => {
  it("空查询返回零分且不命中文本为空的情况", () => {
    expect(fuzzyMatch("任意", "")).toEqual({ score: 0, ranges: [] });
    expect(fuzzyMatch("", "a")).toBeNull();
  });

  it("大小写不敏感", () => {
    expect(fuzzyTest("MarkDown", "markdown")).toBe(true);
  });

  it("子序列匹配（缩写）", () => {
    expect(fuzzyTest("markdown", "md")).toBe(true);
    expect(fuzzyTest("TODO 列表", "td")).toBe(true);
  });

  it("顺序不对不命中", () => {
    expect(fuzzyMatch("abc", "cba")).toBeNull();
  });

  it("多词按 AND 处理", () => {
    expect(fuzzyTest("react hook 指南", "react hook")).toBe(true);
    expect(fuzzyMatch("react 指南", "react hook")).toBeNull();
  });
});

describe("fuzzyMatch 命中区间", () => {
  it("返回连续命中区间", () => {
    expect(fuzzyMatch("React 入门", "react")).toEqual({ score: expect.any(Number), ranges: [{ start: 0, end: 5 }] });
  });

  it("多词命中区间合并重叠与相邻段", () => {
    const hit = fuzzyMatch("foobar", "foo bar");
    expect(hit?.ranges).toEqual([{ start: 0, end: 6 }]);
  });

  it("子序列命中给出每段字符区间", () => {
    expect(fuzzyMatch("markdown", "md")?.ranges).toEqual([
      { start: 0, end: 1 },
      { start: 4, end: 5 },
    ]);
  });
});

describe("splitByRanges", () => {
  it("没有区间时整段返回", () => {
    expect(splitByRanges("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });

  it("按区间切出命中片段", () => {
    expect(
      splitByRanges("abcdef", [
        { start: 1, end: 3 },
        { start: 4, end: 6 },
      ]),
    ).toEqual([
      { text: "a", hit: false },
      { text: "bc", hit: true },
      { text: "d", hit: false },
      { text: "ef", hit: true },
    ]);
  });

  it("越界区间被裁剪而不是抛错", () => {
    expect(splitByRanges("ab", [{ start: 1, end: 99 }])).toEqual([
      { text: "a", hit: false },
      { text: "b", hit: true },
    ]);
  });
});
