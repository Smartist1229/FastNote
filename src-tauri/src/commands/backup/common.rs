use super::*;

/// 按行查询并映射成 JSON 数组
pub(crate) fn query_rows<F>(conn: &Connection, sql: &str, mut map: F) -> Result<Vec<Value>, String>
where
    F: FnMut(&rusqlite::Row) -> rusqlite::Result<Value>,
{
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| map(row))
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

pub(crate) fn json_str(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string()
}

/// 取字符串字段，缺失或空串时用默认值（旧备份缺新字段）
pub(crate) fn json_str_or(v: &Value, key: &str, fallback: &str) -> String {
    v.get(key)
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(crate) fn json_opt_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(|s| s.to_string())
}

pub(crate) fn json_i64(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

/// 笔记 id：新备份是 UUID 字符串，旧备份是数字，统一读成字符串。
/// （数字 id 写进 TEXT 主键时 SQLite 会自动转成文本，引用表也是同样规则，仍能对上）
pub(crate) fn json_id(v: &Value, key: &str) -> String {
    match v.get(key) {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 分组 id / 分组引用：新备份是字符串，旧备份是数字，统一读成 Option<String>
pub(crate) fn json_opt_id(v: &Value, key: &str) -> Option<String> {
    match v.get(key) {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    }
}

/// 备份文件里的 id 列可能是旧版本的 INTEGER，也可能是新版本的 TEXT
pub(crate) fn row_text(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<String> {
    Ok(match row.get_ref(idx)? {
        rusqlite::types::ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned(),
        rusqlite::types::ValueRef::Integer(i) => i.to_string(),
        rusqlite::types::ValueRef::Real(f) => f.to_string(),
        _ => String::new(),
    })
}

/// row_text 的可空版本：NULL 保持 None，数字/文本统一转字符串
pub(crate) fn row_text_opt(row: &rusqlite::Row, idx: usize) -> rusqlite::Result<Option<String>> {
    Ok(match row.get_ref(idx)? {
        rusqlite::types::ValueRef::Null => None,
        rusqlite::types::ValueRef::Text(t) => Some(String::from_utf8_lossy(t).into_owned()),
        rusqlite::types::ValueRef::Integer(i) => Some(i.to_string()),
        rusqlite::types::ValueRef::Real(f) => Some(f.to_string()),
        _ => None,
    })
}

pub(crate) fn json_bool(v: &Value, key: &str) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(false)
}

/// 取布尔字段，缺失时用指定默认值（旧备份缺新字段时保持升级前的行为）
pub(crate) fn json_bool_or(v: &Value, key: &str, fallback: bool) -> bool {
    v.get(key).and_then(|x| x.as_bool()).unwrap_or(fallback)
}

/// 取 AI 访问档位（0/1/2）。
/// 兼容三种历史写法：数字档位、旧的布尔（true=完全 / false=禁止）、字段缺失（用默认值）。
pub(crate) fn json_level(v: &Value, key: &str, fallback: i64) -> i64 {
    match v.get(key) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(fallback).clamp(0, 2),
        Some(Value::Bool(b)) => {
            if *b {
                2
            } else {
                0
            }
        }
        _ => fallback,
    }
}

/// 取数组字段：缺失或类型不对都当空数组，避免一个坏字段让整次恢复失败
pub(crate) fn json_arr<'a>(data: &'a Value, key: &str) -> &'a [Value] {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.as_slice())
        .unwrap_or(&[])
}

/// 时间字段缺失时补当前时间（列上有 NOT NULL 约束）
pub(crate) fn non_empty_or_now(text: String) -> String {
    if text.trim().is_empty() {
        Local::now().to_rfc3339()
    } else {
        text
    }
}

/// 自动备份运行状态：写的是「最近一次成功/尝试」这类只对本机有意义的信息，
/// 无论如何都不进备份；恢复时按本机原值接回，避免恢复完就断掉自动备份。
pub(crate) const WEBDAV_AUTO_STATE_KEYS: [&str; 4] = [
    "webdav.lastAutoBackupAt",
    "webdav.lastAutoAttemptAt",
    "webdav.lastAutoError",
    "webdav.lastAutoFile",
];

/* ---------------- 恢复前快照：保住「本地独有」的内容 ---------------- */

/// 某张表在指定 schema 里的列名（用于按列名对齐地搬数据，兼容旧快照缺列）
pub(crate) fn table_columns(conn: &Connection, schema: &str, table: &str) -> Vec<String> {
    let sql = format!("PRAGMA {schema}.table_info({table})");
    let Ok(mut stmt) = conn.prepare(&sql) else {
        return Vec::new();
    };
    let cols = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows.flatten().collect(),
        Err(_) => Vec::new(),
    };
    cols
}

