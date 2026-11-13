use super::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct EncMeta {
    pub(crate) v: u32,
    /// 派生产法：`pbkdf2-sha256`（旧版）或 `argon2id`。早期数据没有该字段。
    #[serde(default = "meta_default_kdf")]
    pub(crate) kdf: String,
    pub(crate) salt: String,
    #[serde(default = "meta_default_iterations")]
    pub(crate) iterations: u32,
    #[serde(default)]
    pub(crate) m_cost: Option<u32>,
    #[serde(default)]
    pub(crate) t_cost: Option<u32>,
    #[serde(default)]
    pub(crate) p_cost: Option<u32>,
    pub(crate) wrap_item: String,
    #[serde(default)]
    pub(crate) wrap_root: Option<String>,
    #[serde(default)]
    pub(crate) hint: Option<String>,
    pub(crate) created_at: String,
}

pub(crate) fn meta_default_kdf() -> String {
    crypto::KDF_PBKDF2.to_string()
}

pub(crate) fn meta_default_iterations() -> u32 {
    ITERATIONS
}

impl EncMeta {
    /// 是否已经用当前推荐的派生参数（不是就需要在输对密码后顺手升级）
    pub(crate) fn is_current_kdf(&self) -> bool {
        self.kdf == crypto::KDF_ARGON2ID
            && self.m_cost.unwrap_or(0) >= crypto::ARGON2_M_COST
            && self.t_cost.unwrap_or(0) >= crypto::ARGON2_T_COST
            && self.p_cost.unwrap_or(0) >= crypto::ARGON2_P_COST
    }

    pub(crate) fn derive_item_key(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
        let salt = crypto::hex_decode(&self.salt)?;
        if self.kdf == crypto::KDF_ARGON2ID {
            Ok(Zeroizing::new(crypto::derive_argon2id(
                password,
                &salt,
                self.m_cost.unwrap_or(crypto::ARGON2_M_COST),
                self.t_cost.unwrap_or(crypto::ARGON2_T_COST),
                self.p_cost.unwrap_or(crypto::ARGON2_P_COST),
            )?))
        } else {
            Ok(Zeroizing::new(crypto::derive_key(
                password,
                &salt,
                self.iterations,
            )))
        }
    }

    /// 用当前参数重新包裹同一把 DEK：换盐、换派生算法，正文与 wrap_root 都不动。
    pub(crate) fn rewrap_item(
        &mut self,
        password: &str,
        dek: &[u8; 32],
        scope: &str,
        id: &str,
    ) -> Result<(), String> {
        let salt = crypto::random_salt();
        let ik = Zeroizing::new(crypto::derive_argon2id(
            password,
            &salt,
            crypto::ARGON2_M_COST,
            crypto::ARGON2_T_COST,
            crypto::ARGON2_P_COST,
        )?);
        self.v = 2;
        self.kdf = crypto::KDF_ARGON2ID.to_string();
        self.salt = crypto::hex_encode(&salt);
        self.iterations = ITERATIONS;
        self.m_cost = Some(crypto::ARGON2_M_COST);
        self.t_cost = Some(crypto::ARGON2_T_COST);
        self.p_cost = Some(crypto::ARGON2_P_COST);
        self.wrap_item = crypto::seal(&ik, &wrap_aad("item", scope, id), dek)?;
        Ok(())
    }
}

/// 新建加密项：条目密码与根密码各包裹一次 DEK。
pub(crate) fn new_meta(
    password: &str,
    dek: &[u8; 32],
    root_kek: &[u8; 32],
    scope: &str,
    id: &str,
    hint: Option<String>,
) -> Result<EncMeta, String> {
    let mut meta = EncMeta {
        v: 2,
        kdf: crypto::KDF_ARGON2ID.to_string(),
        salt: String::new(),
        iterations: ITERATIONS,
        m_cost: Some(crypto::ARGON2_M_COST),
        t_cost: Some(crypto::ARGON2_T_COST),
        p_cost: Some(crypto::ARGON2_P_COST),
        wrap_item: String::new(),
        wrap_root: Some(crypto::seal(root_kek, &wrap_aad("root", scope, id), dek)?),
        hint: clean_hint(hint),
        created_at: now(),
    };
    meta.rewrap_item(password, dek, scope, id)?;
    Ok(meta)
}

#[derive(Serialize, Deserialize)]
pub(crate) struct TagSnap {
    pub(crate) name: String,
    pub(crate) source: String,
    pub(crate) created_at: String,
}

pub(crate) struct RootMeta {
    pub(crate) kdf: String,
    pub(crate) salt: Vec<u8>,
    pub(crate) iterations: u32,
    pub(crate) m_cost: u32,
    pub(crate) t_cost: u32,
    pub(crate) p_cost: u32,
    pub(crate) verifier: String,
}

