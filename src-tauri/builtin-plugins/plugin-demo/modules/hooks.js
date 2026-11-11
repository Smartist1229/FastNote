/**
 * 生命周期钩子模块：订阅 onNoteCreate / onNoteSave / onNoteDelete / onNoteSwitch，
 * 触发时 toast 提示。每种 hook 最多 toast 3 次，多了静默，避免刷屏。
 * 文案通过闭包里的 ctx.i18n 取值（语言切换会重新激活并重新订阅）。
 */

/** 注册生命周期钩子演示（main.js 编排入口） */
export const registerHooks = (ctx, config) => {
  if (config.hooksEnabled === false) return;
  if (!ctx.hooks) return;

  // 用一个模块内计数器，让 toast 不刷屏
  const hookCounts = { create: 0, save: 0, delete: 0, switch: 0 };
  const maxToastPerHook = 3; // 每种 hook 最多 toast 3 次，多了静默

  if (typeof ctx.hooks.onNoteCreate === "function") {
    ctx.hooks.onNoteCreate((payload) => {
      hookCounts.create++;
      if (hookCounts.create <= maxToastPerHook) {
        const note = payload && payload.note;
        const isExt = payload && payload.isExternal;
        const title = (note && note.title) || ctx.i18n.t("hook.untitled");
        const external = isExt ? ctx.i18n.t("hook.external") : "";
        ctx.ui.toast(ctx.i18n.t("hook.createToast", { title, external }), "success");
      }
    });
  }

  if (typeof ctx.hooks.onNoteSave === "function") {
    ctx.hooks.onNoteSave((payload) => {
      hookCounts.save++;
      if (hookCounts.save <= maxToastPerHook) {
        const id = payload && payload.noteId;
        const len = payload && payload.content ? payload.content.length : 0;
        ctx.ui.toast(ctx.i18n.t("hook.saveToast", { id, len }), "info");
      }
    });
  }

  if (typeof ctx.hooks.onNoteDelete === "function") {
    ctx.hooks.onNoteDelete((payload) => {
      hookCounts.delete++;
      if (hookCounts.delete <= maxToastPerHook) {
        const id = payload && payload.noteId;
        ctx.ui.toast(ctx.i18n.t("hook.deleteToast", { id }), "error");
      }
    });
  }

  if (typeof ctx.hooks.onNoteSwitch === "function") {
    ctx.hooks.onNoteSwitch((payload) => {
      hookCounts.switch++;
      if (hookCounts.switch <= maxToastPerHook) {
        const oldId = payload && payload.oldNoteId;
        const newId = payload && payload.newNoteId;
        ctx.ui.toast(
          ctx.i18n.t("hook.switchToast", {
            old: oldId ?? ctx.i18n.t("hook.empty"),
            new: newId ?? ctx.i18n.t("hook.empty"),
          }),
          "info",
        );
      }
    });
  }
};
