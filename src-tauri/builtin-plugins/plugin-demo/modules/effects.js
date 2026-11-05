/**
 * 界面效果模块：主题 class、隐藏字数统计、呼吸光点。
 * 样式本体在 ../style.css，这里只负责按配置加/清 body class 与装饰 DOM；
 * 自造的 DOM / class 全部登记 ctx.onDispose，停用时由宿主 LIFO 清理。
 */

/** body.classList 上本插件可能加的所有 class，onDispose 时统一清理 */
const THEME_ACCENT = "plugin-demo-theme-accent";
const THEME_FOCUS = "plugin-demo-theme-focus";
const THEME_CLASSES = [THEME_ACCENT, THEME_FOCUS];
const HIDE_STATS_CLASS = "plugin-demo-hide-stats";
const EFFECT_CLASS = "plugin-demo-effect";

/** 主题：none 时只清掉旧 class，其余按名字加类；停用时移除 */
const applyTheme = (theme, ctx) => {
  const body = document.body;
  THEME_CLASSES.forEach((name) => body.classList.remove(name));
  if (theme === "accent") body.classList.add(THEME_ACCENT);
  else if (theme === "focus") body.classList.add(THEME_FOCUS);
  ctx.onDispose(() => THEME_CLASSES.forEach((name) => body.classList.remove(name)));
};

/** 隐藏内置的字数/行数统计区 */
const applyHideStats = (hidden, ctx) => {
  const body = document.body;
  body.classList.toggle(HIDE_STATS_CLASS, hidden);
  ctx.onDispose(() => body.classList.remove(HIDE_STATS_CLASS));
};

/** 呼吸光点：右上角一个纯装饰元素 */
const attachEffect = (ctx) => {
  const dot = document.createElement("div");
  dot.className = EFFECT_CLASS;
  dot.setAttribute("aria-hidden", "true");
  document.body.appendChild(dot);
  ctx.onDispose(() => dot.remove());
};

/** 按配置应用全部界面效果（main.js 编排入口） */
export const applyEffects = (ctx, config) => {
  applyTheme(config.theme, ctx);
  applyHideStats(config.hideStats === true, ctx);
  if (config.effectEnabled === true) attachEffect(ctx);
};
