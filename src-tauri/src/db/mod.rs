//! 数据库层：建表、迁移、启动自愈。
//!
//! - `schema`：建表与增量列（新库从 0 到最新）
//! - `migrate`：历史数据迁移（笔记 / 分组 id 改 UUID）
//! - `open`：打开库时的自检、升级前备份、损坏隔离重建
//! - `mod`：id 生成与表 / 列的探测工具

use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashMap;

/// 短随机 ID：base62（0-9A-Za-z）× 12 位 ≈ 71.5 bit 熵。
/// 生日界约 8e10 条记录才有 50% 碰撞概率，本地笔记库绰绰有余，主键约束兜底。
const BASE62: &[u8; 62] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SHORT_ID_LEN: usize = 12;

/// 生成 12 位 base62 短随机 ID（如 `3xK9fQ2mA7bR`）。
/// 不用「截断 UUID」：截断 hex 12 位只剩 48 bit 熵，碰撞概率高几个数量级；
/// 这里让 UUID v4 的整个 128 bit 随机源逐字节参与编码。
fn new_short_id() -> String {
    let bytes = *uuid::Uuid::new_v4().as_bytes();
    let mut id = String::with_capacity(SHORT_ID_LEN);
    for b in bytes.iter().take(SHORT_ID_LEN) {
        id.push(BASE62[(b % 62) as usize] as char);
    }
    id
}

/// 生成新的笔记主键（短随机 ID，TEXT）
pub(crate) fn new_note_id() -> String {
    new_short_id()
}

/// 生成新的分组主键（与笔记同一生成器）
pub(crate) fn new_category_id() -> String {
    new_short_id()
}

/// 判断某张表是否存在（用于读取可选的数据表）
pub(crate) fn has_table(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = ?1",
        params![table],
        |row| row.get::<_, i64>(0),
    )
    .unwrap_or(0)
        > 0
}

/// 判断某张表是否已有指定列（用于幂等迁移）
pub(crate) fn has_column(conn: &Connection, table: &str, column: &str) -> bool {
    let sql = format!("PRAGMA table_info({})", table);
    let mut stmt = match conn.prepare(&sql) {
        Ok(stmt) => stmt,
        Err(_) => return false,
    };
    let rows = match stmt.query_map([], |row| row.get::<_, String>(1)) {
        Ok(rows) => rows,
        Err(_) => return false,
    };
    for name in rows.flatten() {
        if name == column {
            return true;
        }
    }
    false
}


mod schema;
mod migrate;
mod open;
#[cfg(test)]
mod tests;

pub(crate) use schema::*;
pub(crate) use migrate::*;
pub(crate) use open::*;
