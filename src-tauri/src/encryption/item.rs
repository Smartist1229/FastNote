use super::*;

pub(crate) struct NoteRow {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) content: String,
    pub(crate) category_id: Option<String>,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
    pub(crate) is_deleted: bool,
    pub(crate) deleted_at: Option<String>,
    pub(crate) is_pinned: bool,
    pub(crate) ai_access: i64,
    pub(crate) enc_mode: i64,
    pub(crate) enc_tags: Option<String>,
}

pub(crate) fn load_note_row(conn: &Connection, id: &str) -> Result<NoteRow, String> {
    conn.query_row(
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                is_pinned, ai_access, COALESCE(enc_mode, 0), enc_tags
         FROM notes WHERE id = ?1",
        params![id],
        |row| {
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
        },
    )
    .map_err(|_| "笔记不存在，可能已被删除".to_string())
}

impl NoteRow {
    pub(crate) fn into_note(self, title: String, content: String, is_locked: bool, hint: Option<String>) -> Note {
        Note {
            id: self.id,
            title,
            content,
            category_id: self.category_id,
            created_at: self.created_at,
            updated_at: self.updated_at,
            is_deleted: self.is_deleted,
            deleted_at: self.deleted_at,
            is_pinned: self.is_pinned,
            ai_access: self.ai_access,
            enc_mode: self.enc_mode,
            is_locked,
            enc_hint: hint,
        }
    }
}

pub(crate) fn note_dek(
    state: &EncryptionState,
    note_id: &str,
    enc_mode: i64,
    category_id: Option<&str>,
) -> Result<Zeroizing<[u8; 32]>, String> {
    if enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    let key = if enc_mode == 2 {
        let category = category_id.ok_or_else(|| err_code("locked"))?;
        state.get_key(CAT_SCOPE, category)
    } else {
        state.get_key(NOTE_SCOPE, note_id)
    };
    key.ok_or_else(|| err_code("locked"))
}

/// 标题始终明文存储（方便列表与搜索）；早期版本加密过的标题按密文识别并解回明文。
/// 解不开时按普通标题处理，避免用户恰好把 "encn:v1:" 写进标题就再也读不出来。
pub(crate) fn open_title_legacy(dek: &[u8; 32], note_id: &str, title: &str) -> Result<String, String> {
    if crypto::is_encrypted(title) {
        if let Ok(plain) = crypto::open_text(dek, &note_aad(note_id, "title"), title) {
            return Ok(plain);
        }
    }
    Ok(title.to_string())
}

/// 读取并解密一篇笔记的标题/正文。锁定或非加密时按情况返回。
pub(crate) fn open_note_fields(
    _conn: &Connection,
    state: &EncryptionState,
    note_id: &str,
    enc_mode: i64,
    category_id: Option<&str>,
    title: &str,
    content: &str,
) -> Result<(String, String), String> {
    if enc_mode == 0 {
        return Ok((title.to_string(), content.to_string()));
    }
    let dek = note_dek(state, note_id, enc_mode, category_id)?;
    let title = open_title_legacy(&dek, note_id, title)?;
    let content = crypto::open_text(&dek, &note_aad(note_id, "content"), content)?;
    Ok((title, content))
}

/// 把正文加密成入库值；标题保持明文。密钥不在内存时返回 locked。
pub(crate) fn seal_note_fields(
    _conn: &Connection,
    state: &EncryptionState,
    note_id: &str,
    enc_mode: i64,
    category_id: Option<&str>,
    title: &str,
    content: &str,
) -> Result<(String, String), String> {
    if enc_mode == 0 {
        return Ok((title.to_string(), content.to_string()));
    }
    let dek = note_dek(state, note_id, enc_mode, category_id)?;
    Ok((
        title.to_string(),
        crypto::seal(&dek, &note_aad(note_id, "content"), content.as_bytes())?,
    ))
}

