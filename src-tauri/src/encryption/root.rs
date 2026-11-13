use super::*;

/// 把一次已验证的根 KEK 放进会话缓存。
///
/// 用于「采纳备份的根密码材料」之后：库里已经是新的一套 KDF 参数，
/// 内存里如果还留着旧 KEK，本次会话解 `wrap_root` 会一直失败（重启才好）。
pub(crate) fn adopt_root_kek(state: &EncryptionState, kek: Zeroizing<[u8; 32]>) {
    state.set_root_cache(*kek);
}

/// 把一批 `wrap_root` 从旧根 KEK 重新包裹到新根 KEK。
///
/// 用于「恢复别人的备份」：备份里的 `wrap_root` 是**原设备根密码**包的，
/// 而本机根密码已经换过，直接用新密码解不开。这里用旧密码解开 DEK、
/// 再用本机 KEK 包回去，之后这批笔记就归本机根密码管了。
///
/// 注意只动 `wrap_root`：`wrap_item`（单元自己的密码）与正文密文都不碰，
/// 所以即使迁移中途失败，用笔记自己的密码仍然能打开。
pub(crate) fn migrate_wrap_root(
    conn: &Connection,
    old_kek: &[u8; 32],
    new_kek: &[u8; 32],
) -> Result<usize, String> {
    let items: Vec<(String, String, EncMeta)> = {
        let mut stmt = conn
            .prepare("SELECT scope, ref_id, meta_json FROM encrypted_keys")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for row in mapped.flatten() {
            let Ok(meta) = serde_json::from_str::<EncMeta>(&row.2) else {
                continue;
            };
            out.push((row.0, row.1, meta));
        }
        out
    };

    let mut migrated = 0usize;
    for (scope, id, mut meta) in items {
        let Some(wrap_root) = meta.wrap_root.clone() else {
            // 没有 wrap_root：这条只认单元密码，根密码本来就不管它
            continue;
        };
        let aad = wrap_aad("root", &scope, &id);
        let Ok(dek) = crypto::open(old_kek, &aad, &wrap_root) else {
            // 这条不是用这个旧密码包的（可能是别的来源），跳过而不是整体失败
            continue;
        };
        meta.wrap_root = Some(crypto::seal(new_kek, &aad, &dek)?);
        save_meta(conn, &scope, &id, &meta)?;
        migrated += 1;
    }
    Ok(migrated)
}

/// 用「原设备根密码 + 本机根密码」完成一次迁移，返回迁移条数。
pub(crate) fn migrate_root_from_backup(
    conn: &Connection,
    state: &EncryptionState,
    backup_params: &std::collections::HashMap<String, String>,
    old_password: &str,
    new_password: &str,
) -> Result<usize, String> {
    // 先验旧密码（只算不写）：错的密码绝不能让任何一行被改写
    let old_kek = verify_root_params(backup_params, old_password)?;
    // 本机 KEK：用户现输一次，同时把会话缓存点亮，后面打开笔记不用再输
    let new_kek = verify_root(conn, state, new_password)?;
    let migrated = migrate_wrap_root(conn, &old_kek, &new_kek)?;
    scrub(conn);
    Ok(migrated)
}

