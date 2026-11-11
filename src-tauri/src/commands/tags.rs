use crate::models::*;
use chrono::Local;
use rusqlite::{params, Connection};
use serde_json::json;
use tauri::State;
use crate::AppState;
use crate::encryption;

/* ---------------- 标签 ---------------- */

/// 取某个标签 id（没有就按 source 建一条），失败时返回 Err。
/// 名称统一 trim：`" 待办 "` 和 `"待办"` 是同一个标签。
pub(crate) fn ensure_tag(conn: &Connection, name: &str, source: &str) -> Result<i64, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    if let Ok(id) = conn.query_row(
        "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE",
        params![name],
        |row| row.get::<_, i64>(0),
    ) {
        return Ok(id);
    }
    conn.execute(
        "INSERT INTO tags (name, source, created_at) VALUES (?1, ?2, ?3)",
        params![name, source, Local::now().to_rfc3339()],
    )
    .map_err(|e| e.to_string())?;
    Ok(conn.last_insert_rowid())
}

/// 清掉已失效的关联与空标签。
///
/// 没有开 `PRAGMA foreign_keys`（开了会影响既有删除逻辑的执行计划），
/// 级联删除不会自动发生 —— 彻底删除笔记、恢复备份之后都靠这一步收尾，
/// 否则 tags 里会留下永远数不到笔记的孤儿行。
pub(crate) fn prune_tag_links(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_tags WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM tags WHERE id NOT IN (SELECT tag_id FROM note_tags)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/** 某篇笔记的标签（含计数），按名称排序 */
pub(crate) fn tags_of_note(conn: &Connection, note_id: &str) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, nt.source, t.created_at
             FROM note_tags nt JOIN tags t ON t.id = nt.tag_id
             WHERE nt.note_id = ?1
             ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            let id = row.get::<_, i64>(0)?;
            let used: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                     WHERE nt.tag_id = ?1 AND n.is_deleted = 0",
                    params![id],
                    |r| r.get(0),
                )
                .unwrap_or(0);
            Ok(Tag {
                id,
                name: row.get::<_, String>(1)?,
                source: row.get::<_, String>(2)?,
                created_at: row.get::<_, String>(3)?,
                note_count: used,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/// 参数里的 source 归一化：只允许 "user" / "ai"，别的写法（含空串）一律当 user。
pub(crate) fn normalize_source(source: Option<String>) -> String {
    match source.as_deref().map(|s| s.trim().to_lowercase()) {
        Some(s) if s == "ai" => "ai".to_string(),
        _ => "user".to_string(),
    }
}

/** 全部标签 + 每篇用了多少：给属性窗的候选、AI 查标签用 */
#[tauri::command]
pub fn list_tags(state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.source, t.created_at,
                    (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                      WHERE nt.tag_id = t.id AND n.is_deleted = 0) AS note_count
             FROM tags t
             ORDER BY note_count DESC, t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
                note_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

/** 某篇笔记的标签列表 */
#[tauri::command]
pub fn list_note_tags(note_id: String, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    if encryption::note_enc_mode(&conn, &note_id)? != 0 {
        // 锁定态返回空（快照本身也是密文）；解锁后是只读的虚拟标签
        return encryption::encrypted_note_tags(&conn, &state.encryption, &note_id);
    }
    tags_of_note(&conn, &note_id)
}

/// 加密笔记的标签是随正文一起封存的快照，不能单独增删。
pub(crate) fn reject_encrypted_tags(conn: &Connection, note_id: &str) -> Result<(), String> {
    if encryption::note_enc_mode(conn, note_id)? != 0 {
        return Err(json!({ "code": "tags_encrypted" }).to_string());
    }
    Ok(())
}

/**
 * 给笔记加标签（词不存在会自动创建），返回加完之后这篇笔记的完整标签列表。
 *
 * 一律返回完整列表是有意的：UI 与 AI 都不用再发一次 GET，
 * 也就不会出现"加成功了但列表没刷新"这种假失败。
 */
#[tauri::command]
pub fn add_note_tags(
    note_id: String,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let src = normalize_source(source);
    let conn = state.conn.lock().unwrap();
    reject_encrypted_tags(&conn, &note_id)?;
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let tag_id = ensure_tag(&conn, &name, &src)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![&note_id, tag_id, src, Local::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
        // 已存在但来源是另一方的（用户先打了、AI 又打一遍）：保留先来的一方，
        // 因为删除权限按 source 判定，贸然改写会把别人的标签变成自己的。
    }
    tags_of_note(&conn, &note_id)
}

/**
 * 摘掉笔记上的标签。
 *
 * `source` 传了就只摘那一种来源 —— AI 工具固定传 "ai"，于是 AI 删不到用户手打的标签；
 * 不传则不限来源（属性窗侧的兜底由 UI 负责：按钮本来就只出现在用户标签上）。
 */
#[tauri::command]
pub fn remove_note_tags(
    note_id: String,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let conn = state.conn.lock().unwrap();
    reject_encrypted_tags(&conn, &note_id)?;
    let filter_src = source.clone().map(|s| normalize_source(Some(s)));
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let sql = match filter_src {
            Some(_) => {
                "DELETE FROM note_tags
                  WHERE note_id = ?1 AND source = ?2
                    AND tag_id IN (SELECT id FROM tags WHERE name = ?3 COLLATE NOCASE)"
            }
            None => {
                "DELETE FROM note_tags
                  WHERE note_id = ?1
                    AND tag_id IN (SELECT id FROM tags WHERE name = ?3 COLLATE NOCASE)"
            }
        };
        if let Some(src) = &filter_src {
            conn.execute(sql, params![&note_id, src, name])
                .map_err(|e| e.to_string())?;
        } else {
            conn.execute(sql, params![&note_id, name])
                .map_err(|e| e.to_string())?;
        }
    }
    prune_tag_links(&conn)?;
    tags_of_note(&conn, &note_id)
}

/**
 * 整体替换笔记在某个来源下的标签：`source="ai"` 时只改 AI 那一批，用户手打的不受影响。
 * AI 打标签是"重新看一遍这篇笔记"的结果，用整体替换而不是逐条增删，避免出现重复思考两轮的残留。
 */
#[tauri::command]
pub fn set_note_tags(
    note_id: String,
    names: Vec<String>,
    source: Option<String>,
    state: State<AppState>,
) -> Result<Vec<Tag>, String> {
    let src = normalize_source(source);
    let conn = state.conn.lock().unwrap();
    reject_encrypted_tags(&conn, &note_id)?;
    // 先清掉这个来源在这篇笔记上的旧关联
    conn.execute(
        "DELETE FROM note_tags WHERE note_id = ?1 AND source = ?2",
        params![&note_id, src],
    )
    .map_err(|e| e.to_string())?;
    for raw in names {
        let name = raw.trim().to_string();
        if name.is_empty() {
            continue;
        }
        let tag_id = ensure_tag(&conn, &name, &src)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![&note_id, tag_id, src, Local::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
    }
    prune_tag_links(&conn)?;
    tags_of_note(&conn, &note_id)
}

/// 全局改名：标签在所有笔记上的关联一并跟着走（改的是"这个词"，不是某篇的关联）。
#[tauri::command]
pub fn rename_tag(id: i64, name: String, state: State<AppState>) -> Result<Vec<Tag>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let conn = state.conn.lock().unwrap();
    // 目标名已被别的标签占用：直接合并到它下面，避免改名把一条关系弄丢
    let clash: Option<i64> = conn
        .query_row(
            "SELECT id FROM tags WHERE name = ?1 COLLATE NOCASE AND id <> ?2",
            params![name, id],
            |row| row.get(0),
        )
        .ok();
    let surviving = match clash {
        // 目标名已被别的标签占用：把关联并入它，返回它作为"改名后的那个词"
        Some(target) => {
            conn.execute(
                "UPDATE OR IGNORE note_tags SET tag_id = ?1 WHERE tag_id = ?2",
                params![target, id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            target
        }
        None => {
            conn.execute("UPDATE tags SET name = ?1 WHERE id = ?2", params![name, id])
                .map_err(|e| e.to_string())?;
            id
        }
    };
    list_tags_by_ids(&conn, vec![surviving])
}

/// 删标签（连带它在所有笔记上的关联）。`source` 传了就只删那一种来源 additions 的标签，
/// 用来保证 AI 删不到用户自己打的标签。
#[tauri::command]
pub fn delete_tag(id: i64, source: Option<String>, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let owned: bool = match source.clone() {
        Some(s) => {
            let want = normalize_source(Some(s));
            conn.query_row(
                "SELECT COUNT(*) FROM tags WHERE id = ?1 AND source = ?2",
                params![id, want],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
                > 0
        }
        None => true,
    };
    if !owned {
        return Err("只能删除自己添加的标签".to_string());
    }
    conn.execute("DELETE FROM note_tags WHERE tag_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM tags WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 内部：`list_tags` 的过滤版（改名后只回访受影响的行，减少无谓序列化）
pub(crate) fn list_tags_by_ids(conn: &Connection, ids: Vec<i64>) -> Result<Vec<Tag>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT t.id, t.name, t.source, t.created_at,
                    (SELECT COUNT(*) FROM note_tags nt JOIN notes n ON n.id = nt.note_id
                      WHERE nt.tag_id = t.id AND n.is_deleted = 0) AS note_count
             FROM tags t ORDER BY t.name COLLATE NOCASE",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Tag {
                id: row.get(0)?,
                name: row.get(1)?,
                source: row.get(2)?,
                created_at: row.get(3)?,
                note_count: row.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let tag = row.map_err(|e| e.to_string())?;
        if ids.contains(&tag.id) {
            out.push(tag);
        }
    }
    Ok(out)
}

/** 按标签找笔记（多对多的反面：给这个词，捞所有带它的笔记） */
#[tauri::command]
pub fn list_notes_by_tag(name: String, state: State<AppState>) -> Result<Vec<Note>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("标签名不能为空".to_string());
    }
    let conn = state.conn.lock().unwrap();
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.content, n.category_id, n.created_at, n.updated_at,
                    n.is_deleted, n.deleted_at, n.is_pinned, n.ai_access
             FROM notes n
               JOIN note_tags nt ON nt.note_id = n.id
               JOIN tags t ON t.id = nt.tag_id
             WHERE t.name = ?1 COLLATE NOCASE AND n.is_deleted = 0
               AND COALESCE(n.enc_mode, 0) = 0
             ORDER BY n.updated_at DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![name], |row| {
            Ok(Note {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                category_id: row.get(3)?,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
                is_deleted: row.get::<_, i64>(6)? != 0,
                deleted_at: row.get(7)?,
                is_pinned: row.get::<_, i64>(8)? != 0,
                ai_access: row.get::<_, i64>(9)?.clamp(0, 2),
                enc_mode: 0,
                is_locked: false,
                enc_hint: None,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}
