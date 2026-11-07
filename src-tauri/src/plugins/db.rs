/* ---------------- 插件私有表 ----------------
 * 插件可以自建数据表，但只能碰自己那一份：
 *   - 表名一律强制加前缀 `plugin_<目录名>__`（目录名里的 `-` 换成 `_`），
 *     创建时自动补、读写时自动补，插件侧只写裸名 `records`；
 *   - 宿主自己的表（notes / tags / app_settings…）不带这个前缀，够不到；
 *     别的插件的表前缀不同，也够不到（前提是前端别替它伪造 dirName，
 *     插件与宿主同页面，隔离是契约级的，不是沙箱）。
 *
 * 只暴露结构化操作（建表 / 删表 / 增删改查），不接受任意 SQL 字符串：
 * 标识符按白名单校验后用双引号包起来拼接，值一律走参数绑定。
 */

use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde::Deserialize;
use serde_json::{Map, Value};

/// 标识符长度上限（表名 / 列名）
const IDENT_MAX_LEN: usize = 48;
/// 单次查询返回行数上限
const QUERY_MAX_LIMIT: u32 = 1000;
/// 建表列数上限
const COLUMN_MAX: usize = 24;

/// 表名前缀：`plugin_<目录名>__`，目录名里的连字符换成下划线（SQLite 标识符不欢迎连字符）
pub(super) fn table_prefix(dir_name: &str) -> String {
    format!("plugin_{}__", dir_name.replace('-', "_"))
}

/// 校验标识符：字母/数字/下划线，首字符不能是数字；返回去掉首尾空白后的值
fn ident(raw: &str, what: &str) -> Result<String, String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(format!("{what}不能为空"));
    }
    if name.len() > IDENT_MAX_LEN {
        return Err(format!("{what}过长：{name}（上限 {IDENT_MAX_LEN} 字节）"));
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap_or('_');
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err(format!("{what}必须以字母或下划线开头：{name}"));
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err(format!("{what}只能包含字母、数字与下划线：{name}"));
    }
    Ok(name.to_string())
}

/// 插件侧的裸表名 → 库里真正的表名（带前缀）
pub(super) fn qualified_table(dir_name: &str, table: &str) -> Result<String, String> {
    Ok(format!("{}{}", table_prefix(dir_name), ident(table, "表名")?))
}

/// 建表列定义（前端 `ctx.db.createTable` 的 columns 元素）
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginColumn {
    pub name: String,
    /// text | integer | real
    pub kind: String,
}

fn column_type(kind: &str) -> Result<(&'static str, &'static str), String> {
    match kind.trim().to_ascii_lowercase().as_str() {
        // (SQL 类型, 默认值)：SQLite 的 NOT NULL 列必须有默认值才好在不带值时插入
        "text" => Ok(("TEXT", "''")),
        "integer" | "int" => Ok(("INTEGER", "0")),
        "real" | "number" | "float" => Ok(("REAL", "0")),
        other => Err(format!("不支持的列类型：{other}（可选 text / integer / real）")),
    }
}

/// 建表：固定带 `id INTEGER PRIMARY KEY AUTOINCREMENT` 与 `created_at TEXT`，
/// 业务列按传入顺序追加。已存在时用 IF NOT EXISTS 静默跳过（重复调用安全）。
pub(super) fn create_table(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    columns: &[PluginColumn],
) -> Result<(), String> {
    if columns.len() > COLUMN_MAX {
        return Err(format!("列数过多（上限 {COLUMN_MAX}）"));
    }
    let mut defs: Vec<String> = vec!["id INTEGER PRIMARY KEY AUTOINCREMENT".into()];
    for column in columns {
        let name = ident(&column.name, "列名")?;
        if name == "id" || name == "created_at" {
            return Err(format!("列名「{name}」由宿主保留，换一个"));
        }
        let (sql_type, default) = column_type(&column.kind)?;
        defs.push(format!("\"{name}\" {sql_type} NOT NULL DEFAULT {default}"));
    }
    defs.push("created_at TEXT NOT NULL DEFAULT (datetime('now'))".into());
    let sql = format!(
        "CREATE TABLE IF NOT EXISTS \"{}\" ({})",
        qualified_table(dir_name, table)?,
        defs.join(", ")
    );
    conn.execute(&sql, []).map_err(|e| format!("建表失败：{e}"))?;
    Ok(())
}

/// 删表：只允许删自己的表（前缀由 qualified_table 强制）
pub(super) fn drop_table(conn: &Connection, dir_name: &str, table: &str) -> Result<(), String> {
    let sql = format!("DROP TABLE IF EXISTS \"{}\"", qualified_table(dir_name, table)?);
    conn.execute(&sql, []).map_err(|e| format!("删表失败：{e}"))?;
    Ok(())
}