/// 用一份**外部**的根密码参数（来自备份文件，不是本机库）校验密码。
///
/// 换机恢复时要先证明用户知道原设备根密码，才谈得上采纳 keyring。
/// 这里刻意不碰本机库：算出来对不上就直接返回 root_bad_password，
/// 不会因为「拿别人的备份试密码」把本机的根密码状态搅乱。
pub(crate) fn verify_root_params(
    params: &std::collections::HashMap<String, String>,
    password: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    let salt_hex = params
        .get(ROOT_SALT_KEY)
        .cloned()
        .ok_or_else(|| err_code("root_not_set"))?;
    let verifier = params
        .get(ROOT_VERIFIER_KEY)
        .cloned()
        .ok_or_else(|| err_code("root_not_set"))?;
    let read_u32 = |key: &str| {
        params
            .get(key)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
    };
    let meta = RootMeta {
        kdf: params
            .get(ROOT_KDF_KEY)
            .cloned()
            .unwrap_or_else(|| crypto::KDF_PBKDF2.to_string()),
        salt: crypto::hex_decode(&salt_hex)?,
        iterations: params
            .get(ROOT_ITER_KEY)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(ITERATIONS),
        m_cost: read_u32(ROOT_M_COST_KEY),
        t_cost: read_u32(ROOT_T_COST_KEY),
        p_cost: read_u32(ROOT_P_COST_KEY),
        verifier,
    };
    let kek = meta.derive(password)?;
    let plain = crypto::open(&kek, ROOT_VERIFIER_AAD, &meta.verifier)
        .map_err(|_| err_code("root_bad_password"))?;
    if plain != crypto::ROOT_VERIFIER_PLAIN {
        return Err(err_code("root_bad_password"));
    }
    Ok(kek)
}

/// 把根密码的派生参数升级到当前推荐值。
/// 根 KEK 变了，所有 `wrap_root` 都要用旧 KEK 解开、用新 KEK 重新包一遍；
/// 这一步只需要 wrap_root 本身，不需要用户逐篇解锁。任一项失败就整体回滚，保持旧参数可用。
pub(crate) fn upgrade_root_kdf(
    conn: &Connection,
    password: &str,
    old_kek: &[u8; 32],
) -> Result<Option<Zeroizing<[u8; 32]>>, String> {
    let Some(meta) = read_root_meta(conn)? else {
        return Ok(None);
    };
    if meta.is_current_kdf() {
        return Ok(None);
    }
    let new_salt = crypto::random_salt();
    let new_kek = Zeroizing::new(crypto::derive_argon2id(
        password,
        &new_salt,
        crypto::ARGON2_M_COST,
        crypto::ARGON2_T_COST,
        crypto::ARGON2_P_COST,
    )?);
    let new_verifier = crypto::seal(&new_kek, ROOT_VERIFIER_AAD, crypto::ROOT_VERIFIER_PLAIN)?;

    conn.execute_batch("BEGIN IMMEDIATE").map_err(|e| e.to_string())?;
    let result: Result<(), String> = (|| {
        let rows: Vec<(String, String, String)> = {
            let mut stmt = conn
                .prepare("SELECT scope, ref_id, meta_json FROM encrypted_keys")
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| e.to_string())?;
            mapped
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        };
        for (scope, ref_id, raw) in rows {
            let mut item: EncMeta = serde_json::from_str(&raw).map_err(|_| "加密元数据已损坏".to_string())?;
            let Some(wrap_root) = item.wrap_root.clone() else {
                continue;
            };
            let aad = wrap_aad("root", &scope, &ref_id);
            let dek = dek_from_bytes(crypto::open(old_kek, &aad, &wrap_root)?)?;
            item.wrap_root = Some(crypto::seal(&new_kek, &aad, &dek[..])?);
            let updated = serde_json::to_string(&item).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE encrypted_keys SET meta_json = ?1 WHERE scope = ?2 AND ref_id = ?3",
                params![updated, &scope, &ref_id],
            )
            .map_err(|e| e.to_string())?;
        }
        write_setting(conn, ROOT_KDF_KEY, crypto::KDF_ARGON2ID)?;
        write_setting(conn, ROOT_M_COST_KEY, &crypto::ARGON2_M_COST.to_string())?;
        write_setting(conn, ROOT_T_COST_KEY, &crypto::ARGON2_T_COST.to_string())?;
        write_setting(conn, ROOT_P_COST_KEY, &crypto::ARGON2_P_COST.to_string())?;
        write_setting(conn, ROOT_SALT_KEY, &crypto::hex_encode(&new_salt))?;
        write_setting(conn, ROOT_ITER_KEY, &ITERATIONS.to_string())?;
        write_setting(conn, ROOT_VERIFIER_KEY, &new_verifier)?;
        Ok(())
    })();
    match result {
        Ok(()) => {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            Ok(Some(new_kek))
        }
        Err(error) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}


