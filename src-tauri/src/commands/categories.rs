use crate::models::*;
use chrono::Local;
use rusqlite::params;
use serde_json::json;
use tauri::State;
use crate::AppState;
use crate::semantic;
use crate::encryption;

#[tauri::command]
pub fn create_category(
    name: String,
    ai_access: Option<i64>,
    state: State<AppState>,
) -> Result<Category, String> {
    let conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    // 同 create_note：默认档位由前端按设置传入，缺省"完全"
    let ai_access = ai_access.unwrap_or(2).clamp(0, 2);

    // 短随机 id 撞车主键时重新生成重试（最多 3 次）；名称 UNIQUE 冲突不属此类，直接报错
    let mut id = crate::db::new_category_id();
    let mut retries = 0;
    loop {
        match conn.execute(
            "INSERT INTO categories (id, name, created_at, ai_access) VALUES (?1, ?2, ?3, ?4)",
            params![id, name, now, ai_access],
        ) {
            Ok(_) => break,
            Err(e) if crate::is_primary_key_conflict(&e) && retries < 2 => {
                retries += 1;
                id = crate::db::new_category_id();
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    Ok(Category {
        id,
        name,
        created_at: now,
        note_count: 0,
        ai_access,
        is_encrypted: false,
        is_locked: false,
        enc_hint: None,
    })
}

#[tauri::command]
pub fn get_categories(state: State<AppState>) -> Result<Vec<Category>, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT c.id, c.name, c.created_at, COUNT(n.id) as note_count, c.ai_access,
                    COALESCE(c.is_encrypted, 0)
         FROM categories c
         LEFT JOIN notes n ON c.id = n.category_id AND n.is_deleted = 0
         GROUP BY c.id, c.name, c.created_at, c.ai_access, c.is_encrypted
         ORDER BY c.created_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let categories = stmt
        .query_map([], |row| {
            Ok(Category {
                id: row.get(0)?,
                name: row.get(1)?,
                created_at: row.get(2)?,
                note_count: row.get(3)?,
                ai_access: row.get::<_, i64>(4)?.clamp(0, 2),
                is_encrypted: row.get::<_, i64>(5)? != 0,
                is_locked: false,
                enc_hint: None,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for category in categories {
        result.push(category.map_err(|e| e.to_string())?);
    }
    encryption::apply_category_lock_state(&conn, &state.encryption, &mut result);

    Ok(result)
}

#[tauri::command]
pub fn update_category(id: String, name: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute(
        "UPDATE categories SET name = ?1 WHERE id = ?2",
        params![name, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn delete_category(
    app: tauri::AppHandle,
    id: String,
    delete_notes: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    let encrypted = encryption::category_is_encrypted(&conn, &id)?;
    /*
     * 删除不需要明文，但加密分组有个绕不开的物理约束：
     * 组内笔记的 DEK 是被**分组密钥**包裹的，分组一删这份密钥就没人能解开。
     * 所以「只删分组、留下笔记」对加密分组是假操作——留下的只是一堆打不开的密文。
     * 想保留笔记，请先「解密分组」。
     */
    if encrypted && !delete_notes {
        return Err(json!({ "code": "category_encrypted_keep" }).to_string());
    }

    if delete_notes {
        let now = Local::now().to_rfc3339();
        if encrypted {
            /*
             * 加密分组：组内笔记直接彻底删除，不进回收站。
             * 理由同上——分组密钥随分组一起消失后，回收站里那几条只是占地方打不开。
             * 删除过程完全不碰明文：密文行照删即可。
             */
            let ids: Vec<String> = {
                let mut stmt = conn
                    .prepare("SELECT id FROM notes WHERE category_id = ?1")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![&id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?
            };
            if !ids.is_empty() {
                let candidates =
                    crate::attachments::collect_notes_attachment_paths(&conn, &ids);
                for note_id in &ids {
                    conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id])
                        .map_err(|e| e.to_string())?;
                    super::history::purge_note_history(&conn, note_id)?;
                    super::trash::drop_note_side_rows(&conn, note_id)?;
                    state.encryption.lock(encryption::NOTE_SCOPE, note_id, true);
                }
                crate::attachments::purge_unreferenced_attachments(&app, &conn, &candidates)?;
                super::tags::prune_tag_links(&conn)?;
            }
        } else {
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1, category_id = NULL
                 WHERE category_id = ?2 AND COALESCE(enc_mode, 0) = 0",
                params![now, id],
            ).map_err(|e| e.to_string())?;
            // 普通分组里若混着加密笔记（历史遗留），它们随分组进来时也一并处理掉
            conn.execute(
                "UPDATE notes SET is_deleted = 1, deleted_at = ?1, category_id = NULL
                 WHERE category_id = ?2 AND COALESCE(enc_mode, 0) <> 0",
                params![now, id],
            ).map_err(|e| e.to_string())?;
        }
    } else {
        conn.execute(
            "UPDATE notes SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }

    // 分组密钥与内存里的解锁态一起清掉（组没了，密钥留着就是孤儿）
    conn.execute(
        "DELETE FROM encrypted_keys WHERE scope = 'category' AND ref_id = ?1",
        params![&id],
    )
    .map_err(|e| e.to_string())?;
    state.encryption.lock("category", &id, true);

    conn.execute("DELETE FROM categories WHERE id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    drop(conn);
    // 进回收站的笔记不再参与语义检索；向量缓存按库快照建，必须整表失效
    semantic::invalidate(&state.semantic);

    Ok(())
}

/// 设置分组的 AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
/// 分组的档位是组内笔记的上限，但不改写笔记自身字段——
/// 重新放开分组后，之前单独收紧过的笔记仍然保持自己的档位。
#[tauri::command]
pub fn set_category_ai_access(id: String, level: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE categories SET ai_access = ?1 WHERE id = ?2",
            params![level.clamp(0, 2), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("未找到 ID 为 {} 的分组", id));
    }
    Ok(())
}
