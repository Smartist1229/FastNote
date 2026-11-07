/**
 * 界面效果模块：主题 class、隐藏字数统计、呼吸光点。
 * 样式本体在 ../style.css；class 通过 ctx.ui.setBodyClass 交给**宿主**去加——
 * 沙箱插件自己的 document 是 iframe 的，直接改 document.body 不会影响软件界面。
 * 宿主会在插件停用时自动把这些 class 去掉，这里不用自己登记清理。
 */

const THEME_ACCENT = "plugin-demo-theme-accent";
const THEME_FOCUS = "plugin-demo-theme-focus";
const HIDE_STATS_CLASS = "plugin-demo-hide-stats";
const EFFECT_CLASS = "plugin-demo-effect";

/** 主题：none 时两个类都关掉，其余按名字打开 */
const applyTheme = (theme, ctx) => {
  void ctx.ui.setBodyClass(THEME_ACCENT, theme === "accent");
  void ctx.ui.setBodyClass(THEME_FOCUS, theme === "focus");
};

/** 隐藏内置的字数/行数统计区 */
const applyHideStats = (hidden, ctx) => {
  void ctx.ui.setBodyClass(HIDE_STATS_CLASS, hidden === true);
};

/** 呼吸光点：右上角一个纯装饰元素（走 ctx.ui.mount，宿主代插、停用自动摘掉） */
const attachEffect = (ctx) => {
  const dot = document.createElement("div");
  dot.className = EFFECT_CLASS;
  dot.setAttribute("aria-hidden", "true");
  ctx.ui.mount("body", dot);
};

/** 按配置应用全部界面效果（main.js 编排入口） */
export const applyEffects = (ctx, config) => {
  applyTheme(config.theme, ctx);
  applyHideStats(config.hideStats === true, ctx);
  if (config.effectEnabled === true) attachEffect(ctx);
};
