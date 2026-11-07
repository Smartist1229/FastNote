/**
 * 插件私有表 · 键值配置（ctx.db）。
 *
 * 演示「插件用数据库存自己的设置」：这里存两样东西——
 *   - `shortcut`：当前生效的快捷键，每次 activate 由配置项同步写一遍，
 *     所以打开表就能看到「这个插件现在占着哪个键」；
 *   - `opens`：窗口被快捷键打开过多少次（每次打开 +1，证明数据能跨会话累积）。
 *
 * 表名来自配置项 `dbPrefsTable`（只写裸名，宿主会加 plugin_plugin_demo__ 前缀）。
 * 做成工厂：配置里改了表名，下一次 activate 自然就是另一张表。
 */

/** 配置没填 / 填了非法表名时的兜底 */
export const DEFAULT_PREFS_TABLE = "prefs";

/** 表名只接受 [a-z0-9_]，其余一律回退默认值（宿主侧也会再校验一次） */
const normalizeTable = (raw, fallback) => {
  const name = typeof raw === "string" ? raw.trim() : "";
  return /^[a-z][a-z0-9_]{0,47}$/.test(name) ? name : fallback;
};

export const createPrefs = (tableName) => {
  const table = normalizeTable(tableName, DEFAULT_PREFS_TABLE);
  let ready = false;

  const ensureTable = async (ctx) => {
    if (ready) return;
    // IF NOT EXISTS，重复调用安全
    await ctx.db.createTable(table, [
      { name: "key", kind: "text" },
      { name: "value", kind: "text" },
    ]);
    ready = true;
  };

  /** 读一个键；没有时返回 null */
  const get = async (ctx, key) => {
    await ensureTable(ctx);
    const rows = await ctx.db.query(table, { filter: { key }, limit: 1 });
    if (rows.length === 0) return null;
    const value = rows[0].value;
    return typeof value === "string" ? value : null;
  };

  /** 写一个键（有则更新、无则插入） */
  const set = async (ctx, key, value) => {
    await ensureTable(ctx);
    const rows = await ctx.db.query(table, { filter: { key }, limit: 1 });
    if (rows.length > 0) {
      await ctx.db.update(table, { id: rows[0].id }, { value });
      return;
    }
    await ctx.db.insert(table, { key, value });
  };

  /**
   * 计数器 +1（没有就从 1 开始），返回值仅供日志 / 调试。
   * 值在表里是 TEXT，所以存字符串、加的时候转数字。
   */
  const bump = async (ctx, key) => {
    const raw = await get(ctx, key);
    const next = String((Number.parseInt(raw ?? "0", 10) || 0) + 1);
    await set(ctx, key, next);
    return Number.parseInt(next, 10);
  };

  return { table, get, set, bump };
};
