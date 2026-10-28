/**
 * 第三方渲染能力的懒加载层：highlight.js / KaTeX / Mermaid。
 *
 * 三个依赖都只在真正需要时才 import，因此：
 * - 纯文本用户不会为图表、公式付出首屏体积；
 * - 任一依赖缺失（例如从 npm 提取后没装可选依赖）只降级为纯文本/源码，不抛错。
 *
 * 代码高亮额外做了「按 语言+内容 缓存 + 按行切分并补齐跨行 span」，
 * 后者是行号显示的前提：highlight.js 的输出会把多个 token 包在同一个 span 里，
 * 直接按 \n 切会得到残缺标签。
 */

/** highlight.js 实例类型（type-only，不产生运行时依赖） */
type Hljs = typeof import("highlight.js").default;

let highlighter: Promise<Hljs | null> | null = null;

/** 懒加载 highlight.js；失败返回 null */
export const loadHighlighter = (): Promise<Hljs | null> => {
  if (!highlighter) {
    highlighter = import("highlight.js")
      .then((mod) => mod.default)
      .catch(() => null);
  }
  return highlighter;
};

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** 高亮结果缓存：编辑时同一段代码会被频繁重渲染，命中率很高 */
const cache = new Map<string, string>();
const CACHE_LIMIT = 400;

const remember = (key: string, value: string): string => {
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
};

/** 高亮一段代码，返回可直接 innerHTML 的字符串；失败时返回转义后的纯文本 */
export const highlightCode = async (code: string, lang: string, enabled: boolean): Promise<string> => {
  if (!enabled) return escapeHtml(code);
  const key = `${lang}\u0000${code}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const hljs = await loadHighlighter();
  if (!hljs) return remember(key, escapeHtml(code));

  try {
    if (lang && hljs.getLanguage(lang)) {
      return remember(key, hljs.highlight(code, { language: lang, ignoreIllegals: true }).value);
    }
    if (!lang) {
      // 无语言标记：不猜（auto 检测对短代码误判率太高），保持纯文本
      return remember(key, escapeHtml(code));
    }
    return remember(key, escapeHtml(code));
  } catch {
    return remember(key, escapeHtml(code));
  }
};

const VOID_TAGS = new Set(["br", "hr", "img", "input", "meta", "link", "source", "wbr", "col"]);

/**
 * 把高亮后的 HTML 按行切开，并为每一行补齐跨行的开始/结束标签。
 * 行号槽与代码行需要一一对应，直接 split("\n") 会破坏嵌套 span。
 */
export const splitHighlightedLines = (html: string): string[] => {
  const rawLines = html.split("\n");
  const lines: string[] = [];
  let open: string[] = [];

  const tagRe = /<(\/)?([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g;

  for (const raw of rawLines) {
    const stack = [...open];
    tagRe.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(raw))) {
      const [, closing, name, selfClosing] = match;
      if (closing) {
        const index = stack.lastIndexOf(name);
        if (index >= 0) stack.length = index;
      } else if (!selfClosing && !VOID_TAGS.has(name.toLowerCase())) {
        stack.push(name);
      }
    }
    const prefix = open.map((name) => `<${name}>`).join("");
    const suffix = [...stack].reverse().map((name) => `</${name}>`).join("");
    lines.push(prefix + raw + suffix);
    open = stack;
  }

  return lines;
};

/* ---------------- KaTeX ---------------- */

type Katex = typeof import("katex").default;

let katexModule: Promise<Katex | null> | null = null;

const loadKatex = (): Promise<Katex | null> => {
  if (!katexModule) {
    katexModule = Promise.all([import("katex"), import("katex/dist/katex.min.css")])
      .then(([mod]) => mod.default)
      .catch(() => null);
  }
  return katexModule;
};

/** 渲染公式：返回 HTML；KaTeX 不可用时返回 null */
export const renderMath = async (
  code: string,
  displayMode: boolean,
): Promise<{ html: string; error: string } | null> => {
  const katex = await loadKatex();
  if (!katex) return null;
  try {
    return {
      html: katex.renderToString(code, {
        displayMode,
        throwOnError: true,
        output: "html",
        strict: false,
        trust: false,
      }),
      error: "",
    };
  } catch (error) {
    return { html: "", error: error instanceof Error ? error.message : String(error) };
  }
};

/* ---------------- Mermaid ---------------- */

type Mermaid = typeof import("mermaid").default;

let mermaidModule: Promise<Mermaid | null> | null = null;
let mermaidTheme = "";

const loadMermaid = (): Promise<Mermaid | null> => {
  if (!mermaidModule) {
    mermaidModule = import("mermaid")
      .then((mod) => mod.default)
      .catch(() => null);
  }
  return mermaidModule;
};

let mermaidSeq = 0;

/** 渲染 Mermaid 图：返回 SVG 字符串；失败返回 null 由调用方回退到源码 */
export const renderMermaid = async (
  code: string,
  theme: string,
): Promise<string | null> => {
  const mermaid = await loadMermaid();
  if (!mermaid) return null;
  try {
    if (mermaidTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        suppressErrorRendering: true,
        theme: theme as never,
        securityLevel: "loose",
        fontFamily: "inherit",
      });
      mermaidTheme = theme;
    }
    const id = `mde-mermaid-${++mermaidSeq}`;
    const { svg } = await mermaid.render(id, code);
    return svg;
  } catch {
    return null;
  }
};

export { escapeHtml };
