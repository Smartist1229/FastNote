//! 笔记 / 分组的端到端加密。
//!
//! - `meta`：单元密钥元数据（KDF 参数、包裹后的 DEK）与 app_settings 读写
//! - `root`：根密码（KDF 升级、verifier、冷却、从备份迁移）
//! - `item`：单篇笔记的加解密、标签与历史快照的密文化
//! - `category`：整组加解密（组密钥）
//! - `mod`：状态、解锁计时、明文页清零（scrub）与状态查询
//!
//! 明文只在这几个文件的局部变量里出现，落盘一律密文；
//! 加解密后必须走 `scrub()`，否则明文页会留在 WAL 里。

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
pub(crate) enum UnlockScope {
    Session,
    Once,
}

pub(crate) struct UnlockedKey {
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
pub(crate) struct RootFail {
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

fn map_key(scope: &str, id: &str) -> String {
    format!("{scope}:{id}")
}

impl EncryptionState {
    /// 返回的是一份独立副本，调用方用完就自动清零（`Zeroizing`），
    /// 不会在栈上、临时变量里留下没人管的密钥字节。
    fn get_key(&self, scope: &str, id: impl ToString) -> Option<Zeroizing<[u8; 32]>> {
        self.keys
            .lock()
            .unwrap()
            .get(&map_key(scope, &id.to_string()))
            .map(|k| Zeroizing::new(k.dek))
    }

    fn put_key(&self, scope: &str, id: impl ToString, dek: [u8; 32], unlock: UnlockScope) {
        self.keys
            .lock()
            .unwrap()
            .insert(map_key(scope, &id.to_string()), UnlockedKey { dek, scope: unlock });
    }

    pub(crate) fn lock(&self, scope: &str, id: impl ToString, force: bool) {
        let mut keys = self.keys.lock().unwrap();
        let key = map_key(scope, &id.to_string());
        if force || keys.get(&key).map(|k| k.scope == UnlockScope::Once).unwrap_or(false) {
            keys.remove(&key);
        }
    }

    fn attempts(&self, scope: &str, id: impl ToString) -> u32 {
        self.attempts
            .lock()
            .unwrap()
            .get(&map_key(scope, &id.to_string()))
            .copied()
            .unwrap_or(0)
    }

    fn bump_attempts(&self, scope: &str, id: impl ToString) -> u32 {
        let mut attempts = self.attempts.lock().unwrap();
        let value = attempts.entry(map_key(scope, &id.to_string())).or_insert(0);
        *value += 1;
        *value
    }

    fn reset_attempts(&self, scope: &str, id: impl ToString) {
        self.attempts
            .lock()
            .unwrap()
            .remove(&map_key(scope, &id.to_string()));
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
        Ok(()) => {
            /*
             * VACUUM 在 WAL 下是把**整库重写进 -wal**，主库文件在合并前一个字都没变。
             * 只在事后等 autocheckpoint 的话，WAL 会长到和库一样大（实测 649 MB 的库
             * 留下 656 MB 的 -wal），之后每次读写都要在几十个 WAL 段里找页，整个软件都变慢。
             * 而且明文页这时仍躺在 -wal 里，不合并等于没抹掉。所以这里必须显式 TRUNCATE。
             */
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            Ok(true)
        }
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

    let candidates: Vec<(String, Option<String>, String, bool, bool, bool)> = {
        let mut stmt = tx
            .prepare(
                "SELECT n.id,
                        n.category_id,
                        n.content,
                        EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'note' AND k.ref_id = n.id),
                        COALESCE((SELECT c.is_encrypted FROM categories c WHERE c.id = n.category_id), 0) <> 0,
                        EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = CAST(n.category_id AS TEXT))
                 FROM notes n
                 WHERE COALESCE(n.enc_mode, 0) = 0 AND n.content LIKE ?1",
            )
            .map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map(params![format!("{}%", crypto::ENCN_PREFIX)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
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

    let mut repaired: Vec<String> = Vec::new();
    let mut missing_keys: Vec<String> = Vec::new();
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
                    params![mode, &id],
                )
                .map_err(|e| e.to_string())?;
                repaired.push(id);
            }
            None => missing_keys.push(id),
        }
    }

    let collect_ids = |sql: &str| -> Result<Vec<String>, String> {
        let mut stmt = tx.prepare(sql).map_err(|e| e.to_string())?;
        let mapped = stmt
            .query_map([], |row| {
                // 同一列可能来自 notes.id（TEXT）也可能来自 categories.id（INTEGER）
                Ok(match row.get_ref(0)? {
                    rusqlite::types::ValueRef::Text(t) => {
                        String::from_utf8_lossy(t).into_owned()
                    }
                    rusqlite::types::ValueRef::Integer(i) => i.to_string(),
                    _ => String::new(),
                })
            })
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
                 SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = CAST(notes.category_id AS TEXT)))",
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
           AND NOT EXISTS (SELECT 1 FROM encrypted_keys k WHERE k.scope = 'category' AND k.ref_id = CAST(c.id AS TEXT))",
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


mod meta;
mod root;
mod item;
mod category;

pub(crate) use meta::*;
pub(crate) use root::*;
pub(crate) use item::*;
pub(crate) use category::*;
