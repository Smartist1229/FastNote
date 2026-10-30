import { describe, expect, it } from "vitest";
import { applyPaste, normalizePastedText } from "./paste";

/**
 * 粘贴落点的回归测试。
 *
 * 背景：源码区是虚拟化渲染（DOM 里只有视口附近的行，`value` 才是全文）。
 * 如果粘贴交给浏览器原生处理，它只会替换窗口内那几十行，窗口外的旧内容留着 ——
 * 用户看到的就是「Ctrl+A 全选后粘贴，旧内容只消失了一部分」。
 * 所以粘贴必须按**逻辑选区的文档偏移**切片，这几个用例锁住的就是这条不变式。
 */

const text = "第一段\n第二段\n第三段\n";

describe("normalizePastedText", () => {
  it("CRLF / 单独 CR 都归一成 \\n", () => {
    expect(normalizePastedText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("已是 \\n 的文本原样返回", () => {
    expect(normalizePastedText("a\nb")).toBe("a\nb");
  });
});

describe("applyPaste", () => {
  it("全选后粘贴：整篇被替换，一个字都不留", () => {
    const next = applyPaste({ text, start: 0, end: text.length }, "全新内容");
    expect(next?.text).toBe("全新内容");
    expect(next?.start).toBe(4);
    expect(next?.end).toBe(4);
  });

  it("全选后粘贴多行文本：旧内容不残留", () => {
    const next = applyPaste({ text, start: 0, end: text.length }, "一\n二\r\n三");
    expect(next?.text).toBe("一\n二\n三");
  });

  it("局部替换：只动选区，前后文保留", () => {
    // 「第二段」在文档里的偏移是 4..7
    const next = applyPaste({ text, start: 4, end: 7 }, "新的一段");
    expect(next?.text).toBe("第一段\n新的一段\n第三段\n");
    expect(next?.start).toBe(8);
  });

  it("折叠光标处插入：等价于纯插入", () => {
    const next = applyPaste({ text: "ab", start: 1, end: 1 }, "XY");
    expect(next?.text).toBe("aXYb");
    expect(next?.start).toBe(3);
    expect(next?.end).toBe(3);
  });

  it("空文本（例如只贴了图片）返回 null，交给调用方走图片分支", () => {
    expect(applyPaste({ text, start: 0, end: text.length }, "")).toBeNull();
  });

  it("边界：光标在文末插入不会越界", () => {
    const next = applyPaste({ text: "abc", start: 3, end: 3 }, "d");
    expect(next?.text).toBe("abcd");
    expect(next?.start).toBe(4);
  });
});
