/**
 * 右键菜单模块：笔记右键菜单（多层 submenu + danger + when 条件）
 * 与分组右键菜单。Modal 相关的菜单项在 modals.js。
 * 所有用户可见文案都通过 ctx.i18n 取值（语言切换时宿主会重新激活插件）。
 */
import { enabledCapabilitiesText } from "./utils.js";
import { openSourceModal } from "./sourceView.js";
import { createVisitStore } from "./storage.js";
import { openScratchpad } from "./windows.js";

/** 插件表查询结果 → 一段等宽文本（借自绘弹窗展示，不再另做一套表格 UI） */
const formatVisitReport = (t, tables, rows) => {
  const lines = [t("db.tables", { tables: tables.length > 0 ? tables.join(", ") : t("db.noTables") }), ""];
  if (rows.length === 0) {
    lines.push(t("db.empty"));
    return lines.join("\n");
  }
  lines.push(t("db.recent", { count: rows.length }));
  for (const row of rows) {
    lines.push(
      t("db.row", {
        id: row.id,
        title: row.note_title || t("db.untitled"),
        visits: row.visits,
        time: row.created_at,
      }),
    );
  }
  return lines.join("\n");
};

/** 笔记右键菜单（ctx.menu.note） */
const registerNoteMenus = (ctx, config) => {
  if (config.menuEnabled === false) return;
  const t = (key, vars) => ctx.i18n.t(key, vars);
  // 表名来自配置项：配置里改了表名，下一次 activate 就是另一张表
  const visits = createVisitStore(config.dbVisitsTable);

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

  // 插件笔记管理子菜单：子项按配置开关拼——关掉的功能连菜单项都不出现，
  // 这样「配置里有什么」和「界面上能看到什么」是一一对应的
  const submenu = [
    {
      id: "plugin-demo.delete-plugin-note",
      label: t("menu.deleteMine"),
      icon: "ai-trash",
      danger: true,
      // 仅当笔记可编辑（未锁定）时展示，演示 when 条件
      // 沙箱里不能传函数条件，用声明式：is_locked 为假时显示
      when: { field: "is_locked", is: "falsy" },
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
  ];

  // 读取正文：插件自绘弹窗（配置项 sourceModalEnabled）
  if (config.sourceModalEnabled !== false) {
    submenu.push({
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
          // 弹窗完全由插件自己画：ui.modal 只给一个空壳（标题 / 宽度档位 / 按钮），
          // 内容是一棵插件自己拼的 DOM，样式在 style.css 里，外观对齐「历史版本对比」
          await openSourceModal(c, content && content.trim() ? content : tr("menu.readEmpty"), {
            title: tr("menu.readTitle", { title: note.title || tr("menu.untitled") }),
          });
        } catch (e) {
          c.ui.toast(tr("menu.readFailed", { error: e }), "error");
        }
      },
    });
  }

  // 插件私有表（配置项 dbDemoEnabled / dbVisitsTable）
  if (config.dbDemoEnabled !== false) {
    submenu.push({
      id: "plugin-demo.db-visit",
      label: t("menu.dbDemo"),
      icon: "ai-sparkles",
      onClick: async (note, c) => {
        const tr = c.i18n.t;
        try {
          const rows = await visits.record(c, note);
          const tables = await visits.tables(c);
          await openSourceModal(c, formatVisitReport(tr, tables, rows), {
            title: tr("db.title", { table: visits.table }),
            heading: tr("db.heading"),
          });
        } catch (e) {
          c.ui.toast(tr("db.failed", { error: e }), "error");
        }
      },
    });
  }

  // 插件窗口里的速记工具（配置项 windowEnabled）
  if (config.windowEnabled !== false) {
    submenu.push({
      id: "plugin-demo.open-window",
      label: t("menu.toolWindow"),
      icon: "ai-monitor",
      onClick: (_note, c) => {
        // 带上 config：窗口要用它决定表名、当前键位与尺寸
        void openScratchpad(c, config);
      },
    });
  }

  ctx.menu.note({
    id: "plugin-demo.notes-menu",
    label: t("menu.notesMenu"),
    icon: "ai-file-text",
    submenu,
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
