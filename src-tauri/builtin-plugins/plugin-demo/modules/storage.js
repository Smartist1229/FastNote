/**
 * 插件私有表演示（ctx.db）：插件可以建自己的表、随便增删改查，
 * 但表名由宿主强制加 `plugin_<目录名>__` 前缀，所以：
 *   - 碰不到宿主的 notes / tags / app_settings；
 *   - 碰不到别的插件的表；
 *   - 插件卸载后表还在（数据属于插件），要清理由插件自己调用 drop。
 *
 * 这张 visits 表记录「这篇笔记被插件打开过几次」，演示
 * createTable / query / insert / update 四个动作。
 * 表名来自配置项 `dbVisitsTable`，所以这里也做成工厂。
 */

/** 配置没填 / 填了非法表名时的兜底 */
export const DEFAULT_VISITS_TABLE = "visits";

const normalizeTable = (raw, fallback) => {
  const name = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z][a-z0-9_]{0,47}$/.test(name) ? name : fallback;
};

export const createVisitStore = (tableName) => {
  const table = normalizeTable(tableName, DEFAULT_VISITS_TABLE);
  let ready = false;

  const ensureTable = async (ctx) => {
    if (ready) return;
    await ctx.db.createTable(table, [
      { name: "note_id", kind: "text" },
      { name: "note_title", kind: "text" },
      { name: "visits", kind: "integer" },
    ]);
    ready = true;
  };

  /** 记一次访问：有这行就 +1，没有就插一行；返回最近的记录（新的在前） */
  const record = async (ctx, note) => {
    await ensureTable(ctx);
    const existing = await ctx.db.query(table, { filter: { note_id: note.id }, limit: 1 });
    if (existing.length > 0) {
      const row = existing[0];
      await ctx.db.update(table, { id: row.id }, { visits: Number(row.visits || 0) + 1 });
    } else {
      await ctx.db.insert(table, {
        note_id: note.id,
        note_title: note.title || "",
        visits: 1,
      });
    }
    return await ctx.db.query(table, { limit: 5 });
  };

  return {
    table,
    record,
    /** 本插件的全部表（宿主会把前缀去掉） */
    tables: (ctx) => ctx.db.tables(),
    /** 删表：演示「插件可以自己清理自己的数据」 */
    drop: async (ctx) => {
      await ctx.db.dropTable(table);
      ready = false;
    },
  };
};
