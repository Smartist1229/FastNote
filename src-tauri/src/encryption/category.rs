use super::*;

pub(crate) fn category_note_rows(conn: &Connection, category_id: &str) -> Result<Vec<NoteRow>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                    is_pinned, ai_access, COALESCE(enc_mode, 0), enc_tags
             FROM notes WHERE category_id = ?1 ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![category_id], |row| {
            Ok(NoteRow {
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
                enc_mode: row.get(10)?,
                enc_tags: row.get(11)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn encrypt_category(
    category_id: String,
    password: String,
    root_password: Option<String>,
    hint: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    validate_password(&password)?;
    let mut conn = state.conn.lock().unwrap();
    if category_is_encrypted(&conn, &category_id)? {
        return Err(err_code("already_encrypted"));
    }
    // 只处理组内未删除的笔记：回收站里的笔记可能本来就带自己的密码，
    // 既不能算作「组内有单独加密的笔记」，也不该被组密钥重新封一遍。
    let rows: Vec<NoteRow> = category_note_rows(&conn, &category_id)?
        .into_iter()
        .filter(|row| !row.is_deleted)
        .collect();
    let individually: Vec<String> = rows
        .iter()
        .filter(|row| row.enc_mode == 1)
        .map(|row| row.id.clone())
        .collect();
    if !individually.is_empty() {
        return Err(json!({
            "code": "has_individual_encrypted_notes",
            "note_ids": individually,
        })
        .to_string());
    }
    // 同上：正文已经是密文却标着未加密，说明状态不一致，先修复再整体加密
    let sealed: Vec<String> = rows
        .iter()
        .filter(|row| row.enc_mode == 0 && crypto::is_encrypted(&row.content))
        .map(|row| row.id.clone())
        .collect();
    if !sealed.is_empty() {
        return Err(json!({ "code": "already_sealed", "note_ids": sealed }).to_string());
    }
    let root_kek = root_kek_for_encrypt(&conn, &state.encryption, root_password.as_deref())?;

    let dek = Zeroizing::new(crypto::random_dek());
    let meta = new_meta(&password, &dek, &root_kek, CAT_SCOPE, &category_id, hint)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in &rows {
        let content = crypto::seal(&dek, &note_aad(&row.id, "content"), row.content.as_bytes())?;
        let tags = seal_tags(&tx, &row.id, &dek)?;
        seal_history(&tx, &row.id, &dek)?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![&row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE notes SET content = ?1, enc_mode = 2, enc_tags = ?2 WHERE id = ?3",
            params![content, tags, &row.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![&row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![&row.id],
        )
        .map_err(|e| e.to_string())?;
    }
    // 组内笔记的明文标签关联都删完之后，把没人用的标签行一起收掉
    crate::prune_tag_links(&tx)?;
    tx.execute(
        "UPDATE categories SET is_encrypted = 1 WHERE id = ?1",
        params![category_id],
    )
    .map_err(|e| e.to_string())?;
    save_meta(&tx, CAT_SCOPE, &category_id, &meta)?;
    tx.commit().map_err(|e| e.to_string())?;

    // 加密后分组立即锁定：展开分组或打开组内笔记都要重新输密码
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);
    Ok(())
}

#[tauri::command(async)]
pub fn unlock_category(
    category_id: String,
    password: String,
    use_root: bool,
    scope: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    if !category_is_encrypted(&conn, &category_id)? {
        return Err(err_code("not_encrypted"));
    }
    let meta = load_meta(&conn, CAT_SCOPE, &category_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(
        &conn,
        &state.encryption,
        CAT_SCOPE,
        &category_id,
        &meta,
        &password,
        use_root,
    )?;
    state.encryption.put_key(
        CAT_SCOPE,
        &category_id,
        *dek,
        parse_unlock_scope(&scope)?,
    );
    Ok(())
}

#[tauri::command(async)]
pub fn lock_category(category_id: String, force: bool, state: State<AppState>) -> Result<(), String> {
    state.encryption.lock(CAT_SCOPE, &category_id, force);
    Ok(())
}

#[tauri::command(async)]
pub fn decrypt_category(
    category_id: String,
    password: String,
    use_root: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    if !category_is_encrypted(&conn, &category_id)? {
        return Err(err_code("not_encrypted"));
    }
    let meta = load_meta(&conn, CAT_SCOPE, &category_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(
        &conn,
        &state.encryption,
        CAT_SCOPE,
        &category_id,
        &meta,
        &password,
        use_root,
    )?;
    // 这里必须包含回收站里的笔记：组密钥一删，留在回收站的组密文就再也解不开了
    let rows = category_note_rows(&conn, &category_id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in &rows {
        if row.enc_mode != 2 {
            continue;
        }
        let title = open_title_legacy(&dek, &row.id, &row.title)?;
        let content = crypto::open_text(&dek, &note_aad(&row.id, "content"), &row.content)?;
        let snaps = match &row.enc_tags {
            Some(blob) => open_tags(&row.id, &dek, blob)?,
            None => Vec::new(),
        };
        open_history(&tx, &row.id, &dek)?;
        restore_tags(&tx, &row.id, &snaps)?;
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2, enc_mode = 0, enc_tags = NULL WHERE id = ?3",
            params![title, content, &row.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![&row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![&row.id],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "UPDATE categories SET is_encrypted = 0 WHERE id = ?1",
        params![category_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM encrypted_keys WHERE scope = 'category' AND ref_id = ?1",
        params![&category_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    state.encryption.lock(CAT_SCOPE, &category_id, true);
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);
    Ok(())
}

/* ---------------- 信息查询 ---------------- */

#[tauri::command(async)]
pub fn encryption_info(scope: String, id: String, state: State<AppState>) -> Result<Value, String> {
    let conn = state.conn.lock().unwrap();
    let (scope_key, meta_scope, meta_id, encrypted, is_locked) = match scope.as_str() {
        CAT_SCOPE => {
            let encrypted = category_is_encrypted(&conn, &id)?;
            (
                CAT_SCOPE,
                CAT_SCOPE,
                id.clone(),
                encrypted,
                state.encryption.get_key(CAT_SCOPE, &id).is_none(),
            )
        }
        NOTE_SCOPE => {
            let row = load_note_row(&conn, &id)?;
            let encrypted = row.enc_mode != 0;
            let (meta_scope, meta_id) = if row.enc_mode == 2 {
                match &row.category_id {
                    Some(category) => (CAT_SCOPE, category.clone()),
                    None => (NOTE_SCOPE, id.clone()),
                }
            } else {
                (NOTE_SCOPE, id.clone())
            };
            let locked = note_dek(&state.encryption, &id, row.enc_mode, row.category_id.as_deref()).is_err();
            (NOTE_SCOPE, meta_scope, meta_id, encrypted, locked)
        }
        _ => return Err(err_code("invalid_scope")),
    };
    let meta = if encrypted {
        load_meta(&conn, meta_scope, &meta_id)?
    } else {
        None
    };
    let root = read_root_meta(&conn)?;
    let attempt_id = id.clone();
    Ok(json!({
        "scope": scope_key,
        "encrypted": encrypted,
        "is_locked": is_locked,
        "hint": meta.as_ref().and_then(|m| m.hint.clone()),
        "root_wrapped": meta.as_ref().map(|m| m.wrap_root.is_some()).unwrap_or(false),
        "attempts": state.encryption.attempts(scope_key, &attempt_id),
        "root_allowed": state.encryption.attempts(scope_key, &attempt_id) >= ROOT_FALLBACK_AFTER,
        "root_set": root.is_some(),
        "root_cached": state.encryption.root_cached(),
        "kdf": root.map(|m| m.kdf).unwrap_or_default(),
    }))
}