pub(crate) fn root_cooldown_error(until: Instant) -> String {
    let secs = until
        .saturating_duration_since(Instant::now())
        .as_secs()
        .max(1);
    json!({ "code": "root_bad_password", "cooldown_seconds": secs }).to_string()
}

/// 校验根密码并缓存 KEK。失败计入全局冷却；成功清零。
pub(crate) fn verify_root(
    conn: &Connection,
    state: &EncryptionState,
    password: &str,
) -> Result<Zeroizing<[u8; 32]>, String> {
    {
        let mut fail = state.root_fail.lock().unwrap();
        if let Some(until) = fail.until {
            if Instant::now() < until {
                return Err(root_cooldown_error(until));
            }
            fail.until = None;
            fail.count = 0;
        }
    }
    let result = root_kek_from_password(conn, password);
    match result {
        Ok(kek) => {
            let mut fail = state.root_fail.lock().unwrap();
            fail.count = 0;
            fail.until = None;
            drop(fail);
            // 顺手把旧的 PBKDF2 根密钥升级成 Argon2id；失败就用旧 KEK 继续，下次再试
            let kek = match upgrade_root_kdf(conn, password, &kek) {
                Ok(Some(upgraded)) => upgraded,
                _ => kek,
            };
            state.set_root_cache(*kek);
            Ok(kek)
        }
        Err(error) => {
            if error == err_code("root_not_set") {
                return Err(error);
            }
            let mut fail = state.root_fail.lock().unwrap();
            fail.count += 1;
            if fail.count >= ROOT_FAIL_LIMIT {
                fail.count = 0;
                fail.until = Some(Instant::now() + Duration::from_secs(ROOT_COOLDOWN_SECS));
                return Err(json!({
                    "code": "root_bad_password",
                    "cooldown_seconds": ROOT_COOLDOWN_SECS,
                })
                .to_string());
            }
            Err(json!({ "code": "root_bad_password", "cooldown_seconds": 0 }).to_string())
        }
    }
}

/// 加密新内容时取根 KEK：优先用本次运行已缓存的，其次要求用户重新输入。
pub(crate) fn root_kek_for_encrypt(
    conn: &Connection,
    state: &EncryptionState,
    provided: Option<&str>,
) -> Result<Zeroizing<[u8; 32]>, String> {
    if let Some(password) = provided {
        return verify_root(conn, state, password);
    }
    state
        .cached_root()
        .ok_or_else(|| err_code("root_locked"))
}