impl RootMeta {
    pub(crate) fn is_current_kdf(&self) -> bool {
        self.kdf == crypto::KDF_ARGON2ID
            && self.m_cost >= crypto::ARGON2_M_COST
            && self.t_cost >= crypto::ARGON2_T_COST
            && self.p_cost >= crypto::ARGON2_P_COST
    }

    pub(crate) fn derive(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
        if self.kdf == crypto::KDF_ARGON2ID {
            Ok(Zeroizing::new(crypto::derive_argon2id(
                password,
                &self.salt,
                self.m_cost,
                self.t_cost,
                self.p_cost,
            )?))
        } else {
            Ok(Zeroizing::new(crypto::derive_key(
                password,
                &self.salt,
                self.iterations,
            )))
        }
    }
}

pub(crate) fn now() -> String {
    Local::now().to_rfc3339()
}

pub(crate) fn err_code(code: &str) -> String {
    json!({ "code": code }).to_string()
}

pub(crate) fn bad_password(attempts: u32) -> String {
    json!({
        "code": "bad_password",
        "attempts": attempts,
        "root_allowed": attempts >= ROOT_FALLBACK_AFTER,
    })
    .to_string()
}

pub(crate) fn validate_password(password: &str) -> Result<(), String> {
    let len = password.chars().count();
    if len < 8 {
        return Err(err_code("password_too_short"));
    }
    if len > 128 {
        return Err(err_code("password_too_long"));
    }
    Ok(())
}

pub(crate) fn parse_unlock_scope(scope: &str) -> Result<UnlockScope, String> {
    match scope {
        "once" => Ok(UnlockScope::Once),
        "session" => Ok(UnlockScope::Session),
        // 未知取值不再默认成 session：宁可报错，也不让调用方以为「仅本次」生效
        _ => Err(err_code("invalid_scope")),
    }
}

pub(crate) fn note_aad(note_id: &str, field: &str) -> Vec<u8> {
    format!("fastnote|v1|note|{note_id}|{field}").into_bytes()
}

pub(crate) fn wrap_aad(kind: &str, scope: &str, id: &str) -> Vec<u8> {
    format!("fastnote|v1|wrap|{kind}|{scope}|{id}").into_bytes()
}

pub(crate) fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

pub(crate) fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn read_root_meta(conn: &Connection) -> Result<Option<RootMeta>, String> {
    let Some(salt_hex) = read_setting(conn, ROOT_SALT_KEY) else {
        return Ok(None);
    };
    let Some(verifier) = read_setting(conn, ROOT_VERIFIER_KEY) else {
        return Ok(None);
    };
    let salt = crypto::hex_decode(&salt_hex)?;
    let read_u32 = |key: &str| {
        read_setting(conn, key)
            .and_then(|v| v.parse::<u32>().ok())
            .unwrap_or(0)
    };
    let kdf = read_setting(conn, ROOT_KDF_KEY).unwrap_or_else(|| crypto::KDF_PBKDF2.to_string());
    let iterations = read_setting(conn, ROOT_ITER_KEY)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(ITERATIONS);
    Ok(Some(RootMeta {
        kdf,
        salt,
        iterations,
        m_cost: read_u32(ROOT_M_COST_KEY),
        t_cost: read_u32(ROOT_T_COST_KEY),
        p_cost: read_u32(ROOT_P_COST_KEY),
        verifier,
    }))
}

pub(crate) fn root_kek_from_password(conn: &Connection, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let meta = read_root_meta(conn)?.ok_or_else(|| err_code("root_not_set"))?;
    let kek = meta.derive(password)?;
    let plain = crypto::open(&kek, ROOT_VERIFIER_AAD, &meta.verifier)
        .map_err(|_| err_code("root_bad_password"))?;
    if plain != crypto::ROOT_VERIFIER_PLAIN {
        return Err(err_code("root_bad_password"));
    }
    Ok(kek)
}



pub(crate) fn load_meta(conn: &Connection, scope: &str, id: &str) -> Result<Option<EncMeta>, String> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT meta_json FROM encrypted_keys WHERE scope = ?1 AND ref_id = ?2",
            params![scope, id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    match raw {
        Some(text) => serde_json::from_str::<EncMeta>(&text)
            .map(Some)
            .map_err(|_| "加密元数据已损坏".to_string()),
        None => Ok(None),
    }
}

pub(crate) fn save_meta(conn: &Connection, scope: &str, id: &str, meta: &EncMeta) -> Result<(), String> {
    let raw = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO encrypted_keys (scope, ref_id, meta_json, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope, ref_id) DO UPDATE SET meta_json = excluded.meta_json",
        params![scope, id, raw, meta.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

