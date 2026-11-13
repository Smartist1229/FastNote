use super::*;

/// 备份里的图片条目：只带「被引用到的」（正文 + 历史快照），base64 内联。
///
/// 为什么内联而不是旁边放一个附件包：备份的价值是「一个文件拿去就能完整恢复」。
/// 伴生文件丢一次就变成「笔记还在、图全没了」，而且用户很难第一时间察觉。
pub(crate) fn attachment_backup_entries(
    conn: &Connection,
    app: &AppHandle,
    notes: &[Value],
    history: &[Value],
) -> Vec<Value> {
    /// attachments/xx/<hash>.<ext> → hash
    fn hash_of(path: &str) -> &str {
        path.rsplit('/')
            .next()
            .unwrap_or_default()
            .split('.')
            .next()
            .unwrap_or_default()
    }

    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for item in notes.iter().chain(history.iter()) {
        let content = json_str(item, "content");
        for path in crate::attachments::collect_attachment_paths(&content) {
            if !seen.insert(path.clone()) {
                continue;
            }
            let Some(bytes) = crate::attachments::read_attachment_bytes(app, &path) else {
                continue;
            };
            // 宽高跟着一起备份：恢复后不用重新测，预览能立刻按比例占位
            let (width, height): (i64, i64) = conn
                .query_row(
                    "SELECT width, height FROM attachments WHERE hash = ?1",
                    params![hash_of(&path)],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap_or((0, 0));
            out.push(json!({
                "path": path,
                "mime": crate::attachments::mime_of_attachment(&path),
                "width": width,
                "height": height,
                "data": crate::attachments::base64_encode(&bytes),
            }));
        }
    }
    out
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_backup(
    state: State<AppState>,
    path: String,
    include_api_keys: bool,
    include_webdav: bool,
    // 图片是否内联进 JSON。WebDAV 场景体积敏感，可以关掉（默认带）
    include_attachments: Option<bool>,
    // 根密码材料是否随包走。关掉后这份备份只能在本机恢复（默认带）
    include_root_key: Option<bool>,
    /*
     * 只备份笔记：导入端要用的东西（分组、标签、密钥环、加密笔记的密文）全带，
     * 其余一律不进包 —— 历史版本、图片、AI 对话、服务商、全部设置。
     *
     * 云备份之所以需要它：历史快照动辄几百 MB，加上 base64 图片，一份 JSON 上到 GB 级，
     * 很多 WebDAV 服务对单文件有硬上限，直接 413 / 507。默认关（普通导出要完整）。
     */
    notes_only: Option<bool>,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    let notes_only = notes_only.unwrap_or(false);
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let categories = query_rows(
        &conn,
        // 加密分组也导出：备份要完整，能不能读取决于有没有原根密码
        "SELECT id, name, created_at, ai_access, COALESCE(is_encrypted, 0) FROM categories ORDER BY id",
        |row| {
            Ok(json!({
                "id": row_text(row, 0)?,
                "name": row.get::<_, String>(1)?,
                "created_at": row.get::<_, String>(2)?,
                "ai_access": row.get::<_, i64>(3)?.clamp(0, 2),
                "is_encrypted": row.get::<_, i64>(4)? != 0,
            }))
        },
    )?;

    let notes = query_rows(
        &conn,
        // 加密笔记以**密文**导出（content 本身就是密文），id 必须原样保留：
        // 密文与 DEK 的 AAD 里都拼了它，换 id 就永久解不开。
        "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at,
                is_pinned, ai_access, COALESCE(enc_mode, 0), enc_tags
         FROM notes ORDER BY id",
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

    // 默认不查 api_key 列：备份文件里不含密钥。
    // 勾选「备份 API Key」时再单独取出并解密，合并成明文写进备份。
    // 只备份笔记时不带服务商配置，连查都不用查。
    let mut providers = if notes_only {
        Vec::new()
    } else {
        query_rows(
            &conn,
            "SELECT id, name, provider_type, api_base_url, api_path, enabled_model, enabled_models,
                    created_at, updated_at
             FROM ai_providers ORDER BY id",
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
        )?
    };

    if include_api_keys && !notes_only {
        let mut stmt = conn
            .prepare("SELECT id, api_key FROM ai_providers")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?;
        let mut plain_keys: std::collections::HashMap<i64, String> =
            std::collections::HashMap::new();
        for (id, stored) in rows.flatten() {
            // 解不开（例如换了机器/用户）就留空，不因一条 Key 让整次导出失败
            let plain = if stored.is_empty() {
                String::new()
            } else {
                decrypt_secret(&conn, &stored).unwrap_or_default()
            };
            plain_keys.insert(id, plain);
        }
        for p in providers.iter_mut() {
            if let Some(obj) = p.as_object_mut() {
                let id = obj.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
                obj.insert(
                    "api_key".to_string(),
                    json!(plain_keys.get(&id).cloned().unwrap_or_default()),
                );
            }
        }
    }

    let sessions = if notes_only {
        Vec::new()
    } else {
        query_rows(
            &conn,
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
        )?
    };

    let messages = if notes_only {
        Vec::new()
    } else {
        query_rows(
            &conn,
            "SELECT id, session_id, role, content, created_at
             FROM ai_chat_messages ORDER BY id",
            |row| {
                Ok(json!({
                    "id": row.get::<_, i64>(0)?,
                    "session_id": row.get::<_, i64>(1)?,
                    "role": row.get::<_, String>(2)?,
                    "content": row.get::<_, String>(3)?,
                    "created_at": row.get::<_, String>(4)?,
                }))
            },
        )?
    };

    /*
     * 本机专属设置默认不进备份：未勾选 WebDAV 时整组 webdav.* 都排除；
     * 勾选后仍只排除自动备份运行状态，密码会在下面解密成明文写进 JSON（换机可直接恢复）。
     *
     * app.security.*（根密码材料）由 `include_root_key` 单独控制：
     * 带上它，换机后输入原根密码就能解；不带，包里就没有可离线爆破的 verifier，
     * 但这份备份也只能在本机恢复。
     *
     * 「只备份笔记」时整组设置都不查：里面既有本机主题/编辑器现状，
     * 「只备份笔记」时设置里**只保留根密码材料**（app.security.*，几百字节）：
     * 加密笔记的密文在包里，没有这份 wrap_root，换机后一把根密码也解不开。
     * 其余的设置项（主题、编辑器、服务商、WebDAV…）与「恢复笔记」无关，整组不进包。
     */
    let settings_sql = {
        let mut sql =
            String::from("SELECT key, value, updated_at FROM app_settings WHERE 1 = 1");
        if include_webdav {
            sql.push_str(
                " AND key NOT IN ('webdav.lastAutoBackupAt', 'webdav.lastAutoAttemptAt',
                                  'webdav.lastAutoError', 'webdav.lastAutoFile')",
            );
        } else {
            sql.push_str(" AND key NOT LIKE 'webdav.%'");
        }
        if !include_root_key.unwrap_or(true) {
            sql.push_str(" AND key NOT LIKE 'app.security.%'");
        }
        sql.push_str(" ORDER BY key");
        sql
    };
    let settings_map = |row: &rusqlite::Row| {
        Ok(json!({
            "key": row.get::<_, String>(0)?,
            "value": row.get::<_, String>(1)?,
            "updated_at": row.get::<_, String>(2)?,
        }))
    };
    let mut settings = if notes_only {
        if include_root_key.unwrap_or(true) {
            query_rows(
                &conn,
                "SELECT key, value, updated_at FROM app_settings
                 WHERE key LIKE 'app.security.%' ORDER BY key",
                settings_map,
            )?
        } else {
            Vec::new()
        }
    } else {
        query_rows(&conn, &settings_sql, settings_map)?
    };

    if include_webdav && !notes_only {
        for setting in settings.iter_mut() {
            if setting.get("key").and_then(|v| v.as_str()) != Some("webdav.password") {
                continue;
            }
            let stored = json_str(setting, "value");
            if stored.is_empty() {
                continue;
            }
            // 解不开（换了机器/用户）就留空，不因一条密码让整次导出失败
            let plain = decrypt_secret(&conn, &stored).unwrap_or_default();
            if let Some(obj) = setting.as_object_mut() {
                obj.insert("value".to_string(), json!(plain));
            }
        }
    }

    // 标签与其关联单独成表导出：笔记是被恢复的，标签如果不在备份里，恢复后就只剩"没打标签的笔记"
    let tags = query_rows(
        &conn,
        "SELECT id, name, source, created_at FROM tags ORDER BY id",
        |row| {
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "name": row.get::<_, String>(1)?,
                "source": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let note_tags = query_rows(
        &conn,
        "SELECT note_id, tag_id, source, created_at FROM note_tags
         ORDER BY note_id, tag_id",
        |row| {
            Ok(json!({
                "note_id": row.get::<_, String>(0)?,
                "tag_id": row.get::<_, i64>(1)?,
                "source": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    // 历史版本是备份体积的头号来源（每篇笔记的每一版全文都在里面），
    // 「只备份笔记」时整表跳过 —— 恢复后丢的是可回滚的旧版本，不是笔记本身。
    let notes_history = if notes_only {
        Vec::new()
    } else {
        query_rows(
            &conn,
            "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
             FROM notes_history
             ORDER BY id",
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
    };

    // 加密单元的密钥（包裹后的 DEK）：随包走，否则加密笔记无法恢复
    let encrypted_keys = query_rows(
        &conn,
        "SELECT scope, ref_id, meta_json, created_at FROM encrypted_keys ORDER BY scope, ref_id",
        |row| {
            Ok(json!({
                "scope": row.get::<_, String>(0)?,
                "ref_id": row.get::<_, String>(1)?,
                "meta_json": row.get::<_, String>(2)?,
                "created_at": row.get::<_, String>(3)?,
            }))
        },
    )?;

    let exported_at = Local::now().to_rfc3339();
    let skipped_encrypted = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE COALESCE(enc_mode, 0) <> 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0) as usize;
    let summary = BackupSummary {
        notes: notes.len(),
        categories: categories.len(),
        providers: providers.len(),
        sessions: sessions.len(),
        messages: messages.len(),
        settings: settings.len(),
        skipped_encrypted,
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let doc = json!({
        "format": BACKUP_FORMAT,
        "version": BACKUP_VERSION,
        "app_version": app.package_info().version.to_string(),
        "exported_at": exported_at,
        "data": {
            "categories": categories,
            "notes": notes,
            "providers": providers,
            "sessions": sessions,
            "messages": messages,
            "settings": settings,
            "tags": tags,
            "note_tags": note_tags,
            "notes_history": notes_history,
            // 密钥环：包裹后的 DEK（每单元一条）。没有它，带回来的密文就是永远打不开的死壳
            "encrypted_keys": encrypted_keys,
            // 图片以 base64 内联：单个 JSON 就能完整恢复，用户不用手动搬 attachments 目录
            "attachments": if include_attachments.unwrap_or(true) && !notes_only {
                attachment_backup_entries(&conn, &app, &notes, &notes_history)
            } else {
                Vec::new()
            },
        }
    });

    // `.gz` 结尾的写压缩：JSON 里全是重复的键名与中文正文，deflate 后通常只剩 1/5~1/10，
    // 直接决定一份备份能不能塞进 WebDAV 服务的单文件上限。
    // 压缩后再 pretty 没有意义（还白白多生成一份大字符串），所以走紧凑序列化。
    // 直接序列化进文件（`.gz` 紧凑、明文 pretty），不再先 to_string
    write_backup_json(&path, &doc)?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    // 体积进日志：用户说「备份怎么这么大/这么小」时，这是第一个要看的数据
    crate::log_info!(
        "exported backup {path} ({} notes, {:.1} MB, notes_only={notes_only})",
        summary.notes,
        size as f64 / 1_048_576.0
    );
    Ok(summary)
}

/// 备份文件按扩展名决定是否压缩（云端 / 自动备份写 `.gz`）
pub(crate) fn is_gzip_path(path: &str) -> bool {
    path.to_ascii_lowercase().ends_with(".gz")
}

/// 备份落盘的唯一出口：**先写同目录的 `.part`，落盘后再 rename**。
///
/// 直接写目标路径有两个致命窗口：
/// 1. 写到一半断电 / 磁盘满 / 进程被杀 → 目标路径留下半截文件；
/// 2. `File::create` 是「先清空再写」，所以同名旧备份会在开写那一刻就蒸发，
///    失败后两头空 —— 恢复前的安全快照（`fastnote-safety-`）最怕这个。
///
/// rename 在同一文件系统内是原子的：目标要么是完整的旧文件，要么是完整的新文件。
/// 因此 `.part` **必须与目标同目录**：跨盘 rename 在 Windows 上直接失败。
pub(crate) fn write_backup_atomic(
    path: &str,
    write: impl FnOnce(&mut dyn std::io::Write) -> Result<(), String>,
) -> Result<(), String> {
    let failed = |e: std::io::Error| format!("写入备份文件失败：{e}");
    let target = std::path::Path::new(path);
    let dir = target
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("backup");
    let temp = dir.join(format!(".{name}.{}.part", std::process::id()));

    let outcome = (|| -> Result<(), String> {
        let file = std::fs::File::create(&temp).map_err(failed)?;
        let mut buffered = std::io::BufWriter::new(file);
        if is_gzip_path(path) {
            // 6 级：文本上比 9 级只多几个百分点，快一倍以上
            let mut encoder = flate2::write::GzEncoder::new(
                &mut buffered,
                flate2::Compression::new(6),
            );
            write(&mut encoder)?;
            encoder.finish().map_err(failed)?;
        } else {
            write(&mut buffered)?;
        }
        /*
         * 先 flush 再 sync_all：rename 只保证**目录项**原子，不保证数据已经落盘。
         * 少了这句，断电后可能得到「文件名对、内容为空」——比半截文件更难查。
         */
        let file = buffered.into_inner().map_err(|e| failed(e.into_error()))?;
        file.sync_all().map_err(failed)?;
        Ok(())
    })();

    if let Err(error) = outcome {
        let _ = std::fs::remove_file(&temp);
        return Err(error);
    }
    std::fs::rename(&temp, target).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("替换备份文件失败：{e}")
    })
}

/// 写备份文件（JSON 版）：**直接序列化进目标流**，不再先拼出一份完整字符串。
///
/// 一份 300 MB 的备份，`to_string` 会再复制一份（连同 `Value` 树，峰值能摸到 1 GB），
/// 走 `to_writer` 只占序列化缓冲。压缩备份用紧凑格式——pretty 在 gzip 之后没有意义。
pub(crate) fn write_backup_json<T: Serialize>(path: &str, doc: &T) -> Result<(), String> {
    let pretty = !is_gzip_path(path);
    write_backup_atomic(path, |w| {
        let failed = |e: serde_json::Error| format!("序列化备份失败：{e}");
        if pretty {
            serde_json::to_writer_pretty(w, doc)
        } else {
            serde_json::to_writer(w, doc)
        }
        .map_err(failed)
    })
}

/// 读备份文件：按内容魔数判断是否 gzip，老的明文 JSON 备份照样能读
pub(crate) fn read_backup_text(path: &str) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读取备份文件失败：{e}"))?;
    backup_text_from_bytes(&bytes)
}

/// 字节流 → JSON 文本（gzip 或明文都由它统一收口）
pub(crate) fn backup_text_from_bytes(bytes: &[u8]) -> Result<String, String> {
    use std::io::Read;
    if bytes.starts_with(&[0x1f, 0x8b]) {
        let mut out = String::new();
        flate2::read::GzDecoder::new(bytes)
            .read_to_string(&mut out)
            .map_err(|e| format!("解压备份文件失败：{e}"))?;
        return Ok(out);
    }
    String::from_utf8(bytes.to_vec()).map_err(|_| "备份文件不是合法的 JSON".to_string())
}