/// 锁定态统一返回空内容，绝不把密文发给前端。
pub(crate) fn apply_lock_state(
    conn: &Connection,
    state: &EncryptionState,
    notes: &mut [Note],
) {
    for note in notes.iter_mut() {
        if note.enc_mode == 0 {
            note.is_locked = false;
            note.enc_hint = None;
            continue;
        }
        let (meta_scope, meta_id) = if note.enc_mode == 2 {
            match &note.category_id {
                Some(category) => (CAT_SCOPE, category.clone()),
                None => (NOTE_SCOPE, note.id.clone()),
            }
        } else {
            (NOTE_SCOPE, note.id.clone())
        };
        note.enc_hint = load_meta(conn, meta_scope, &meta_id)
            .ok()
            .flatten()
            .and_then(|m| m.hint);
        match open_note_fields(
            conn,
            state,
            &note.id,
            note.enc_mode,
            note.category_id.as_deref(),
            &note.title,
            &note.content,
        ) {
            Ok((title, content)) => {
                note.title = title;
                note.content = content;
                note.is_locked = false;
            }
            Err(_) => {
                // 标题是明文，锁定后照常展示；旧数据里的标题密文绝不下发
                if crypto::is_encrypted(&note.title) {
                    note.title.clear();
                }
                note.content.clear();
                note.is_locked = true;
            }
        }
    }
}

pub(crate) fn apply_category_lock_state(
    conn: &Connection,
    state: &EncryptionState,
    categories: &mut [crate::Category],
) {
    for category in categories.iter_mut() {
        if !category.is_encrypted {
            category.is_locked = false;
            category.enc_hint = None;
            continue;
        }
        category.enc_hint = load_meta(conn, CAT_SCOPE, &category.id)
            .ok()
            .flatten()
            .and_then(|m| m.hint);
        category.is_locked = state.get_key(CAT_SCOPE, &category.id).is_none();
    }
}

pub(crate) fn note_enc_mode(conn: &Connection, id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(enc_mode, 0) FROM notes WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|_| "笔记不存在，可能已被删除".to_string())
}

