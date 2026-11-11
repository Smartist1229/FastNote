/**
 * 纯工具函数模块：被 menus / commands / modals / notes 等多个模块 import，
 * 证明 fastnote-plugin 协议下模块之间的相对路径互相引用可以工作。
 * 没有副作用，任何模块 import 它都是安全的。
 */

/** 把毫秒数格式化成 mm:ss */
export const fmtDuration = (ms) => {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
};

/** 返回一个切换函数：调用一次取反 */
export const makeToggle = (initial = false) => {
  let v = initial;
  return () => { v = !v; return v; };
};

/** 延迟 n 毫秒的 Promise */
export const sleep = (n) => new Promise((r) => setTimeout(r, n));

/**
 * 已启用的能力清单：返回本地化后的能力名数组。
 * t 由调用方传入（ctx.i18n.t），本模块不依赖宿主全局。
 */
export const enabledCapabilities = (config, t) => {
  const list = [t("ui.capabilitiesList.config")];
  if (config.menuEnabled !== false) list.push(t("ui.capabilitiesList.menu"));
  if (config.groupMenuEnabled !== false) list.push(t("ui.capabilitiesList.groupMenu"));
  if (config.commandEnabled !== false) list.push(t("ui.capabilitiesList.command"));
  if (config.toolbarEnabled !== false) list.push(t("ui.capabilitiesList.toolbar"));
  if (config.modalEnabled !== false) list.push(t("ui.capabilitiesList.modal"));
  if (config.hooksEnabled !== false) list.push(t("ui.capabilitiesList.hooks"));
  if (config.aiToolEnabled !== false) list.push(t("ui.capabilitiesList.aiTool"));
  if (config.aiDemoEnabled !== false) {
    list.push(t("ui.capabilitiesList.aiProvider"), t("ui.capabilitiesList.aiSettings"));
  }
  if (config.settingsSectionEnabled !== false) list.push(t("ui.capabilitiesList.section"));
  if (config.theme === "accent" || config.theme === "focus") list.push(t("ui.capabilitiesList.theme"));
  if (config.effectEnabled === true) list.push(t("ui.capabilitiesList.effect"));
  if (config.hideStats === true) list.push(t("ui.capabilitiesList.hideStats"));
  if (config.notesEnabled !== false) list.push(t("ui.capabilitiesList.notes"));
  if (config.sourceModalEnabled !== false) list.push(t("ui.capabilitiesList.sourceModal"));
  if (config.dbDemoEnabled !== false) list.push(t("ui.capabilitiesList.db"));
  if (config.shortcutEnabled !== false) list.push(t("ui.capabilitiesList.shortcut"));
  if (config.windowEnabled !== false) list.push(t("ui.capabilitiesList.window"));
  return list;
};

/** 能力清单的一句话文案（「能力说明」菜单项与「显示插件信息」命令共用） */
export const enabledCapabilitiesText = (config, t) => {
  const list = enabledCapabilities(config, t);
  if (list.length <= 1) return t("ui.disabled");
  return t("ui.capabilities", { list: list.join(t("ui.separator")) });
};
