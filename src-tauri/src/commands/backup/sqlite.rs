use super::*;

/// 读快照里的 meta 值（导出时间等）
pub(crate) fn snapshot_meta(conn: &Connection, key: &str) -> Option<String> {
    if !has_table(conn, SQLITE_BACKUP_META) {
        return None;
    }
    conn.query_row(
        &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = ?1"),
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

/// 拼一个「列存在就取值、不存在就用默认值」的表达式，兼容旧版本快照
pub(crate) fn col_expr(conn: &Connection, table: &str, col: &str, fallback: &str) -> String {
    if table_columns(conn, "main", table).iter().any(|c| c == col) {
        format!("COALESCE({col}, {fallback})")
    } else {
        fallback.to_string()
    }
}

/// 把 SQLite 快照读成与 `export_backup` 完全一致的 `data` 结构。
///
/// api_key 刻意不读：快照里存的是**本机加密值**，换机解不开，
/// 交给 `apply_backup_merge` 按「名称+类型+地址」沿用本机已有的 Key 更正确。
pub(crate) fn sqlite_snapshot_to_data(conn: &Connection) -> Result<Value, String> {
    // 复用原有校验：是不是 FastNote 导出的快照、版本是否过新、必需列是否齐全
    read_sqlite_backup(conn)?;

    let c_ai = col_expr(conn, "categories", "ai_access", "2");
    let c_enc = col_expr(conn, "categories", "is_encrypted", "0");
    let categories = query_rows(
        conn,
        &format!(
            "SELECT id, name, created_at, {c_ai}, {c_enc} FROM categories ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, String>(2)?,
                "ai_access": row.get::<_, i64>(3)?.clamp(0, 2),
                "is_encrypted": row.get::<_, i64>(4)? != 0,
            }))
        },
    )?;

    let n_del = col_expr(conn, "notes", "is_deleted", "0");
    let n_del_at = col_expr(conn, "notes", "deleted_at", "NULL");
    let n_pin = col_expr(conn, "notes", "is_pinned", "0");
    let n_ai = col_expr(conn, "notes", "ai_access", "2");
    let n_enc = col_expr(conn, "notes", "enc_mode", "0");
    let n_tags = col_expr(conn, "notes", "enc_tags", "NULL");
    let notes = query_rows(
        conn,
        &format!(
            "SELECT id, title, content, category_id, created_at, updated_at,
                    {n_del}, {n_del_at}, {n_pin}, {n_ai}, {n_enc}, {n_tags}
             FROM notes ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, String>(0)?,
                "title": row.get::<_, String>(1)?,
                "content": row.get::<_, String>(2)?,
                "category_id": row.get::<_, Option<String>>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
                "is_deleted": row.get::<_, i64>(6)? != 0,
                "deleted_at": row.get::<_, Option<String>>(7)?,
                "is_pinned": row.get::<_, i64>(8)? != 0,
                "ai_access": row.get::<_, i64>(9)?.clamp(0, 2),
                "enc_mode": row.get::<_, i64>(10)?,
                "enc_tags": row.get::<_, Option<String>>(11)?,
            }))
        },
    )?;

    let p_models = col_expr(conn, "ai_providers", "enabled_models", "'[]'");
    let p_model = col_expr(conn, "ai_providers", "enabled_model", "NULL");
    let p_path = col_expr(conn, "ai_providers", "api_path", "NULL");
    let providers = query_rows(
        conn,
        &format!(
            "SELECT id, name, provider_type, api_base_url, {p_path}, {p_model}, {p_models},
                    created_at, updated_at
             FROM ai_providers ORDER BY id"
        ),
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "provider_type": row.get::<_, String>(2)?,
                "api_base_url": row.get::<_, String>(3)?,
                "api_path": row.get::<_, Option<String>>(4)?,
                "enabled_model": row.get::<_, Option<String>>(5)?,
                "enabled_models": parse_models_json(row.get::<_, Option<String>>(6)?),
                "created_at": row.get::<_, String>(7)?,
                "updated_at": row.get::<_, String>(8)?,
            }))
        },
    )?;

    let sessions = query_rows(
        conn,
        "SELECT id, title, provider_id, model, created_at, updated_at
         FROM ai_chat_sessions ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "title": row.get::<_, String>(1)?,
                "provider_id": row.get::<_, i64>(2)?,
                "model": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
                "updated_at": row.get::<_, String>(5)?,
            }))
        },
    )?;

    let messages = query_rows(
        conn,
        "SELECT id, session_id, role, content, created_at FROM ai_chat_messages ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "session_id": row.get::<_, i64>(1)?,
                "role": row.get::<_, String>(2)?,
                "content": row.get::<_, String>(3)?,
                "created_at": row.get::<_, String>(4)?,
            }))
        },
    )?;

    // 根密码材料也读出来：换机恢复要靠它解锁（是否采纳由专用命令决定）
    let settings = query_rows(
        conn,
        "SELECT key, value, updated_at FROM app_settings ORDER BY key",
        |row| {
            Ok(json!({
                "key": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
                "updated_at": row.get::<_, String>(2)?,
            }))
        },
    )?;

    let tags = if has_table(conn, "tags") {
        query_rows(
            conn,
            "SELECT id, name, source, created_at FROM tags ORDER BY id",
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "name": row.get::<_, String>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let note_tags = if has_table(conn, "note_tags") {
        query_rows(
            conn,
            "SELECT note_id, tag_id, source, created_at FROM note_tags ORDER BY note_id, tag_id",
            |row| {
                Ok(json!({
                    "note_id": row.get::<_, String>(0)?,
                    "tag_id": row.get::<_, i64>(1)?,
                    "source": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let history = if has_table(conn, "notes_history") {
        let h_kind = col_expr(conn, "notes_history", "kind", "'auto'");
        let h_pinned = col_expr(conn, "notes_history", "pinned", "0");
        let h_pin = col_expr(conn, "notes_history", "is_pinned", "0");
        query_rows(
            conn,
            &format!(
                "SELECT id, note_id, title, content, category_id, {h_pin}, {h_kind},
                        {h_pinned}, saved_at
                 FROM notes_history ORDER BY id"
            ),
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "note_id": row.get::<_, String>(1)?,
                    "title": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "category_id": row.get::<_, Option<String>>(4)?,
                    "is_pinned": row.get::<_, i64>(5)? != 0,
                    "kind": row.get::<_, String>(6)?,
                    "pinned": row.get::<_, i64>(7)? != 0,
                    "saved_at": row.get::<_, String>(8)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    let encrypted_keys = if has_table(conn, "encrypted_keys") {
        query_rows(
            conn,
            "SELECT scope, ref_id, meta_json, created_at FROM encrypted_keys ORDER BY scope, ref_id",
            |row| {
                Ok(json!({
                    "scope": row.get::<_, String>(0)?,
                    "ref_id": row.get::<_, String>(1)?,
                    "meta_json": row.get::<_, String>(2)?,
                    "created_at": row.get::<_, String>(3)?,
                }))
            },
        )?
    } else {
        Vec::new()
    };

    // 图片：快照里带的是字节（attachments.data），转成 JSON 备份同一套 base64 结构
    let mut attachments = Vec::new();
    if has_table(conn, "attachments") && table_columns(conn, "main", "attachments").iter().any(|c| c == "data") {
        let mut stmt = conn
            .prepare(
                "SELECT hash, ext, mime, COALESCE(width, 0), COALESCE(height, 0), data
                 FROM attachments WHERE data IS NOT NULL",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for (hash, ext, mime, width, height, bytes) in rows.flatten() {
            // 与附件模块的落盘规则保持一致：attachments/<hash 前 2 位>/<hash>.<ext>
            let bucket = hash.get(..2).unwrap_or("00");
            attachments.push(json!({
                "path": format!("attachments/{bucket}/{hash}.{ext}"),
                "mime": mime,
                "width": width,
                "height": height,
                "data": crate::attachments::base64_encode(&bytes),
            }));
        }
    }

    Ok(json!({
        "categories": categories,
        "notes": notes,
        "providers": providers,
        "sessions": sessions,
        "messages": messages,
        "settings": settings,
        "tags": tags,
        "note_tags": note_tags,
        "notes_history": history,
        "encrypted_keys": encrypted_keys,
        "attachments": attachments,
    }))
}

/// 打开快照文件（只读）：备份文件不在我们手里，任何写操作都不该发生
pub(crate) fn open_snapshot(path: &str) -> Result<Connection, String> {
    Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("打开备份文件失败：{e}"))
}

/// SQLite 快照的只读预检：与 JSON 预检返回同一份结构
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn preflight_sqlite_backup(
    state: State<AppState>,
    path: String,
) -> Result<BackupPreflight, String> {
    let snap = open_snapshot(&path)?;
    let data = sqlite_snapshot_to_data(&snap)?;
    let exported_at = snapshot_meta(&snap, "exported_at");
    drop(snap);
    preflight_from_data(
        &state,
        &data,
        SQLITE_BACKUP_FORMAT.to_string(),
        SQLITE_BACKUP_VERSION as i64,
        exported_at,
    )
}

/// SQLite 快照的按勾选恢复：读快照 → 转成 data → 走同一套合并逻辑
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_sqlite_selected(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    selection: BackupSelection,
) -> Result<BackupSummary, String> {
    let snap = open_snapshot(&path)?;
    let data = sqlite_snapshot_to_data(&snap)?;
    let exported_at = snapshot_meta(&snap, "exported_at");
    // 先断开快照文件，避免它和后来的写事务互相占着句柄
    drop(snap);
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    apply_backup_merge(&app, &state, &mut conn, &data, &selection, exported_at)
}

/// 从备份的 settings 里抽出根密码参数（app.security.root.*）
pub(crate) fn backup_root_params(data: &Value) -> std::collections::HashMap<String, String> {
    json_arr(data, "settings")
        .iter()
        .filter_map(|s| {
            let key = json_str(s, "key");
            if key.starts_with("app.security.root.") {
                Some((key, json_str(s, "value")))
            } else {
                None
            }
        })
        .collect()
}

/// 从任意一种备份里抽出根密码参数：JSON 读 data，.db 打开快照读 app_settings。
pub(crate) fn root_params_from_path(path: &str) -> Result<std::collections::HashMap<String, String>, String> {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".db") || lower.ends_with(".sqlite") {
        let snap = open_snapshot(path)?;
        let data = sqlite_snapshot_to_data(&snap)?;
        return Ok(backup_root_params(&data));
    }
    let doc = load_backup_doc(path)?;
    let data = doc
        .get("data")
        .ok_or_else(|| "备份文件内容不完整（缺少 data）".to_string())?;
    Ok(backup_root_params(data))
}


/// 把备份里的根密钥迁移到本机根密码（换机 / 改过密码后恢复的关键一步）。
///
/// 场景：备份里的 `wrap_root` 是**原设备根密码**包的，而本机根密码换过，
/// 于是恢复回来的笔记「根密码解不开、只有自己的密码能解」。这里用旧密码解开、
/// 用本机 KEK 重新包回去，之后一把根密码就能全部打开。
///
/// 只改 `wrap_root`，`wrap_item` 与正文密文都不动，出错也能用单元密码打开。
#[tauri::command(async)]
pub fn migrate_backup_root_wrap(
    state: State<AppState>,
    path: String,
    old_password: String,
    new_password: String,
) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let migrated = crate::encryption::migrate_root_from_backup(
        &conn,
        &state.encryption,
        &params,
        &old_password,
        &new_password,
    )?;
    Ok(json!({ "ok": true, "migrated": migrated }))
}

/// 校验「原设备根密码」是否与备份里的根密码材料吻合。
///
/// **只算不写**：换机恢复时先让用户证明自己知道原密码，再决定要不要采纳 keyring。
/// 这里的失败计数沿用本机根密码的冷却机制（同一条通道，避免被拿来反复试密码）。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn verify_backup_root_password(path: String, password: String) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    crate::encryption::verify_root_params(&params, &password)?;
    Ok(json!({ "ok": true }))
}

/// 采纳备份里的根密码材料（换机解锁的最后一步）。
///
/// 只做「把 app.security.root.* 写进本机」，笔记密文与 encrypted_keys 在恢复时已入库，
/// 写完之后本机就能用原设备根密码解开它们。
///
/// `allow_replace` 为 false 时，本地已有根密码就拒绝——替换会让本机原有加密笔记全部失效，
/// 必须由用户在界面上明确确认过才能进来。
/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_backup_root_key(
    state: State<AppState>,
    path: String,
    password: String,
    allow_replace: bool,
) -> Result<Value, String> {
    let params = root_params_from_path(&path)?;
    if params.is_empty() {
        return Err(json!({ "code": "root_not_set" }).to_string());
    }
    // 先验密码：错的密码绝不能写进库，否则本机根密码会被一份无效 verifier 顶掉
    let kek = crate::encryption::verify_root_params(&params, &password)?;

    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let local_root_set: bool = conn
        .query_row(
            "SELECT COUNT(*) FROM app_settings WHERE key = 'app.security.root.salt'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0)
        > 0;
    if local_root_set && !allow_replace {
        return Err(json!({ "code": "root_already_set" }).to_string());
    }

    let now = chrono::Local::now().to_rfc3339();
    for (key, value) in &params {
        conn.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![key, value, now],
        )
        .map_err(|e| e.to_string())?;
    }
    // 库里的根密码材料换了，内存缓存也必须跟着换：否则本次会话还在用旧 KEK 解 wrap_root，
    // 表现是「刚恢复完的加密笔记打不开，重启后却好了」。
    crate::encryption::adopt_root_kek(&state.encryption, kek);
    Ok(json!({ "ok": true, "replaced": local_root_set }))
}

/* ---------------- SQLite 备份与恢复 ----------------
 * 与 JSON 备份互补：SQLite 是整库快照，恢复时直接按表写回，适合本机快速备份；
 * JSON 带字段级兼容逻辑，更适合跨版本 / 换机迁移。
 *
 * 快照用 VACUUM INTO 生成，是独立、一致的 .db 文件（不是正在使用的库文件副本）；
 * 文件内附一张 fastnote_backup_meta 标记表，导入时据此拒绝来路不明的数据库。
 * API Key 的处理：
 *   - 不勾选备份 Key：快照里的 api_key 全部清空；
 *   - 勾选：保留本机加密值（密钥文件不随备份走，换机后无法解密，恢复时会尝试沿用本机同名服务商的 Key）。
 */

pub(crate) const SQLITE_BACKUP_FORMAT: &str = "fastnote-sqlite-backup";

pub(crate) const SQLITE_BACKUP_META: &str = "fastnote_backup_meta";

pub(crate) const SQLITE_BACKUP_VERSION: u32 = 1;

pub(crate) fn count_rows(conn: &Connection, table: &str) -> usize {
    conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
        row.get::<_, i64>(0)
    })
    .unwrap_or(0) as usize
}

/// 把临时文件挪到用户选的目标路径。Windows 的 rename 不会覆盖已有文件，先删旧目标。
pub(crate) fn replace_backup_file(tmp: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        std::fs::remove_file(target).map_err(|e| format!("覆盖已有备份文件失败：{e}"))?;
    }
    std::fs::rename(tmp, target).map_err(|e| format!("保存备份文件失败：{e}"))
}

/// 生成 SQLite 快照到 `tmp`（目标必须不存在）。
/// `include_encrypted` 为 true 时原样保留加密笔记/分组、`encrypted_keys` 与 `app.security.*`：
/// 只在「加密容器备份」里用（外层还有一层口令加密），普通快照一律把加密内容剔除。
pub(crate) fn build_sqlite_snapshot(
    conn: &Connection,
    tmp: &Path,
    app: &AppHandle,
    exported_at: &str,
    include_api_keys: bool,
    include_webdav: bool,
    include_encrypted: bool,
) -> Result<(), String> {
    conn.execute("VACUUM INTO ?1", params![tmp.to_string_lossy().to_string()])
        .map_err(|e| format!("生成数据库快照失败：{e}"))?;

    let snap = Connection::open(tmp).map_err(|e| format!("打开数据库快照失败：{e}"))?;
    // 快照必须是单文件：切回 DELETE 日志模式，不把 -wal / -shm 留给用户
    let _ = snap.execute_batch("PRAGMA journal_mode=DELETE;");
    snap.execute_batch(&format!(
        "CREATE TABLE IF NOT EXISTS {SQLITE_BACKUP_META} (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                );"
    ))
    .map_err(|e| format!("写入备份标记失败：{e}"))?;

    {
        let mut stmt = snap
            .prepare(&format!(
                "INSERT OR REPLACE INTO {SQLITE_BACKUP_META} (key, value) VALUES (?1, ?2)"
            ))
            .map_err(|e| e.to_string())?;
        let meta = [
            ("format", SQLITE_BACKUP_FORMAT.to_string()),
            ("version", SQLITE_BACKUP_VERSION.to_string()),
            ("exported_at", exported_at.to_string()),
            ("app_version", app.package_info().version.to_string()),
            (
                "api_keys",
                if include_api_keys {
                    "encrypted"
                } else {
                    "none"
                }
                .to_string(),
            ),
            (
                "encrypted_content",
                if include_encrypted { "included" } else { "none" }.to_string(),
            ),
        ];
        for (key, value) in meta {
            stmt.execute(params![key, value])
                .map_err(|e| format!("写入备份标记失败：{e}"))?;
        }
    }

    if !include_api_keys {
        snap.execute("UPDATE ai_providers SET api_key = ''", [])
            .map_err(|e| format!("清除快照中的 API Key 失败：{e}"))?;
    }
    // 自动备份运行状态永远不随快照走；未勾选 WebDAV 时整组配置一起清掉，
    // 勾选后保留服务器/账号/密码密文，恢复后仍可在同机继续使用。
    for key in WEBDAV_AUTO_STATE_KEYS {
        snap.execute("DELETE FROM app_settings WHERE key = ?1", params![key])
            .map_err(|e| format!("清除快照中的本机设置失败：{e}"))?;
    }
    if !include_webdav {
        snap.execute("DELETE FROM app_settings WHERE key LIKE 'webdav.%'", [])
            .map_err(|e| format!("清除快照中的 WebDAV 设置失败：{e}"))?;
    }
    // 语义索引与元数据是纯本机派生物（体积大、换机/换模型无意义）：快照里也不带，
    // 恢复后由后台按当前模型重建。
    for table in ["note_chunks", "note_index_state", "semantic_meta"] {
        snap.execute(&format!("DELETE FROM {table}"), [])
            .map_err(|e| format!("清除快照中的语义数据失败：{e}"))?;
    }
    if !include_encrypted {
        // 加密内容与根密码元数据不进普通备份：备份文件不假设用户还记得密码。
        // 顺序：先删笔记行，再按"已不存在的 note_id"清历史与标签关联。
        snap.execute("DELETE FROM notes WHERE COALESCE(enc_mode, 0) <> 0", [])
            .map_err(|e| format!("清除快照中的加密笔记失败：{e}"))?;
        for sql in [
            "DELETE FROM notes_history WHERE note_id NOT IN (SELECT id FROM notes)",
            "DELETE FROM note_tags WHERE note_id NOT IN (SELECT id FROM notes)",
            "DELETE FROM categories WHERE COALESCE(is_encrypted, 0) <> 0",
            "DELETE FROM encrypted_keys",
            "DELETE FROM app_settings WHERE key LIKE 'app.security.%'",
        ] {
            snap.execute(sql, [])
                .map_err(|e| format!("清除快照中的加密数据失败：{e}"))?;
        }
    }
    // 图片字节平时只存在磁盘上；快照要能「一个 .db 文件就完整恢复」，
    // 就必须把被引用到的图片写进快照库的 attachments.data 列（运行时那一列始终是 NULL）。
    embed_attachments_into_snapshot(conn, &snap, app)?;

    // 删行只让页面变成空闲页，VACUUM 才能真正把密文/元数据从文件里抹掉
    snap.execute("VACUUM", [])
        .map_err(|e| format!("整理数据库快照失败：{e}"))?;
    Ok(())
}

/// 把图片字节写进快照的 `attachments.data`（恢复时再落地成文件）。
///
/// 只带附件表里登记过的图片，且必须文件真的存在——手工删过数据目录时跳过，
/// 不让「一张丢了的图」把整次备份搞失败。
pub(crate) fn embed_attachments_into_snapshot(
    live: &Connection,
    snap: &Connection,
    app: &AppHandle,
) -> Result<(), String> {
    snap.execute_batch(
        "CREATE TABLE IF NOT EXISTS attachments (
            hash TEXT PRIMARY KEY,
            ext TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            data BLOB,
            created_at TEXT NOT NULL
        );",
    )
    .map_err(|e| format!("准备快照图片表失败：{e}"))?;

    let mut stmt = live
        .prepare("SELECT hash, ext, mime, bytes, width, height, created_at FROM attachments")
        .map_err(|e| format!("读取图片元数据失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|e| format!("读取图片元数据失败：{e}"))?;

    for row in rows.flatten() {
        let (hash, ext, mime, bytes, width, height, created_at) = row;
        let rel = format!("attachments/{}/{hash}.{ext}", &hash[..2.min(hash.len())]);
        let Some(data) = crate::attachments::read_attachment_bytes(app, &rel) else {
            continue;
        };
        snap.execute(
            "INSERT OR REPLACE INTO attachments (hash, ext, mime, bytes, width, height, data, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![hash, ext, mime, bytes, width, height, data, created_at],
        )
        .map_err(|e| format!("写入快照图片失败：{e}"))?;
    }
    Ok(())
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_sqlite_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    // 是否把加密笔记、分组密钥与根密码材料一起打进快照。
    // 缺省 true：备份要完整，能不能读交给根密码决定（与 JSON 备份一致）。
    include_encrypted: Option<bool>,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let exported_at = Local::now().to_rfc3339();
    let count = |sql: &str| -> usize {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0) as usize
    };
    // 摘要按"实际进快照的行数"算：不勾选加密内容时，加密项会在副本里被删掉
    let include_enc = include_encrypted.unwrap_or(true);
    let summary = BackupSummary {
        notes: if include_enc {
            count("SELECT COUNT(*) FROM notes")
        } else {
            count("SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) = 0")
        },
        categories: if include_enc {
            count("SELECT COUNT(*) FROM categories")
        } else {
            count("SELECT COUNT(*) FROM categories WHERE COALESCE(is_encrypted, 0) = 0")
        },
        providers: count_rows(&conn, "ai_providers"),
        sessions: count_rows(&conn, "ai_chat_sessions"),
        messages: count_rows(&conn, "ai_chat_messages"),
        settings: count(
            "SELECT COUNT(*) FROM app_settings WHERE key NOT LIKE 'app.security.%'",
        ),
        // 默认随包导出；用户主动关掉「备份加密内容」时才计入跳过
        skipped_encrypted: if include_enc {
            0
        } else {
            count("SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0")
        },
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let target = std::path::PathBuf::from(&path);
    let parent = target.parent().ok_or("备份路径不可用".to_string())?;
    // 保存对话框给出的目标可能已存在，而 VACUUM INTO 要求目标不存在：
    // 先写同目录临时文件，成功后再替换，避免中途失败留下半个备份。
    let tmp = parent.join(format!(".fastnote-sqlite-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp);

    let result = build_sqlite_snapshot(
        &conn,
        &tmp,
        &app,
        &exported_at,
        include_api_keys,
        include_webdav,
        include_encrypted.unwrap_or(true),
    )
    .and_then(|()| replace_backup_file(&tmp, &target));

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result?;
    Ok(summary)
}

/** SQLite 快照读出的数据：字段与当前库结构对齐，缺失的列由读取 SQL 补默认值 */
#[derive(Default)]
pub struct SqliteBackupData {
    categories: Vec<SqliteCategoryRow>,
    notes: Vec<SqliteNoteRow>,
    providers: Vec<SqliteProviderRow>,
    sessions: Vec<SqliteSessionRow>,
    messages: Vec<SqliteMessageRow>,
    settings: Vec<SqliteSettingRow>,
    tags: Vec<SqliteTagRow>,
    note_tags: Vec<SqliteNoteTagRow>,
    notes_history: Vec<SqliteNoteHistoryRow>,
    /// 只有加密容器备份里才有；普通快照导不出这行数据
    encrypted_keys: Vec<SqliteEncryptedKeyRow>,
    exported_at: Option<String>,
}

pub struct SqliteCategoryRow {
    id: String,
    name: String,
    created_at: String,
    ai_access: i64,
    is_encrypted: i64,
}

pub struct SqliteNoteRow {
    id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    created_at: String,
    updated_at: String,
    is_deleted: i64,
    deleted_at: Option<String>,
    is_pinned: i64,
    ai_access: i64,
    enc_mode: i64,
    enc_tags: Option<String>,
}

pub struct SqliteEncryptedKeyRow {
    scope: String,
    ref_id: String,
    meta_json: String,
    created_at: String,
}

pub struct SqliteProviderRow {
    id: i64,
    name: String,
    provider_type: String,
    api_base_url: String,
    api_key: String,
    api_path: Option<String>,
    enabled_model: Option<String>,
    enabled_models: Option<String>,
    created_at: String,
    updated_at: String,
}

pub struct SqliteSessionRow {
    id: i64,
    title: String,
    provider_id: i64,
    model: String,
    created_at: String,
    updated_at: String,
}

pub struct SqliteMessageRow {
    id: i64,
    session_id: i64,
    role: String,
    content: String,
    created_at: String,
}

pub struct SqliteSettingRow {
    key: String,
    value: String,
    updated_at: String,
}

pub struct SqliteTagRow {
    id: i64,
    name: String,
    source: String,
    created_at: String,
}

pub struct SqliteNoteTagRow {
    note_id: String,
    tag_id: i64,
    source: String,
    created_at: String,
}

pub struct SqliteNoteHistoryRow {
    id: i64,
    note_id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    is_pinned: i64,
    kind: String,
    pinned: i64,
    saved_at: String,
}

/// 读取并校验 SQLite 备份。表结构必须包含当前版本的核心列；
/// 后加的列（置顶、AI 档位、多选模型等）缺失时用默认值补齐。
pub(crate) fn read_sqlite_backup(conn: &Connection) -> Result<SqliteBackupData, String> {
    if !has_table(conn, SQLITE_BACKUP_META) {
        return Err("这不是 FastNote 导出的 SQLite 备份文件".to_string());
    }
    let format: Option<String> = conn
        .query_row(
            &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'format'"),
            [],
            |row| row.get(0),
        )
        .ok();
    if format.as_deref() != Some(SQLITE_BACKUP_FORMAT) {
        return Err("这不是 FastNote 导出的 SQLite 备份文件".to_string());
    }
    let version: Option<String> = conn
        .query_row(
            &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'version'"),
            [],
            |row| row.get(0),
        )
        .ok();
    if version.and_then(|v| v.parse::<u32>().ok()).unwrap_or(0) > SQLITE_BACKUP_VERSION {
        return Err("备份由更新版本的 FastNote 创建，请先升级软件再恢复".to_string());
    }

    let required: [(&str, &[&str]); 6] = [
        ("categories", &["id", "name", "created_at"]),
        (
            "notes",
            &[
                "id",
                "title",
                "content",
                "category_id",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_providers",
            &[
                "id",
                "name",
                "provider_type",
                "api_base_url",
                "api_key",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_chat_sessions",
            &[
                "id",
                "title",
                "provider_id",
                "model",
                "created_at",
                "updated_at",
            ],
        ),
        (
            "ai_chat_messages",
            &["id", "session_id", "role", "content", "created_at"],
        ),
        ("app_settings", &["key", "value", "updated_at"]),
    ];
    for (table, columns) in required {
        if !has_table(conn, table) {
            return Err(format!("SQLite 备份缺少数据表 {table}"));
        }
        for column in columns {
            if !has_column(conn, table, column) {
                return Err(format!("SQLite 备份的表 {table} 缺少列 {column}"));
            }
        }
    }

    // 后加的列缺失时补默认值，兼容较早导出的快照
    let col = |table: &str, column: &str, fallback: &str| {
        if has_column(conn, table, column) {
            column.to_string()
        } else {
            fallback.to_string()
        }
    };
    let ai_access = |table: &str| col(table, "ai_access", "2");

    let mut out = SqliteBackupData {
        exported_at: conn
            .query_row(
                &format!("SELECT value FROM {SQLITE_BACKUP_META} WHERE key = 'exported_at'"),
                [],
                |row| row.get(0),
            )
            .ok(),
        ..Default::default()
    };

    {
        let sql = format!(
            "SELECT id, name, created_at, {}, {} FROM categories ORDER BY id",
            ai_access("categories"),
            col("categories", "is_encrypted", "0")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteCategoryRow {
                    id: row_text(row, 0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    ai_access: row.get::<_, i64>(3)?.clamp(0, 2),
                    is_encrypted: row.get::<_, i64>(4)?.min(1),
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.categories.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let sql = format!(
            "SELECT id, title, content, category_id, created_at, updated_at, {}, {}, {}, {},
                    {}, {}
             FROM notes ORDER BY id",
            col("notes", "is_deleted", "0"),
            col("notes", "deleted_at", "NULL"),
            col("notes", "is_pinned", "0"),
            ai_access("notes"),
            col("notes", "enc_mode", "0"),
            col("notes", "enc_tags", "NULL")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteRow {
                    id: row_text(row, 0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    category_id: row_text_opt(row, 3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_deleted: row.get(6)?,
                    deleted_at: row.get(7)?,
                    is_pinned: row.get(8)?,
                    ai_access: row.get::<_, i64>(9)?.clamp(0, 2),
                    enc_mode: row.get::<_, i64>(10)?.clamp(0, 2),
                    enc_tags: row.get(11)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.notes.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 历史版本同样是后加的表：老快照没有时按空数组处理
    if has_table(conn, "notes_history")
        && [
            "id",
            "note_id",
            "title",
            "content",
            "category_id",
            "is_pinned",
            "saved_at",
        ]
        .iter()
        .all(|column| has_column(conn, "notes_history", column))
    {
        let sql = format!(
            "SELECT id, note_id, title, content, category_id, is_pinned, {}, {}, saved_at
             FROM notes_history ORDER BY id",
            col("notes_history", "kind", "'auto'"),
            col("notes_history", "pinned", "0")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteHistoryRow {
                    id: row.get(0)?,
                    note_id: row_text(row, 1)?,
                    title: row.get(2)?,
                    content: row.get(3)?,
                    category_id: row_text_opt(row, 4)?,
                    is_pinned: row.get(5)?,
                    kind: normalize_history_kind(&row.get::<_, String>(6)?),
                    pinned: row.get(7)?,
                    saved_at: row.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.notes_history.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let sql = format!(
            "SELECT id, name, provider_type, api_base_url, api_key, {}, {}, {},
                    created_at, updated_at
             FROM ai_providers ORDER BY id",
            col("ai_providers", "api_path", "NULL"),
            col("ai_providers", "enabled_model", "NULL"),
            col("ai_providers", "enabled_models", "NULL")
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteProviderRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    provider_type: row.get(2)?,
                    api_base_url: row.get(3)?,
                    api_key: row.get(4)?,
                    api_path: row.get(5)?,
                    enabled_model: row.get(6)?,
                    enabled_models: row.get(7)?,
                    created_at: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.providers.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare(
                "SELECT id, title, provider_id, model, created_at, updated_at
                 FROM ai_chat_sessions ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteSessionRow {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    provider_id: row.get(2)?,
                    model: row.get(3)?,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.sessions.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare(
                "SELECT id, session_id, role, content, created_at
                 FROM ai_chat_messages ORDER BY id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteMessageRow {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    role: row.get(2)?,
                    content: row.get(3)?,
                    created_at: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.messages.push(row.map_err(|e| e.to_string())?);
        }
    }

    {
        let mut stmt = conn
            .prepare("SELECT key, value, updated_at FROM app_settings ORDER BY key")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteSettingRow {
                    key: row.get(0)?,
                    value: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.settings.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 标签是后加的功能：老快照没有这两张表时按空数组处理
    if has_table(conn, "tags")
        && ["id", "name", "source", "created_at"]
            .iter()
            .all(|column| has_column(conn, "tags", column))
    {
        let mut stmt = conn
            .prepare("SELECT id, name, source, created_at FROM tags ORDER BY id")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteTagRow {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    source: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.tags.push(row.map_err(|e| e.to_string())?);
        }
    }
    if has_table(conn, "note_tags")
        && ["note_id", "tag_id", "source", "created_at"]
            .iter()
            .all(|column| has_column(conn, "note_tags", column))
    {
        let mut stmt = conn
            .prepare(
                "SELECT note_id, tag_id, source, created_at
                 FROM note_tags ORDER BY note_id, tag_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteNoteTagRow {
                    note_id: row_text(row, 0)?,
                    tag_id: row.get(1)?,
                    source: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.note_tags.push(row.map_err(|e| e.to_string())?);
        }
    }

    // 加密容器备份才有的密钥包裹元数据；普通快照里这张表是空的
    if has_table(conn, "encrypted_keys")
        && ["scope", "ref_id", "meta_json", "created_at"]
            .iter()
            .all(|column| has_column(conn, "encrypted_keys", column))
    {
        let mut stmt = conn
            .prepare(
                "SELECT scope, ref_id, meta_json, created_at
                 FROM encrypted_keys ORDER BY scope, ref_id",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(SqliteEncryptedKeyRow {
                    scope: row.get(0)?,
                    ref_id: row_text(row, 1)?,
                    meta_json: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            out.encrypted_keys.push(row.map_err(|e| e.to_string())?);
        }
    }

    Ok(out)
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_sqlite_backup(app: AppHandle, state: State<AppState>, path: String) -> Result<BackupSummary, String> {
    /*
     * 整库替换会丢掉备份里没有的本地内容（加密笔记、密钥、根密码材料…）。
     * 所以先拍一张本地快照，恢复完再把缺的行补回来 —— 与 JSON 恢复同一套策略。
     */
    let preserve = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        LocalPreserve::capture(&conn, "sqlite")?
    };
    // 先把快照里的图片落地成文件，再覆盖数据库：这样「一个 .db 就完整恢复」成立
    restore_attachments_from_snapshot(&app, &std::path::PathBuf::from(&path))?;
    let mut summary = restore_sqlite_snapshot(&state, &std::path::PathBuf::from(&path), false)?;
    {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        summary.preserved = preserve.restore(&conn)?;
    }
    Ok(summary)
}

/// 从 .db 快照里取出图片字节并写到附件目录（`attachments.data` 有值才处理）。
///
/// 老快照没有 attachments 表或 data 列，直接返回 Ok：等价于「这次备份没有图片」。
pub(crate) fn restore_attachments_from_snapshot(app: &AppHandle, source: &Path) -> Result<(), String> {
    if !source.is_file() {
        return Ok(());
    }
    let snap = match Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY) {
        Ok(snap) => snap,
        Err(_) => return Ok(()),
    };
    if !has_table(&snap, "attachments") || !has_column(&snap, "attachments", "data") {
        return Ok(());
    }
    let mut stmt = snap
        .prepare("SELECT hash, ext, data FROM attachments WHERE data IS NOT NULL")
        .map_err(|e| format!("读取快照图片失败：{e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| format!("读取快照图片失败：{e}"))?;
    for row in rows.flatten() {
        let (hash, ext, data) = row;
        // 哈希格式异常的跳过，别让坏数据打断整次恢复
        if hash.len() < 3 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let rel = format!("attachments/{}/{hash}.{ext}", &hash[..2]);
        crate::attachments::restore_attachment(app, &rel, &data)?;
    }
    Ok(())
}

/// 用 SQLite 快照覆盖当前库。
/// `allow_encrypted` 只给加密容器恢复用：跳过「本地/备份含加密内容」两道拦截，
/// 并把 `enc_mode` / `enc_tags` / `encrypted_keys` / 根密码元数据一并写回。
pub(crate) fn restore_sqlite_snapshot(
    state: &State<AppState>,
    source: &Path,
    allow_encrypted: bool,
) -> Result<BackupSummary, String> {
    if !source.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let source_canonical =
        std::fs::canonicalize(source).map_err(|e| format!("读取备份文件失败：{e}"))?;

    let bak = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| format!("无法打开 SQLite 备份文件：{e}"))?;
    // 先做完整性检查，再读表结构；坏文件不进入覆盖流程
    let quick_check: String = bak
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|e| format!("无法校验 SQLite 备份文件：{e}"))?;
    if quick_check != "ok" {
        return Err("SQLite 备份文件已损坏，无法恢复".to_string());
    }
    let data = read_sqlite_backup(&bak)?;
    // 旧快照可能没有这两列，缺列即视为没有加密内容；密钥表有行同样说明是加密备份
    let backup_encrypted = {
        let count_where = |table: &str, column: &str| -> i64 {
            if !has_column(&bak, table, column) {
                return 0;
            }
            bak.query_row(
                &format!("SELECT COUNT(*) FROM {table} WHERE COALESCE({column}, 0) <> 0"),
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
        };
        let has_keys = has_table(&bak, "encrypted_keys")
            && bak
                .query_row("SELECT COUNT(*) FROM encrypted_keys", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0)
                > 0;
        count_where("notes", "enc_mode") + count_where("categories", "is_encrypted") > 0
            || has_keys
    };
    drop(bak);

    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    if conn
        .path()
        .and_then(|p| std::fs::canonicalize(p).ok())
        .map(|p| p == source_canonical)
        .unwrap_or(false)
    {
        return Err("不能用当前正在使用的数据库文件恢复".to_string());
    }

    // 覆盖式恢复会整体替换数据库：本地已有的加密项会连同密钥一起丢失，必须先拦住
    let local_encrypted: i64 = conn
        .query_row(
            "SELECT (SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0)
                  + (SELECT COUNT(*) FROM categories WHERE COALESCE(is_encrypted, 0) <> 0)",
            [],
            |row| row.get(0),
        )
        .unwrap_or(0);
    /*
     * 过去这里会拒绝「本地有加密内容」或「备份含加密内容」的恢复。现在不再拒绝：
     * 调用方（import_sqlite_backup / import_encrypted_backup）会在恢复前后做本地内容保全，
     * 把备份里没有的本地行（含加密笔记与密钥）补回来。`local_encrypted` / `backup_encrypted`
     * 仍保留计算，用于调试与将来的预检统计。
     */
    let _ = (local_encrypted, backup_encrypted, allow_encrypted);

    // 先记下本机现有的 Key 密文，供备份里没有可用 Key 时按「名称+类型+地址」接回
    let mut local_keys: std::collections::HashMap<(String, String, String), String> =
        std::collections::HashMap::new();
    {
        let mut stmt = conn
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

    // 快照里不含 WebDAV 密码与自动备份状态；先记下本机值，恢复完再接回去
    let local_only_settings = read_local_only_settings(&conn);

    // 加密操作需要不可变的 &Connection，必须在开启事务前算好最终密文
    let mut provider_keys: Vec<String> = Vec::with_capacity(data.providers.len());
    for p in &data.providers {
        let fallback = || {
            local_keys
                .get(&(
                    p.name.clone(),
                    p.provider_type.clone(),
                    p.api_base_url.clone(),
                ))
                .cloned()
                .unwrap_or_default()
        };
        if p.api_key.is_empty() {
            provider_keys.push(fallback());
        } else if is_encrypted(&p.api_key) {
            // 同机备份能用当前密钥解开：原样保留；解不开（换机/换用户）则沿用本机同名服务商的 Key
            if decrypt_secret(&conn, &p.api_key).is_ok() {
                provider_keys.push(p.api_key.clone());
            } else {
                provider_keys.push(fallback());
            }
        } else {
            provider_keys.push(encrypt_secret(&conn, &p.api_key)?);
        }
    }

    let tx = conn.transaction().map_err(|e| e.to_string())?;
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
        // 备份里的向量可能来自另一台机器/另一个模型，一律不用；恢复后交给 worker 重建。
        // 语义元数据同样清空，否则快照里的 model_id / dim / last_error 会盖住恢复后的真实状态
        "DELETE FROM note_chunks",
        "DELETE FROM note_index_state",
        "DELETE FROM semantic_meta",
        "DELETE FROM encrypted_keys",
    ] {
        tx.execute(sql, []).map_err(|e| e.to_string())?;
    }

    for c in &data.categories {
        tx.execute(
            "INSERT INTO categories (id, name, created_at, ai_access, is_encrypted)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                c.id,
                c.name,
                non_empty_or_now(c.created_at.clone()),
                c.ai_access,
                if c.is_encrypted != 0 { 1 } else { 0 }
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for n in &data.notes {
        tx.execute(
            "INSERT INTO notes (id, title, content, category_id, created_at, updated_at, is_deleted,
                                deleted_at, is_pinned, ai_access, enc_mode, enc_tags)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                &n.id,
                n.title,
                n.content,
                n.category_id,
                non_empty_or_now(n.created_at.clone()),
                non_empty_or_now(n.updated_at.clone()),
                if n.is_deleted != 0 { 1 } else { 0 },
                n.deleted_at,
                if n.is_pinned != 0 { 1 } else { 0 },
                n.ai_access,
                n.enc_mode,
                n.enc_tags
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for h in &data.notes_history {
        tx.execute(
            "INSERT INTO notes_history (id, note_id, title, content, category_id, is_pinned, kind,
                                        pinned, saved_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                h.id,
                &h.note_id,
                &h.title,
                &h.content,
                h.category_id,
                if h.is_pinned != 0 { 1 } else { 0 },
                normalize_history_kind(&h.kind),
                if h.pinned != 0 { 1 } else { 0 },
                non_empty_or_now(h.saved_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for (i, p) in data.providers.iter().enumerate() {
        let enabled_models = p
            .enabled_models
            .clone()
            .filter(|text| !text.trim().is_empty())
            .unwrap_or_else(|| "[]".to_string());
        tx.execute(
            "INSERT INTO ai_providers (id, name, provider_type, api_base_url, api_key, api_path,
                                       enabled_model, enabled_models, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                p.id,
                p.name,
                p.provider_type,
                p.api_base_url,
                provider_keys[i],
                p.api_path,
                p.enabled_model,
                enabled_models,
                non_empty_or_now(p.created_at.clone()),
                non_empty_or_now(p.updated_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in &data.sessions {
        tx.execute(
            "INSERT INTO ai_chat_sessions (id, title, provider_id, model, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                s.id,
                s.title,
                s.provider_id,
                s.model,
                non_empty_or_now(s.created_at.clone()),
                non_empty_or_now(s.updated_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for m in &data.messages {
        tx.execute(
            "INSERT INTO ai_chat_messages (id, session_id, role, content, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                m.id,
                m.session_id,
                m.role,
                m.content,
                non_empty_or_now(m.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for s in &data.settings {
        // 普通快照不导入外来的根密码元数据，避免覆盖本机 verifier；
        // 加密容器恢复是整库替换，根密码元数据必须一起回来，否则加密内容再也解不开
        if !allow_encrypted && s.key.starts_with("app.security.") {
            continue;
        }
        tx.execute(
            "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params![s.key, s.value, non_empty_or_now(s.updated_at.clone())],
        )
        .map_err(|e| e.to_string())?;
    }

    restore_local_only_settings(&tx, &local_only_settings)?;

    for t in &data.tags {
        tx.execute(
            "INSERT OR IGNORE INTO tags (id, name, source, created_at) VALUES (?1, ?2, ?3, ?4)",
            params![
                t.id,
                t.name,
                normalize_source(Some(t.source.clone())),
                non_empty_or_now(t.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for nt in &data.note_tags {
        tx.execute(
            "INSERT OR IGNORE INTO note_tags (note_id, tag_id, source, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &nt.note_id,
                nt.tag_id,
                normalize_source(Some(nt.source.clone())),
                non_empty_or_now(nt.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    for k in &data.encrypted_keys {
        tx.execute(
            "INSERT OR REPLACE INTO encrypted_keys (scope, ref_id, meta_json, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                k.scope,
                &k.ref_id,
                k.meta_json,
                non_empty_or_now(k.created_at.clone())
            ],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);
    // 库里的密钥元数据整个换了一批，内存里缓存的旧 DEK/KEK 全部作废
    if allow_encrypted {
        state.encryption.clear_all();
    }
    semantic::invalidate(&state.semantic);

    Ok(BackupSummary {
        notes: data.notes.len(),
        categories: data.categories.len(),
        providers: data.providers.len(),
        sessions: data.sessions.len(),
        messages: data.messages.len(),
        settings: data.settings.len(),
        skipped_encrypted: 0,
        preserved: 0,
        exported_at: data.exported_at,
    })
}

/* ---------------- 加密容器备份 ----------------
 * 整库 SQLite 快照（含加密笔记、encrypted_keys、根密码元数据）用**独立的备份口令**
 * 再包一层 Argon2id + AES-256-GCM，容器文件本身就是密文：
 *   FNBK1\n<json 头>\n<nonce‖密文‖tag>
 * 头部（含 KDF 参数与盐）同时作为 AAD，改一个字节都解不开。
 * 恢复时先解容器，再走 allow_encrypted 的整库替换；条目内容仍需各自的密码/根密码解锁。
 */