/// 把 `prev` 库里、`main` 里没有的行原样补回来；同主键的以 `main`（备份）为准。
///
/// 列名取两边交集：备份是旧版本快照时 `main` 可能少几列，直接 `SELECT *` 会对不上。
/// `skip` 排除自增主键（`notes_history.id`、`encrypted_keys.id`）：换库后序号没有意义，重新生成。
pub(crate) fn copy_missing_rows(conn: &Connection, table: &str, skip: &[&str]) -> usize {
    let main_cols = table_columns(conn, "main", table);
    let prev_cols = table_columns(conn, "prev", table);
    let cols: Vec<String> = main_cols
        .into_iter()
        .filter(|c| prev_cols.contains(c) && !skip.contains(&c.as_str()))
        .collect();
    if cols.is_empty() {
        return 0;
    }
    let list = cols
        .iter()
        .map(|c| format!("\"{c}\""))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "INSERT OR IGNORE INTO main.\"{table}\" ({list}) SELECT {list} FROM prev.\"{table}\""
    );
    conn.execute(&sql, []).unwrap_or(0)
}

/// 覆盖式恢复会清库，而**本地独有的内容**（尤其是加密笔记及其密钥）通常不在备份里，
/// 会被一起删掉——这正是过去「有加密内容就不让恢复」的根因。
///
/// 做法：恢复前用 `VACUUM INTO` 给本地库拍一张快照，恢复完把备份里没有的行补回来。
/// 顺序先父表后子表（分类 → 笔记 → 历史），不留悬空引用。
pub(crate) struct LocalPreserve {
    path: std::path::PathBuf,
}

impl LocalPreserve {
    pub(crate) fn capture(conn: &Connection, tag: &str) -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!(
            "fastnote-preserve-{}-{tag}.db",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        conn.execute(
            "VACUUM INTO ?1",
            params![path.to_string_lossy().to_string()],
        )
        .map_err(|e| format!("生成恢复前快照失败：{e}"))?;
        Ok(Self { path })
    }

    /// 把本地独有行补回当前库，返回补回的条数
    pub(crate) fn restore(self, conn: &Connection) -> Result<usize, String> {
        conn.execute(
            "ATTACH DATABASE ?1 AS prev",
            params![self.path.to_string_lossy().to_string()],
        )
        .map_err(|e| format!("挂载恢复前快照失败：{e}"))?;
        let mut preserved = 0usize;
        for (table, skip) in [
            ("categories", &[][..]),
            ("notes", &[][..]),
            ("notes_history", &["id"][..]),
            ("tags", &[][..]),
            ("note_tags", &[][..]),
            // 加密笔记的密钥：丢了就永久解不开，必须补回
            ("encrypted_keys", &["id"][..]),
            // 图片元数据：字节在磁盘上，行丢了会变孤儿
            ("attachments", &[][..]),
            // 本机设置（含 app.security.root.* 根密码材料）：备份通常不带，补回来根密码才不会「消失」
            ("app_settings", &[][..]),
        ] {
            preserved += copy_missing_rows(conn, table, skip);
        }
        let _ = conn.execute("DETACH DATABASE prev", []);
        let _ = std::fs::remove_file(&self.path);
        Ok(preserved)
    }
}

/// 读出本机全部 webdav.* 设置（服务器、账号、密码、自动备份配置与运行状态）。
/// 备份默认不带 WebDAV；恢复时这些键按「备份里有就用备份、没有就保留本机」合并，
/// 避免一次恢复把本机正在用的云端配置抹成默认值。
pub(crate) fn read_local_only_settings(conn: &Connection) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    let Ok(mut stmt) =
        conn.prepare("SELECT key, value, updated_at FROM app_settings WHERE key LIKE 'webdav.%' ORDER BY key")
    else {
        return out;
    };
    let Ok(rows) = stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    }) else {
        return out;
    };
    out.extend(rows.flatten());
    out
}

pub(crate) fn restore_local_only_settings(
    conn: &Connection,
    rows: &[(String, String, String)],
) -> Result<(), String> {
    for (key, value, updated_at) in rows {
        // 备份勾选了 WebDAV 时可能自带密码：以备份为准，本机原值只在该键缺失时补上
        conn.execute(
            "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, updated_at],
        )
        .map_err(|e| format!("恢复本机 WebDAV 设置失败：{e}"))?;
    }
    Ok(())
}

