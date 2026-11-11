/**
 * 插件 HTML 消毒：沙箱插件只能交**字符串**，由宿主插入页面。
 * 直接 innerHTML 会把沙箱白干（一段 <img onerror> 就能拿到主页面权限），所以：
 *   - 标签白名单，其余整段丢弃（script/style/iframe/object/embed/form/input/link/meta/base…）；
 *   - 属性白名单 + 禁止 on* 事件、禁止 javascript: / data: 协议（img 的 data: 图像除外）；
 *   - 只保留 text 与安全结构，注释直接去掉。
 *
 * 这是保守实现：宁可少显示，也不放行可疑标签。插件要更复杂的结构请用 div/span 拼。
 */

/** 允许保留的标签 */
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "dd", "div", "dl", "dt", "em", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "kbd", "li", "mark", "ol", "p", "pre", "s", "small",
  "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "u", "ul",
]);

/** 允许保留的属性（其余一律删除，尤其是 on*） */
const ALLOWED_ATTRS = new Set([
  "class", "title", "href", "src", "alt", "width", "height", "colspan", "rowspan", "style",
]);

/** 协议白名单：href 只许 http/https/mailto/#，src 只许 http/https */
const isSafeUrl = (value: string, attr: string): boolean => {
  const url = value.trim().toLowerCase();
  if (url.startsWith("#") || url.startsWith("/") || url.startsWith("./") || url.startsWith("../")) {
    return true;
  }
  if (url.startsWith("http://") || url.startsWith("https://")) return true;
  if (attr === "href" && url.startsWith("mailto:")) return true;
  // 内联图片：只允许 image/*
  if (attr === "src" && url.startsWith("data:image/")) return true;
  return false;
};

/** 清洗一段 HTML，返回可安全 innerHTML 的字符串 */
export const sanitizePluginHtml = (html: string): string => {
  if (!html) return "";
  if (typeof DOMParser === "undefined") return ""; // 非浏览器环境直接拒绝
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const walk = (node: Element): void => {
    for (const child of [...node.children]) {
      const tag = child.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) {
        child.remove();
        continue;
      }
      for (const attr of [...child.attributes]) {
        const name = attr.name.toLowerCase();
        if (!ALLOWED_ATTRS.has(name)) {
          child.removeAttribute(attr.name);
          continue;
        }
        if ((name === "href" || name === "src") && !isSafeUrl(attr.value, name)) {
          child.removeAttribute(attr.name);
        }
      }
      walk(child);
    }
  };
  walk(doc.body);
  return doc.body.innerHTML;
};
