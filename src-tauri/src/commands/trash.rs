use crate::models::*;
use chrono::{Duration, Local};
use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, State};
use crate::AppState;
use crate::semantic;
use crate::encryption;
use crate::map_row_to_note;
use super::tags::prune_tag_links;
use super::history::purge_note_history;

#[tauri::command(async)]
pub fn move_to_trash(id: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    /*
     * 加密笔记也能进回收站：删除只需要 id，不需要明文。
     * 密文与它的密钥行（note 级在 encrypted_keys，分组级挂在分组上）都原样留着，
     * 所以从回收站还原后照样能解——「能不能解密」只影响读取，不该拦着删除。
     */
    let now = Local::now().to_rfc3339();

    conn.execute(
        "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command(async)]
pub fn restore_note(id: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let (category_id, enc_mode): (Option<String>, i64) = conn
        .query_row(
            "SELECT category_id, COALESCE(enc_mode, 0) FROM notes WHERE id = ?1",
            params![&id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;
    // 明文笔记（或只有自己密码的笔记）还原进已加密分组会破坏“组内全是密文”，先要求解密分组
    if enc_mode != 2 {
        if let Some(cat_id) = &category_id {
            if encryption::category_is_encrypted(&conn, cat_id)? {
                return Err(json!({ "code": "category_encrypted", "reason": "restore" }).to_string());
            }
        }
    }

    conn.execute(
        "UPDATE notes SET is_deleted = 0, deleted_at = NULL WHERE id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

#[tauri::command]
pub fn get_trash_notes(state: State<AppState>) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn.prepare(
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, 
                is_pinned, ai_access, COALESCE(enc_mode, 0) AS enc_mode
         FROM notes 
         WHERE is_deleted = 1 
         ORDER BY deleted_at DESC"
    ).map_err(|e| e.to_string())?;

    let notes = stmt
        .query_map([], map_row_to_note)
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for note in notes {
        result.push(note.map_err(|e| e.to_string())?);
    }

    encryption::apply_lock_state(&conn, &state.encryption, &mut result);
    Ok(result)
}

/// 永久删除笔记时清掉所有按 note_id 存的旁路行（密钥、语义块、索引状态）。
/// 没有外键，只能逐表删，否则 encrypted_keys 会留孤儿行。
pub(crate) fn drop_note_side_rows(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    encryption::cleanup_note_key(conn, note_id)
}

#[tauri::command(async)]
pub fn delete_note_permanently(
    app: AppHandle,
    id: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    // 正文一删就找不到图片路径了，先把这份笔记（含历史快照）用到的图记下来
    let candidates = crate::attachments::collect_notes_attachment_paths(&conn, std::slice::from_ref(&id));

    conn.execute("DELETE FROM notes WHERE id = ?1", params![&id])
        .map_err(|e| e.to_string())?;
    purge_note_history(&conn, &id)?;
    drop_note_side_rows(&conn, &id)?;
    state.encryption.lock(encryption::NOTE_SCOPE, &id, true);

    // 图片也一起回收：没人再引用的删文件 + 删 attachments 行，空分桶目录顺手删掉
    crate::attachments::purge_unreferenced_attachments(&app, &conn, &candidates)?;

    // 没开级联外键，笔记没了标签关联会留成孤儿（list_tags 的计数会飘）
    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}

/// 批量永久删除；返回因加密而跳过的条数（调用方据此提示用户先解密）
#[tauri::command(async)]
pub fn delete_multiple_notes_permanently(
    app: AppHandle,
    ids: Vec<String>,
    state: State<AppState>,
) -> Result<usize, String> {
    let conn = state.conn.lock().unwrap();

    // 删除前先收齐这批笔记用到的图片；删完后再统一判断还有没有人引用
    let mut candidates: Vec<String> = Vec::new();
    for id in ids {
        /*
         * 加密笔记同样删除：`drop_note_side_rows` 里的 cleanup_note_key 会
         * 一并清掉它的 note 级密钥。分组加密（enc_mode=2）的密钥挂在分组上，
         * 删单篇不碰分组密钥，同组其他笔记不受影响。
         */
        candidates.extend(crate::attachments::collect_notes_attachment_paths(
            &conn,
            std::slice::from_ref(&id),
        ));
        conn.execute("DELETE FROM notes WHERE id = ?1", params![&id])
            .map_err(|e| e.to_string())?;
        purge_note_history(&conn, &id)?;
        drop_note_side_rows(&conn, &id)?;
        state.encryption.lock(encryption::NOTE_SCOPE, &id, true);
    }

    crate::attachments::purge_unreferenced_attachments(&app, &conn, &candidates)?;

    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    // 加密笔记不再跳过，返回 0 表示「一条都没漏」
    Ok(0)
}

#[tauri::command(async)]
pub fn cleanup_old_trash(app: AppHandle, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let thirty_days_ago = Local::now() - Duration::days(30);
    let threshold = thirty_days_ago.to_rfc3339();

    // 先挑出过期笔记：图片路径要在这批数据被删掉之前收集（历史快照也算引用）
    let expired: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT id FROM notes
                 WHERE is_deleted = 1 AND deleted_at < ?1 AND COALESCE(enc_mode, 0) = 0",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![threshold], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    let candidates = crate::attachments::collect_notes_attachment_paths(&conn, &expired);

    // 加密笔记不参与自动清理：它们的密文和密钥只能由用户先永久解密再删除
    conn.execute(
        "DELETE FROM notes_history WHERE note_id IN (
            SELECT id FROM notes WHERE is_deleted = 1 AND deleted_at < ?1 AND COALESCE(enc_mode, 0) = 0
         )",
        params![threshold],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM notes WHERE is_deleted = 1 AND deleted_at < ?1 AND COALESCE(enc_mode, 0) = 0",
        params![threshold],
    )
    .map_err(|e| e.to_string())?;
    for id in expired {
        drop_note_side_rows(&conn, &id)?;
        state.encryption.lock(encryption::NOTE_SCOPE, &id, true);
    }

    crate::attachments::purge_unreferenced_attachments(&app, &conn, &candidates)?;

    prune_tag_links(&conn)?;
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(())
}
