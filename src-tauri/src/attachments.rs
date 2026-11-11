//! 笔记内图片附件：内容寻址落盘 + 自定义协议供 webview 加载。
//!
//! 为什么不是把图片塞进正文（base64）或数据库（BLOB）：
//! - 正文里内联会让 Markdown 体积 ×1.33，编辑器按逻辑行虚拟化、行内解析逐字符扫描，
//!   一行几十万字符的 base64 会直接拖慢输入；内容寻址后正文只多一行短路径。
//! - 进 BLOB 则库文件随图片线性膨胀，WAL / VACUUM 都会变慢；元数据进库、字节进盘更合适。
//!
//! 存储布局（`<数据目录>/attachments/`，与 fastnote.db 同级）：
//!
//! ```text
//! attachments/
//!   3f/                      # sha256 前两位分桶，避免单目录堆上万个文件
//!     3f9c2a8e1d4b6c7a.png   # 文件名 = 内容 sha256 前 16 位十六进制
//! ```
//!
//! 内容寻址带来的两个直接好处：
//! 1. 同一张图贴进十篇笔记只存一份，重复粘贴不重复占盘；
//! 2. 把一段 `![](attachments/xx/hash.png)` 从一篇笔记复制到另一篇仍然有效
//!    （路径是全局的，不绑笔记 id）。
//!
//! 回收：正文与**历史快照**里的引用都算数（回滚一次笔记不能让图消失），
//! 因此 GC 是「扫正文收集引用集合 → 删未引用且超过宽限期的文件」，见 `gc_attachments`。
//!
//! 协议：`fastnote-asset://attachments/xx/hash.png`（Windows 上是
//! `http://fastnote-asset.localhost/...`，与插件协议同一套平台差异），
//! 只服务 attachments 根目录内、文件名严格符合内容寻址规则的文件，不做任意文件读取。

use std::collections::HashSet;
use std::path::PathBuf;
use std::time::{Duration, SystemTime};

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::http::{Request, Response};
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// 协议名（lib.rs 里 register_uri_scheme_protocol 注册用）
pub const ASSET_SCHEME: &str = "fastnote-asset";

/// 附件根目录名（数据目录下）
pub const ATTACHMENTS_DIR: &str = "attachments";

/// 单张图片上限：20 MB。超过直接拒绝，不进 IPC、不落盘
const MAX_BYTES: usize = 20 * 1024 * 1024;

/// 内容哈希截断长度（十六进制字符数）：64 bit，本地笔记库的量级不会撞
const HASH_LEN: usize = 16;

/// 落盘 + 入库后返回给前端的元数据
#[derive(Debug, Clone, Serialize)]
pub struct AttachmentMeta {
    /// 内容哈希（截断 16 hex）
    pub hash: String,
    /// Markdown 里写的相对路径：`attachments/xx/hash.ext`
    pub path: String,
    pub mime: String,
    pub bytes: i64,
    /// 像素宽高由前端读 naturalWidth 传上来：后端不解析图片，省一个 image 依赖
    pub width: i64,
    pub height: i64,
}

/// 占用统计（设置页展示）
#[derive(Debug, Serialize)]
pub struct AttachmentUsage {
    pub count: i64,
    pub bytes: i64,
}

/// 回收结果
#[derive(Debug, Serialize)]
pub struct GcReport {
    pub removed: i64,
    pub freed: i64,
}

/* ---------------- 路径与类型 ---------------- */

/// 附件根目录（数据目录下的 attachments/），不存在则创建
fn attachments_root(app: &AppHandle) -> Result<PathBuf, String> {
    let data_dir = crate::resolve_data_dir(app.path().app_data_dir().ok());
    let dir = data_dir.join(ATTACHMENTS_DIR);
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建图片目录失败：{e}"))?;
    Ok(dir)
}

/// MIME → 扩展名；只认图片白名单，其余一律拒绝（防把任意文件塞进附件目录）
fn ext_for_mime(mime: &str) -> Result<&'static str, String> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/gif" => Ok("gif"),
        "image/webp" => Ok("webp"),
        "image/svg+xml" => Ok("svg"),
        other => Err(format!("不支持的图片类型：{other}")),
    }
}

