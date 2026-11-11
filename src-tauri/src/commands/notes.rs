use crate::models::*;
use chrono::Local;
use rusqlite::params;
use serde_json::json;
use tauri::{AppHandle, State};
use crate::AppState;
use crate::semantic;
use crate::encryption;
use crate::crypto;
use crate::map_row_to_note;
use super::history::note_history_limit;
use super::history::note_history_interval_secs;
use super::history::snapshot_note;
use super::history::should_snapshot_history;
use super::history::prune_note_history;
use super::history::HISTORY_KIND_AUTO;

#[tauri::command]
pub fn create_note(
    title: String,
    content: String,
    category_id: Option<String>,
    ai_access: Option<i64>,
    state: State<AppState>,
) -> Result<Note, String> {
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    // 新笔记的 AI 档位由调用方给（设置里的「新建笔记默认权限」），缺省按"完全"，
    // 与老版本行为一致；写库时显式带上，返回值也用同一个值，避免库里是 A 返回是 B
    let ai_access = ai_access.unwrap_or(2).clamp(0, 2);
    let group_encrypted = match &category_id {
        Some(category) => encryption::category_is_encrypted(&conn, category)?,
        None => false,
    };
    let enc_mode = if group_encrypted { 2 } else { 0 };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 短随机 id 撞车主键时重新生成重试（最多 3 次）
    let mut id = crate::db::new_note_id();
    let mut retries = 0;
    loop {
        match tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_pinned, ai_access, enc_mode)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8)",
            params![id, title, content, category_id, now, now, ai_access, enc_mode],
        ) {
            Ok(_) => break,
            Err(e) if crate::is_primary_key_conflict(&e) && retries < 2 => {
                retries += 1;
                id = crate::db::new_note_id();
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    if group_encrypted {
        // 新笔记正文可能是空的，但仍要立刻加密；密钥不在内存时整条插入回滚。
        let (stored_title, cipher_content) = encryption::seal_note_fields(
            &tx,
            &state.encryption,
            &id,
            enc_mode,
            category_id.as_deref(),
            &title,
            &content,
        )?;
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2 WHERE id = ?3",
            params![stored_title, cipher_content, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Note {
        id,
        title,
        content,
        category_id,
        created_at: now.clone(),
        updated_at: now,
        is_deleted: false,
        deleted_at: None,
        is_pinned: false,
        ai_access,
        enc_mode,
        is_locked: false,
        enc_hint: None,
    })
}

/// 查询笔记列表（含正文）。正文随列表一起返回，AI 读未打开的笔记也无需额外请求。
#[tauri::command]
pub fn get_notes(
    category_id: Option<String>,
    sort_by: String,
    sort_order: String,
    state: State<AppState>,
) -> Result<Vec<Note>, String> {
    let conn = state.conn.lock().unwrap();

    let order_direction = if sort_order == "asc" { "ASC" } else { "DESC" };

    // 优先排序：置顶笔记在前，然后按用户选择的排序方式
    let order_clause = match sort_by.as_str() {
        "created_at" => format!("ORDER BY is_pinned DESC, created_at {}", order_direction),
        "updated_at" => format!("ORDER BY is_pinned DESC, updated_at {}", order_direction),
        "title" => format!(
            "ORDER BY is_pinned DESC, title {}",
            if sort_order == "asc" { "ASC" } else { "DESC" }
        ),
        _ => format!("ORDER BY is_pinned DESC, updated_at {}", order_direction),
    };

    let sql = if category_id.is_some() {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access, COALESCE(enc_mode, 0) AS enc_mode
             FROM notes
             WHERE is_deleted = 0 AND category_id = ?1
             {}",
            order_clause
        )
    } else {
        format!(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access, COALESCE(enc_mode, 0) AS enc_mode
             FROM notes
             WHERE is_deleted = 0
             {}",
            order_clause
        )
    };

    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;

    let notes_iter = if let Some(cat_id) = &category_id {
        stmt.query_map(params![cat_id], map_row_to_note)
            .map_err(|e| e.to_string())?
    } else {
        stmt.query_map([], map_row_to_note)
            .map_err(|e| e.to_string())?
    };

    let mut result = Vec::new();
    for note in notes_iter {
        result.push(note.map_err(|e| e.to_string())?);
    }
    encryption::apply_lock_state(&conn, &state.encryption, &mut result);

    Ok(result)
}

/// 读取单条笔记（含正文），供编辑器保存前的兜底校验/按 id 取用。
#[tauri::command]
pub fn get_note(id: String, state: State<AppState>) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();

    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access, COALESCE(enc_mode, 0) AS enc_mode
             FROM notes WHERE id = ?1",
        )
        .map_err(|e| e.to_string())?;

    let mut note = stmt
        .query_row(params![id], map_row_to_note)
        .map_err(|e| e.to_string())?;
    encryption::apply_lock_state(
        &conn,
        &state.encryption,
        std::slice::from_mut(&mut note),
    );
    Ok(note)
}

