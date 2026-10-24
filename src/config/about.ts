/**
 * 「关于」页展示的固定信息：应用名兜底值、作者、图标来源、开源项目清单。
 *
 * 组件只负责渲染（消费方为 SettingsModal 的关于页），改文案或增删开源项目不用碰界面代码。
 */

/** 应用名兜底值（读不到 Tauri 应用名时使用） */
export const APP_NAME_FALLBACK = "FastNote";

/** 作者（固定值） */
export const APP_AUTHOR = "Smartist";

/** 图标来源：界面里的图标取自阿里巴巴矢量图标库 */
export const ICON_SOURCE = {
  name: "iconfont-阿里巴巴矢量图标库",
  url: "https://www.iconfont.cn/",
};

/** 开源项目清单（链接取自各包 package.json / Cargo.toml 里的官方仓库），按依赖类型大致排序 */
export const OPEN_SOURCE_PROJECTS: { name: string; url: string }[] = [
  { name: "Tauri", url: "https://github.com/tauri-apps/tauri" },
  { name: "React", url: "https://github.com/react/react" },
  { name: "Vite", url: "https://github.com/vitejs/vite" },
  { name: "TypeScript", url: "https://github.com/microsoft/TypeScript" },
  { name: "Tailwind CSS", url: "https://github.com/tailwindlabs/tailwindcss" },
  { name: "Mermaid", url: "https://github.com/mermaid-js/mermaid" },
  { name: "KaTeX", url: "https://github.com/KaTeX/KaTeX" },
  { name: "date-fns", url: "https://github.com/date-fns/date-fns" },
  { name: "Serde", url: "https://github.com/serde-rs/serde" },
  { name: "Reqwest", url: "https://github.com/seanmonstar/reqwest" },
  { name: "Chrono", url: "https://github.com/chronotope/chrono" },
  { name: "rusqlite", url: "https://github.com/rusqlite/rusqlite" },
  { name: "SQLite", url: "https://sqlite.org" },
  { name: "pulldown-cmark", url: "https://github.com/pulldown-cmark/pulldown-cmark" },
  { name: "zip", url: "https://github.com/zip-rs/zip2" },
  { name: "ring", url: "https://github.com/briansmith/ring" },
  { name: "sha2（RustCrypto）", url: "https://github.com/RustCrypto/hashes" },
];

/** 仅用于展示：去掉协议、www. 与结尾的 .git，列表里只留域名和路径（不改动原始 url） */
export const shortUrl = (url: string) =>
  url.replace(/^https?:\/\/(www\.)?/, "").replace(/\.git$/, "");
