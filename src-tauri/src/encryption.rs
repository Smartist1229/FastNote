//! 笔记 / 分组加密的业务层。
//!
//! - 数据库里永远只有密文；临时解锁只把 DEK 放在 Rust 内存，不写回明文。
//! - 每个加密单元一把随机 DEK，分别被条目密码和根密码包裹。
//! - 条目密码错 3 次后才允许改用根密码；根密码失败 5 次冷却 30 秒。
//! - 根密码在本次运行内验证成功后会缓存 KEK，用于继续加密新内容（不落盘）。

use crate::crypto::{self, ITERATIONS};
use crate::semantic;
use crate::{AppState, Note, Tag};
use chrono::Local;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::State;
use zeroize::{Zeroize, Zeroizing};

pub(crate) const NOTE_SCOPE: &str = "note";
const CAT_SCOPE: &str = "category";
const ROOT_SALT_KEY: &str = "app.security.root.salt";
const ROOT_ITER_KEY: &str = "app.security.root.iterations";
const ROOT_KDF_KEY: &str = "app.security.root.kdf";
const ROOT_M_COST_KEY: &str = "app.security.root.m_cost";
const ROOT_T_COST_KEY: &str = "app.security.root.t_cost";
const ROOT_P_COST_KEY: &str = "app.security.root.p_cost";
const ROOT_VERIFIER_KEY: &str = "app.security.root.verifier";
const ROOT_VERIFIER_AAD: &[u8] = b"fastnote|v1|root-verifier";
pub(crate) const ROOT_FALLBACK_AFTER: u32 = 3;
const ROOT_FAIL_LIMIT: u32 = 5;
const ROOT_COOLDOWN_SECS: u64 = 30;

/* ---------------- 运行时状态 ---------------- */

#[derive(Clone, Copy, PartialEq)]
enum UnlockScope {
    Session,
    Once,
}

struct UnlockedKey {
    dek: [u8; 32],
    scope: UnlockScope,
}

impl Drop for UnlockedKey {
    fn drop(&mut self) {
        // 锁定/移除时把 DEK 覆写掉，别留给分配器或进程转储
        self.dek.zeroize();
    }
}

#[derive(Default)]
struct RootFail {
    count: u32,
    until: Option<Instant>,
}

#[derive(Default)]
pub struct EncryptionState {
    /// key = "note:12" / "category:3"
    keys: Mutex<HashMap<String, UnlockedKey>>,
    attempts: Mutex<HashMap<String, u32>>,
    root_fail: Mutex<RootFail>,
    /// 本次运行内验证过根密码后缓存的 KEK；退出即消失，绝不落盘。
    root_kek: Mutex<Option<[u8; 32]>>,
}

fn map_key(scope: &str, id: i64) -> String {
    format!("{scope}:{id}")
}

impl EncryptionState {
    /// 返回的是一份独立副本，调用方用完就自动清零（`Zeroizing`），
    /// 不会在栈上、临时变量里留下没人管的密钥字节。
    fn get_key(&self, scope: &str, id: i64) -> Option<Zeroizing<[u8; 32]>> {
        self.keys
            .lock()
            .unwrap()
            .get(&map_key(scope, id))
            .map(|k| Zeroizing::new(k.dek))
    }

    fn put_key(&self, scope: &str, id: i64, dek: [u8; 32], unlock: UnlockScope) {
        self.keys
            .lock()
            .unwrap()
            .insert(map_key(scope, id), UnlockedKey { dek, scope: unlock });
    }

    pub(crate) fn lock(&self, scope: &str, id: i64, force: bool) {
        let mut keys = self.keys.lock().unwrap();
        let key = map_key(scope, id);
        if force || keys.get(&key).map(|k| k.scope == UnlockScope::Once).unwrap_or(false) {
            keys.remove(&key);
        }
    }

    fn attempts(&self, scope: &str, id: i64) -> u32 {
        self.attempts
            .lock()
            .unwrap()
            .get(&map_key(scope, id))
            .copied()
            .unwrap_or(0)
    }

    fn bump_attempts(&self, scope: &str, id: i64) -> u32 {
        let mut attempts = self.attempts.lock().unwrap();
        let value = attempts.entry(map_key(scope, id)).or_insert(0);
        *value += 1;
        *value
    }

    fn reset_attempts(&self, scope: &str, id: i64) {
        self.attempts.lock().unwrap().remove(&map_key(scope, id));
    }

