use super::*;

/// 恢复备份里的图片：先落盘（同名已存在就跳过，重复导入是幂等的），再补元数据行
pub(crate) fn restore_backup_attachments(
    app: &AppHandle,
    conn: &Connection,
    items: &[Value],
) -> Result<(), String> {
    let created_at = Local::now().to_rfc3339();
    for item in items {
        let path = json_str(item, "path");
        let encoded = json_str(item, "data");
        let Some(bytes) = crate::attachments::base64_decode(&encoded) else {
            continue;
        };
        crate::attachments::restore_attachment(app, &path, &bytes)?;
        let file_name = path.rsplit('/').next().unwrap_or_default();
        let (hash, ext) = file_name.split_once('.').unwrap_or((file_name, "png"));
        let _ = conn.execute(
            "INSERT INTO attachments (hash, ext, mime, bytes, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(hash) DO NOTHING",
            params![
                hash,
                ext,
                json_str(item, "mime"),
                bytes.len() as i64,
                json_i64(item, "width"),
                json_i64(item, "height"),
                created_at
            ],
        );
    }
    Ok(())
}

/* ---------------- 数据备份与恢复 ----------------
 * 备份文件是一个 JSON：format 标记 + 各表数据，用于换机迁移或整体还原。
 * AI 服务商的 api_key 由导出时的 include_api_keys 决定：
 *   - false（默认）：不写入密钥，换机恢复后需重新填写；
 *   - true：写入**解密后的明文** Key，方便换机直接恢复（明文文件请妥善保管）。
 * 导入时若备份里带明文 Key，会重新加密后入库，数据库里始终不落明文。
 */

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup(app: AppHandle, state: State<AppState>, path: String) -> Result<BackupSummary, String> {
    let text = read_backup_text(&path)?;
    let doc: Value =
        serde_json::from_str(&text).map_err(|_| "备份文件不是合法的 JSON".to_string())?;
    if doc.get("format").and_then(|v| v.as_str()) != Some(BACKUP_FORMAT) {
        return Err("这不是 FastNote 的备份文件".to_string());
    }
    check_backup_version(&doc)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;

    let categories = json_arr(data, "categories");
    let notes = json_arr(data, "notes");
    let providers = json_arr(data, "providers");
    let sessions = json_arr(data, "sessions");
    let messages = json_arr(data, "messages");
    let settings = json_arr(data, "settings");
    // 老备份没有这两张表 → json_arr 返回空数组，等价于"这次不恢复标签"，不会挂
    let tags = json_arr(data, "tags");
    let note_tags = json_arr(data, "note_tags");
    let notes_history = json_arr(data, "notes_history");
    // 老备份没有这个字段 → 空数组，等价于「这次没有图片要恢复」，不报错
    let attachments = json_arr(data, "attachments");

    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    /*
     * 先给本地库拍一张快照：恢复是「覆盖」语义，备份里没有的本地内容（**尤其是加密笔记与
     * 它们的密钥**）会被清掉。过去为了不丢这些内容，入口干脆拒绝恢复；现在改成恢复完再把
     * 本地独有的行补回来 —— 不再需要「有加密内容就不让恢复」这种一刀切。
     */
    let preserve = LocalPreserve::capture(&conn, "json")?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 先记下本机现有的 Key 密文，恢复时按「名称+类型+地址」原样接回去：
    // 备份里没带 Key（未勾选导出）时同机恢复不会丢已填好的 Key；换机匹配不到则留空由用户重填。
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = tx
            .prepare("SELECT name, provider_type, api_base_url, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    (
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ),
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows.flatten() {
            local_keys.insert(row.0, row.1);
        }
    }

    // WebDAV 密码与自动备份状态不随备份走：先记下本机值，写完备份数据后再接回
    let local_only_settings = read_local_only_settings(&tx);

    // 覆盖式恢复：先清空，再按备份里的 id 原样写回（先删子表再删主表）
    for sql in [
        "DELETE FROM ai_chat_messages",
        "DELETE FROM ai_chat_sessions",
        "DELETE FROM note_tags",
        "DELETE FROM tags",
        "DELETE FROM notes_history",
        "DELETE FROM notes",
        "DELETE FROM categories",
        "DELETE FROM ai_providers",
        "DELETE FROM app_settings",
        // 向量、索引状态与语义元数据都不随备份走：旧向量与恢复后的笔记已不对应，
        // 残留的 model_id / dim / last_error 会让面板显示备份之前的旧状态与旧错误
        "DELETE FROM note_chunks",
        "DELETE FROM note_index_state",
        "DELETE FROM semantic_meta",
        "DELETE FROM encrypted_keys",
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                json_id(c, "id"),
                json_str(c, "name"),
                non_empty_or_now(json_str(c, "created_at")),
                // 旧备份可能没有这个字段，或是布尔（true=完全 / false=禁止）：统一归一化
                json_level(c, "ai_access", 2),
                // 加密分组同样原样保留（分组名在库里是密文，能不能打开取决于密钥）
                if json_bool_or(c, "is_encrypted", false) { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                                is_pinned, ai_access, enc_mode, enc_tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                json_id(n, "id"),
                json_str(n, "title"),
                json_str(n, "content"),
                json_opt_id(n, "category_id"),
                non_empty_or_now(json_str(n, "created_at")),
                non_empty_or_now(json_str(n, "updated_at")),
                if json_bool(n, "is_deleted") { 1 } else { 0 },
                json_opt_str(n, "deleted_at"),
                // 旧备份没有这两个字段：置顶 / AI 访问都按默认值兜底
                if json_bool_or(n, "is_pinned", false) { 1 } else { 0 },
                json_level(n, "ai_access", 2),
                // 加密笔记保持原样入库（密文 + 加密元数据），能不能读取决于有没有原根密码。
                // 注意 id 必须原样保留：密文与 DEK 的 AAD 里都拼了它。
                json_i64(n, "enc_mode"),
                json_opt_str(n, "enc_tags")
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 加密笔记的密钥：备份带就一起入库（按 scope+ref_id 幂等）。
    // 缺了它，带回来的密文就是永久打不开的死壳，所以能带就必须带。
    for k in json_arr(data, "encrypted_keys") {
        tx.execute(
            "INSERT OR IGNORE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                json_str(k, "scope"),
                json_str(k, "ref_id"),
                json_str(k, "meta_json"),
                non_empty_or_now(json_str(k, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    // 历史版本必须排在笔记之后写；老备份没有这张表时就是空数组
    for h in notes_history {
        tx.execute(
            "INSERT INTO notes_history (id, note_id, title, content, category_id, is_pinned, kind,
                                        pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                json_i64(h, "id"),
                json_id(h, "note_id"),
                json_str(h, "title"),
                json_str(h, "content"),
                json_opt_id(h, "category_id"),
                if json_bool_or(h, "is_pinned", false) { 1 } else { 0 },
                // 旧备份没有来源/固定字段：按自动版本、未固定处理
                normalize_history_kind(&json_str_or(h, "kind", HISTORY_KIND_AUTO)),
                if json_bool_or(h, "pinned", false) { 1 } else { 0 },
                non_empty_or_now(json_str(h, "saved_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for p in providers {
        // 备份里带了明文 api_key（导出时勾选了「备份 API Key」）→ 重新加密后入库；
        // 否则按「名称+类型+地址」沿用本机已有的密文（同机恢复不丢已填好的 Key）。
        let api_key = match json_opt_str(p, "api_key").filter(|k| !k.is_empty()) {
            Some(plain) => encrypt_secret(&tx, &plain)?,
            None => local_keys
                .get(&(
                    json_str(p, "name"),
                    json_str(p, "provider_type"),
                    json_str(p, "api_base_url"),
                ))
                .cloned()
                .unwrap_or_default(),
        };
        let enabled_models = p
            .get("enabled_models")
            .and_then(|v| v.as_array())
            .map(|list| {
                let models: Vec<&str> = list.iter().filter_map(|m| m.as_str()).collect();
                serde_json::to_string(&models).unwrap_or_else(|_| "[]".to_string())
            })
            .unwrap_or_else(|| "[]".to_string());
        tx.execute(
            "INSERT INTO ai_providers (id, name, provider_type, api_base_url, api_key, api_path,
                                       enabled_model, enabled_models, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                json_i64(p, "id"),
                json_str(p, "name"),
                json_str(p, "provider_type"),
                json_str(p, "api_base_url"),
                api_key,
                json_opt_str(p, "api_path"),
                json_opt_str(p, "enabled_model"),
                enabled_models,
                non_empty_or_now(json_str(p, "created_at")),
                non_empty_or_now(json_str(p, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in sessions {
        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, provider_id, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                json_i64(s, "id"),
                json_str(s, "title"),
                json_i64(s, "provider_id"),
                json_str(s, "model"),
                non_empty_or_now(json_str(s, "created_at")),
                non_empty_or_now(json_str(s, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for m in messages {
        tx.execute(
            "INSERT INTO ai_chat_messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                json_i64(m, "id"),
                json_i64(m, "session_id"),
                json_str(m, "role"),
                json_str(m, "content"),
                non_empty_or_now(json_str(m, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in settings {
        let key = json_str(s, "key");
        /*
         * 根密码材料（app.security.*）默认不采纳外来值：本地已有根密码时换掉它，
         * 会让本机原有的加密笔记立刻失效。本地值由恢复前的快照补回来；
         * 换机场景走 `verify_backup_root_password` + `import_backup_root_key` 那条显式通道
         * （用户必须先输对原设备根密码）。
         */
        if key.starts_with("app.security.") {
            continue;
        }
        let mut value = json_str(s, "value");
        // 勾选了「备份 WebDAV」的备份带的是明文密码，入库前重新加密；已是密文则原样保留
        if key == "webdav.password" && !value.is_empty() && !is_encrypted(&value) {
            value = encrypt_secret(&tx, &value)?;
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![
                key,
                value,
                non_empty_or_now(json_str(s, "updated_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    restore_local_only_settings(&tx, &local_only_settings)?;

    // 标签必须在 notes 之后写：这里的 INSERT 没有外键检查，
    // 顺序反了也不会报错，但会留下一批指向不存在笔记的孤儿关联。
    for t in tags {
        tx.execute(
            "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                json_i64(t, "id"),
                json_str(t, "name"),
                normalize_source(Some(json_str(t, "source"))),
                non_empty_or_now(json_str(t, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for nt in note_tags {
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                json_id(nt, "note_id"),
                json_i64(nt, "tag_id"),
                normalize_source(Some(json_str(nt, "source"))),
                non_empty_or_now(json_str(nt, "created_at"))
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    // 把备份里没有、本地独有的行补回来（加密笔记、密钥、根密码材料、本机设置、图片元数据）
    let preserved = preserve.restore(&conn)?;
    // 图片：备份里内联了被引用到的附件，恢复时直接写回磁盘并补元数据
    restore_backup_attachments(&app, &conn, &attachments)?;

    drop(conn);
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
        skipped_encrypted: 0,
        preserved,
        exported_at: doc
            .get("exported_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
    })
}


/* ---------------- 预检与选择性恢复 ----------------
 *
 * `import_backup` 是「清表重建」：结果等于备份那一刻。它适合换机、整库回滚，
 * 但用户真正想要的经常是「把备份里的某几样拿回来」——本地多出来的不该被删。
 * 下面这组命令就是那条路：先 `preflight_backup` 只读扫一遍给出清单，
 * 用户勾选之后 `import_backup_selected` 按**合并**语义写库，全程不删任何本地行。
 */