#[tauri::command(async)]
pub fn set_root_password(password: String, state: State<AppState>) -> Result<Value, String> {
    validate_password(&password)?;
    let mut conn = state.conn.lock().unwrap();
    if read_root_meta(&conn)?.is_some() {
        return Err(err_code("root_already_set"));
    }
    let salt = crypto::random_salt();
    let kek = Zeroizing::new(crypto::derive_argon2id(
        &password,
        &salt,
        crypto::ARGON2_M_COST,
        crypto::ARGON2_T_COST,
        crypto::ARGON2_P_COST,
    )?);
    let verifier = crypto::seal(&kek, ROOT_VERIFIER_AAD, crypto::ROOT_VERIFIER_PLAIN)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    write_setting(&tx, ROOT_SALT_KEY, &crypto::hex_encode(&salt))?;
    write_setting(&tx, ROOT_ITER_KEY, &ITERATIONS.to_string())?;
    write_setting(&tx, ROOT_KDF_KEY, crypto::KDF_ARGON2ID)?;
    write_setting(&tx, ROOT_M_COST_KEY, &crypto::ARGON2_M_COST.to_string())?;
    write_setting(&tx, ROOT_T_COST_KEY, &crypto::ARGON2_T_COST.to_string())?;
    write_setting(&tx, ROOT_P_COST_KEY, &crypto::ARGON2_P_COST.to_string())?;
    write_setting(&tx, ROOT_VERIFIER_KEY, &verifier)?;

    // 根密码元数据丢失后重新设置：旧 wrap_root 已无法解开，清掉以免假称可用。
    let mut orphans = 0i64;
    let rows: Vec<(i64, String, String, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, scope, ref_id, meta_json FROM encrypted_keys")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };
    for (row_id, _scope, _ref_id, raw) in rows {
        let Ok(mut meta) = serde_json::from_str::<EncMeta>(&raw) else {
            continue;
        };
        if meta.wrap_root.is_some() {
            meta.wrap_root = None;
            let raw = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE encrypted_keys SET meta_json = ?1 WHERE id = ?2",
                params![raw, row_id],
            )
            .map_err(|e| e.to_string())?;
            orphans += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    state.encryption.set_root_cache(*kek);
    drop(conn);
    // 重新设置根密码不应该阻塞界面去做全库 VACUUM；这里只清 WAL。
    Ok(json!({ "rewrapped": 0, "orphans": orphans }))
}

#[tauri::command(async)]
pub fn unlock_root(password: String, state: State<AppState>) -> Result<Value, String> {
    let conn = state.conn.lock().unwrap();
    verify_root(&conn, &state.encryption, &password)?;
    Ok(json!({ "ok": true }))
}

#[tauri::command(async)]
pub fn change_root_password(
    old_password: String,
    new_password: String,
    state: State<AppState>,
) -> Result<Value, String> {
    validate_password(&new_password)?;
    let mut conn = state.conn.lock().unwrap();
    let old_kek = verify_root(&conn, &state.encryption, &old_password)?;
    if read_root_meta(&conn)?.is_none() {
        return Err(err_code("root_not_set"));
    }
    let new_salt = crypto::random_salt();
    let new_kek = Zeroizing::new(crypto::derive_argon2id(
        &new_password,
        &new_salt,
        crypto::ARGON2_M_COST,
        crypto::ARGON2_T_COST,
        crypto::ARGON2_P_COST,
    )?);
    let new_verifier = crypto::seal(&new_kek, ROOT_VERIFIER_AAD, crypto::ROOT_VERIFIER_PLAIN)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, String)> = {
        let mut stmt = tx
            .prepare("SELECT scope, ref_id, meta_json FROM encrypted_keys")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut rewrapped = 0i64;
    let mut skipped = 0i64;
    for (scope, ref_id, raw) in rows {
        let Ok(mut meta) = serde_json::from_str::<EncMeta>(&raw) else {
            skipped += 1;
            continue;
        };
        let Some(wrap_root) = meta.wrap_root.clone() else {
            skipped += 1;
            continue;
        };
        let aad = wrap_aad("root", &scope, &ref_id);
        let dek = dek_from_bytes(
            crypto::open(&old_kek, &aad, &wrap_root)
                .map_err(|_| "根密码已变化，无法重新绑定该加密项".to_string())?,
        )?;
        meta.wrap_root = Some(crypto::seal(&new_kek, &aad, &dek[..])?);
        let updated = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE encrypted_keys SET meta_json = ?1 WHERE scope = ?2 AND ref_id = ?3",
            params![updated, &scope, &ref_id],
        )
        .map_err(|e| e.to_string())?;
        rewrapped += 1;
    }

    write_setting(&tx, ROOT_SALT_KEY, &crypto::hex_encode(&new_salt))?;
    write_setting(&tx, ROOT_ITER_KEY, &ITERATIONS.to_string())?;
    write_setting(&tx, ROOT_KDF_KEY, crypto::KDF_ARGON2ID)?;
    write_setting(&tx, ROOT_M_COST_KEY, &crypto::ARGON2_M_COST.to_string())?;
    write_setting(&tx, ROOT_T_COST_KEY, &crypto::ARGON2_T_COST.to_string())?;
    write_setting(&tx, ROOT_P_COST_KEY, &crypto::ARGON2_P_COST.to_string())?;
    write_setting(&tx, ROOT_VERIFIER_KEY, &new_verifier)?;
    tx.commit().map_err(|e| e.to_string())?;
    state.encryption.set_root_cache(*new_kek);
    Ok(json!({ "rewrapped": rewrapped, "skipped": skipped }))
}

/* ---------------- 行查询 ---------------- */