    fn root_cached(&self) -> bool {
        self.root_kek.lock().unwrap().is_some()
    }

    fn set_root_cache(&self, kek: [u8; 32]) {
        let mut slot = self.root_kek.lock().unwrap();
        if let Some(mut old) = slot.take() {
            old.zeroize();
        }
        *slot = Some(kek);
    }

    fn cached_root(&self) -> Option<Zeroizing<[u8; 32]>> {
        self.root_kek.lock().unwrap().map(Zeroizing::new)
    }

    /// 立即全部锁定：清空条目 DEK 与根 KEK，并把内存里的密钥字节覆写掉。
    pub(crate) fn clear_all(&self) {
        self.keys.lock().unwrap().clear();
        let mut slot = self.root_kek.lock().unwrap();
        if let Some(mut kek) = slot.take() {
            kek.zeroize();
        }
    }
}

/* ---------------- 元数据 ---------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
struct EncMeta {
    v: u32,
    /// 派生产法：`pbkdf2-sha256`（旧版）或 `argon2id`。早期数据没有该字段。
    #[serde(default = "meta_default_kdf")]
    kdf: String,
    salt: String,
    #[serde(default = "meta_default_iterations")]
    iterations: u32,
    #[serde(default)]
    m_cost: Option<u32>,
    #[serde(default)]
    t_cost: Option<u32>,
    #[serde(default)]
    p_cost: Option<u32>,
    wrap_item: String,
    #[serde(default)]
    wrap_root: Option<String>,
    #[serde(default)]
    hint: Option<String>,
    created_at: String,
}

fn meta_default_kdf() -> String {
    crypto::KDF_PBKDF2.to_string()
}

fn meta_default_iterations() -> u32 {
    ITERATIONS
}

impl EncMeta {
    /// 是否已经用当前推荐的派生参数（不是就需要在输对密码后顺手升级）
    fn is_current_kdf(&self) -> bool {
        self.kdf == crypto::KDF_ARGON2ID
            && self.m_cost.unwrap_or(0) >= crypto::ARGON2_M_COST
            && self.t_cost.unwrap_or(0) >= crypto::ARGON2_T_COST
            && self.p_cost.unwrap_or(0) >= crypto::ARGON2_P_COST
    }

    fn derive_item_key(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
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
    fn rewrap_item(
        &mut self,
        password: &str,
        dek: &[u8; 32],
        scope: &str,
        id: i64,
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
fn new_meta(
    password: &str,
    dek: &[u8; 32],
    root_kek: &[u8; 32],
    scope: &str,
    id: i64,
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
struct TagSnap {
    name: String,
    source: String,
    created_at: String,
}

struct RootMeta {
    kdf: String,
    salt: Vec<u8>,
    iterations: u32,
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
    verifier: String,
}

impl RootMeta {
    fn is_current_kdf(&self) -> bool {
        self.kdf == crypto::KDF_ARGON2ID
            && self.m_cost >= crypto::ARGON2_M_COST
            && self.t_cost >= crypto::ARGON2_T_COST
            && self.p_cost >= crypto::ARGON2_P_COST
    }

    fn derive(&self, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
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

fn now() -> String {
    Local::now().to_rfc3339()
}

fn err_code(code: &str) -> String {
    json!({ "code": code }).to_string()
}

fn bad_password(attempts: u32) -> String {
    json!({
        "code": "bad_password",
        "attempts": attempts,
        "root_allowed": attempts >= ROOT_FALLBACK_AFTER,
    })
    .to_string()
}

fn validate_password(password: &str) -> Result<(), String> {
    let len = password.chars().count();
    if len < 8 {
        return Err(err_code("password_too_short"));
    }
    if len > 128 {
        return Err(err_code("password_too_long"));
    }
    Ok(())
}

fn parse_unlock_scope(scope: &str) -> Result<UnlockScope, String> {
    match scope {
        "once" => Ok(UnlockScope::Once),
        "session" => Ok(UnlockScope::Session),
        // 未知取值不再默认成 session：宁可报错，也不让调用方以为「仅本次」生效
        _ => Err(err_code("invalid_scope")),
    }
}

fn note_aad(note_id: i64, field: &str) -> Vec<u8> {
    format!("fastnote|v1|note|{note_id}|{field}").into_bytes()
}

fn wrap_aad(kind: &str, scope: &str, id: i64) -> Vec<u8> {
    format!("fastnote|v1|wrap|{kind}|{scope}|{id}").into_bytes()
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM app_settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![key, value, now()],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_root_meta(conn: &Connection) -> Result<Option<RootMeta>, String> {
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

fn root_kek_from_password(conn: &Connection, password: &str) -> Result<Zeroizing<[u8; 32]>, String> {
    let meta = read_root_meta(conn)?.ok_or_else(|| err_code("root_not_set"))?;
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
fn upgrade_root_kdf(
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
        let rows: Vec<(String, i64, String)> = {
            let mut stmt = conn
                .prepare("SELECT scope, ref_id, meta_json FROM encrypted_keys")
                .map_err(|e| e.to_string())?;
            let mapped = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
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
            let aad = wrap_aad("root", &scope, ref_id);
            let dek = dek_from_bytes(crypto::open(old_kek, &aad, &wrap_root)?)?;
            item.wrap_root = Some(crypto::seal(&new_kek, &aad, &dek[..])?);
            let updated = serde_json::to_string(&item).map_err(|e| e.to_string())?;
            conn.execute(
                "UPDATE encrypted_keys SET meta_json = ?1 WHERE scope = ?2 AND ref_id = ?3",
                params![updated, scope, ref_id],
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


fn root_cooldown_error(until: Instant) -> String {
    let secs = until
        .saturating_duration_since(Instant::now())
        .as_secs()
        .max(1);
    json!({ "code": "root_bad_password", "cooldown_seconds": secs }).to_string()
}

/// 校验根密码并缓存 KEK。失败计入全局冷却；成功清零。
fn verify_root(
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
fn root_kek_for_encrypt(
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

fn load_meta(conn: &Connection, scope: &str, id: i64) -> Result<Option<EncMeta>, String> {
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

fn save_meta(conn: &Connection, scope: &str, id: i64, meta: &EncMeta) -> Result<(), String> {
    let raw = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO encrypted_keys (scope, ref_id, meta_json, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(scope, ref_id) DO UPDATE SET meta_json = excluded.meta_json",
        params![scope, id, raw, meta.created_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 加解密后需要「压缩库文件、把旧页真正抹掉」。VACUUM 会扫全库（14 MB 约 0.4 秒，
/// 且随库变大线性上升），所以这里只打脏标记，等空闲时由 `crypto_scrub_flush` 做一次。
/// 立即安全性由 `PRAGMA secure_delete = ON` 保证：被释放的页在写入时就已清零。
static SCRUB_DIRTY: AtomicBool = AtomicBool::new(false);

fn scrub(conn: &Connection) {
    // journal_mode=delete 下这个 checkpoint 基本是空操作，留着是为将来可能切到 WAL
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    SCRUB_DIRTY.store(true, Ordering::SeqCst);
}

/// 空闲时调用：如果期间发生过加解密，就压缩一次数据库。返回是否真的执行了 VACUUM。
#[tauri::command(async)]
pub fn crypto_scrub_flush(state: State<AppState>) -> Result<bool, String> {
    if !SCRUB_DIRTY.swap(false, Ordering::SeqCst) {
        return Ok(false);
    }
    let conn = state.conn.lock().unwrap();
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    match conn.execute_batch("VACUUM;") {
        Ok(()) => Ok(true),
        Err(error) => {
            // 压缩失败不影响内容安全，下次空闲再试
            SCRUB_DIRTY.store(true, Ordering::SeqCst);
            Err(error.to_string())
        }
    }
}

fn clean_hint(hint: Option<String>) -> Option<String> {
    hint.map(|h| h.trim().chars().take(100).collect::<String>())
        .filter(|h| !h.is_empty())
}

fn dek_from_bytes(mut bytes: Vec<u8>) -> Result<Zeroizing<[u8; 32]>, String> {
    if bytes.len() != 32 {
        // 长度不对也先把缓冲抹掉再报错
        bytes.zeroize();
        return Err("密钥长度不正确".to_string());
    }
    let mut dek = Zeroizing::new([0u8; 32]);
    dek.copy_from_slice(&bytes);
    bytes.zeroize();
    Ok(dek)
}

/* ---------------- 根密码命令 ---------------- */

