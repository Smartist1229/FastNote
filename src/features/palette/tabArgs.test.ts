import { describe, expect, it } from "vitest";
import { parseTabBatch, parseTabQuery } from "./tabArgs";

describe("parseTabQuery（tab 指令的动词）", () => {
  it("没有动词时整段都是关键词：`tab 周报` 是切换", () => {
    expect(parseTabQuery("周报")).toEqual({ verb: "switch", rest: "周报" });
    expect(parseTabQuery("")).toEqual({ verb: "switch", rest: "" });
  });

  it("close / 关闭 / 关 都是关闭，后面的文字是关键词", () => {
    expect(parseTabQuery("close")).toEqual({ verb: "close", rest: "" });
    expect(parseTabQuery("close 周报")).toEqual({ verb: "close", rest: "周报" });
    expect(parseTabQuery("关闭 周报")).toEqual({ verb: "close", rest: "周报" });
    expect(parseTabQuery("关 周报")).toEqual({ verb: "close", rest: "周报" });
  });

  it("pin / 固定 是转常驻", () => {
    expect(parseTabQuery("pin")).toEqual({ verb: "pin", rest: "" });
    expect(parseTabQuery("固定 周报")).toEqual({ verb: "pin", rest: "周报" });
  });

  it("只认第一个词：`周报 close` 是切换（标题里带 close 不算动词）", () => {
    expect(parseTabQuery("周报 close")).toEqual({ verb: "switch", rest: "周报 close" });
    expect(parseTabQuery("closet")).toEqual({ verb: "switch", rest: "closet" });
  });

  it("中文逗号也能断开（手打时很常见）", () => {
    expect(parseTabQuery("close，周报")).toEqual({ verb: "close", rest: "周报" });
  });
});

describe("parseTabBatch（批量关闭的保留词）", () => {
  it("中英文等价", () => {
    expect(parseTabBatch("all")).toBe("all");
    expect(parseTabBatch("全部")).toBe("all");
    expect(parseTabBatch("others")).toBe("others");
    expect(parseTabBatch("其他")).toBe("others");
    expect(parseTabBatch("左")).toBe("left");
    expect(parseTabBatch("右侧")).toBe("right");
  });

  it("不是保留词就是普通关键词（那时它是一篇笔记的标题）", () => {
    expect(parseTabBatch("周报")).toBeNull();
    expect(parseTabBatch("")).toBeNull();
  });
});