/// 列出该插件自己的表（去掉前缀后的裸名）
pub(super) fn list_tables(conn: &Connection, dir_name: &str) -> Result<Vec<String>, String> {
    let prefix = table_prefix(dir_name);
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE ?1 ORDER BY name")
        .map_err(|e| format!("读取表清单失败：{e}"))?;
    let rows = stmt
        .query_map([format!("{prefix}%")], |row| row.get::<_, String>(0))
        .map_err(|e| format!("读取表清单失败：{e}"))?;
    let mut out = Vec::new();
    for row in rows {
        let name = row.map_err(|e| format!("读取表清单失败：{e}"))?;
        out.push(name.strip_prefix(&prefix).unwrap_or(&name).to_string());
    }
    Ok(out)
}

/// JSON 值 → SQL 值：只接受 null / bool / number / string（数组与对象直接拒绝并说明）
fn sql_value(value: &Value) -> Result<SqlValue, String> {
    match value {
        Value::Null => Ok(SqlValue::Null),
        Value::Bool(flag) => Ok(SqlValue::Integer(i64::from(*flag))),
        Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                Ok(SqlValue::Integer(int))
            } else if let Some(float) = number.as_f64() {
                Ok(SqlValue::Real(float))
            } else {
                Err("数值超出范围".into())
            }
        }
        Value::String(text) => Ok(SqlValue::Text(text.clone())),
        _ => Err("字段值只支持字符串 / 数字 / 布尔 / null".into()),
    }
}

/// SQL 值 → JSON 值
fn json_value(value: SqlValue) -> Value {
    match value {
        SqlValue::Null => Value::Null,
        SqlValue::Integer(int) => Value::from(int),
        SqlValue::Real(float) => serde_json::Number::from_f64(float)
            .map(Value::Number)
            .unwrap_or(Value::Null),
        SqlValue::Text(text) => Value::String(text),
        SqlValue::Blob(bytes) => Value::String(format!("<{} 字节二进制>", bytes.len())),
    }
}

/// 表是否存在（把 SQLite 的原始错误换成人话）
fn table_exists(conn: &Connection, qualified: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [qualified],
        |_| Ok(()),
    )
    .is_ok()
}

/// 拼 WHERE（等值过滤，全部参数绑定），并把值推进 params
fn where_clause(
    filter: Option<&Map<String, Value>>,
    params: &mut Vec<SqlValue>,
) -> Result<String, String> {
    let Some(filter) = filter else {
        return Ok(String::new());
    };
    if filter.is_empty() {
        return Ok(String::new());
    }
    let mut parts = Vec::new();
    for (key, value) in filter {
        parts.push(format!("\"{}\" = ?", ident(key, "过滤字段名")?));
        params.push(sql_value(value)?);
    }
    Ok(format!(" WHERE {}", parts.join(" AND ")))
}

/// 插入一行，返回新行 id
pub(super) fn insert(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    values: &Map<String, Value>,
) -> Result<i64, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    if values.is_empty() {
        return Err("插入的字段不能为空".into());
    }
    let mut columns = Vec::new();
    let mut params = Vec::new();
    for (key, value) in values {
        columns.push(format!("\"{}\"", ident(key, "字段名")?));
        params.push(sql_value(value)?);
    }
    let placeholders = vec!["?"; columns.len()].join(", ");
    let sql = format!(
        "INSERT INTO \"{qualified}\" ({}) VALUES ({placeholders})",
        columns.join(", ")
    );
    conn.execute(&sql, params_from_iter(params.iter()))
        .map_err(|e| format!("插入失败：{e}"))?;
    Ok(conn.last_insert_rowid())
}

/// 查询：等值过滤 + 排序 + 分页，返回对象数组
pub(super) fn query(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    filter: Option<&Map<String, Value>>,
    order_by: Option<&str>,
    descending: bool,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<Value>, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    let mut params = Vec::new();
    let mut sql = format!("SELECT * FROM \"{qualified}\"");
    sql.push_str(&where_clause(filter, &mut params)?);
    let order = ident(order_by.unwrap_or("id"), "排序字段名")?;
    sql.push_str(&format!(
        " ORDER BY \"{order}\" {}",
        if descending { "DESC" } else { "ASC" }
    ));
    let limit = limit.unwrap_or(200).min(QUERY_MAX_LIMIT);
    sql.push_str(&format!(" LIMIT {limit} OFFSET {}", offset.unwrap_or(0)));

    let mut stmt = conn.prepare(&sql).map_err(|e| format!("查询失败：{e}"))?;
    let columns: Vec<String> = stmt.column_names().into_iter().map(str::to_string).collect();
    let mut rows = stmt
        .query(params_from_iter(params.iter()))
        .map_err(|e| format!("查询失败：{e}"))?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| format!("读取结果失败：{e}"))? {
        let mut object = Map::new();
        for (index, name) in columns.iter().enumerate() {
            let value: SqlValue = row.get(index).map_err(|e| format!("读取字段失败：{e}"))?;
            object.insert(name.clone(), json_value(value));
        }
        out.push(Value::Object(object));
    }
    Ok(out)
}

