/**
 * 全局快捷键演示（ctx.shortcut）：按下就打开插件自己的窗口。
 *
 * 键位从哪来：配置项 `shortcutCombo`（设置 → 插件 → 插件演示 → 快捷键与窗口 里改），
 * 改完宿主会把配置落库并重新激活本插件，这里重新注册、宿主自动注销旧键。
 * 顺手把这个键写进插件私有表（`prefs` 的 `shortcut` 行），所以「数据库里能看到当前快捷键」
 * ——窗口里也是从这张表读出来展示的。
 *
 * 四条约定（宿主实现）：
 *   - 组合键写成 "Ctrl+Alt+P" 这种形式，修饰键顺序随便，大小写不敏感；
 *   - `scope: "app"` 只在软件窗口有焦点时响应，`"global"` 注册为系统热键（最小化 / 托盘里也能按到）；
 *   - 和宿主**当前生效**的快捷键（用户可在设置里改）、别的插件、系统里已占用的热键撞了会直接抛错，
 *     插件自己决定是降级提示还是让加载失败——这里选择提示后继续；
 *   - 插件停用 / 卸载时宿主自动注销，不需要手动 remove。
 */

import { createPrefs } from "./prefs.js";
import { openScratchpad } from "./windows.js";

/** 配置项也空着时的最终兜底 */
const FALLBACK_SHORTCUT = "Ctrl+Alt+P";

export const registerShortcuts = async (ctx, config = {}) => {
  if (config.shortcutEnabled === false) return;
  if (!ctx.shortcut || typeof ctx.shortcut.register !== "function") return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  const combo =
    typeof config.shortcutCombo === "string" && config.shortcutCombo.trim()
      ? config.shortcutCombo.trim()
      : FALLBACK_SHORTCUT;

  // 把生效的键位记进插件表：数据库里能看到「这个插件占着哪个键」。
  // 表写不进去不影响功能（窗口里会回落到配置里的默认值），但要**说出来**——
  // 静默 catch 的后果是「表是空的、键也不是表里那个值」，排查时毫无线索。
  const prefs = createPrefs(config.dbPrefsTable);
  try {
    await prefs.set(ctx, "shortcut", combo);
  } catch (e) {
    console.error("写入快捷键记录失败：", e);
    ctx.ui.toast(t("shortcut.dbFailed", { error: e && e.message ? e.message : e }), "error");
  }

  // 作用域：默认系统全局，用户可在设置里改成「仅窗口内」
  const scope = config.shortcutScope === "app" ? "app" : "global";

  try {
    // 按下快捷键 → 打开速记窗口（工具本体在 window.html，数据在插件的 drafts 表里）
    ctx.shortcut.register(combo, () => {
      void prefs
        .bump(ctx, "opens")
        .catch((e) => console.warn("写入打开次数失败：", e))
        .finally(() => openScratchpad(ctx, config, combo));
    }, { scope });
  } catch (e) {
    ctx.ui.toast(t("shortcut.conflict", { combo, error: e && e.message ? e.message : e }), "error");
  }
};
