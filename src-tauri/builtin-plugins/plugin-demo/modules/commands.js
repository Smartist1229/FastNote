/**
 * 命令面板模块：插件信息命令 + 配置读写演示（toggle 特效 / toggle 生命周期钩子）。
 * Modal 演示命令在 modals.js，写笔记演示命令在 notes.js，AI 设置命令在 ai.js。
 * 所有用户可见文案都通过 ctx.i18n 取值。
 */
import { enabledCapabilitiesText } from "./utils.js";

/** 注册命令面板贡献（main.js 编排入口） */
export const registerCommands = (ctx, config) => {
  if (config.commandEnabled === false) return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // 基础：显示插件信息
  ctx.command({
    id: "plugin-demo.info",
    label: t("command.info"),
    icon: "ai-monitor",
    run: (c) => {
      c.ui.toast(
        c.i18n.t("command.infoToast", {
          version: "0.7.0",
          caps: enabledCapabilitiesText(config, c.i18n.t),
        }),
        "info",
      );
    },
  });

  // 配置切换：toggle 特效（读 ctx.config.values + 写 ctx.config.set）
  ctx.command({
    id: "plugin-demo.toggle-effect",
    label: t("command.toggleEffect"),
    icon: "sidebar-clock",
    run: async (c) => {
      const tr = c.i18n.t;
      if (!c.config || typeof c.config.set !== "function") {
        c.ui.toast(tr("command.unsupportedConfig"), "error");
        return;
      }
      const next = !(c.config.values && c.config.values.effectEnabled === true);
      try {
        await c.config.set({ effectEnabled: next });
        c.ui.toast(tr(next ? "command.effectOn" : "command.effectOff"), next ? "success" : "info");
      } catch (e) {
        c.ui.toast(tr("command.saveFailed", { error: e }), "error");
      }
    },
  });

  // 配置切换：toggle 生命周期钩子订阅（演示局部更新 + 自动重激活）
  ctx.command({
    id: "plugin-demo.toggle-hooks",
    label: t("command.toggleHooks"),
    icon: "ai-bolt",
    run: async (c) => {
      const tr = c.i18n.t;
      if (!c.config || typeof c.config.set !== "function") {
        c.ui.toast(tr("command.unsupportedConfig"), "error");
        return;
      }
      const next = !(c.config.values && c.config.values.hooksEnabled === true);
      try {
        await c.config.set({ hooksEnabled: next });
        c.ui.toast(tr(next ? "command.hooksOn" : "command.hooksOff"), next ? "success" : "info");
      } catch (e) {
        c.ui.toast(tr("command.saveFailed", { error: e }), "error");
      }
    },
  });
};
