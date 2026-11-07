/**
 * 编辑器工具栏模块：6 个按钮，其中 4 个图标按钮 + 2 个纯文字按钮。
 * 用来验证图标按钮固定 32×32 对齐、中文文字按钮不竖排、溢出区可横向滚动。
 * 插入走 editor.insertText（需要 editor.insert 权限），只读或未就绪时返回 false。
 * 所有用户可见文案都通过 ctx.i18n 取值。
 */

/** 统计正文字符数与词数 */
const countText = (content) => {
  const chars = content?.length ?? 0;
  const words = content ? content.trim().split(/\s+/).filter(Boolean).length : 0;
  return { chars, words };
};

/** 注册编辑器工具栏贡献（main.js 编排入口） */
export const registerToolbar = (ctx, config) => {
  if (config.toolbarEnabled === false) return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  // 图标按钮 ①：插入当前时间
  ctx.editor.toolbar({
    id: "plugin-demo.insert-time",
    title: t("toolbar.insertTime"),
    icon: "sidebar-clock",
    onClick: async (editor, c) => {
      const tr = c.i18n.t;
      if (typeof c.editor.insertText !== "function") {
        c.ui.toast(tr("toolbar.insertUnsupported"), "error");
        return;
      }
      if (!(await c.editor.insertText("\n" + new Date().toLocaleString() + "\n"))) {
        c.ui.toast(tr("toolbar.editorNotReady"), "error");
        return;
      }
      c.ui.toast(tr("toolbar.insertedTime"), "success");
    },
  });

  // 图标按钮 ②：统计字数
  ctx.editor.toolbar({
    id: "plugin-demo.word-count",
    title: t("toolbar.count"),
    icon: "ai-file-text",
    onClick: async (editor, c) => {
      const { chars, words } = countText(editor.content);
      c.ui.toast(c.i18n.t("toolbar.statsToast", { chars, words }), "info");
    },
  });

  // 图标按钮 ③：复制笔记标题（演示 editor-copy 图标）
  ctx.editor.toolbar({
    id: "plugin-demo.copy-title",
    title: t("toolbar.copyTitle"),
    icon: "editor-copy",
    onClick: async (editor, c) => {
      const tr = c.i18n.t;
      try {
        await navigator.clipboard.writeText(editor.title || "");
        c.ui.toast(tr("toolbar.copyOk", { title: editor.title || "" }), "success");
      } catch (e) {
        c.ui.toast(tr("toolbar.copyFailed", { error: e }), "error");
      }
    },
  });

  // 图标按钮 ④：导出正文（演示 editor-export 图标）
  ctx.editor.toolbar({
    id: "plugin-demo.export",
    title: t("toolbar.exportDemo"),
    icon: "editor-export",
    onClick: async (editor, c) => {
      const { chars, words } = countText(editor.content);
      c.ui.toast(c.i18n.t("toolbar.exportToast", { chars, words }), "info");
    },
  });

  // 纯文字按钮 ①：插入 Markdown 引用块
  ctx.editor.toolbar({
    id: "plugin-demo.insert-quote",
    title: t("toolbar.insertQuote"),
    label: t("toolbar.insertQuoteLabel"),
    onClick: async (editor, c) => {
      const tr = c.i18n.t;
      if (!editor.insertText?.(tr("toolbar.quoteText"))) {
        c.ui.toast(tr("toolbar.editorNotReady"), "error");
        return;
      }
      c.ui.toast(tr("toolbar.insertedQuote"), "success");
    },
  });

  // 纯文字按钮 ②：验证中文 label 不竖排、超长时截断
  ctx.editor.toolbar({
    id: "plugin-demo.label-only",
    title: t("toolbar.labelOnly"),
    label: t("toolbar.labelOnlyLabel"),
    onClick: async (_editor, c) => {
      c.ui.toast(c.i18n.t("toolbar.labelOnlyToast"), "info");
    },
  });
};
