import type { EditState } from "./commands";

/**
 * 粘贴文本的落点计算。
 *
 * 为什么单独成文件、而不是写在 SourceEditor 里：
 *
 * 源码区是**虚拟化**的——DOM 里只有视口附近那几十行，`value` 才是全文。
 * 所以「把剪贴板内容贴进文档」绝不能交给浏览器原生行为：浏览器只会在
 * 已渲染的那几十行里做替换，窗口外的内容原封不动，再被 readback 当成本地改动收下。
 * 表现就是 **Ctrl+A 全选后粘贴，只有一部分旧内容被替换掉**（全选时逻辑选区是
 * `[0, len]`，DOM 却只覆盖窗口）。
 *
 * 因此粘贴一律走这里：拿**逻辑选区的文档偏移**切片拼接，全文替换/插入都由 `value` 决定，
 * 与 DOM 里渲染了多少行无关。
 */

/** 剪贴板文本统一成 `\n`：Windows 复制来的内容普遍是 CRLF，混进 value 会让增量解析退回整篇 */
export const normalizePastedText = (raw: string): string => raw.replace(/\r\n?/g, "\n");

/** 把粘贴文本替换进选区；文本为空（例如只贴了图片）时返回 null，交给调用方走别的分支 */
export const applyPaste = (state: EditState, raw: string): EditState | null => {
  const insert = normalizePastedText(raw);
  if (!insert) return null;
  const { text, start, end } = state;
  const caret = start + insert.length;
  return { text: text.slice(0, start) + insert + text.slice(end), start: caret, end: caret };
};