#[derive(Serialize)]
pub struct EncryptionStatus {
    root_set: bool,
    root_cached: bool,
    encrypted_notes: i64,
    encrypted_categories: i64,
}

#[tauri::command(async)]
pub fn encryption_status(state: State<AppState>) -> Result<EncryptionStatus, String> {
    let conn = state.conn.lock().unwrap();
    Ok(EncryptionStatus {
        root_set: read_root_meta(&conn)?.is_some(),
        root_cached: state.encryption.root_cached(),
        encrypted_notes: count_where(&conn, "notes", "enc_mode <> 0")?,
        encrypted_categories: count_where(&conn, "categories", "is_encrypted <> 0")?,
    })
}

fn count_where(conn: &Connection, table: &str, predicate: &str) -> Result<i64, String> {
    conn.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE {predicate}"),
        [],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
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
    let rows: Vec<(i64, String, i64, String)> = {
        let mut stmt = tx
            .prepare("SELECT id, scope, ref_id, meta_json FROM encrypted_keys")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
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
    let rows: Vec<(String, i64, String)> = {
        let mut stmt = tx
            .prepare("SELECT scope, ref_id, meta_json FROM encrypted_keys")
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
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
        let aad = wrap_aad("root", &scope, ref_id);
        let dek = dek_from_bytes(
            crypto::open(&old_kek, &aad, &wrap_root)
                .map_err(|_| "根密码已变化，无法重新绑定该加密项".to_string())?,
        )?;
        meta.wrap_root = Some(crypto::seal(&new_kek, &aad, &dek[..])?);
        let updated = serde_json::to_string(&meta).map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE encrypted_keys SET meta_json = ?1 WHERE scope = ?2 AND ref_id = ?3",
            params![updated, scope, ref_id],
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

struct NoteRow {
    id: i64,
    title: String,
    content: String,
    category_id: Option<i64>,
    created_at: String,
    updated_at: String,
    is_deleted: bool,
    deleted_at: Option<String>,
    is_pinned: bool,
    ai_access: i64,
    enc_mode: i64,
    enc_tags: Option<String>,
}

fn load_note_row(conn: &Connection, id: i64) -> Result<NoteRow, String> {
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
    fn into_note(self, title: String, content: String, is_locked: bool, hint: Option<String>) -> Note {
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

fn note_dek(
    state: &EncryptionState,
    note_id: i64,
    enc_mode: i64,
    category_id: Option<i64>,
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
fn open_title_legacy(dek: &[u8; 32], note_id: i64, title: &str) -> Result<String, String> {
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
    note_id: i64,
    enc_mode: i64,
    category_id: Option<i64>,
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
    note_id: i64,
    enc_mode: i64,
    category_id: Option<i64>,
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
            match note.category_id {
                Some(category) => (CAT_SCOPE, category),
                None => (NOTE_SCOPE, note.id),
            }
        } else {
            (NOTE_SCOPE, note.id)
        };
        note.enc_hint = load_meta(conn, meta_scope, meta_id)
            .ok()
            .flatten()
            .and_then(|m| m.hint);
        match open_note_fields(
            conn,
            state,
            note.id,
            note.enc_mode,
            note.category_id,
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
        category.enc_hint = load_meta(conn, CAT_SCOPE, category.id)
            .ok()
            .flatten()
            .and_then(|m| m.hint);
        category.is_locked = state.get_key(CAT_SCOPE, category.id).is_none();
    }
}

pub(crate) fn note_enc_mode(conn: &Connection, id: i64) -> Result<i64, String> {
    conn.query_row(
        "SELECT COALESCE(enc_mode, 0) FROM notes WHERE id = ?1",
        params![id],
        |row| row.get(0),
    )
    .map_err(|_| "笔记不存在，可能已被删除".to_string())
}

pub(crate) fn category_is_encrypted(conn: &Connection, id: i64) -> Result<bool, String> {
    conn.query_row(
        "SELECT COALESCE(is_encrypted, 0) FROM categories WHERE id = ?1",
        params![id],
        |row| Ok(row.get::<_, i64>(0)? != 0),
    )
    .map_err(|_| "分组不存在".to_string())
}

pub(crate) fn cleanup_note_key(conn: &Connection, note_id: i64) -> Result<(), String> {
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
    note_id: i64,
) -> Result<Vec<Tag>, String> {
    let row = load_note_row(conn, note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    let dek = match note_dek(state, note_id, row.enc_mode, row.category_id) {
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

fn snapshot_tags(conn: &Connection, note_id: i64) -> Result<Vec<TagSnap>, String> {
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

fn restore_tags(conn: &Connection, note_id: i64, snaps: &[TagSnap]) -> Result<(), String> {
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

fn seal_tags(conn: &Connection, note_id: i64, dek: &[u8; 32]) -> Result<String, String> {
    let snaps = snapshot_tags(conn, note_id)?;
    let plain = serde_json::to_vec(&snaps).map_err(|e| e.to_string())?;
    crypto::seal(dek, &note_aad(note_id, "tags"), &plain)
}

fn open_tags(note_id: i64, dek: &[u8; 32], blob: &str) -> Result<Vec<TagSnap>, String> {
    let plain = crypto::open_text(dek, &note_aad(note_id, "tags"), blob)?;
    serde_json::from_str(&plain).map_err(|_| "标签快照已损坏".to_string())
}

/// 把一篇笔记的全部历史版本正文从明文加密成密文（标题保持明文）。
fn seal_history(conn: &Connection, note_id: i64, dek: &[u8; 32]) -> Result<(), String> {
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

fn open_history(conn: &Connection, note_id: i64, dek: &[u8; 32]) -> Result<(), String> {
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
    note_id: i64,
    enc_mode: i64,
    category_id: Option<i64>,
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

fn acquire_dek(
    conn: &Connection,
    state: &EncryptionState,
    scope: &str,
    id: i64,
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
fn upgrade_item_meta(
    conn: &Connection,
    scope: &str,
    id: i64,
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
    note_id: i64,
    password: String,
    root_password: Option<String>,
    hint: Option<String>,
    state: State<AppState>,
) -> Result<Note, String> {
    validate_password(&password)?;
    let mut conn = state.conn.lock().unwrap();
    let row = load_note_row(&conn, note_id)?;
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
    if let Some(category_id) = row.category_id {
        if category_is_encrypted(&conn, category_id)? {
            return Err(err_code("category_encrypted"));
        }
    }
    let root_kek = root_kek_for_encrypt(&conn, &state.encryption, root_password.as_deref())?;

    // 随机 DEK 也是一份密钥副本：包进 Zeroizing，出作用域自动清零
    let dek = Zeroizing::new(crypto::random_dek());
    let meta = new_meta(&password, &dek, &root_kek, NOTE_SCOPE, note_id, hint)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let content_cipher = crypto::seal(&dek, &note_aad(note_id, "content"), row.content.as_bytes())?;
    let tags_cipher = seal_tags(&tx, note_id, &dek)?;
    seal_history(&tx, note_id, &dek)?;
    tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    // 标签名本身在密文快照里，明文关联删掉后 tags 表里的行就是孤儿了——
    // 不收掉的话「标签名」仍然明文躺在库里，加密等于漏了一半
    crate::prune_tag_links(&tx)?;
    tx.execute(
        "UPDATE notes SET content = ?1, enc_mode = 1, enc_tags = ?2 WHERE id = ?3",
        params![content_cipher, tags_cipher, note_id],
    )
    .map_err(|e| e.to_string())?;
    save_meta(&tx, NOTE_SCOPE, note_id, &meta)?;
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![note_id],
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
    note_id: i64,
    password: String,
    use_root: bool,
    scope: String,
    state: State<AppState>,
) -> Result<Note, String> {
    let conn = state.conn.lock().unwrap();
    let row = load_note_row(&conn, note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    if row.enc_mode == 2 {
        return Err(json!({ "code": "note_encrypted", "reason": "group" }).to_string());
    }
    let meta = load_meta(&conn, NOTE_SCOPE, note_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(&conn, &state.encryption, NOTE_SCOPE, note_id, &meta, &password, use_root)?;
    state.encryption.put_key(
        NOTE_SCOPE,
        note_id,
        *dek,
        parse_unlock_scope(&scope)?,
    );
    let title = open_title_legacy(&dek, note_id, &row.title)?;
    let content = crypto::open_text(&dek, &note_aad(note_id, "content"), &row.content)?;
    // 旧数据的标题曾经是密文：借这次解锁把明文标题写回库，之后列表搜索都能用
    if title != row.title {
        conn.execute(
            "UPDATE notes SET title = ?1 WHERE id = ?2",
            params![title, note_id],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(row.into_note(title, content, false, meta.hint))
}

#[tauri::command(async)]
pub fn lock_note(note_id: i64, force: bool, state: State<AppState>) -> Result<(), String> {
    state.encryption.lock(NOTE_SCOPE, note_id, force);
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
    note_id: i64,
    password: String,
    use_root: bool,
    state: State<AppState>,
) -> Result<Note, String> {
    let mut conn = state.conn.lock().unwrap();
    let mut row = load_note_row(&conn, note_id)?;
    if row.enc_mode == 0 {
        return Err(err_code("not_encrypted"));
    }
    if row.enc_mode == 2 {
        return Err(json!({ "code": "note_encrypted", "reason": "group" }).to_string());
    }
    let meta = load_meta(&conn, NOTE_SCOPE, note_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(&conn, &state.encryption, NOTE_SCOPE, note_id, &meta, &password, use_root)?;
    let title = open_title_legacy(&dek, note_id, &row.title)?;
    let content = crypto::open_text(&dek, &note_aad(note_id, "content"), &row.content)?;
    let snaps = match &row.enc_tags {
        Some(blob) => open_tags(note_id, &dek, blob)?,
        None => Vec::new(),
    };

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    open_history(&tx, note_id, &dek)?;
    restore_tags(&tx, note_id, &snaps)?;
    tx.execute(
        "UPDATE notes SET title = ?1, content = ?2, enc_mode = 0, enc_tags = NULL WHERE id = ?3",
        params![title, content, note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM encrypted_keys WHERE scope = 'note' AND ref_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![note_id])
        .map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_index_state WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    state.encryption.lock(NOTE_SCOPE, note_id, true);
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);

    // 返回给前端的笔记必须反映刚写入的 enc_mode=0：沿用旧行会让列表继续当成「已加密且已解锁」，
    // 右键还能「锁定」，一锁就变成永远打不开的假锁定态（库里其实已经是明文）。
    row.enc_mode = 0;
    Ok(row.into_note(title, content, false, None))
}

/* ---------------- 分组命令 ---------------- */

fn category_note_rows(conn: &Connection, category_id: i64) -> Result<Vec<NoteRow>, String> {
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
    category_id: i64,
    password: String,
    root_password: Option<String>,
    hint: Option<String>,
    state: State<AppState>,
) -> Result<(), String> {
    validate_password(&password)?;
    let mut conn = state.conn.lock().unwrap();
    if category_is_encrypted(&conn, category_id)? {
        return Err(err_code("already_encrypted"));
    }
    // 只处理组内未删除的笔记：回收站里的笔记可能本来就带自己的密码，
    // 既不能算作「组内有单独加密的笔记」，也不该被组密钥重新封一遍。
    let rows: Vec<NoteRow> = category_note_rows(&conn, category_id)?
        .into_iter()
        .filter(|row| !row.is_deleted)
        .collect();
    let individually: Vec<i64> = rows
        .iter()
        .filter(|row| row.enc_mode == 1)
        .map(|row| row.id)
        .collect();
    if !individually.is_empty() {
        return Err(json!({
            "code": "has_individual_encrypted_notes",
            "note_ids": individually,
        })
        .to_string());
    }
    // 同上：正文已经是密文却标着未加密，说明状态不一致，先修复再整体加密
    let sealed: Vec<i64> = rows
        .iter()
        .filter(|row| row.enc_mode == 0 && crypto::is_encrypted(&row.content))
        .map(|row| row.id)
        .collect();
    if !sealed.is_empty() {
        return Err(json!({ "code": "already_sealed", "note_ids": sealed }).to_string());
    }
    let root_kek = root_kek_for_encrypt(&conn, &state.encryption, root_password.as_deref())?;

    let dek = Zeroizing::new(crypto::random_dek());
    let meta = new_meta(&password, &dek, &root_kek, CAT_SCOPE, category_id, hint)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in &rows {
        let content = crypto::seal(&dek, &note_aad(row.id, "content"), row.content.as_bytes())?;
        let tags = seal_tags(&tx, row.id, &dek)?;
        seal_history(&tx, row.id, &dek)?;
        tx.execute("DELETE FROM note_tags WHERE note_id = ?1", params![row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE notes SET content = ?1, enc_mode = 2, enc_tags = ?2 WHERE id = ?3",
            params![content, tags, row.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![row.id],
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
    save_meta(&tx, CAT_SCOPE, category_id, &meta)?;
    tx.commit().map_err(|e| e.to_string())?;

    // 加密后分组立即锁定：展开分组或打开组内笔记都要重新输密码
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);
    Ok(())
}

#[tauri::command(async)]
pub fn unlock_category(
    category_id: i64,
    password: String,
    use_root: bool,
    scope: String,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    if !category_is_encrypted(&conn, category_id)? {
        return Err(err_code("not_encrypted"));
    }
    let meta = load_meta(&conn, CAT_SCOPE, category_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(
        &conn,
        &state.encryption,
        CAT_SCOPE,
        category_id,
        &meta,
        &password,
        use_root,
    )?;
    state.encryption.put_key(
        CAT_SCOPE,
        category_id,
        *dek,
        parse_unlock_scope(&scope)?,
    );
    Ok(())
}

#[tauri::command(async)]
pub fn lock_category(category_id: i64, force: bool, state: State<AppState>) -> Result<(), String> {
    state.encryption.lock(CAT_SCOPE, category_id, force);
    Ok(())
}

#[tauri::command(async)]
pub fn decrypt_category(
    category_id: i64,
    password: String,
    use_root: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let mut conn = state.conn.lock().unwrap();
    if !category_is_encrypted(&conn, category_id)? {
        return Err(err_code("not_encrypted"));
    }
    let meta = load_meta(&conn, CAT_SCOPE, category_id)?.ok_or_else(|| err_code("not_encrypted"))?;
    let dek = acquire_dek(
        &conn,
        &state.encryption,
        CAT_SCOPE,
        category_id,
        &meta,
        &password,
        use_root,
    )?;
    // 这里必须包含回收站里的笔记：组密钥一删，留在回收站的组密文就再也解不开了
    let rows = category_note_rows(&conn, category_id)?;

    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in &rows {
        if row.enc_mode != 2 {
            continue;
        }
        let title = open_title_legacy(&dek, row.id, &row.title)?;
        let content = crypto::open_text(&dek, &note_aad(row.id, "content"), &row.content)?;
        let snaps = match &row.enc_tags {
            Some(blob) => open_tags(row.id, &dek, blob)?,
            None => Vec::new(),
        };
        open_history(&tx, row.id, &dek)?;
        restore_tags(&tx, row.id, &snaps)?;
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2, enc_mode = 0, enc_tags = NULL WHERE id = ?3",
            params![title, content, row.id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![row.id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![row.id],
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
        params![category_id],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;

    state.encryption.lock(CAT_SCOPE, category_id, true);
    scrub(&conn);
    drop(conn);
    semantic::invalidate(&state.semantic);
    Ok(())
}

/* ---------------- 信息查询 ---------------- */

#[tauri::command(async)]
pub fn encryption_info(scope: String, id: i64, state: State<AppState>) -> Result<Value, String> {
    let conn = state.conn.lock().unwrap();
    let (scope_key, meta_scope, meta_id, encrypted, is_locked) = match scope.as_str() {
        CAT_SCOPE => {
            let encrypted = category_is_encrypted(&conn, id)?;
            (
                CAT_SCOPE,
                CAT_SCOPE,
                id,
                encrypted,
                state.encryption.get_key(CAT_SCOPE, id).is_none(),
            )
        }
        NOTE_SCOPE => {
            let row = load_note_row(&conn, id)?;
            let encrypted = row.enc_mode != 0;
            let (meta_scope, meta_id) = if row.enc_mode == 2 {
                match row.category_id {
                    Some(category) => (CAT_SCOPE, category),
                    None => (NOTE_SCOPE, id),
                }
            } else {
                (NOTE_SCOPE, id)
            };
            let locked = note_dek(&state.encryption, id, row.enc_mode, row.category_id).is_err();
            (NOTE_SCOPE, meta_scope, meta_id, encrypted, locked)
        }
        _ => return Err(err_code("invalid_scope")),
    };
    let meta = if encrypted {
        load_meta(&conn, meta_scope, meta_id)?
    } else {
        None
    };
    let root = read_root_meta(&conn)?;
    Ok(json!({
        "scope": scope_key,
        "encrypted": encrypted,
        "is_locked": is_locked,
        "hint": meta.as_ref().and_then(|m| m.hint.clone()),
        "root_wrapped": meta.as_ref().map(|m| m.wrap_root.is_some()).unwrap_or(false),
        "attempts": state.encryption.attempts(scope_key, id),
        "root_allowed": state.encryption.attempts(scope_key, id) >= ROOT_FALLBACK_AFTER,
        "root_set": root.is_some(),
        "root_cached": state.encryption.root_cached(),
        "kdf": root.map(|m| m.kdf).unwrap_or_default(),
    }))
}

/// 粗略判断一段正文是不是我们生成的密文：前缀 + 全十六进制 + 足够长。
/// 用来区分「真的被加密了」和「用户正文刚好以 encn:v1: 开头」。
fn looks_like_ciphertext(stored: &str) -> bool {
    let Some(hex) = stored.strip_prefix(crypto::ENCN_PREFIX) else {
        return false;
    };
    hex.len() >= 32 && hex.len() % 2 == 0 && hex.bytes().all(|b| b.is_ascii_hexdigit())
}

/// 启动自检：找出「库里的加密标志和实际内容对不上」的笔记。
///
/// 能安全推断的（正文是密文、密钥还在、只是 `enc_mode` 丢了——刷新/重启后加密状态消失
/// 就是这一类）直接修好；其余只报告，绝不擅自删正文或删密钥。
#[tauri::command(async)]
pub fn encryption_self_check(state: State<AppState>) -> Result<Value, String> {
    let mut conn = state.conn.lock().unwrap();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let candidates: Vec<(i64, Option<i64>, String, bool, bool, bool)> = {
        let mut stmt = tx
            .prepare(
                "SELECT n.id,
                        n.category_id,
                        n.content,
                        EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'note' AND k.ref_id = n.id),
                        COALESCE((SELECT c.is_encrypted FROM categories c WHERE c.id = n.category_id), 0) <> 0,
                        EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = n.category_id)
                 FROM notes n
                 WHERE COALESCE(n.enc_mode, 0) = 0 AND n.content LIKE ?1",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![format!("{}%", crypto::ENCN_PREFIX)], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)? != 0,
                    row.get::<_, i64>(4)? != 0,
                    row.get::<_, i64>(5)? != 0,
                ))
            })
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?
    };

    let mut repaired: Vec<i64> = Vec::new();
    let mut missing_keys: Vec<i64> = Vec::new();
    for (id, category_id, content, has_note_meta, category_encrypted, has_category_meta) in candidates
    {
        if !looks_like_ciphertext(&content) {
            continue;
        }
        let mode = if has_note_meta {
            Some(1)
        } else if category_id.is_some() && category_encrypted && has_category_meta {
            Some(2)
        } else {
            None
        };
        match mode {
            Some(mode) => {
                tx.execute(
                    "UPDATE notes SET enc_mode = ?1 WHERE id = ?2",
                    params![mode, id],
                )
                .map_err(|e| e.to_string())?;
                repaired.push(id);
            }
            None => missing_keys.push(id),
        }
    }

    let collect_ids = |sql: &str| -> Result<Vec<i64>, String> {
        let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, i64>(0))
            .map_err(|e| e.to_string())?;
        mapped
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    };
    // 标了加密却找不到密钥：数据无法解密，只能如实报告（可能是恢复了不完整备份）
    missing_keys.extend(collect_ids(
        "SELECT id FROM notes WHERE COALESCE(enc_mode, 0) = 1
           AND NOT EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'note' AND k.ref_id = notes.id)
         UNION
         SELECT id FROM notes WHERE COALESCE(enc_mode, 0) = 2
           AND (category_id IS NULL OR NOT EXISTS (
                 SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = notes.category_id))",
    )?);
    missing_keys.sort_unstable();
    missing_keys.dedup();

    // 有密钥但标志是未加密：可能是解密中断留下的残渣，保留密钥，只报告
    let orphan_keys = collect_ids(
        "SELECT k.ref_id FROM encrypted_keys k
         LEFT JOIN notes n ON n.id = k.ref_id
         WHERE k.scope = 'note' AND (n.id IS NULL OR COALESCE(n.enc_mode, 0) = 0)",
    )?;

    let missing_category_keys = collect_ids(
        "SELECT c.id FROM categories c WHERE COALESCE(c.is_encrypted, 0) <> 0
           AND NOT EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = c.id)",
    )?;

    // 标了加密但正文不是密文：解密中途被打断或外部工具改过库，同样只报告
    let content_mismatch = collect_ids(
        "SELECT id FROM notes WHERE COALESCE(enc_mode, 0) <> 0 AND content NOT LIKE 'encn:v1:%'",
    )?;

    // 借用到这里结束（NLL），后面才能把 tx 移进 commit
    tx.commit().map_err(|e| e.to_string())?;
    drop(conn);

    Ok(json!({
        "repaired": repaired,
        "missing_keys": missing_keys,
        "missing_category_keys": missing_category_keys,
        "orphan_keys": orphan_keys,
        "content_mismatch": content_mismatch,
    }))
}
