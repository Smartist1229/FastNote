/**
 * 插件模板（沙箱运行时）。
 *
 * 约定：export default { activate(ctx) }；`ctx` 的类型在同目录 plugin-api.d.ts（jsconfig.json 已配好）。
 * 这里演示最小闭环：配置 + 私有表 + 右键菜单 + 快捷键 + 钩子 + 数据目录 + 弹窗 + 清理。
 *
 * 三个容易踩的点：
 *   1. 注册类调用（menu / shortcut / hooks）在沙箱里是**异步 RPC**，必须 await，
 *      否则注册失败只会变成一条 unhandled rejection，界面上什么都看不到；
 *   2. 沙箱里的 `document` 是 iframe 自己的，改宿主样式只能走 ctx.ui.setBodyClass /
 *      setHtmlClass，插节点只能走 ctx.ui.mount（宿主代插）；
 *   3. 弹窗只能交 HTML 字符串（宿主会消毒），不能传 DOM 节点或函数。
 */
export default {
  /**
   * 这一行 JSDoc 就是「补全」的来源：编辑器看到 `import("./plugin-api")` 就知道 ctx 的完整结构。
   * 删掉它也不会影响运行，只是 ctx 变成 any（没有补全、没有类型检查）。
   *
   * @param {import("./plugin-api").FastNoteContext} ctx
   */
  async activate(ctx) {
    const t = (key, vars) => ctx.i18n.t(key, vars);
    const greeting = String(ctx.config.values.greeting || "");
    const combo = String(ctx.config.values.combo || "Ctrl+Alt+L");

    // 私有表：表名自动加 plugin_<目录名>__ 前缀，碰不到宿主和其它插件
    await ctx.db.createTable("visits", [{ name: "at", kind: "text" }]);
    await ctx.db.insert("visits", { at: new Date().toISOString() });
    const count = await ctx.db.count("visits");

    // 界面注入：一个角标（宿主插入，并登记到清理契约，停用自动摘掉）
    const badge = document.createElement("span");
    badge.className = "my-plugin-badge";
    badge.textContent = `★ ${count}`;
    await ctx.ui.mount("body", badge);

    // 快捷键：切换宿主 body 上的一个 class（样式写在 style.css）
    let active = false;
    try {
      await ctx.shortcut.register(combo, async () => {
        active = !active;
        await ctx.ui.setBodyClass("my-plugin-active", active);
        ctx.ui.toast(active ? t("ui.on") : t("ui.off"), "info");
      });
    } catch (e) {
      // 撞宿主键位（Ctrl+F 等）或其它插件占用时这里会抛，别静默吞掉
      ctx.ui.toast(t("toast.shortcutFailed", { combo, error: e?.message ?? e }), "error");
    }

    // 右键菜单：when 用声明式条件（跨 iframe 不能同步调函数）
    await ctx.menu.note({
      id: "my-plugin.stats",
      label: t("menu.stats"),
      icon: "sidebar-list",
      onClick: async (note) => {
        await ctx.db.insert("visits", { at: new Date().toISOString() });
        const total = await ctx.db.count("visits");
        // 弹窗内容：HTML 字符串（div/p/span/table… 白名单内的标签），样式来自 style.css
        await ctx.ui.modal({
          title: t("menu.stats"),
          html: `<div class="my-plugin-dialog"><p>${t("dialog.line", {
            title: note?.title || t("dialog.untitled"),
            total,
          })}</p></div>`,
          buttons: [{ label: t("dialog.close") }],
        });
      },
    });

    // 生命周期钩子 + 数据目录：每次保存笔记时留一份时间戳（<data>/plugin-data/<目录名>/）
    await ctx.hooks.onNoteSave(async (note) => {
      try {
        await ctx.fs.write(
          "last-save.json",
          JSON.stringify({ at: new Date().toISOString(), title: note?.title ?? "" }, null, 2),
        );
      } catch (e) {
        // 钩子里抛错会被宿主记日志，但不会打扰用户；要提示就自己 toast
        console.warn("写入 last-save.json 失败：", e);
      }
    });

    ctx.ui.toast(t("toast.ready", { count, greeting }), "success");
  },
};
