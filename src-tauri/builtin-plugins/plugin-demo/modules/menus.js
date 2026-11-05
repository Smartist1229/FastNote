/**
 * 右键菜单模块：笔记右键菜单（多层 submenu + danger + when 条件）
 * 与分组右键菜单。Modal 相关的菜单项在 modals.js。
 * 所有用户可见文案都通过 ctx.i18n 取值（语言切换时宿主会重新激活插件）。
 */
import { enabledCapabilitiesText } from "./utils.js";

/** 笔记右键菜单（ctx.menu.note） */
const registerNoteMenus = (ctx, config) => {
  if (config.menuEnabled === false) return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // 打招呼子菜单（hover 展开；宿主会先渲染插件分组，再渲染本项，形成三层结构）
  ctx.menu.note({
    id: "plugin-demo.greet",
    label: t("menu.greet"),
    icon: "ai-sparkles",
    submenu: [
      {
        id: "plugin-demo.greet-hello",
        label: t("menu.hello"),
        icon: "ai-sparkles",
        onClick: (note, c) => {
          const title = (note && note.title) || c.i18n.t("menu.untitled");
          const greeting = typeof config.greeting === "string" ? config.greeting : "";
          c.ui.toast(c.i18n.t("menu.helloToast", { greeting, title }), "success");
        },
      },
      {
        id: "plugin-demo.capabilities",
        label: t("menu.capabilities"),
        icon: "ai-lightbulb",
        onClick: (_note, c) => {
          c.ui.toast(
            c.i18n.t("menu.capabilitiesToast", {
              caps: enabledCapabilitiesText(config, c.i18n.t),
            }),
            "info",
          );
        },
      },
    ],
  });

  // 插件笔记管理子菜单（danger + when + notes API 联动）
  ctx.menu.note({
    id: "plugin-demo.notes-menu",
    label: t("menu.notesMenu"),
    icon: "ai-file-text",
    submenu: [
      {
        id: "plugin-demo.delete-plugin-note",
        label: t("menu.deleteMine"),
        icon: "ai-trash",
        danger: true,
        // 仅当笔记可编辑（未锁定）时展示，演示 when 条件
        when: (note) => !!note && note.is_locked !== true,
        onClick: async (note, c) => {
          const tr = c.i18n.t;
          if (!c.notes || typeof c.notes.remove !== "function") {
            c.ui.toast(tr("menu.unsupportedRemove"), "error");
            return;
          }
          const result = await c.ui.modal({
            title: tr("menu.deleteTitle"),
            content: tr("menu.deleteContent", {
              title: note.title || tr("menu.untitled"),
            }),
            confirmText: tr("menu.deleteConfirm"),
            cancelText: tr("menu.deleteCancel"),
            danger: true,
          });
          if (!result || !result.ok) {
            c.ui.toast(tr("menu.deleteCanceled"), "info");
            return;
          }
          try {
            await c.notes.remove(note.id);
            c.ui.toast(tr("menu.deleted", { id: note.id }), "success");
          } catch (e) {
            c.ui.toast(tr("menu.deleteFailed", { error: e }), "error");
          }
        },
      },
      {
        id: "plugin-demo.read-note",
        label: t("menu.readNote"),
        icon: "ai-edit",
        onClick: async (note, c) => {
          const tr = c.i18n.t;
          if (!c.notes || typeof c.notes.getContent !== "function") {
            c.ui.toast(tr("menu.unsupportedRead"), "error");
            return;
          }
          if (note.is_locked) {
            c.ui.toast(tr("menu.noteLocked"), "info");
            return;
          }
          try {
            const content = await c.notes.getContent(note.id);
            // 笔记正文交给编辑器的纯渲染模式展示：ctx.editor.render 生成句柄，
            // ui.modal 的 render 字段识别句柄后用 MarkdownPreview（只读）排版渲染
            await c.ui.modal({
              title: tr("menu.readTitle", { title: note.title || tr("menu.untitled") }),
              render: c.editor.render(content && content.trim() ? content : tr("menu.readEmpty")),
              buttons: [{ label: tr("menu.close") }],
            });
          } catch (e) {
            c.ui.toast(tr("menu.readFailed", { error: e }), "error");
          }
        },
      },
    ],
  });
};

/** 分组右键菜单（ctx.menu.group） */
const registerGroupMenus = (ctx, config) => {
  if (config.groupMenuEnabled === false) return;
  if (!ctx.menu || typeof ctx.menu.group !== "function") return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // 顶层入口：hover 展开子菜单
  ctx.menu.group({
    id: "plugin-demo.group-menu-root",
    label: t("menu.groupRoot"),
    icon: "ai-sparkles",
    submenu: [
      {
        id: "plugin-demo.group-stats",
        label: t("menu.groupCount"),
        icon: "ai-monitor",
        onClick: (c) => {
          c.ui.toast(c.i18n.t("menu.groupCountToast"), "success");
        },
      },
    ],
  });

  // 独立 danger 项（演示 danger 样式）
  ctx.menu.group({
    id: "plugin-demo.group-danger",
    label: t("menu.groupDanger"),
    icon: "ai-warning",
    danger: true,
    onClick: (c) => {
      c.ui.toast(c.i18n.t("menu.groupDangerToast"), "info");
    },
  });
};

/** 注册全部右键菜单贡献（main.js 编排入口） */
export const registerMenus = (ctx, config) => {
  registerNoteMenus(ctx, config);
  registerGroupMenus(ctx, config);
};