/// 扩展名 → MIME（协议响应用）
fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => "application/octet-stream",
    }
}

fn is_hex(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

/// 内容哈希：sha256 前 16 个十六进制字符
fn content_hash(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut hex = String::with_capacity(HASH_LEN);
    for byte in digest.iter() {
        hex.push_str(&format!("{byte:02x}"));
        if hex.len() >= HASH_LEN {
            break;
        }
    }
    hex.truncate(HASH_LEN);
    hex
}

/// Markdown 里的相对路径 → (hash, ext)。严格三段的 `attachments/xx/hash.ext`。
fn parse_rel_path(rel: &str) -> Option<(String, String)> {
    let rest = rel.strip_prefix("attachments/")?;
    let mut parts = rest.split('/');
    let bucket = parts.next()?;
    let file = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if bucket.len() != 2 || !is_hex(bucket) {
        return None;
    }
    let (hash, ext) = file.rsplit_once('.')?;
    if hash.len() != HASH_LEN || !is_hex(hash) || !hash.starts_with(bucket) {
        return None;
    }
    if !matches!(ext, "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg") {
        return None;
    }
    Some((hash.to_string(), ext.to_string()))
}

/* ---------------- 命令 ---------------- */

/// 保存图片：算哈希 → 已存在就复用 → 落盘 → 元数据入库 → 返回相对路径。
///
/// 字节走 IPC 的 **raw body**（前端 `invoke(cmd, new Uint8Array(...))`），
/// 不走 JSON 数组：一张 5 MB 的截图序列化成 `[137,80,78,71,…]` 会变成几十 MB 文本，
/// 解析开销与内存峰值都不可接受。mime 与宽高放在请求头里（`InvokeOptions.headers`）。
///
/// 重复粘贴同一张图不会重复写盘（`created_at` 也不刷新），前端拿到的 path 永远一致。
#[tauri::command]
pub fn save_attachment(
    app: AppHandle,
    state: State<AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<AttachmentMeta, String> {
    let data: &[u8] = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes.as_slice(),
        _ => return Err("图片必须以二进制方式提交".to_string()),
    };
    if data.is_empty() {
        return Err("图片是空的（可能是剪贴板里只有文件路径）".to_string());
    }
    if data.len() > MAX_BYTES {
        return Err(format!("图片不能超过 {} MB", MAX_BYTES / 1024 / 1024));
    }
    let header = |name: &str| -> Option<String> {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(|v| v.trim().to_string())
    };
    let mime = header("x-image-mime").unwrap_or_else(|| "image/png".to_string());
    let width: i64 = header("x-image-width")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let height: i64 = header("x-image-height")
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);

    let ext = ext_for_mime(&mime)?;
    let hash = content_hash(data);
    let bucket = hash[..2].to_string();
    let bytes_len = data.len() as i64;

    let root = attachments_root(&app)?;
    let bucket_dir = root.join(&bucket);
    std::fs::create_dir_all(&bucket_dir).map_err(|e| format!("创建图片分桶目录失败：{e}"))?;
    let file = bucket_dir.join(format!("{hash}.{ext}"));
    if !file.is_file() {
        std::fs::write(&file, data).map_err(|e| format!("写入图片失败：{e}"))?;
    }

    let created_at = chrono::Local::now().to_rfc3339();
    {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        conn.execute(
            "INSERT INTO attachments (hash, ext, mime, bytes, width, height, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(hash) DO NOTHING",
            params![hash, ext, mime, bytes_len, width.max(0), height.max(0), created_at],
        )
        .map_err(|e| format!("保存图片元数据失败：{e}"))?;
    }

    Ok(AttachmentMeta {
        path: format!("attachments/{bucket}/{hash}.{ext}"),
        hash,
        mime,
        bytes: bytes_len,
        width: width.max(0),
        height: height.max(0),
    })
}