#[tauri::command]
pub fn update_note(
    id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    is_pinned: Option<i64>,
    app: AppHandle,
    state: State<AppState>,
) -> Result<(), String> {
    // 读设置要在锁住 conn 之前：read_setting_* 内部也会拿同一把锁
    let limit = note_history_limit(&app);
    let interval_secs = note_history_interval_secs(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (old_title, old_content, old_category, old_enc_mode): (
        String,
        String,
        Option<String>,
        i64,
    ) = tx
        .query_row(
            "SELECT title, content, category_id, COALESCE(enc_mode, 0) FROM notes WHERE id = ?1",
            params![id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .map_err(|e| e.to_string())?;

    // 加密笔记：不允许借保存顺手换分组（密文是用原分组密钥加密的，换组会变孤儿）。
    if old_enc_mode != 0 && old_category != category_id {
        return Err(json!({ "code": "note_encrypted", "reason": "move" }).to_string());
    }
    if old_enc_mode == 0 {
        if let Some(target) = &category_id {
            if old_category != category_id && encryption::category_is_encrypted(&tx, target)? {
                return Err(json!({ "code": "category_encrypted" }).to_string());
            }
        }
    } else if crypto::is_encrypted(&content) {
        // 加密笔记保存的应当是明文；拿到密文说明状态错乱，再封一层就永远解不开了
        return Err(json!({ "code": "already_sealed" }).to_string());
    }

    // 比较"内容是否变化"必须用明文：加密笔记库里存的是密文。
    let (plain_old_title, plain_old_content) = encryption::open_note_fields(
        &tx,
        &state.encryption,
        &id,
        old_enc_mode,
        old_category.as_deref(),
        &old_title,
        &old_content,
    )?;

    // 只改了置顶不算内容变化，不必占一条历史
    let changed =
        plain_old_title != title || plain_old_content != content || old_category != category_id;
    // 加密笔记的历史行是「整行复制密文」，用密文比较才和它一致：
    // 明文相同但 nonce 不同，拿明文比会每次保存都判定为「不一样」。
    let (snap_title, snap_content) = if old_enc_mode == 0 {
        (&plain_old_title, &plain_old_content)
    } else {
        (&old_title, &old_content)
    };
    if changed
        && should_snapshot_history(
            &tx,
            &id,
            snap_title,
            snap_content,
            old_category.as_deref(),
            &now,
            interval_secs,
        )?
    {
        snapshot_note(&tx, &id, &now, HISTORY_KIND_AUTO)?;
    }

    let (stored_title, stored_content) = encryption::seal_note_fields(
        &tx,
        &state.encryption,
        &id,
        old_enc_mode,
        old_category.as_deref(),
        &title,
        &content,
    )?;

    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, is_pinned = COALESCE(?4, is_pinned), updated_at = ?5 WHERE id = ?6",
        params![stored_title, stored_content, category_id, is_pinned, now, id],
    ).map_err(|e| e.to_string())?;

    // 旧块立刻作废：否则 worker 重建前的这几秒里，语义搜索会拿旧正文当片段返回。
    // note_index_state 一并删掉，worker 下一轮凭「state 缺失」判定为脏。
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    if changed {
        prune_note_history(&tx, &id, limit, &now)?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    semantic::invalidate(&state.semantic);
    Ok(())
}

/// 设置单篇笔记的 AI 访问档位（0=禁止 / 1=只读 / 2=完全）。
/// 只写标志位：真正的拦截在前端工具链（读、写、检索、选择都会先过这一关），
/// 所以这里不做级联，也不改动 content。
#[tauri::command]
pub fn set_note_ai_access(id: String, level: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE notes SET ai_access = ?1 WHERE id = ?2",
            params![level.clamp(0, 2), id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err(format!("未找到 ID 为 {} 的笔记", id));
    }
    Ok(())
}

#[tauri::command]
pub fn pin_note(id: String, pinned: bool, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();

    conn.execute(
        "UPDATE notes SET is_pinned = ?1 WHERE id = ?2",
        params![if pinned { 1 } else { 0 }, id],
    )
    .map_err(|e| e.to_string())?;

    Ok(())
}

/* ---------------- 插件写笔记 API（source_plugin 沙箱） ----------------
 * 插件必须声明 permissions: ["notes.write"] 才能调用这些命令；
 * 插件创建的笔记会在 source_plugin 字段留下自己的 dirName，后续只有
 * 同一插件能 update/delete 自己创建的笔记——宿主笔记与其他插件的笔记一律拒之门外。
 *
 * 隐藏参数 plugin_id 由宿主前端 host.ts 自动塞入，插件 JS 侧感知不到。
 * 后端会去 plugin/<plugin_id>/plugin.json 做二次权限校验，防止绕过前端。
 */

use crate::plugins::{load_installed_manifest, plugins_root};

/// 从插件清单里检查是否声明了指定权限；清单解析失败或缺权限时返回 Err。
fn require_plugin_permission(plugin_id: &str, need: &str) -> Result<(), String> {
    let root = plugins_root().map_err(|e| format!("{e}"))?;
    let plugin_dir = root.join(plugin_id);
    let manifest = load_installed_manifest(&plugin_dir)
        .map_err(|e| format!("插件权限校验失败（{plugin_id}）：{e}"))?;
    if manifest.permissions.iter().any(|p| p == need) {
        Ok(())
    } else {
        Err(format!("插件未声明 {need} 权限"))
    }
}

#[tauri::command]
pub fn plugin_create_note(
    title: String,
    content: Option<String>,
    category_id: Option<String>,
    plugin_id: String,
    state: State<AppState>,
) -> Result<Note, String> {
    require_plugin_permission(&plugin_id, "notes.write")?;

    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let content = content.unwrap_or_default();
    let category = category_id;

    let group_encrypted = match &category {
        Some(cat) => crate::encryption::category_is_encrypted(&conn, cat)?,
        None => false,
    };
    let enc_mode = if group_encrypted { 2 } else { 0 };

    // 插件不参与 AI 访问档位选择：默认与宿主新建一致（完全）。
    let ai_access: i64 = 2;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    // 短随机 id 撞车主键时重新生成重试（最多 3 次）
    let mut id = crate::db::new_note_id();
    let mut retries = 0;
    loop {
        match tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_pinned, ai_access, enc_mode, source_plugin)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, ?8, ?9)",
            params![id, title, content, category, now, now, ai_access, enc_mode, plugin_id],
        ) {
            Ok(_) => break,
            Err(e) if crate::is_primary_key_conflict(&e) && retries < 2 => {
                retries += 1;
                id = crate::db::new_note_id();
            }
            Err(e) => return Err(e.to_string()),
        }
    }

    if group_encrypted {
        let (stored_title, cipher_content) = crate::encryption::seal_note_fields(
            &tx,
            &state.encryption,
            &id,
            enc_mode,
            category.as_deref(),
            &title,
            &content,
        )?;
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2 WHERE id = ?3",
            params![stored_title, cipher_content, id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;

    Ok(Note {
        id,
        title,
        content,
        category_id: category,
        created_at: now.clone(),
        updated_at: now,
        is_deleted: false,
        deleted_at: None,
        is_pinned: false,
        ai_access,
        enc_mode,
        is_locked: false,
        enc_hint: None,
    })
}

#[tauri::command]
pub fn plugin_update_note(
    note_id: String,
    title: Option<String>,
    content: Option<String>,
    plugin_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    require_plugin_permission(&plugin_id, "notes.write")?;

    let conn = state.conn.lock().unwrap();

    // 沙箱校验：source_plugin 必须等于 plugin_id，且笔记未被删除
    let owner: Option<String> = conn
        .query_row(
            "SELECT source_plugin FROM notes WHERE id = ?1 AND COALESCE(is_deleted, 0) = 0",
            params![note_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| format!("笔记不存在或不可访问：{e}"))?;
    if owner.as_deref() != Some(plugin_id.as_str()) {
        return Err("无权修改此笔记：source_plugin 不匹配".into());
    }

    let now = Local::now().to_rfc3339();

    // 读取当前字段作为默认值，支持 title / content 单独更新
    let (cur_title, cur_content): (String, String) = conn
        .query_row(
            "SELECT title, content FROM notes WHERE id = ?1",
            params![note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;

    let new_title = title.unwrap_or(cur_title);
    let new_content = content.unwrap_or(cur_content);

    conn.execute(
        "UPDATE notes SET title = ?1, content = ?2, updated_at = ?3 WHERE id = ?4",
        params![new_title, new_content, now, note_id],
    )
    .map_err(|e| e.to_string())?;

    // 让语义索引 worker 知道这条笔记脏了
    drop(conn);
    crate::semantic::invalidate(&state.semantic);
    Ok(())
}

#[tauri::command]
pub fn plugin_delete_note(
    note_id: String,
    plugin_id: String,
    state: State<AppState>,
) -> Result<(), String> {
    require_plugin_permission(&plugin_id, "notes.write")?;

    let conn = state.conn.lock().unwrap();

    // 沙箱校验：source_plugin 必须等于 plugin_id
    let owner: Option<String> = conn
        .query_row(
            "SELECT source_plugin FROM notes WHERE id = ?1",
            params![note_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| format!("笔记不存在：{e}"))?;
    if owner.as_deref() != Some(plugin_id.as_str()) {
        return Err("无权删除此笔记：source_plugin 不匹配".into());
    }

    // 插件删除 = 软删除进回收站（跟宿主 move_to_trash 行为一致，允许恢复）
    let now = Local::now().to_rfc3339();
    conn.execute(
        "UPDATE notes SET is_deleted = 1, deleted_at = ?1 WHERE id = ?2",
        params![now, note_id],
    )
    .map_err(|e| e.to_string())?;

    drop(conn);
    crate::semantic::invalidate(&state.semantic);
    Ok(())
}
