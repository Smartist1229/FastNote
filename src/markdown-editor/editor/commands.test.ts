import { describe, expect, it } from "vitest";
import { continueMarkdownOnEnter } from "./commands";

/**
 * 回车续写的回归测试。
 *
 * 重点锁住空引用行：`>` 后面没有内容时回车直接去掉标记、留空行；
 * 旧实现不删标记也不插换行，光标卡在 `>` 上。
 */

describe("continueMarkdownOnEnter", () => {
  it("非空引用行回车继续续写 > ", () => {
    const input = "> 内容";
    const next = continueMarkdownOnEnter(input, input.length, 2);
    expect(next?.text).toBe("> 内容\n> ");
    expect(next?.caret).toBe(next!.text.length);
  });

  it("空引用行回车结束引用，光标回到空行行首", () => {
    const input = "> [text](link)\n> ";
    const next = continueMarkdownOnEnter(input, input.length, 2);
    expect(next?.text).toBe("> [text](link)\n");
    expect(next?.caret).toBe(input.indexOf("\n") + 1);
  });

  it("callout 的空引用行只去掉自己的 >，不连带上一行", () => {
    const input = "> [!NOTE]\n> ";
    const next = continueMarkdownOnEnter(input, input.length, 2);
    expect(next?.text).toBe("> [!NOTE]\n");
    expect(next?.caret).toBe(10);
  });

  it("callout 正文后的孤立 > 回车也只去掉自己", () => {
    const input = "> [!NOTE]\n测试\n>";
    const next = continueMarkdownOnEnter(input, input.length, 2);
    expect(next?.text).toBe("> [!NOTE]\n测试\n");
    expect(next?.caret).toBe(13);
  });

  it("空列表项回车仍然结束列表", () => {
    const next = continueMarkdownOnEnter("- ", 2, 2);
    expect(next?.text).toBe("");
    expect(next?.caret).toBe(0);
  });
});