pub(crate) fn category_is_encrypted(conn: &Connection, id: &str) -> Result<bool, String> {
    conn.query_row(
        "SELECT COALESCE(is_encrypted, 0) FROM categories WHERE id = ?1",
        params![id],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .map_err(|_| "分组不存在".to_string())
}

pub(crate) fn cleanup_note_key(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM encrypted_keys WHERE scope = 'note' AND ref_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 加密笔记的标签快照（只读虚拟标签）；锁定时返回空。
pub(crate) fn encrypted_note_tags(
    conn: &Connection,
    state: &EncryptionState,
    note_id: &str,
) -> Result<Vec<Tag>, String> {
    let row = load_note_row(conn, note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    let dek = match note_dek(state, note_id, row.enc_mode, row.category_id.as_deref()) {
        Ok(key) => key,
        Err(_) => return Ok(Vec::new()),
    };
    let Some(blob) = row.enc_tags else {
        return Ok(Vec::new());
    };
    let plain = crypto::open_text(&dek, &note_aad(note_id, "tags"), &blob)?;
    let snaps: Vec<TagSnap> = serde_json::from_str(&plain).map_err(|e| e.to_string())?;
    Ok(snaps
        .into_iter()
        .enumerate()
        .map(|(index, snap)| Tag {
            id: -((index as i64) + 1),
            name: snap.name,
            source: snap.source,
            created_at: snap.created_at,
            note_count: 1,
        })
        .collect())
}

/* ---------------- 标签与历史 ---------------- */

pub(crate) fn snapshot_tags(conn: &Connection, note_id: &str) -> Result<Vec<TagSnap>, String> {
    let tags = crate::tags_of_note(conn, note_id)?;
    Ok(tags
        .into_iter()
        .map(|tag| TagSnap {
            name: tag.name,
            source: crate::normalize_source(Some(tag.source)),
            created_at: tag.created_at,
        })
        .collect())
}

pub(crate) fn restore_tags(conn: &Connection, note_id: &str, snaps: &[TagSnap]) -> Result<(), String> {
    conn.execute("DELETE FROM note_tags WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    for snap in snaps {
        let tag_id = crate::ensure_tag(conn, &snap.name, &snap.source)?;
        conn.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![note_id, tag_id, snap.source, snap.created_at],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn seal_tags(conn: &Connection, note_id: &str, dek: &[u8; 32]) -> Result<String, String> {
    let snaps = snapshot_tags(conn, note_id)?;
    let plain = serde_json::to_vec(&snaps).map_err(|e| e.to_string())?;
    crypto::seal(dek, &note_aad(note_id, "tags"), &plain)
}

pub(crate) fn open_tags(note_id: &str, dek: &[u8; 32], blob: &str) -> Result<Vec<TagSnap>, String> {
    let plain = crypto::open_text(dek, &note_aad(note_id, "tags"), blob)?;
    serde_json::from_str(&plain).map_err(|_| "标签快照已损坏".to_string())
}

/// 把一篇笔记的全部历史版本正文从明文加密成密文（标题保持明文）。
pub(crate) fn seal_history(conn: &Connection, note_id: &str, dek: &[u8; 32]) -> Result<(), String> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, title, content FROM notes_history WHERE note_id = ?1")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![note_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (id, title, content) in rows {
        // 已经是密文（重复加密防护）就跳过
        if crypto::is_encrypted(&content) {
            continue;
        }
        let content = crypto::seal(dek, &note_aad(note_id, "content"), content.as_bytes())?;
        conn.execute(
            "UPDATE notes_history SET title = ?1, content = ?2 WHERE id = ?3",
            params![title, content, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn open_history(conn: &Connection, note_id: &str, dek: &[u8; 32]) -> Result<(), String> {
    let rows: Vec<(i64, String, String)> = {
        let mut stmt = conn
            .prepare("SELECT id, title, content FROM notes_history WHERE note_id = ?1")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![note_id], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (id, title, content) in rows {
        if !crypto::is_encrypted(&title) && !crypto::is_encrypted(&content) {
            continue;
        }
        // 只有旧数据的历史标题才是密文；新行标题一直明文
        let title = open_title_legacy(dek, note_id, &title)?;
        let content = if crypto::is_encrypted(&content) {
            crypto::open_text(dek, &note_aad(note_id, "content"), &content)?
        } else {
            content
        };
        conn.execute(
            "UPDATE notes_history SET title = ?1, content = ?2 WHERE id = ?3",
            params![title, content, id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn decrypt_history_fields(
    state: &EncryptionState,
    note_id: &str,
    enc_mode: i64,
    category_id: Option<&str>,
    title: &str,
    content: &str,
) -> Result<(String, String), String> {
    if enc_mode == 0 {
        return Ok((title.to_string(), content.to_string()));
    }
    let dek = note_dek(state, note_id, enc_mode, category_id)?;
    let title = open_title_legacy(&dek, note_id, title)?;
    let content = if crypto::is_encrypted(content) {
        crypto::open_text(&dek, &note_aad(note_id, "content"), content)?
    } else {
        content.to_string()
    };
    Ok((title, content))
}

/* ---------------- 条目密钥获取 ---------------- */

pub(crate) fn acquire_dek(
    conn: &Connection,
    state: &EncryptionState,
    scope: &str,
    id: &str,
    meta: &EncMeta,
    password: &str,
    use_root: bool,
) -> Result<Zeroizing<[u8; 32]>, String> {
    if use_root {
        if state.attempts(scope, id) < ROOT_FALLBACK_AFTER {
            return Err(json!({
                "code": "root_not_allowed",
                "attempts": state.attempts(scope, id),
                "required": ROOT_FALLBACK_AFTER,
            })
            .to_string());
        }
        let Some(wrap_root) = meta.wrap_root.as_deref() else {
            return Err(err_code("root_unavailable"));
        };
        let kek = verify_root(conn, state, password)?;
        let dek = dek_from_bytes(crypto::open(
            &kek,
            &wrap_aad("root", scope, id),
            wrap_root,
        )?)?;
        state.reset_attempts(scope, id);
        return Ok(dek);
    }

    let ik = meta.derive_item_key(password)?;
    match crypto::open(&ik, &wrap_aad("item", scope, id), &meta.wrap_item) {
        Ok(bytes) => {
            let dek = dek_from_bytes(bytes)?;
            state.reset_attempts(scope, id);
            upgrade_item_meta(conn, scope, id, meta, password, &dek);
            Ok(dek)
        }
        Err(_) => Err(bad_password(state.bump_attempts(scope, id))),
    }
}

/// 输对密码后顺手把旧的 PBKDF2 参数换成 Argon2id；失败就保持原样，不影响这次解锁。
pub(crate) fn upgrade_item_meta(
    conn: &Connection,
    scope: &str,
    id: &str,
    meta: &EncMeta,
    password: &str,
    dek: &[u8; 32],
) {
    if meta.is_current_kdf() {
        return;
    }
    let mut upgraded = meta.clone();
    if upgraded.rewrap_item(password, dek, scope, id).is_err() {
        return;
    }
    let _ = save_meta(conn, scope, id, &upgraded);
}

/* ---------------- 单篇笔记命令 ---------------- */

#[tauri::command(async)]
pub fn encrypt_note(
    note_id: String,
    password: String,
    root_password: Option<String>,
    hint: Option<String>,
    state: State<AppState>,
) -> Result<Note, String> {
    validate_password(&password)?;
    let mut conn = state.conn.lock().unwrap();
    let row = load_note_row(&conn, &note_id)?;
    // 回收站里的笔记不参与加密：还原后加密状态会和分组/移动守卫纠缠，
    // 而且回收站里根本看不到正文，加密对用户没有任何意义。
    if row.is_deleted {
        return Err(err_code("note_deleted"));
    }
    if row.enc_mode != 0 {
        return Err(err_code("already_encrypted"));
    }
    // 正文已经是密文却还标着未加密（历史异常数据）：再封一层会变成双重密文，
    // 用户输对密码也只能解出乱码，所以直接拒绝，交给启动自检修复。
    if crypto::is_encrypted(&row.content) {
        return Err(err_code("already_sealed"));
    }
    if let Some(category_id) = &row.category_id {
        if category_is_encrypted(&conn, category_id)? {
            return Err(err_code("category_encrypted"));
        }
    }
    let root_kek = root_kek_for_encrypt(&conn, &state.encryption, root_password.as_deref())?;

    // 随机 DEK 也是一份密钥副本：包进 Zeroizing，出作用域自动清零
    let dek = Zeroizing::new(crypto::random_dek());
    let meta = new_meta(&password, &dek, &root_kek, NOTE_SCOPE, &note_id, hint)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let content_cipher = crypto::seal(&dek, &note_aad(&note_id, "content"), row.content.as_bytes())?;
    let tags_cipher = seal_tags(&tx, &note_id, &dek)?;
    seal_history(&tx, &note_id, &dek)?;
    tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![&note_id])
        .map_err(|e| e.to_string())?;
    // 标签名本身在密文快照里，明文关联删掉后 tags 表里的行就是孤儿了——
    // 不收掉的话「标签名」仍然明文躺在库里，加密等于漏了一半
    crate::prune_tag_links(&tx)?;
    tx.execute(
        "UPDATE notes SET content = ?1, enc_mode = 1, enc_tags = ?2 WHERE id = ?3",
        params![content_cipher, tags_cipher, &note_id],
    )
    .map_err(|e| e.to_string())?;
    save_meta(&tx, NOTE_SCOPE, &note_id, &meta)?;
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![&note_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![&note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    // 加密后立刻回到锁定态：下次单击笔记必须重新输密码
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(Note {
        id: row.id,
        title: row.title,
        content: String::new(),
        category_id: row.category_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
        is_deleted: row.is_deleted,
        deleted_at: row.deleted_at,
        is_pinned: row.is_pinned,
        ai_access: row.ai_access,
        enc_mode: 1,
        is_locked: true,
        enc_hint: meta.hint,
    })
}

#[tauri::command(async)]
pub fn unlock_note(
    note_id: String,
    password: String,
    use_root: bool,
    scope: String,
    state: State<AppState>,
) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();
    let row = load_note_row(&conn, &note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    if row.enc_mode == 2 {
        return Err(json!({ "code": "note_encrypted", "reason": "group" }).to_string());
    }
    let meta = load_meta(&conn, NOTE_SCOPE, &note_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(&conn, &state.encryption, NOTE_SCOPE, &note_id, &meta, &password, use_root)?;
    state.encryption.put_key(
        NOTE_SCOPE,
        &note_id,
        *dek,
        parse_unlock_scope(&scope)?,
    );
    let title = open_title_legacy(&dek, &note_id, &row.title)?;
    let content = crypto::open_text(&dek, &note_aad(&note_id, "content"), &row.content)?;
    // 旧数据的标题曾经是密文：借这次解锁把明文标题写回库，之后列表搜索都能用
    if title != row.title {
        conn.execute(
            "UPDATE notes SET title = ?1 WHERE id = ?2",
            params![title, &note_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(row.into_note(title, content, false, meta.hint))
}

#[tauri::command(async)]
pub fn lock_note(note_id: String, force: bool, state: State<AppState>) -> Result<(), String> {
    state.encryption.lock(NOTE_SCOPE, &note_id, force);
    Ok(())
}

#[tauri::command(async)]
pub fn lock_all(state: State<AppState>) -> Result<(), String> {
    // 条目 DEK 与根 KEK 一起清掉，并把字节覆写掉；
    // 之后继续加密新内容需要重新输入根密码（前端会按 root_locked 提示）。
    state.encryption.clear_all();
    Ok(())
}

#[tauri::command(async)]
pub fn decrypt_note(
    note_id: String,
    password: String,
    use_root: bool,
    state: State<AppState>,
) -> Result<Note, String> {
    let mut conn = state.conn.lock().unwrap();
    let mut row = load_note_row(&conn, &note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    if row.enc_mode == 2 {
        return Err(json!({ "code": "note_encrypted", "reason": "group" }).to_string());
    }
    let meta = load_meta(&conn, NOTE_SCOPE, &note_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(&conn, &state.encryption, NOTE_SCOPE, &note_id, &meta, &password, use_root)?;
    let title = open_title_legacy(&dek, &note_id, &row.title)?;
    let content = crypto::open_text(&dek, &note_aad(&note_id, "content"), &row.content)?;
    let snaps = match &row.enc_tags {
        Some(blob) => open_tags(&note_id, &dek, blob)?,
        None => Vec::new(),
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    open_history(&tx, &note_id, &dek)?;
    restore_tags(&tx, &note_id, &snaps)?;
    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, enc_mode = 0, enc_tags = NULL WHERE id = ?3",
        params![title, content, &note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM encrypted_keys WHERE scope = 'note' AND ref_id = ?1",
        params![&note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![&note_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![&note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    state.encryption.lock(NOTE_SCOPE, &note_id, true);
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);

    // 返回给前端的笔记必须反映刚写入的 enc_mode=0：沿用旧行会让列表继续当成「已加密且已解锁」，
    // 右键还能「锁定」，一锁就变成永远打不开的假锁定态（库里其实已经是明文）。
    row.enc_mode = 0;
    Ok(row.into_note(title, content, false, None))
}

/* ---------------- 分组命令 ---------------- */

