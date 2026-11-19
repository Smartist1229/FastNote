/**
 * 新建条目（笔记 / 分组）的临时名字：前缀 + 无符号时间戳（YYYYMMDDHHMMSS）。
 *
 * 新建时先落库一个能看的名字，用户随后在侧栏就地改名：换成自己的标题，
 * 或者直接回车沿用这个名字。所以列表里不会再冒出「无标题」条目，
 * 时间戳也保证同一秒内连建多个不会撞名。
 *
 * 前缀由调用方按界面语言传入（新笔记 / New note），中日韩字符与数字直接相连，
 * 拉丁字母结尾则补一个空格——`New note20261119123605` 读起来是粘在一起的。
 */

const pad = (value: number): string => String(value).padStart(2, "0");

/** 例：`新笔记20261229123605` / `New note 20261229123605` */
export const buildAutoTitle = (prefix: string, now: Date = new Date()): string => {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  // 前缀以拉丁字母/数字结尾时补空格；中文、日文等宽字符不留缝
  const separator = /[A-Za-z0-9]$/.test(prefix) ? " " : "";
  return `${prefix}${separator}${stamp}`;
};
