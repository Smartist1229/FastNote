/**
 * `tab` 指令的参数解析（纯函数，不依赖 React / 标签域，可单测）。
 *
 * 语法刻意做成 VS Code 那种「一个动词 + 一个关键词」：
 *   tab                  → 切到某个标签（列全部）
 *   tab 周报             → 切到标题含「周报」的标签
 *   tab close            → 列全部，第一条是「关闭当前标签」
 *   tab close 周报       → 关掉标题含「周报」的标签
 *   tab close others     → 批量关闭（others / left / right / all）
 *   tab pin              → 把预览标签转成常驻
 *
 * 只认第一个词：`tab close` 里的 `close` 是动词，其余整段都是关键词。
 * 中文动词（关闭 / 固定）与英文等价，避免界面全中文却要敲英文。
 */

/** 动词：切换 / 关闭 / 固定 */
export type TabVerb = "switch" | "close" | "pin";

export interface TabQuery {
  verb: TabVerb;
  /** 动词之后的关键词，可能为空串 */
  rest: string;
}

const VERBS: { verb: TabVerb; words: string[] }[] = [
  { verb: "close", words: ["close", "关闭", "关"] },
  { verb: "pin", words: ["pin", "固定", "钉住"] },
];

/** `tab close 周报` → { verb: "close", rest: "周报" } */
export const parseTabQuery = (raw: string): TabQuery => {
  const text = raw.trim();
  if (!text) return { verb: "switch", rest: "" };
  // 第一个词：遇到空白或中英文逗号都断开（用户常顺手打「tab close，周报」）
  const match = /^([^\s,，]+)[\s,，]*([\s\S]*)$/.exec(text);
  if (!match) return { verb: "switch", rest: text };
  const word = match[1].toLowerCase();
  const rest = match[2].trim();
  for (const entry of VERBS) {
    if (entry.words.includes(word)) return { verb: entry.verb, rest };
  }
  return { verb: "switch", rest: text };
};

/** 批量关闭的保留词 */
export type TabBatch = "others" | "left" | "right" | "all";

const BATCHES: { batch: TabBatch; words: string[] }[] = [
  { batch: "others", words: ["others", "other", "其他", "其它"] },
  { batch: "left", words: ["left", "左", "左边", "左侧"] },
  { batch: "right", words: ["right", "右", "右边", "右侧"] },
  { batch: "all", words: ["all", "全部", "所有"] },
];

/** `tab close all` → "all"；不是保留词就返回 null（那时它是笔记标题的关键词） */
export const parseTabBatch = (rest: string): TabBatch | null => {
  const word = rest.trim().toLowerCase();
  if (!word) return null;
  return BATCHES.find((entry) => entry.words.includes(word))?.batch ?? null;
};
