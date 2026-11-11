/**
 * 行内语法解析：把一行（或一个段落的整段文本）切成 InlineNode[]。
 *
 * 采用「递归下降 + 定界符就近闭合」策略，而不是完整的 CommonMark 定界符栈：
 * 对日常写法（粗体套斜体、行内代码里带星号、链接文字里带强调）足够稳，
 * 代价是极端嵌套（如 `**a*b**c*`）的结果可能与规范不同——这属于有意取舍。
 *
 * 关键约束：
 * - 强调、删除线等不允许跨行，避免一段写坏的行把后面整篇吞掉；
 * - `_` 强调要求两侧不是字母数字，避免 snake_case 被吃掉；
 * - 行内代码优先于一切定界符：反引号内的 `*` `_` `[` 一律当字面量。
 */
import type { InlineContext, InlineNode } from "./types";

const ESCAPABLE = /[!-/:-@[-`{-~]/;

const isAlnum = (ch: string) => /[A-Za-z0-9\u4e00-\u9fa5]/.test(ch);

/** 统计从 i 开始的连续同字符长度 */
const countRun = (src: string, i: number, ch: string): number => {
  let n = 0;
  while (src[i + n] === ch) n++;
  return n;
};

/** 找长度为 len 的反引号闭合串，返回其起点；找不到返回 -1 */
const findBacktickClose = (src: string, from: number, len: number): number => {
  let j = from;
  while (j < src.length) {
    if (src[j] === "`") {
      const run = countRun(src, j, "`");
      if (run === len) return j;
      j += run;
      continue;
    }
    j++;
  }
  return -1;
};

/** 找 `]` 的匹配位置：支持嵌套方括号、跳过转义与行内代码 */
const findBracketClose = (src: string, from: number): number => {
  let depth = 0;
  for (let j = from; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\\") {
      j++;
      continue;
    }
    if (ch === "`") {
      const run = countRun(src, j, "`");
      const close = findBacktickClose(src, j + run, run);
      if (close >= 0) {
        j = close + run - 1;
        continue;
      }
    }
    if (ch === "[") depth++;
    else if (ch === "]") {
      if (depth === 0) return j;
      depth--;
    }
  }
  return -1;
};

/** 解析链接目标：`(href "title")`，返回 href/title 与右括号之后的位置 */
const parseDestination = (
  src: string,
  from: number,
): { href: string; title?: string; end: number } | null => {
  let j = from;
  while (src[j] === " " || src[j] === "\t") j++;
  let href = "";
  if (src[j] === "<") {
    const close = src.indexOf(">", j + 1);
    if (close < 0) return null;
    href = src.slice(j + 1, close);
    j = close + 1;
  } else {
    const start = j;
    let depth = 0;
    while (j < src.length) {
      const ch = src[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "(") depth++;
      else if (ch === ")") {
        if (depth === 0) break;
        depth--;
      } else if ((ch === " " || ch === "\t") && depth === 0) break;
      j++;
    }
    href = src.slice(start, j);
  }
  while (src[j] === " " || src[j] === "\t") j++;
  let title: string | undefined;
  const q = src[j];
  if (q === '"' || q === "'" || q === "(") {
    const closer = q === "(" ? ")" : q;
    const close = src.indexOf(closer, j + 1);
    if (close < 0) return null;
    title = src.slice(j + 1, close);
    j = close + 1;
    while (src[j] === " " || src[j] === "\t") j++;
  }
  if (src[j] !== ")") return null;
  return { href, title, end: j + 1 };
};

/** 归一化引用标签：大小写不敏感、空白折叠 */
export const normalizeLabel = (label: string): string => label.trim().toLowerCase().replace(/\s+/g, " ");

/** 找强调闭合定界符；找不到返回 -1。
 *
 * 闭合位置必须落在定界符串的「末尾」，否则 `**` 的前半段会把后半段吞掉：
 * `*斜 **粗** 斜*` 里 `**` 若在第一个星号处闭合，整段嵌套就废了。
 * 单字符定界符还要求两侧不与自己同类相邻（整串只含 1 个），双字符只要求右侧不再接同类字符。
 */
