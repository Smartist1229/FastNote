/**
 * 基础 HTML 净化。
 *
 * 定位：Markdown 里的 HTML 是「作者自己的富文本」，默认放行；但用户可能粘贴来源不明的
 * 文档，因此默认再过滤一遍脚本类标签、事件属性与 javascript: 协议。
 *
 * 明确边界：这是正则级白名单/黑名单，不是浏览器级解析器。若场景涉及不可信第三方内容，
 * 应把 `preview.sanitizeHtml` 保持开启，并优先考虑关闭 `preview.allowHtml`。
 */

const DANGEROUS_TAGS = ["script", "style", "iframe", "object", "embed", "link", "meta", "base", "form"];

const tagPattern = DANGEROUS_TAGS.join("|");

/** 去掉危险标签（成对与自闭合都处理） */
const stripTags = (html: string): string =>
  html
    .replace(new RegExp(`<\\s*(${tagPattern})\\b[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>`, "gi"), "")
    .replace(new RegExp(`<\\s*\\/?\\s*(${tagPattern})\\b[^>]*>`, "gi"), "");

/** 去掉事件属性（onclick 等）与危险协议 */
const stripAttributes = (html: string): string =>
  html
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\sstyle\s*=\s*("[^"]*"|'[^']*')/gi, (match, value: string) => {
      const inner = value.slice(1, -1);
      // 保留纯排版样式，去掉 expression / url(javascript:)
      return /expression\s*\(|javascript\s*:/i.test(inner) ? "" : match;
    })
    .replace(
      /\s(href|src|xlink:href)\s*=\s*("|')?\s*(?:javascript|vbscript|data:text\/html)[^"'\s>]*("|')?/gi,
      ' $1="#"',
    );

/** 入口 */
export const sanitizeHtml = (html: string): string => stripAttributes(stripTags(html));