/// 批量查元数据：预览要按宽高提前占位，避免图片解码完把行高撑开。
/// 非附件路径（远程链接、不认识的相对路径）返回 None，前端回落默认占位。
#[tauri::command]
pub fn get_attachment_meta(
    state: State<AppState>,
    paths: Vec<String>,
) -> Result<Vec<Option<AttachmentMeta>>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let mut out = Vec::with_capacity(paths.len());
    for path in &paths {
        let meta = match parse_rel_path(path) {
            Some((hash, ext)) => conn
                .query_row(
                    "SELECT hash, mime, bytes, width, height FROM attachments WHERE hash = ?1",
                    params![hash],
                    |row| {
                        Ok(AttachmentMeta {
                            hash: row.get(0)?,
                            path: path.clone(),
                            mime: row.get(1)?,
                            bytes: row.get(2)?,
                            width: row.get(3)?,
                            height: row.get(4)?,
                        })
                    },
                )
                .optional()
                .map_err(|e| format!("读取图片信息失败：{e}"))?
                .or_else(|| {
                    // 文件在、元数据丢了（手工拷过数据目录）：仍返回路径，宽度留 0 由前端兜底
                    let _ = ext;
                    None
                }),
            None => None,
        };
        out.push(meta);
    }
    Ok(out)
}

/// 占用统计：张数与总体积
#[tauri::command]
pub fn attachments_usage(state: State<AppState>) -> Result<AttachmentUsage, String> {
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(bytes), 0) FROM attachments",
        [],
        |row| {
            Ok(AttachmentUsage {
                count: row.get(0)?,
                bytes: row.get(1)?,
            })
        },
    )
    .map_err(|e| format!("统计图片占用失败：{e}"))
}

/// 从一段 Markdown 里收集被引用的图片哈希。
///
/// 不用正则：命名是固定的 `attachments/<2 hex>/<16 hex>.<ext>`，
/// 顺序扫描子串再就地校验比编译正则快得多，也不引入额外依赖。
fn collect_refs(text: &str, out: &mut HashSet<String>) {
    for (start, _end) in scan_attachment_paths(text) {
        // 路径形如 attachments/xx/hash.ext：hash 从第 16 个字符开始，长 16
        if let Some(hash) = text[start + "attachments/".len() + 3..].get(..HASH_LEN) {
            if is_hex(hash) {
                out.insert(hash.to_string());
            }
        }
    }
}

/// 扫描正文里所有附件相对路径的**字节区间**（`[start, end)`）。
///
/// 只认严格形状：`attachments/` + 2 位十六进制桶 + `/` + 16 位十六进制 + `.` + 图片扩展名。
/// GC、导出打包、单文件内联三处都靠它，保证「什么算一张图」只有一套判定。
fn scan_attachment_paths(text: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    if !text.contains("attachments/") {
        return out;
    }
    let bytes = text.as_bytes();
    let prefix = "attachments/";
    let mut from = 0usize;
    while let Some(pos) = text[from..].find(prefix) {
        let start = from + pos;
        let mut cursor = start + prefix.len();
        let ok = (|| {
            if cursor + 3 > bytes.len() || !is_hex(&text[cursor..cursor + 2]) || bytes[cursor + 2] != b'/' {
                return false;
            }
            cursor += 3;
            if cursor + HASH_LEN + 1 > bytes.len() || !is_hex(&text[cursor..cursor + HASH_LEN]) {
                return false;
            }
            cursor += HASH_LEN;
            if bytes[cursor] != b'.' {
                return false;
            }
            cursor += 1;
            let ext_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_alphabetic() {
                cursor += 1;
            }
            matches!(&text[ext_start..cursor], "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg")
        })();
        if ok {
            out.push((start, cursor));
            from = cursor;
        } else {
            from = start + prefix.len();
        }
    }
    out
}

/// 正文里出现的全部附件相对路径（去重，导出打包用）
pub(crate) fn collect_attachment_paths(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    for (start, end) in scan_attachment_paths(text) {
        let path = &text[start..end];
        if seen.insert(path) {
            out.push(path.to_string());
        }
    }
    out
}

