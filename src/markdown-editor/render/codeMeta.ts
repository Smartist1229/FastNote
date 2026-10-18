/**
 * 代码围栏 info 串的解析：折叠指令 + 行号开关 + 行高亮范围。
 *
 * 采用的写法（比 `pytjon1-2,5` 更接近主流编辑器，也不会和语言名粘连）：
 *
 * ```python {1-2,5}
 * ```
 *
 * 同时兼容：
 * - 不带花括号：```python 1-2,5
 * - 行号开关：```python lines / ```python nolines
 * - 折叠：```python collapse / expand / nocollapse（花括号形式 {fold} 也认）
 *
 * 解析成纯函数，方便单测；渲染层只消费结果。
 */

export interface CodeMetaInfo {
  /** 强制收起 */
  collapse: boolean;
  /** 强制展开（优先级高于全局默认收起） */
  expand: boolean;
  /** 关闭折叠控件 */
  foldDisabled: boolean;
  /** 行号开关：null = 跟随全局配置 */
  lineNumbers: boolean | null;
  /** 需要高亮的行号（1 起算，已去重排序） */
  highlight: number[];
}

/** 单段行号上限，避免 `{1-999999}` 把浏览器拖死 */
const MAX_LINE = 5000;

/** 解析 `1-2,5`、`3`、`5-8,10-12`；非法片段忽略 */
export const parseLineRanges = (spec: string): number[] => {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!match) continue;
    const a = Math.min(parseInt(match[1], 10), MAX_LINE);
    const b = match[2] ? Math.min(parseInt(match[2], 10), MAX_LINE) : a;
    const from = Math.max(1, Math.min(a, b));
    const to = Math.max(1, Math.max(a, b));
    for (let line = from; line <= to; line++) out.add(line);
  }
  return [...out].sort((x, y) => x - y);
};

/** 入口：解析整段 info string */
export const parseCodeMeta = (meta: string): CodeMetaInfo => {
  const text = meta ?? "";
  const braces = [...text.matchAll(/\{([^}]*)\}/g)].map((m) => m[1]).join(",");
  const rest = text.replace(/\{[^}]*\}/g, " ");
  // 花括号里除了行号范围，也可能写指令（{collapse}），所以两类都参与 token
  const tokens = new Set(
    `${rest} ${braces}`
      .toLowerCase()
      .split(/[\s,]+/)
      .filter(Boolean),
  );

  // 不带花括号的裸范围：取第一个满足 `数字[-数字][,数字...]` 的 token
  const bareRange =
    rest
      .split(/\s+/)
      .map((token) => token.replace(/^[,{]+|[,}]+$/g, ""))
      .find((token) => /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(token)) ?? "";

  const rangeSpec = [braces, bareRange].filter(Boolean).join(",");

  const on = tokens.has("lines") || tokens.has("linenums") || tokens.has("linenumbers") || tokens.has("numbers");
  const off = tokens.has("nolines") || tokens.has("nonumbers") || tokens.has("nolinenumbers");

  return {
    collapse: tokens.has("collapse") || tokens.has("collapsed") || tokens.has("fold"),
    expand: tokens.has("expand") || tokens.has("expanded") || tokens.has("unfold"),
    foldDisabled: tokens.has("nocollapse") || tokens.has("nofold") || tokens.has("unfoldable"),
    lineNumbers: off ? false : on ? true : null,
    highlight: parseLineRanges(rangeSpec),
  };
};
