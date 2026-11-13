use super::*;

pub(crate) const ENCRYPTED_BACKUP_MAGIC: &[u8] = b"FNBK1\n";

pub(crate) const ENCRYPTED_BACKUP_FORMAT: &str = "fastnote-encrypted-backup";

pub(crate) const ENCRYPTED_BACKUP_VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
pub struct EncryptedBackupHeader {
    format: String,
    version: u32,
    kdf: String,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    salt: String,
    created_at: String,
}

pub(crate) fn validate_backup_passphrase(passphrase: &str) -> Result<(), String> {
    let len = passphrase.chars().count();
    if len < 8 {
        return Err(json!({ "code": "backup_passphrase_too_short" }).to_string());
    }
    if len > 128 {
        return Err(json!({ "code": "backup_passphrase_too_long" }).to_string());
    }
    Ok(())
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn export_encrypted_backup(
    state: State<AppState>,
    path: String,
    passphrase: String,
    app: AppHandle,
) -> Result<BackupSummary, String> {
    validate_backup_passphrase(&passphrase)?;
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let exported_at = Local::now().to_rfc3339();
    let count = |sql: &str| -> usize {
        conn.query_row(sql, [], |row| row.get::<_, i64>(0))
            .unwrap_or(0) as usize
    };
    // 加密备份是整库快照：加密笔记也算在摘要里
    let summary = BackupSummary {
        notes: count("SELECT COUNT(*) FROM notes"),
        categories: count("SELECT COUNT(*) FROM categories"),
        providers: count_rows(&conn, "ai_providers"),
        sessions: count_rows(&conn, "ai_chat_sessions"),
        messages: count_rows(&conn, "ai_chat_messages"),
        settings: count("SELECT COUNT(*) FROM app_settings"),
        skipped_encrypted: 0,
        preserved: 0,
        exported_at: Some(exported_at.clone()),
    };

    let target = std::path::PathBuf::from(&path);
    let parent = target.parent().ok_or("备份路径不可用".to_string())?;
    let tmp_db = parent.join(format!(".fastnote-encdb-{}.tmp", std::process::id()));
    let tmp_out = parent.join(format!(".fastnote-encout-{}.tmp", std::process::id()));
    let _ = std::fs::remove_file(&tmp_db);
    let _ = std::fs::remove_file(&tmp_out);

    let result = (|| -> Result<(), String> {
        // 容器里保留 API Key / WebDAV 密文：文件本身已有口令保护，不额外裁剪
        build_sqlite_snapshot(&conn, &tmp_db, &app, &exported_at, true, true, true)?;
        let mut plain = std::fs::read(&tmp_db).map_err(|e| format!("读取数据库快照失败：{e}"))?;
        let _ = std::fs::remove_file(&tmp_db);

        let salt = crypto::random_salt();
        let header = EncryptedBackupHeader {
            format: ENCRYPTED_BACKUP_FORMAT.to_string(),
            version: ENCRYPTED_BACKUP_VERSION,
            kdf: crypto::KDF_ARGON2ID.to_string(),
            m_cost: crypto::ARGON2_M_COST,
            t_cost: crypto::ARGON2_T_COST,
            p_cost: crypto::ARGON2_P_COST,
            salt: crypto::hex_encode(&salt),
            created_at: exported_at.clone(),
        };
        let header_line = serde_json::to_string(&header).map_err(|e| e.to_string())?;
        let key = Zeroizing::new(crypto::derive_argon2id(
            &passphrase,
            &salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )?);
        // 头部当 AAD：盐或 KDF 参数被改过就解不开，避免降参数重算
        let sealed = crypto::seal_bytes(&key, header_line.as_bytes(), &plain)?;
        plain.zeroize();

        let mut out = Vec::with_capacity(ENCRYPTED_BACKUP_MAGIC.len() + header_line.len() + 1 + sealed.len());
        out.extend_from_slice(ENCRYPTED_BACKUP_MAGIC);
        out.extend_from_slice(header_line.as_bytes());
        out.push(b'\n');
        out.extend_from_slice(&sealed);
        std::fs::write(&tmp_out, &out).map_err(|e| format!("保存加密备份失败：{e}"))?;
        replace_backup_file(&tmp_out, &target)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&tmp_db);
        let _ = std::fs::remove_file(&tmp_out);
    }
    result?;
    Ok(summary)
}

/*
 * (async)：备份/恢复是重 IO（整库读写、VACUUM、图片编解码），同步命令会占着
 * IPC 线程把窗口一起卡住。交给 Tauri 的线程池跑，UI 不再冻结。
 */
#[tauri::command(async)]
pub fn import_encrypted_backup(
    app: AppHandle,
    state: State<AppState>,
    path: String,
    passphrase: String,
) -> Result<BackupSummary, String> {
    let source = std::path::PathBuf::from(&path);
    if !source.is_file() {
        return Err("备份文件不存在".to_string());
    }
    let raw = std::fs::read(&source).map_err(|e| format!("读取备份文件失败：{e}"))?;
    let rest = raw
        .strip_prefix(ENCRYPTED_BACKUP_MAGIC)
        .ok_or_else(|| json!({ "code": "not_encrypted_backup" }).to_string())?;
    let split = rest
        .iter()
        .position(|b| *b == b'\n')
        .ok_or_else(|| "备份文件头已损坏".to_string())?;
    let header_bytes = &rest[..split];
    let body = &rest[split + 1..];
    let header: EncryptedBackupHeader =
        serde_json::from_slice(header_bytes).map_err(|_| "备份文件头已损坏".to_string())?;
    if header.format != ENCRYPTED_BACKUP_FORMAT {
        return Err(json!({ "code": "not_encrypted_backup" }).to_string());
    }
    if header.version > ENCRYPTED_BACKUP_VERSION {
        return Err("备份由更新版本的 FastNote 创建，请先升级软件再恢复".to_string());
    }
    if header.kdf != crypto::KDF_ARGON2ID {
        return Err("不支持的备份加密算法".to_string());
    }
    let salt = crypto::hex_decode(&header.salt)?;
    let key = Zeroizing::new(crypto::derive_argon2id(
        &passphrase,
        &salt,
        header.m_cost,
        header.t_cost,
        header.p_cost,
    )?);
    // 口令错和文件被截断在这里是同一种失败：AES-GCM 校验不过
    let mut plain = crypto::open_bytes(&key, header_bytes, body)
        .map_err(|_| json!({ "code": "bad_backup_passphrase" }).to_string())?;

    let tmp = std::env::temp_dir().join(format!("fastnote-restore-{}.db", std::process::id()));
    let _ = std::fs::remove_file(&tmp);
    let write = std::fs::write(&tmp, &plain);
    plain.zeroize();
    write.map_err(|e| format!("写入临时文件失败：{e}"))?;

    // 加密备份同样带着图片字节（快照的 attachments.data），先落地成文件再覆盖数据库
    restore_attachments_from_snapshot(&app, &tmp)?;
    let result = restore_sqlite_snapshot(&state, &tmp, true);
    let _ = std::fs::remove_file(&tmp);
    result
}

/* ---------------- 分组导出（ZIP / 电子书） ----------------
 * 笔记正文是 Markdown 原文，导出 HTML / EPUB 时用 pulldown-cmark 渲染成网页。
 * 章节顺序统一为「按创建时间正序」：最早创建的笔记在前；章节名直接用笔记标题。
 */