/// 按 `map` 的返回值改写正文里的附件路径（返回 None 表示保持原样）。
///
/// 导出用：单文件 HTML 换成 data URI、EPUB 换成包内 `images/…`，
/// 其余非图片内容一字不动（不重新渲染 Markdown，保留原始写法）。
pub(crate) fn map_attachment_paths(text: &str, map: &dyn Fn(&str) -> Option<String>) -> String {
    let ranges = scan_attachment_paths(text);
    if ranges.is_empty() {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut cursor = 0usize;
    for (start, end) in ranges {
        out.push_str(&text[cursor..start]);
        let path = &text[start..end];
        match map(path) {
            Some(replaced) => out.push_str(&replaced),
            None => out.push_str(path),
        }
        cursor = end;
    }
    out.push_str(&text[cursor..]);
    out
}

/// 读附件字节（导出打包 / 备份内联用）；路径不合法或文件缺失返回 None
pub(crate) fn read_attachment_bytes(app: &AppHandle, rel: &str) -> Option<Vec<u8>> {
    let (hash, ext) = parse_rel_path(rel)?;
    let root = attachments_root(app).ok()?;
    std::fs::read(root.join(&hash[..2]).join(format!("{hash}.{ext}"))).ok()
}

/// 把附件字节写回磁盘（备份恢复用）；已存在则跳过，保证重复导入是幂等的
pub(crate) fn restore_attachment(app: &AppHandle, rel: &str, bytes: &[u8]) -> Result<(), String> {
    let (hash, ext) = parse_rel_path(rel).ok_or_else(|| format!("非法的图片路径：{rel}"))?;
    let root = attachments_root(app)?;
    let bucket = root.join(&hash[..2]);
    std::fs::create_dir_all(&bucket).map_err(|e| format!("创建图片目录失败：{e}"))?;
    let file = bucket.join(format!("{hash}.{ext}"));
    if file.is_file() {
        return Ok(());
    }
    std::fs::write(&file, bytes).map_err(|e| format!("写入图片失败：{e}"))
}

/// 标准 base64 编码（单文件导出 / JSON 备份把图片内联进文本时用）
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let group = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((group >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((group >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[((group >> 6) & 0x3f) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(group & 0x3f) as usize] as char } else { '=' });
    }
    out
}

/// 标准 base64 解码（JSON 备份恢复用）；遇到非法字符返回 None
pub(crate) fn base64_decode(text: &str) -> Option<Vec<u8>> {
    let mut table = [255u8; 256];
    for (index, byte) in b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".iter().enumerate() {
        table[*byte as usize] = index as u8;
    }
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer = 0u32;
    let mut bits = 0u32;
    for byte in text.bytes() {
        if byte == b'=' || byte == b'\n' || byte == b'\r' {
            continue;
        }
        let value = table[byte as usize];
        if value == 255 {
            return None;
        }
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buffer >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// 附件相对路径对应的 MIME（导出内联时用）
pub(crate) fn mime_of_attachment(rel: &str) -> &'static str {
    let ext = rel.rsplit_once('.').map(|(_, ext)| ext).unwrap_or("");
    mime_for_ext(ext)
}

/// 回收未被引用的图片。
///
/// 引用来源包含 `notes` 与 `notes_history`：历史快照里的引用也算「还在用」，
/// 否则回滚一次笔记，图就被当成垃圾删了。
///
/// 宽限期（`grace_days`）兜三类边缘情况：撤销后正要重新插入、剪贴板里还放着旧文本、
/// 备份尚未完成。只有「没人引用 + 落盘超过宽限期」的文件才会被删除。
#[tauri::command(async)]
pub fn gc_attachments(app: AppHandle, state: State<AppState>, grace_days: u32) -> Result<GcReport, String> {
    // 1) 收集引用（锁内只做查询，尽快释放，避免与保存/编辑抢锁）
    let mut referenced: HashSet<String> = HashSet::new();
    {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        let mut stmt = conn
            .prepare("SELECT content FROM notes UNION ALL SELECT content FROM notes_history")
            .map_err(|e| format!("读取笔记正文失败：{e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("读取笔记正文失败：{e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("读取笔记正文失败：{e}"))? {
            let content: String = row.get(0).unwrap_or_default();
            collect_refs(&content, &mut referenced);
        }
    }

    // 2) 扫盘，删未引用且超过宽限期的文件
    let root = attachments_root(&app)?;
    let grace = Duration::from_secs(u64::from(grace_days) * 24 * 60 * 60);
    let now = SystemTime::now();
    let mut removed: i64 = 0;
    let mut freed: i64 = 0;
    let mut gone: Vec<String> = Vec::new();

    let buckets = std::fs::read_dir(&root).map_err(|e| format!("读取图片目录失败：{e}"))?;
    for bucket in buckets.flatten() {
        let path = bucket.path();
        if !path.is_dir() {
            continue;
        }
        let files = match std::fs::read_dir(&path) {
            Ok(files) => files,
            Err(_) => continue,
        };
        for file in files.flatten() {
            let file_path = file.path();
            let name = file.file_name().to_string_lossy().to_string();
            let Some((hash, _ext)) = name.rsplit_once('.') else {
                continue;
            };
            if !is_hex(hash) || hash.len() != HASH_LEN {
                continue;
            }
            if referenced.contains(hash) {
                continue;
            }
            let meta = file.metadata().ok();
            let fresh = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| now.duration_since(t).ok())
                .map(|age| age < grace)
                .unwrap_or(false);
            if fresh {
                continue;
            }
            let size = meta.as_ref().map(|m| m.len() as i64).unwrap_or(0);
            if std::fs::remove_file(&file_path).is_ok() {
                removed += 1;
                freed += size;
                gone.push(hash.to_string());
            }
        }
        // 空分桶目录顺手清掉，别留一堆空目录
        let _ = std::fs::remove_dir(&path);
    }

    // 3) 清掉对应的元数据行（上面拿到的哈希可能重复，用集合去重）
    if !gone.is_empty() {
        gone.sort();
        gone.dedup();
        if let Ok(conn) = state.conn.lock() {
            for hash in &gone {
                let _ = conn.execute("DELETE FROM attachments WHERE hash = ?1", params![hash]);
            }
        }
    }

    Ok(GcReport { removed, freed })
}

/* ---------------- 删除笔记后回收图片 ---------------- */

/// 取一批笔记（正文 + 它们的历史快照）引用到的图片路径。
///
/// **必须在删除笔记之前调用**：删完以后正文就没了，图片路径再也无从得知。
pub(crate) fn collect_notes_attachment_paths(conn: &Connection, note_ids: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if note_ids.is_empty() {
        return out;
    }
    let mut push = |content: &str| {
        for path in collect_attachment_paths(content) {
            if !out.contains(&path) {
                out.push(path);
            }
        }
    };

    if let Ok(mut stmt) = conn.prepare("SELECT content FROM notes WHERE id = ?1") {
        for id in note_ids {
            if let Ok(content) = stmt.query_row(params![id], |row| row.get::<_, String>(0)) {
                push(&content);
            }
        }
    }
    if let Ok(mut stmt) = conn.prepare("SELECT content FROM notes_history WHERE note_id = ?1") {
        for id in note_ids {
            if let Ok(rows) = stmt.query_map(params![id], |row| row.get::<_, String>(0)) {
                for content in rows.flatten() {
                    push(&content);
                }
            }
        }
    }
    out
}

/// 笔记彻底删除**之后**调用：把已经没人引用的图片连同元数据一起删掉。
///
/// 为什么还要再扫一遍全库：图片是内容寻址的，同一张图可能被别的笔记（或别的笔记的
/// 历史快照）引用着。直接按「这篇笔记用到的图」删，会把别人的图一起删掉。
///
/// 文件删完后尝试删分桶目录：`remove_dir` 只在目录为空时成功，
/// 因此「空了才删、还有文件就保留」是天然满足的，不需要自己数文件。
pub(crate) fn purge_unreferenced_attachments(
    app: &AppHandle,
    conn: &Connection,
    candidates: &[String],
) -> Result<usize, String> {
    if candidates.is_empty() {
        return Ok(0);
    }
    // 1) 剩下的正文 + 历史快照里还有谁在引用
    //
    // 先用 `LIKE '%attachments/%'` 在 SQLite 里过一遍：这一步仍然扫全表，但只把**含图片
    // 路径的行**带回 Rust。不预筛的话，1500 条历史快照（实测 392 MB）会被整份读进内存，
    // 每次删笔记都要分配几百 MB——这正是「删除、清空回收站变慢」的来源之一。
    // 用 LIKE 而不是 instr：两者在 SQL 层都是全表扫，但 LIKE 对 ASCII 大小写不敏感，
    // 正文里写成大写时也不会整行漏掉（Rust 侧仍按严格的小写形状判定）。
    let mut referenced: HashSet<String> = HashSet::new();
    {
        let mut stmt = conn
            .prepare(
                "SELECT content FROM notes WHERE content LIKE '%attachments/%'
                 UNION ALL
                 SELECT content FROM notes_history WHERE content LIKE '%attachments/%'",
            )
            .map_err(|e| format!("读取笔记正文失败：{e}"))?;
        let mut rows = stmt.query([]).map_err(|e| format!("读取笔记正文失败：{e}"))?;
        while let Some(row) = rows.next().map_err(|e| format!("读取笔记正文失败：{e}"))? {
            let content: String = row.get(0).unwrap_or_default();
            collect_refs(&content, &mut referenced);
        }
    }

    let root = attachments_root(app)?;
    let mut removed = 0usize;
    // 同一张图可能在候选里出现多次（不同笔记/历史），按 hash 去重后再动手
    let mut seen: HashSet<String> = HashSet::new();
    for path in candidates {
        let Some((hash, ext)) = parse_rel_path(path) else {
            continue;
        };
        if referenced.contains(&hash) || !seen.insert(hash.clone()) {
            continue;
        }
        let bucket = root.join(&hash[..2]);
        let file = bucket.join(format!("{hash}.{ext}"));
        if std::fs::remove_file(&file).is_ok() {
            removed += 1;
        }
        // 文件可能早就不在了：元数据行照样清掉，避免库里留着指向空气的记录
        let _ = conn.execute("DELETE FROM attachments WHERE hash = ?1", params![hash]);
        // 分桶目录空了就顺手删掉；还有别的图时这里会失败，正好保留
        let _ = std::fs::remove_dir(&bucket);
    }
    // 整个 attachments 目录都空了也收掉；有残留文件时同样会失败并保留
    let _ = std::fs::remove_dir(&root);

    Ok(removed)
}

/* ---------------- 协议 ---------------- */

fn respond(status: u16, content_type: &str, body: Vec<u8>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header("Content-Type", content_type)
        // 内容寻址：URL 变了内容才会变，可以永久缓存
        .header("Cache-Control", "public, max-age=31536000, immutable")
        .header("Access-Control-Allow-Origin", "*")
        .body(body)
        .expect("构建图片响应失败")
}

fn fail(status: u16, message: &str) -> Response<Vec<u8>> {
    respond(status, "text/plain; charset=utf-8", message.as_bytes().to_vec())
}

/// 协议 handler：`/attachments/xx/hash.ext` → 磁盘文件字节。
///
/// 安全边界：路径必须严格符合内容寻址规则（2 hex 桶 + 16 hex 文件名 + 图片扩展名），
/// 白名单字符集天然排除 `..`、反斜杠与绝对路径，因此不会读到附件目录之外的文件。
pub fn handle_asset_request(app: &AppHandle, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let path = request.uri().path().trim_start_matches('/');
    let Some((hash, ext)) = parse_rel_path(path) else {
        return fail(403, "非法的图片路径");
    };
    let root = match attachments_root(app) {
        Ok(root) => root,
        Err(e) => return fail(500, &e),
    };
    let file = root.join(&hash[..2]).join(format!("{hash}.{ext}"));
    match std::fs::read(&file) {
        Ok(bytes) => respond(200, mime_for_ext(&ext), bytes),
        Err(_) => fail(404, "图片不存在"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rel_path_accepts_canonical_shape() {
        let (hash, ext) = parse_rel_path("attachments/3f/3f9c2a8e1d4b6c7a.png").expect("应通过");
        assert_eq!(hash, "3f9c2a8e1d4b6c7a");
        assert_eq!(ext, "png");
    }

    #[test]
    fn rel_path_rejects_traversal_and_mismatch() {
        // 目录穿越、桶与哈希前缀不一致、扩展名不在白名单：一律拒绝
        assert!(parse_rel_path("attachments/3f/../../fastnote.db").is_none());
        assert!(parse_rel_path("attachments/3f/aa9c2a8e1d4b6c7a.png").is_none());
        assert!(parse_rel_path("attachments/3f/3f9c2a8e1d4b6c7a.exe").is_none());
        assert!(parse_rel_path("attachments/3f/3f9c2a8e1d4b6c7a").is_none());
    }

    #[test]
    fn scan_finds_paths_and_skips_noise() {
        let text = "看图 ![a](attachments/3f/3f9c2a8e1d4b6c7a.png) 和 \
                    ![b](attachments/ab/ab01d9c7e5f3b2a1.jpg) \
                    以及不是图片的 attachments/zz/xx.txt";
        let paths = collect_attachment_paths(text);
        assert_eq!(
            paths,
            vec![
                "attachments/3f/3f9c2a8e1d4b6c7a.png".to_string(),
                "attachments/ab/ab01d9c7e5f3b2a1.jpg".to_string(),
            ]
        );
    }

    #[test]
    fn map_rewrites_only_attachment_paths() {
        let text = "![a](attachments/3f/3f9c2a8e1d4b6c7a.png) 与 ![b](https://x/y.png)";
        let out = map_attachment_paths(text, &|path| Some(format!("<{path}>")));
        assert!(out.contains("<attachments/3f/3f9c2a8e1d4b6c7a.png>"));
        // 远程链接原样保留，不会被误改写
        assert!(out.contains("https://x/y.png"));
    }

    #[test]
    fn base64_roundtrip() {
        for sample in [b"a".as_slice(), b"ab", b"abc", b"abcd", b"\x00\xff\x10\x20\x30"] {
            let encoded = base64_encode(sample);
            let decoded = base64_decode(&encoded).expect("应能解码");
            assert_eq!(decoded, sample.to_vec(), "base64 往返失败：{encoded}");
        }
    }

    #[test]
    fn collect_paths_covers_note_and_history() {
        // 历史快照也算引用：删笔记时要把它一起算进来，否则回滚链上的图会被误删
        let conn = Connection::open_in_memory().expect("内存库");
        conn.execute_batch(
            "CREATE TABLE notes (id TEXT PRIMARY KEY, content TEXT NOT NULL);
             CREATE TABLE notes_history (id INTEGER PRIMARY KEY, note_id TEXT, content TEXT);",
        )
        .expect("建表");
        conn.execute(
            "INSERT INTO notes VALUES ('n1', '![a](attachments/3f/3f9c2a8e1d4b6c7a.png)')",
            [],
        )
        .expect("插入笔记");
        conn.execute(
            "INSERT INTO notes_history (note_id, content) VALUES ('n1', '![b](attachments/ab/ab01d9c7e5f3b2a1.jpg)')",
            [],
        )
        .expect("插入历史");

        let paths = collect_notes_attachment_paths(&conn, &["n1".to_string()]);
        assert_eq!(paths.len(), 2, "正文与历史各一张，应该都收集到：{paths:?}");
        // 不存在的 note id 不会误伤
        assert!(collect_notes_attachment_paths(&conn, &["nope".to_string()]).is_empty());
    }

    #[test]
    fn hash_is_stable_and_truncated() {
        let first = content_hash(b"hello");
        let second = content_hash(b"hello");
        assert_eq!(first, second);
        assert_eq!(first.len(), HASH_LEN);
        assert!(is_hex(&first));
        assert_ne!(first, content_hash(b"hello!"));
    }
}