const findDelimiterClose = (src: string, open: number, delim: string): number => {
  const ch = delim[0];
  const from = open + delim.length;
  const single = delim.length === 1;
  let j = from;
  while (j < src.length) {
    const cur = src[j];
    if (cur === "\n") return -1;
    if (cur === "\\") {
      j += 2;
      continue;
    }
    if (cur === "`") {
      const run = countRun(src, j, "`");
      const close = findBacktickClose(src, j + run, run);
      if (close >= 0) {
        j = close + run;
        continue;
      }
    }
    if (src.startsWith(delim, j)) {
      const inner = src.slice(from, j);
      const aligned = src[j + delim.length] !== ch && (!single || src[j - 1] !== ch);
      const opensOk = inner.length > 0 && !/^\s/.test(inner);
      const closesOk = !/\s$/.test(inner);
      // `_` 要求外侧是词边界，避免 foo_bar_baz 被解析成强调
      const boundaryOk =
        ch !== "_" ||
        ((open === 0 || !isAlnum(src[open - 1])) &&
          (j + delim.length >= src.length || !isAlnum(src[j + delim.length])));
      if (aligned && opensOk && closesOk && boundaryOk) return j;
      // 逐字符前进：长定界符串的尾部对齐位置可能只隔一个字符
      j++;
      continue;
    }
    j++;
  }
  return -1;
};