/// 更新：filter 必须非空（避免插件手滑清空整张表），返回影响行数
pub(super) fn update(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    filter: &Map<String, Value>,
    values: &Map<String, Value>,
) -> Result<usize, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    if filter.is_empty() {
        return Err("更新必须带过滤条件（不支持无条件更新整表）".into());
    }
    if values.is_empty() {
        return Err("要更新的字段不能为空".into());
    }
    // SET 的值在前、WHERE 的值在后，顺序必须与语句里的 ? 一致
    let mut params = Vec::new();
    let mut sets = Vec::new();
    for (key, value) in values {
        sets.push(format!("\"{}\" = ?", ident(key, "字段名")?));
        params.push(sql_value(value)?);
    }
    let where_sql = where_clause(Some(filter), &mut params)?;
    let sql = format!("UPDATE \"{qualified}\" SET {} {where_sql}", sets.join(", "));
    conn.execute(&sql, params_from_iter(params.iter()))
        .map_err(|e| format!("更新失败：{e}"))
}

/// 删除：filter 必须非空（同 update），返回影响行数
pub(super) fn delete(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    filter: &Map<String, Value>,
) -> Result<usize, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    if filter.is_empty() {
        return Err("删除必须带过滤条件（不支持无条件清空整表）".into());
    }
    let mut params = Vec::new();
    let where_sql = where_clause(Some(filter), &mut params)?;
    let sql = format!("DELETE FROM \"{qualified}\"{where_sql}");
    conn.execute(&sql, params_from_iter(params.iter()))
        .map_err(|e| format!("删除失败：{e}"))
}

/// 删除该插件的全部私有表（卸载时用户选择「删除表」）。
/// 返回删掉的表数量；一张都没有时返回 0，不报错。
pub(super) fn drop_all(conn: &Connection, dir_name: &str) -> Result<usize, String> {
    let tables = list_tables(conn, dir_name)?;
    for table in &tables {
        drop_table(conn, dir_name, table)?;
    }
    Ok(tables.len())
}

/// 统计行数（不把行拉回前端）
pub(super) fn count(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    filter: Option<&Map<String, Value>>,
) -> Result<i64, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    let mut params = Vec::new();
    let where_sql = where_clause(filter, &mut params)?;
    let sql = format!("SELECT COUNT(*) FROM \"{qualified}\"{where_sql}");
    conn.query_row(&sql, params_from_iter(params.iter()), |row| row.get(0))
        .map_err(|e| format!("统计失败：{e}"))
}

/// 加一列（迁移用）：已存在同名列时返回 false，不报错——插件可以每次激活都调一次。
/// SQLite 的 ADD COLUMN 要求 NOT NULL 列带默认值，这里统一用列类型的默认值。
pub(super) fn add_column(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    column: &PluginColumn,
) -> Result<bool, String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    let name = ident(&column.name, "列名")?;
    if name == "id" || name == "created_at" {
        return Err(format!("列名「{name}」由宿主保留，换一个"));
    }
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info(\"{qualified}\")"))
        .map_err(|e| format!("读取表结构失败：{e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("读取表结构失败：{e}"))?;
    while let Some(row) = rows.next().map_err(|e| format!("读取表结构失败：{e}"))? {
        let existing: String = row.get(1).map_err(|e| format!("读取表结构失败：{e}"))?;
        if existing == name {
            return Ok(false);
        }
    }
    let (sql_type, default) = column_type(&column.kind)?;
    let sql = format!(
        "ALTER TABLE \"{qualified}\" ADD COLUMN \"{name}\" {sql_type} NOT NULL DEFAULT {default}"
    );
    conn.execute(&sql, []).map_err(|e| format!("加列失败：{e}"))?;
    Ok(true)
}

/// 建索引：索引名同样带插件前缀，避免和其它插件 / 宿主撞名；已存在时静默跳过
pub(super) fn create_index(
    conn: &Connection,
    dir_name: &str,
    table: &str,
    name: &str,
    columns: &[String],
    unique: bool,
) -> Result<(), String> {
    let qualified = qualified_table(dir_name, table)?;
    if !table_exists(conn, &qualified) {
        return Err(format!("表不存在：{table}（先用 ctx.db.createTable 建表）"));
    }
    if columns.is_empty() {
        return Err("建索引至少要指定一列".into());
    }
    let mut cols = Vec::with_capacity(columns.len());
    for column in columns {
        cols.push(format!("\"{}\"", ident(column, "索引列名")?));
    }
    let index_name = format!("{}{}", table_prefix(dir_name), ident(name, "索引名")?);
    let sql = format!(
        "CREATE {}INDEX IF NOT EXISTS \"{index_name}\" ON \"{qualified}\" ({})",
        if unique { "UNIQUE " } else { "" },
        cols.join(", ")
    );
    conn.execute(&sql, []).map_err(|e| format!("建索引失败：{e}"))?;
    Ok(())
}
