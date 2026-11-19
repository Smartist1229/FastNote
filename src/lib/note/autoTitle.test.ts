import { describe, expect, it } from "vitest";
import { buildAutoTitle } from "./autoTitle";

describe("buildAutoTitle", () => {
  it("中文前缀直接拼 14 位无符号时间戳", () => {
    expect(buildAutoTitle("新笔记", new Date(2026, 11, 29, 12, 36, 5))).toBe("新笔记20261229123605");
  });

  it("月日时分秒不足两位时补零", () => {
    expect(buildAutoTitle("新笔记", new Date(2026, 0, 2, 3, 4, 5))).toBe("新笔记20260102030405");
  });

  it("拉丁字母前缀补一个空格，避免和数字粘在一起", () => {
    expect(buildAutoTitle("New note", new Date(2026, 11, 29, 12, 36, 5))).toBe("New note 20261229123605");
  });

  it("前缀自带尾随空格时不再重复补", () => {
    expect(buildAutoTitle("New note ", new Date(2026, 11, 29, 12, 36, 5))).toBe("New note 20261229123605");
  });

  it("分组与笔记共用同一套规则", () => {
    expect(buildAutoTitle("新分组", new Date(2026, 11, 29, 12, 36, 5))).toBe("新分组20261229123605");
    expect(buildAutoTitle("New group", new Date(2026, 11, 29, 12, 36, 5))).toBe("New group 20261229123605");
  });
});
