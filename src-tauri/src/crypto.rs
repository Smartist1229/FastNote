//! 笔记/分组加密的底层原语：密码派生、AES-256-GCM 封装、密钥包裹。
//!
//! 与 API Key 的 `enc:v1:` 体系严格分离：这里所有密文都带 `encn:v1:` 前缀，
//! 且从不使用机器绑定的 `fastnote.key`。笔记加密的密钥只来自用户密码。
//!
//! 派生产法有两代：早期数据用 PBKDF2-SHA256（60 万次），新数据用 Argon2id。
//! 密文前缀不随代次变化，只有 `encrypted_keys.meta_json` 里记录用了哪种。

use argon2::{Algorithm, Argon2, Params, Version};
use ring::aead::{Aad, LessSafeKey, Nonce, UnboundKey, AES_256_GCM, NONCE_LEN};
use ring::pbkdf2::{derive, PBKDF2_HMAC_SHA256};
use ring::rand::{SecureRandom, SystemRandom};
use std::num::NonZeroU32;

/// 旧版 PBKDF2 的迭代次数，保留用于读取存量数据与参数升级判定。
pub const ITERATIONS: u32 = 600_000;
/// 派生产法标识，写入 `encrypted_keys.meta_json` 与根密码设置。
pub const KDF_PBKDF2: &str = "pbkdf2-sha256";
pub const KDF_ARGON2ID: &str = "argon2id";
/// Argon2id 参数（桌面端）：64 MiB 内存、3 轮、1 条通道。
/// 内存换时间，GPU/ASIC 的并行优势被大幅削弱。
pub const ARGON2_M_COST: u32 = 65_536;
pub const ARGON2_T_COST: u32 = 3;
pub const ARGON2_P_COST: u32 = 1;
/// 笔记密文前缀，刻意区别于 API Key 的 `enc:v1:`。
pub const ENCN_PREFIX: &str = "encn:v1:";
/// 根密码校验块明文；解密后必须完全相等才算密码正确。
pub const ROOT_VERIFIER_PLAIN: &[u8] = b"fastnote-root-verifier-v1";

/// PBKDF2-HMAC-SHA256 派生 32 字节密钥。盐由调用方随机生成并随密文一起保存。
/// 只用于读取旧数据；新数据一律走 `derive_argon2id`。
pub fn derive_key(password: &str, salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut out = [0u8; 32];
    let rounds = NonZeroU32::new(iterations.max(1)).expect("iterations > 0");
    derive(
        PBKDF2_HMAC_SHA256,
        rounds,
        salt,
        password.as_bytes(),
        &mut out,
    );
    out
}

/// Argon2id 派生 32 字节密钥。参数随密文保存，允许以后调参而不破坏旧数据。
pub fn derive_argon2id(
    password: &str,
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p_cost: u32,
) -> Result<[u8; 32], String> {
    let params = Params::new(m_cost, t_cost, p_cost, Some(32))
        .map_err(|_| "Argon2 参数无效".to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt, &mut out)
        .map_err(|_| "密码派生失败".to_string())?;
    Ok(out)
}

/// 生成 16 字节随机盐。
pub fn random_salt() -> Vec<u8> {
    let mut salt = vec![0u8; 16];
    SystemRandom::new()
        .fill(&mut salt)
        .expect("system random is available");
    salt
}

/// 生成 32 字节随机 DEK。
pub fn random_dek() -> [u8; 32] {
    let mut dek = [0u8; 32];
    SystemRandom::new()
        .fill(&mut dek)
        .expect("system random is available");
    dek
}

fn aead_key(key: &[u8; 32]) -> Result<LessSafeKey, String> {
    let unbound =
        UnboundKey::new(&AES_256_GCM, key).map_err(|_| "初始化加密器失败".to_string())?;
    Ok(LessSafeKey::new(unbound))
}

/// 加密成二进制 `nonce || ciphertext || tag`。
/// 容器文件（加密备份）用这个：整库快照是二进制，没必要再转一层十六进制。
pub fn seal_bytes(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let key = aead_key(key)?;
    let mut nonce_bytes = [0u8; NONCE_LEN];
    SystemRandom::new()
        .fill(&mut nonce_bytes)
        .map_err(|_| "生成随机数失败".to_string())?;
    let nonce = Nonce::assume_unique_for_key(nonce_bytes);
    let mut in_out = plaintext.to_vec();
    key.seal_in_place_append_tag(nonce, Aad::from(aad), &mut in_out)
        .map_err(|_| "加密失败".to_string())?;
    let mut payload = nonce_bytes.to_vec();
    payload.extend_from_slice(&in_out);
    Ok(payload)
}