/** 去掉裸链接末尾的标点，并处理括号配对 */
const trimUrlTail = (raw: string): string => {
  let url = raw;
  while (/[.,;:!?'"]$/.test(url)) url = url.slice(0, -1);
  while (url.endsWith(")") && (url.match(/\(/g) || []).length < (url.match(/\)/g) || []).length) {
    url = url.slice(0, -1);
  }
  return url;
};

/** 合并相邻文本节点，减少渲染时的节点数量 */
const mergeText = (nodes: InlineNode[]): InlineNode[] => {
  const out: InlineNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (node.type === "text" && prev && prev.type === "text") {
      prev.value += node.value;
      continue;
    }
    if (node.type === "text" && !node.value) continue;
    out.push(node);
  }
  return out;
};

/** 入口：解析一段行内文本 */
/**
 * 行内标签配对：从 `src[from]`（开标签之后）找到与之配对的闭标签。
 *
 * 同名标签要压深度计数，否则 `<font><font>x</font></font>` 会在第一个闭合就收工；
 * 找不到就返回 -1 —— 宁可不配对让它按原文显示，也不要把后面的内容吞进一个假标签。
 */
const findTagClose = (src: string, from: number, tag: string): number => {
  const name = tag.toLowerCase();
  const openRe = new RegExp(`<${name}(?:\\s[^<>]*)?>`, "gi");
  const closeRe = new RegExp(`</${name}\\s*>`, "gi");
  let depth = 0;
  let cursor = from;
  while (cursor < src.length) {
    openRe.lastIndex = cursor;
    closeRe.lastIndex = cursor;
    const open = openRe.exec(src);
    const close = closeRe.exec(src);
    if (!open && !close) return -1;
    if (close && (!open || close.index < open.index)) {
      if (depth === 0) return close.index;
      depth -= 1;
      cursor = close.index + close[0].length;
    } else if (open) {
      depth += 1;
      cursor = open.index + open[0].length;
    } else {
      return -1;
    }
  }
  return -1;
};

/** 不需要配对的行内标签（自闭合 / 空元素） */
const VOID_INLINE_TAGS = new Set([
  "br",
  "hr",
  "img",
  "input",
  "wbr",
  "source",
  "embed",
  "track",
  "area",
  "col",
  "param",
  "base",
  "meta",
  "link",
]);

export function parseInline(src: string, ctx: InlineContext): InlineNode[] {
  const out: InlineNode[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push({ type: "text", value: buf });
      buf = "";
    }
  };

  /** 硬换行标记：把缓冲区末尾的空格去掉 */
  const trimTrailingSpaces = () => {
    if (buf) {
      buf = buf.replace(/[ \t]+$/, "");
      return;
    }
    const last = out[out.length - 1];
    if (last && last.type === "text") last.value = last.value.replace(/[ \t]+$/, "");
  };

  while (i < src.length) {
    const ch = src[i];

    // 转义
    if (ch === "\\") {
      const next = src[i + 1];
      if (next === "\n") {
        trimTrailingSpaces();
        flush();
        out.push({ type: "break", hard: true });
        i += 2;
        while (src[i] === " " || src[i] === "\t") i++;
        continue;
      }
      if (next && ESCAPABLE.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
      buf += "\\";
      i++;
      continue;
    }

    // 换行：两空格以上为硬换行，否则软换行；开启 breaks（GFM）时单个 \n 就算硬换行
    if (ch === "\n") {
      const hard = ctx.breaks || /[ ]{2,}$/.test(src.slice(0, i));
      trimTrailingSpaces();
      flush();
      out.push({ type: "break", hard });
      i++;
      while (src[i] === " " || src[i] === "\t") i++;
      continue;
    }

    // 行内代码
    if (ch === "`") {
      const run = countRun(src, i, "`");
      const close = findBacktickClose(src, i + run, run);
      if (close >= 0) {
        let value = src.slice(i + run, close).replace(/\n/g, " ");
        if (value.length > 2 && value.startsWith(" ") && value.endsWith(" ")) value = value.slice(1, -1);
        flush();
        out.push({ type: "code", value });
        i = close + run;
        continue;
      }
      buf += src.slice(i, i + run);
      i += run;
      continue;
    }

    // 图片
    if (ch === "!" && src[i + 1] === "[") {
      const close = findBracketClose(src, i + 2);
      if (close > 0) {
        const alt = src.slice(i + 2, close);
        if (src[close + 1] === "(") {
          const dest = parseDestination(src, close + 2);
          if (dest) {
            flush();
            out.push({ type: "image", src: dest.href, alt, title: dest.title });
            i = dest.end;
            continue;
          }
        }
        // 引用式图片：![alt][id] / ![alt][]
        let ref: { href: string; title?: string } | undefined;
        let end = close + 1;
        if (src[close + 1] === "[") {
          const close2 = src.indexOf("]", close + 2);
          if (close2 > 0) {
            const explicit = src.slice(close + 2, close2);
            ref = ctx.links.get(normalizeLabel(explicit || alt));
            end = close2 + 1;
          }
        } else {
          ref = ctx.links.get(normalizeLabel(alt));
        }
        if (ref) {
          flush();
          out.push({ type: "image", src: ref.href, alt, title: ref.title });
          i = end;
          continue;
        }
      }
      buf += "!";
      i++;
      continue;
    }

    // 链接 / 脚注引用
    if (ch === "[") {
      if (src[i + 1] === "^") {
        const close = src.indexOf("]", i + 2);
        if (close > 0) {
          const id = src.slice(i + 2, close);
          if (!ctx.footnoteIndex.has(id)) {
            ctx.footnoteIndex.set(id, ctx.footnoteIndex.size + 1);
            ctx.footnoteOrder.push(id);
          }
          flush();
          out.push({ type: "footnoteRef", id, index: ctx.footnoteIndex.get(id)! });
          i = close + 1;
          continue;
        }
      }
      const close = findBracketClose(src, i + 1);
      if (close > 0) {
        const label = src.slice(i + 1, close);
        if (src[close + 1] === "(") {
          const dest = parseDestination(src, close + 2);
          if (dest) {
            flush();
            out.push({ type: "link", href: dest.href, title: dest.title, children: parseInline(label, ctx) });
            i = dest.end;
            continue;
          }
        }
        let ref: { href: string; title?: string } | undefined;
        let end = close + 1;
        if (src[close + 1] === "[") {
          const close2 = src.indexOf("]", close + 2);
          if (close2 > 0) {
            const explicit = src.slice(close + 2, close2);
            ref = ctx.links.get(normalizeLabel(explicit || label));
            end = close2 + 1;
          }
        } else {
          ref = ctx.links.get(normalizeLabel(label));
        }
        if (ref) {
          flush();
          out.push({ type: "link", href: ref.href, title: ref.title, children: parseInline(label, ctx) });
          i = end;
          continue;
        }
      }
      buf += "[";
      i++;
      continue;
    }

    // 尖括号自动链接 / 内联 HTML
    if (ch === "<") {
      const auto = /^<((?:[a-zA-Z][a-zA-Z0-9+.-]{1,31}):[^\s<>]*)>/.exec(src.slice(i));
      if (auto) {
        flush();
        out.push({ type: "link", href: auto[1], children: [{ type: "text", value: auto[1] }] });
        i += auto[0].length;
        continue;
      }
      const email = /^<([^\s<>@]+@[^\s<>@]+\.[^\s<>@]+)>/.exec(src.slice(i));
      if (email) {
        flush();
        out.push({ type: "link", href: `mailto:${email[1]}`, children: [{ type: "text", value: email[1] }] });
        i += email[0].length;
        continue;
      }
      const tag = /^<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/.exec(src.slice(i));
      const comment = /^<!--[\s\S]*?-->/.exec(src.slice(i));
      if (ctx.allowHtml && (comment || tag)) {
        // 成对的行内标签：连闭标签一起吃下，内部照常解析 Markdown（粗体、链接、高亮都在）
        const open = tag && /^<([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*)?)>$/.exec(tag[0]);
        if (open && !VOID_INLINE_TAGS.has(open[1].toLowerCase())) {
          const close = findTagClose(src, i + open[0].length, open[1]);
          if (close > 0) {
            flush();
            out.push({
              type: "htmlInline",
              tag: open[1].toLowerCase(),
              attrs: open[2] ?? "",
              raw: open[0],
              children: parseInline(src.slice(i + open[0].length, close), ctx),
            });
            i = close + src.slice(close).indexOf(">") + 1;
            continue;
          }
        }
        flush();
        out.push({ type: "html", value: (comment || tag)![0] });
        i += (comment || tag)![0].length;
        continue;
      }
      buf += "<";
      i++;
      continue;
    }

    // 行内公式 $...$（不跨行、两侧不留空格）
    if (ch === "$" && src[i + 1] !== "$") {
      const close = src.indexOf("$", i + 1);
      if (close > i + 1) {
        const value = src.slice(i + 1, close);
        if (!/^\s|\s$/.test(value) && !value.includes("\n")) {
          flush();
          out.push({ type: "math", value });
          i = close + 1;
          continue;
        }
      }
      buf += "$";
      i++;
      continue;
    }

    // 高亮 ==x==
    if (ch === "=" && src[i + 1] === "=") {
      const close = findDelimiterClose(src, i, "==");
      if (close > 0) {
        flush();
        out.push({ type: "mark", children: parseInline(src.slice(i + 2, close), ctx) });
        i = close + 2;
        continue;
      }
    }

    // 删除线 ~~x~~
    if (ch === "~" && src[i + 1] === "~") {
      const close = findDelimiterClose(src, i, "~~");
      if (close > 0) {
        flush();
        out.push({ type: "del", children: parseInline(src.slice(i + 2, close), ctx) });
        i = close + 2;
        continue;
      }
    }

    // 下标 ~x~
    if (ch === "~" && src[i + 1] !== "~") {
      const close = findDelimiterClose(src, i, "~");
      if (close > 0) {
        flush();
        out.push({ type: "sub", children: parseInline(src.slice(i + 1, close), ctx) });
        i = close + 1;
        continue;
      }
    }

    // 上标 ^x^
    if (ch === "^") {
      const close = findDelimiterClose(src, i, "^");
      if (close > 0) {
        flush();
        out.push({ type: "sup", children: parseInline(src.slice(i + 1, close), ctx) });
        i = close + 1;
        continue;
      }
    }

    // 粗体 / 斜体
    if (ch === "*" || ch === "_") {
      const run = countRun(src, i, ch);
      const strong = run >= 2;
      const delim = strong ? ch + ch : ch;
      const close = findDelimiterClose(src, i, delim);
      if (close > 0) {
        flush();
        out.push({
          type: strong ? "strong" : "em",
          children: parseInline(src.slice(i + delim.length, close), ctx),
        });
        i = close + delim.length;
        continue;
      }
      buf += src.slice(i, i + run);
      i += run;
      continue;
    }

    // 裸链接
    if ((ch === "h" || ch === "w" || ch === "f") && (i === 0 || /[\s([<]/.test(src[i - 1]))) {
      const bare = /^(?:(?:https?|ftp):\/\/|www\.)[^\s<]+/.exec(src.slice(i));
      if (bare) {
        const url = trimUrlTail(bare[0]);
        if (url.length > 4) {
          flush();
          const href = url.startsWith("www.") ? `http://${url}` : url;
          out.push({ type: "link", href, children: [{ type: "text", value: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return mergeText(out);
}

/** 提取行内节点的纯文本（标题锚点、大纲、字数统计都要用） */
export function inlineToText(nodes: InlineNode[]): string {
  let text = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text":
      case "code":
      case "math":
        text += node.value;
        break;
      case "image":
        text += node.alt;
        break;
      case "break":
        text += " ";
        break;
      case "footnoteRef":
        text += `[${node.index}]`;
        break;
      case "link":
      case "strong":
      case "em":
      case "del":
      case "mark":
      case "sup":
      case "sub":
      case "htmlInline":
        text += inlineToText(node.children);
        break;
      default:
        break;
    }
  }
  return text;
}
