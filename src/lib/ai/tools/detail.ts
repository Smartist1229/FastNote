import { t as translate } from "@/i18n";
import type { ToolCall } from "@/interface/ai/aiOutput";
import { TOOL_LABELS } from "./labels";

/**
 * 工具轨迹右侧的目标信息：执行前用入参拼，执行后用结果补得更具体。
 * 只负责展示，不做业务校验；未知工具走 default 分支，保证轨迹永远有内容可显示。
 */
// 原始轨迹/模型上下文保留中文源文；只有界面消费时才传入 t。
export const sourceText: typeof translate = (source, params) => source.replace(/\{(\w+)\}/g, (match, key: string) => String(params?.[key] ?? match));

export const toolDetail = (name: string, args: Record<string, unknown>, result: unknown, t: typeof translate = sourceText): string => {
  const isObj = !!result && typeof result === "object";
  const r = (isObj && !Array.isArray(result) ? result : {}) as Record<string, unknown>;
  const arr = Array.isArray(result) ? (result as Record<string, unknown>[]) : null;
  const rawTitle = (typeof r.title === "string" && r.title) || (args.title !== undefined ? String(args.title) : "");
  const title = rawTitle ? `《${String(rawTitle).slice(0, 18)}》` : "";
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : Number(v));
  const clip = (v: unknown, n = 22) => {
    const s = String(v ?? "").replace(/\s+/g, " ").trim();
    return s.length > n ? `${s.slice(0, n)}…` : s;
  };
  const head = (id: unknown) => (id !== undefined && id !== null && id !== "" && Number.isFinite(Number(id)) ? `#${id}` : "");
  /** 目标笔记的统一写法：#ID · 《标题》（结果里的 id/noteId 都认，标题也可以从入参兜底） */
  const target = [head(r.id ?? r.noteId ?? args.noteId), title].filter(Boolean).join(" · ");
  /** 失败时轨迹上直接显示原因（红色行），不用点开才知道 */
  const failure = typeof r.error === "string" && r.error ? t("失败：{error}", { error: clip(r.error, 40) }) : "";
  switch (name) {
    case "selectNote":
      return target ? t("已打开 {target}", { target }) : failure;
    case "getNoteContent":
    case "getCurrentNote":
    case "readNoteLines": {
      // 读了哪几行、整篇多大：这是"读取笔记"最该让用户看到的信息
      const range = typeof r.lines === "string" ? r.lines : "";
      const total = num(r.totalLines);
      const chars = num(r.totalChars);
      const parts = [target];
      if (range) parts.push(t("第 {range} 行", { range }));
      if (Number.isFinite(total) && total > 0) parts.push(t("共 {count} 行", { count: total }));
      if (Number.isFinite(chars) && chars > 0 && !range) parts.push(t("{count} 字", { count: chars }));
      return parts.filter(Boolean).join(" · ") || failure;
    }
    case "findInNote": {
      const count = num(r.count);
      const lines = Array.isArray(r.matches)
        ? (r.matches as { line?: unknown }[]).map((m) => num(m.line)).filter((n) => Number.isFinite(n)).slice(0, 6)
        : [];
      const parts = [target, args.query ? `「${clip(args.query, 14)}」` : ""];
      if (Number.isFinite(count)) parts.push(t("命中 {count} 处", { count }));
      if (lines.length > 0) parts.push(t("第 {range} 行", { range: `${lines.join("、")}${count > lines.length ? "…" : ""}` }));
      return parts.filter(Boolean).join(" · ");
    }
    case "replaceLines": {
      const total = num(r.totalLines);
      return [target, t("改第 {start}-{end} 行", { start: String(args.startLine), end: String(args.endLine) }), Number.isFinite(total) ? t("现共 {count} 行", { count: total }) : ""].filter(Boolean).join(" · ");
    }
    case "insertLines": {
      const total = num(r.totalLines);
      const text = String(args.text ?? "");
      return [target, t("第 {line} 行后插入 {count} 行", { line: String(args.afterLine), count: text ? text.split("\n").length : 0 }), Number.isFinite(total) ? t("现共 {count} 行", { count: total }) : ""].filter(Boolean).join(" · ");
    }
    case "deleteLines": {
      const total = num(r.totalLines);
      return [target, t("删第 {start}-{end} 行", { start: String(args.startLine), end: String(args.endLine) }), Number.isFinite(total) ? t("现共 {count} 行", { count: total }) : ""].filter(Boolean).join(" · ");
    }
    case "replaceInNote": {
      const replaced = num(r.replaced);
      return [target, t("替换 {count} 处", { count: Number.isFinite(replaced) ? replaced : 1 }), args.oldText ? `「${clip(args.oldText, 12)}」` : ""].filter(Boolean).join(" · ");
    }
    case "appendToNote": {
      const len = num(r.appendedLength);
      return [target, Number.isFinite(len) ? t("追加 {count} 字", { count: len }) : args.text ? t("追加 {count} 字", { count: String(args.text).length }) : ""].filter(Boolean).join(" · ");
    }
    case "createNote":
    case "updateNote":
    case "updateCurrentNote": {
      // 写操作要说清"改了哪些字段"，光一个标题看不出做了什么
      const changed: string[] = [];
      if (name !== "createNote") {
        if (args.title !== undefined) changed.push(t("标题"));
        if (args.content !== undefined) changed.push(t("正文"));
        if (args.categoryName !== undefined) changed.push(t("分组"));
      } else if (args.content) {
        changed.push(t("{count} 字", { count: String(args.content).length }));
      }
      return [target, changed.length > 0 ? changed.join("/") : ""].filter(Boolean).join(" · ");
    }
    case "createNotes": {
      const created = Array.isArray(r.created) ? (r.created as { id?: unknown; title?: unknown }[]) : [];
      if (created.length > 0) {
        const names = created.slice(0, 3).map((c) => `#${c.id}《${clip(c.title, 10)}》`).join("、");
        return t("创建 {count} 篇：{names}", { count: created.length, names: names + (created.length > 3 ? "…" : "") });
      }
      return Array.isArray(args.notes) ? t("{count} 篇", { count: args.notes.length }) : "";
    }
    case "getCategories": {
      const list = Array.isArray(result) ? (result as { name?: unknown }[]) : [];
      const names = list.slice(0, 3).map((c) => clip(c.name, 8)).join("、");
      return list.length > 0 ? t("{count} 个分组", { count: list.length }) + (names ? `：${names}${list.length > 3 ? "…" : ""}` : "") : "";
    }
    case "moveNote": {
      const to = typeof r.category === "string" && r.category ? `→「${clip(r.category, 12)}」` : args.categoryId !== undefined ? t("→分组 #{id}", { id: String(args.categoryId) }) : "";
      return [head(r.id ?? args.noteId), to].filter(Boolean).join(" ");
    }
    case "emptyTrash": {
      const deleted = num(r.deleted);
      return Number.isFinite(deleted) ? t("清空 {count} 篇", { count: deleted }) : "";
    }
    case "searchNotes": {
      const q = args.query ? `「${clip(args.query, 14)}」` : "";
      const total = num(r.total);
      const fuzzy = r.fuzzy === true ? t("（模糊）") : "";
      return [q + fuzzy, Number.isFinite(total) ? t("命中 {count} 篇", { count: total }) : ""].filter(Boolean).join(" · ");
    }
    case "searchNotesSemantic": {
      const q = args.query ? `「${clip(args.query, 14)}」` : "";
      const total = num(r.total);
      return [q, Number.isFinite(total) ? t("命中 {count} 篇", { count: total }) : "", failure].filter(Boolean).join(" · ");
    }
    case "listNotes": {
      const scope = args.categoryName ? `「${clip(args.categoryName)}」` : t("全部");
      const total = num(r.total);
      const shown = Array.isArray(r.notes) ? r.notes.length : NaN;
      return [scope, Number.isFinite(total) ? t("{count} 篇", { count: total }) + (Number.isFinite(shown) ? t("（列出 {count}）", { count: shown }) : "") : ""].filter(Boolean).join(" · ");
    }
    /* ---- 标签：轨迹要能看出"加了哪几个词"，光一个数字看不出做了什么 ---- */
    case "listTags": {
      const total = num(r.total);
      const list = Array.isArray(r.tags) ? (r.tags as { name?: unknown }[]) : [];
      const names = list.slice(0, 3).map((t) => clip(t.name, 8)).join("、");
      return [Number.isFinite(total) ? t("{count} 个标签", { count: total }) : "", names ? `：${names}${list.length > 3 ? "…" : ""}` : ""].filter(Boolean).join("");
    }
    case "getNoteTags": {
      const list = Array.isArray(r.tags) ? (r.tags as { name?: unknown }[]) : [];
      return [target, list.length > 0 ? list.slice(0, 4).map((tag) => clip(tag.name, 8)).join("、") : t("暂无标签")].filter(Boolean).join(" · ");
    }
    case "findNotesByTag": {
      const tag = args.tagName ? `「${clip(args.tagName, 14)}」` : "";
      const total = num(r.total);
      return [tag, Number.isFinite(total) ? t("{count} 篇", { count: total }) : ""].filter(Boolean).join(" · ") || failure;
    }
    case "addNoteTags": {
      const added = Array.isArray(r.added) ? (r.added as unknown[]) : [];
      return [target, added.length > 0 ? t("加「{names}」", { names: added.slice(0, 4).map((tag) => clip(tag, 8)).join("、") }) : t("未新增")].filter(Boolean).join(" · ");
    }
    case "setNoteTags": {
      const tags = Array.isArray(r.aiTags) ? (r.aiTags as unknown[]) : [];
      return [target, tags.length > 0 ? t("标签：{names}", { names: tags.slice(0, 4).map((tag) => clip(tag, 8)).join("、") }) : t("已清空")].filter(Boolean).join(" · ");
    }
    case "removeNoteTags": {
      const removed = Array.isArray(r.removed) ? (r.removed as unknown[]) : [];
      const skipped = Array.isArray(r.skipped) ? (r.skipped as unknown[]) : [];
      const parts = [target, removed.length > 0 ? t("移除「{names}」", { names: removed.slice(0, 4).map((tag) => clip(tag, 8)).join("、") }) : t("没有可移除的")];
      if (skipped.length > 0) parts.push(t("{count} 个跳过（用户标签）", { count: skipped.length }));
      return parts.filter(Boolean).join(" · ");
    }
    case "renameTag":
      return args.tagName ? `「${clip(args.tagName, 10)}」→「${clip(args.newName, 10)}」` : failure;
    case "deleteTag":
      return [args.tagName ? `「${clip(args.tagName, 14)}」` : "", t("已删除（连带所有笔记）")].filter(Boolean).join(" ") || failure;
    case "listTrash": {
      const total = num(r.total);
      return Number.isFinite(total) ? t("{count} 篇", { count: total }) : "";
    }
    case "deleteNote":
      return [target, t("已移入回收站（可还原）")].filter(Boolean).join(" · ") || failure;
    case "restoreNote":
      return [target, t("已还原")].filter(Boolean).join(" · ") || failure;
    case "deleteFromTrash":
      return [target, t("已彻底删除（不可恢复）")].filter(Boolean).join(" · ") || failure;
    case "createCategory":
      return [head(r.id), args.name ? `「${clip(args.name)}」` : ""].filter(Boolean).join(" · ") || failure;
    case "renameCategory":
      return [head(r.id ?? args.categoryId), args.name ? t("改名为「{name}」", { name: clip(args.name) }) : ""].filter(Boolean).join(" · ") || failure;
    case "deleteCategory": {
      const cnt = num(r.noteCount);
      const mode = r.notesMovedToTrash === true ? (Number.isFinite(cnt) && cnt > 0 ? t("组内 {count} 篇已移入回收站", { count: cnt }) : t("组内笔记已移入回收站")) : t("组内笔记已变为未分类");
      return [head(r.id ?? args.categoryId), r.name ? `「${clip(r.name)}」` : "", mode].filter(Boolean).join(" · ") || failure;
    }
    default: {
      // 兜底：任何工具都至少说清"做了什么/多大/几项"，不留空白
      if (failure) return failure;
      if (arr) return t("{count} 项", { count: arr.length });
      if (target) return target;
      const keys = Object.keys(r).filter(k => k !== "success" && k !== "note");
      if (keys.length > 0) return clip(JSON.stringify(r), 40);
      return r.note ? clip(r.note, 40) : t("已完成");
    }
  }
};