/// 解密 `nonce || ciphertext || tag`。AAD 或密钥不对都会失败。
pub fn open_bytes(key: &[u8; 32], aad: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    if blob.len() <= NONCE_LEN {
        return Err("密文长度不正确".to_string());
    }
    let (nonce_bytes, cipher_text) = blob.split_at(NONCE_LEN);
    let nonce = Nonce::try_assume_unique_for_key(nonce_bytes)
        .map_err(|_| "密文 nonce 不正确".to_string())?;
    let key = aead_key(key)?;
    let mut buf = cipher_text.to_vec();
    let plain = key
        .open_in_place(nonce, Aad::from(aad), &mut buf)
        .map_err(|_| "解密失败（密码错误或数据已损坏）".to_string())?;
    Ok(plain.to_vec())
}

/// 加密并返回 `encn:v1:<hex(nonce || ciphertext || tag)>`。
/// `aad` 必须绑定作用对象，防止密文被挪到别的笔记/字段后仍能解开。
pub fn seal(key: &[u8; 32], aad: &[u8], plaintext: &[u8]) -> Result<String, String> {
    let payload = seal_bytes(key, aad, plaintext)?;
    Ok(format!("{ENCN_PREFIX}{}", hex_encode(&payload)))
}

/// 解密 `encn:v1:` 密文。AAD 或密码不对都会失败。
pub fn open(key: &[u8; 32], aad: &[u8], stored: &str) -> Result<Vec<u8>, String> {
    let Some(hex) = stored.strip_prefix(ENCN_PREFIX) else {
        return Err("密文格式不正确".to_string());
    };
    let raw = hex_decode(hex)?;
    open_bytes(key, aad, &raw)
}

pub fn open_text(key: &[u8; 32], aad: &[u8], stored: &str) -> Result<String, String> {
    let bytes = open(key, aad, stored)?;
    String::from_utf8(bytes).map_err(|_| "解密结果不是有效的文本".to_string())
}

pub fn is_encrypted(stored: &str) -> bool {
    stored.starts_with(ENCN_PREFIX)
}

pub fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn hex_decode(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err("密文格式不正确".to_string());
    }
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in bytes.chunks(2) {
        let hi = (pair[0] as char).to_digit(16).ok_or("密文格式不正确")?;
        let lo = (pair[1] as char).to_digit(16).ok_or("密文格式不正确")?;
        out.push(((hi << 4) | lo) as u8);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn derive_is_deterministic_and_salt_sensitive() {
        let a = derive_key("password123", b"0123456789abcdef", 1_000);
        let b = derive_key("password123", b"0123456789abcdef", 1_000);
        let c = derive_key("password123", b"abcdef0123456789", 1_000);
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn argon2_is_deterministic_and_salt_sensitive() {
        // 测试用极低参数，避免拖慢 cargo test
        let a = derive_argon2id("password123", b"0123456789abcdef", 16, 1, 1).unwrap();
        let b = derive_argon2id("password123", b"0123456789abcdef", 16, 1, 1).unwrap();
        let c = derive_argon2id("password123", b"abcdef0123456789", 16, 1, 1).unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn argon2_rejects_invalid_params() {
        assert!(derive_argon2id("password123", b"0123456789abcdef", 0, 1, 1).is_err());
    }

    #[test]
    fn seal_open_roundtrip() {
        let key = random_dek();
        let blob = seal(&key, b"aad", "机密内容".as_bytes()).unwrap();
        assert!(blob.starts_with(ENCN_PREFIX));
        assert_eq!(open_text(&key, b"aad", &blob).unwrap(), "机密内容");
    }

    #[test]
    fn seal_bytes_roundtrip_and_aad_binding() {
        let key = random_dek();
        let blob = seal_bytes(&key, b"backup-header", b"\x00\x01binary").unwrap();
        assert_eq!(open_bytes(&key, b"backup-header", &blob).unwrap(), b"\x00\x01binary");
        assert!(open_bytes(&key, b"other-header", &blob).is_err());
    }

    #[test]
    fn wrong_aad_and_key_fail() {
        let key = random_dek();
        let blob = seal(&key, b"note:1", b"secret").unwrap();
        assert!(open(&key, b"note:2", &blob).is_err());
        assert!(open(&random_dek(), b"note:1", &blob).is_err());
    }

    #[test]
    fn tampering_fails() {
        let key = random_dek();
        let blob = seal(&key, b"aad", b"secret").unwrap();
        let mut raw = hex_decode(blob.strip_prefix(ENCN_PREFIX).unwrap()).unwrap();
        let last = raw.len() - 1;
        raw[last] ^= 0x01;
        let tampered = format!("{ENCN_PREFIX}{}", hex_encode(&raw));
        assert!(open(&key, b"aad", &tampered).is_err());
    }
}
