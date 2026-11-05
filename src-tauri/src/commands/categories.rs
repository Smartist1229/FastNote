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
pub fn delete_category(id: String, delete_notes: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    // 加密分组删掉后组密钥里的 DEK 就再也对不上了；要求先永久解密（前端也隐藏删除项）
    if encryption::category_is_encrypted(&conn, &id)? {
        return Err(json!({ "code": "category_encrypted" }).to_string());
    }

    if delete_notes {
        let now = Local::now().to_rfc3339();
        // 加密笔记受「必须先永久解密才能删除」约束，连带删除分组也不能绕过：
        // 只把普通笔记移入回收站，单独加密的笔记改为移出分组，保留在原地与密钥。
        conn.execute(
            "UPDATE notes SET is_deleted = 1, deleted_at = ?1, category_id = NULL
             WHERE category_id = ?2 AND COALESCE(enc_mode, 0) = 0",
            params![now, id],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE notes SET category_id = NULL
             WHERE category_id = ?1 AND COALESCE(enc_mode, 0) <> 0",
            params![id],
        ).map_err(|e| e.to_string())?;
    } else {
        conn.execute(
            "UPDATE notes SET category_id = NULL WHERE category_id = ?1",
            params![id],
        )
        .map_err(|e| e.to_string())?;
    }

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
