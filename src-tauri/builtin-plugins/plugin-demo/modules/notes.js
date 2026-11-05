/**
 * 笔记 API 演示模块：
 * - 创建 / 更新 / 删除最近创建的插件笔记（source_plugin 沙箱，需 notes.write 权限）
 * - 完整生命周期命令（创建 → 读 → 更新 → 删除），每步 toast
 * AI tool「plugin-demo.count-chars」在 modules/ai.js。
 * 所有用户可见文案都通过 ctx.i18n 取值。
 */
import { sleep } from "./utils.js";

/** 写笔记 API 演示命令 */
export const registerNotes = (ctx, config) => {
  if (config.notesEnabled === false) return;
  if (config.commandEnabled === false) return;
  if (!ctx.notes || typeof ctx.notes.create !== "function") return;
  const t = (key, vars) => ctx.i18n.t(key, vars);

  /** 最近一次由本插件创建的笔记 id，供更新 / 删除命令复用 */
  let lastNoteId = null;

  // ① 创建
  ctx.command({
    id: "plugin-demo.create-note",
    label: t("notes.createCommand"),
    icon: "ai-plus",
    run: async (c) => {
      const tr = c.i18n.t;
      try {
        const now = new Date().toLocaleString();
        lastNoteId = await c.notes.create(
          tr("notes.createdTitle", { time: now }),
          tr("notes.createdContent", { time: now }),
          null,
        );
        c.ui.toast(tr("notes.created", { id: lastNoteId }), "success");
      } catch (e) {
        c.ui.toast(tr("notes.createFailed", { error: e }), "error");
      }
    },
  });

  // ② 更新最近创建的笔记
  ctx.command({
    id: "plugin-demo.update-note",
    label: t("notes.updateCommand"),
    icon: "ai-edit",
    run: async (c) => {
      const tr = c.i18n.t;
      if (lastNoteId === null) {
        c.ui.toast(tr("notes.updateNoNote"), "info");
        return;
      }
      try {
        await c.notes.update(
          lastNoteId,
          undefined,
          tr("notes.updatedContent", { time: new Date().toLocaleString() }),
        );
        c.ui.toast(tr("notes.updated", { id: lastNoteId }), "success");
      } catch (e) {
        c.ui.toast(tr("notes.updateFailed", { error: e }), "error");
      }
    },
  });

  // ③ 删除最近创建的笔记
  ctx.command({
    id: "plugin-demo.delete-note",
    label: t("notes.deleteCommand"),
    icon: "ai-trash",
    run: async (c) => {
      const tr = c.i18n.t;
      if (lastNoteId === null) {
        c.ui.toast(tr("notes.deleteNoNote"), "info");
        return;
      }
      try {
        await c.notes.remove(lastNoteId);
        c.ui.toast(tr("notes.deleted", { id: lastNoteId }), "success");
        lastNoteId = null;
      } catch (e) {
        c.ui.toast(tr("notes.deleteFailed", { error: e }), "error");
      }
    },
  });

  // ④ 完整生命周期演示（创建 → 读 → 更新 → 删）
  ctx.command({
    id: "plugin-demo.note-lifecycle",
    label: t("notes.lifecycleCommand"),
    icon: "ai-file-text",
    run: async (c) => {
      const tr = c.i18n.t;
      try {
        c.ui.toast(tr("notes.lifecycleStart"), "info");
        const now = new Date().toLocaleString();
        const noteId = await c.notes.create(
          tr("notes.createdTitle", { time: now }),
          tr("notes.createdContent", { time: now }),
          null,
        );
        lastNoteId = noteId;
        c.ui.toast(tr("notes.lifecycleCreate", { id: noteId }), "success");
        await sleep(300);
        const content = await c.notes.getContent(noteId);
        c.ui.toast(tr("notes.lifecycleRead", { len: content.length }), "info");
        await sleep(300);
        await c.notes.update(
          noteId,
          undefined,
          `${content}${tr("notes.updatedContent", { time: new Date().toLocaleString() })}`,
        );
        c.ui.toast(tr("notes.lifecycleUpdate"), "success");
        await sleep(300);
        await c.notes.remove(noteId);
        c.ui.toast(tr("notes.lifecycleDelete", { id: noteId }), "success");
        lastNoteId = null;
      } catch (e) {
        c.ui.toast(tr("notes.lifecycleFailed", { error: e }), "error");
      }
    },
  });
};