/** 确认弹窗里的一句话说明：让用户在点"确认执行"前看懂这批写操作会改什么 */
export const summarizeToolCall = (c: ToolCall, t: typeof translate): string => {
  const id = String(c.args.noteId);
  switch (c.name) {
    case "createNote":
      return t("创建笔记「{title}」并填入内容", { title: String(c.args.title || "").substring(0, 30) });
    case "updateNote": {
      const parts: string[] = [];
      if (c.args.title) parts.push(t("标题：「{title}」", { title: String(c.args.title).substring(0, 30) }));
      if (c.args.content) parts.push(t("内容已更新"));
      if (c.args.categoryName) parts.push(t("移至分组「{name}」", { name: String(c.args.categoryName) }));
      return t("修改笔记 #{id}", { id }) + (parts.length > 0 ? ` (${parts.join(" / ")})` : "");
    }
    case "updateCurrentNote": {
      const parts: string[] = [];
      if (c.args.title) parts.push(t("标题改为「{title}」", { title: String(c.args.title).substring(0, 30) }));
      if (c.args.content) parts.push(t("正文将被覆盖"));
      if (c.args.categoryName) parts.push(t("移至分组「{name}」", { name: String(c.args.categoryName) }));
      return t("修改当前打开的笔记") + (parts.length > 0 ? ` (${parts.join(" / ")})` : "");
    }
    case "deleteNote":
      return t("删除笔记 #{id}", { id });
    case "replaceLines":
      return t("替换笔记 #{id} 的第 {start}-{end} 行（只改这一段，其余保留）", { id, start: String(c.args.startLine), end: String(c.args.endLine) });
    case "insertLines":
      return t("在笔记 #{id} 第 {line} 行后插入内容（约 {count} 字）", { id, line: String(c.args.afterLine), count: String(c.args.text || "").length });
    case "deleteLines":
      return t("删除笔记 #{id} 的第 {start}-{end} 行", { id, start: String(c.args.startLine), end: String(c.args.endLine) });
    case "replaceInNote": {
      const all = c.args.replaceAll === true || c.args.replaceAll === "true";
      return t("在笔记 #{id} 里把「{oldText}」替换为「{newText}」{scope}", { id, oldText: String(c.args.oldText || "").slice(0, 20), newText: String(c.args.newText || "").slice(0, 20), scope: all ? t("（全部匹配）") : t("（仅第一处）") });
    }
    case "restoreNote":
      return t("从回收站还原笔记 #{id}", { id });
    case "deleteFromTrash":
      return t("彻底删除回收站中的笔记 #{id}（不可恢复）", { id });
    case "emptyTrash":
      return t("清空回收站（不可恢复）");
    case "appendToNote": {
      const target = c.args.noteId ? t("笔记 #{id}", { id }) : t("当前打开的笔记");
      return t("在{target}末尾追加内容（约 {count} 字）", { target, count: String(c.args.text || "").length });
    }
    case "createNotes": {
      const count = Array.isArray(c.args.notes) ? c.args.notes.length : 0;
      return t("一次创建 {count} 篇笔记", { count });
    }
    case "createCategory":
      return t("创建分组「{name}」", { name: String(c.args.name || "").substring(0, 20) });
    case "renameCategory":
      return t("重命名分组为「{name}」", { name: String(c.args.name || "").substring(0, 20) });
    case "deleteCategory":
      return c.args.deleteNotes === true || c.args.deleteNotes === "true"
        ? t("删除分组（组内笔记移入回收站，可还原）")
        : t("删除分组（组内笔记变为未分类）");
    case "moveNote":
      return t("移动笔记到其他分组");
    default:
      return TOOL_LABELS[c.name] ? t(TOOL_LABELS[c.name]) : c.name;
  }
};
