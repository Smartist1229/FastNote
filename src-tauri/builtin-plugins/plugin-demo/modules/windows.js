/**
 * 插件窗口演示（ctx.window）：把插件目录里的 window.html 单独开成一个窗口。
 *
 * 窗口是「宿主外壳 + 插件页面」：外壳在应用源，负责标题栏、关闭按钮和代理宿主能力；
 * 插件页面在 iframe 里，页面 / 样式 / 脚本全归插件。插件停用 / 卸载时宿主会把窗口全部关掉。
 *
 * 窗口里跑的是本插件的「速记」小工具：写点东西 → 存进插件的 drafts 表 → 下次能翻回来。
 * 页面里没有 ctx（它是另一个文档），所以语言、表名、当前键位都由这里通过 query 转交。
 */

/** 配置里表名没填时的兜底（与 prefs.js 保持一致） */
const FALLBACK_PREFS_TABLE = "prefs";
const FALLBACK_DRAFTS_TABLE = "drafts";
const FALLBACK_SHORTCUT = "Ctrl+Alt+P";

/** 裸表名：只接受 [a-z0-9_]，非法值回落到默认（宿主侧还会再校验一次） */
const normalizeTable = (raw, fallback) => {
  const name = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z][a-z0-9_]{0,47}$/.test(name) ? name : fallback;
};

/**
 * 打开速记窗口。
 * @param {object} ctx 插件上下文（用 ctx.i18n / ctx.window / ctx.ui）
 * @param {object} config 插件配置项
 * @param {string} [combo] 当前生效的快捷键，窗口里只用来展示「按这个键能打开我」
 */
export const openScratchpad = async (ctx, config = {}, combo) => {
  const t = (key, vars) => ctx.i18n.t(key, vars);
  if (config.windowEnabled === false) {
    ctx.ui.toast(t("window.disabled"), "info");
    return;
  }

  const prefsTable = normalizeTable(config.dbPrefsTable, FALLBACK_PREFS_TABLE);
  const draftsTable = normalizeTable(config.dbDraftsTable, FALLBACK_DRAFTS_TABLE);
  const shortcut =
    typeof combo === "string" && combo.trim()
      ? combo.trim()
      : typeof config.shortcutCombo === "string" && config.shortcutCombo.trim()
        ? config.shortcutCombo.trim()
        : FALLBACK_SHORTCUT;

  const query = new URLSearchParams({
    lang: ctx.i18n.locale || "zh",
    prefs: prefsTable,
    drafts: draftsTable,
    combo: shortcut,
  });

  try {
    await ctx.window.open(`window.html?${query.toString()}`, {
      title: t("window.title"),
      width: Number(config.windowWidth) || 560,
      height: Number(config.windowHeight) || 520,
    });
  } catch (e) {
    ctx.ui.toast(t("window.failed", { error: e }), "error");
  }
};
