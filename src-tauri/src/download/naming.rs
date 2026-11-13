use super::*;

/// 分片临时目录取下载文件名（去扩展名）：既按文件区分任务，又不会和最终文件同名冲突。
/// 文件名本身没有扩展名时追加 `-parts`，避免目录与最终文件同名。
pub(crate) fn staging_name(filename: &str) -> String {
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or(filename);
    if stem.is_empty() || stem == filename {
        format!("{filename}-parts")
    } else {
        stem.to_string()
    }
}

/// 准备 `download/<文件名>`：同名文件占位时追加后缀，并清掉上次异常退出留下的分片
pub(crate) async fn prepare_staging(root: &Path, name: &str) -> Result<PathBuf, String> {
    for attempt in 0..100 {
        let candidate = if attempt == 0 {
            root.join(name)
        } else {
            root.join(format!("{name}-{attempt}"))
        };
        match tokio::fs::metadata(&candidate).await {
            Ok(meta) if meta.is_dir() => {
                purge_part_files(&candidate).await;
                return Ok(candidate);
            }
            Ok(_) => continue,
            Err(_) => {
                tokio::fs::create_dir_all(&candidate)
                    .await
                    .map_err(|e| format!("创建分片目录失败：{e}"))?;
                return Ok(candidate);
            }
        }
    }
    Err("无法创建分片目录：同名文件过多".to_string())
}

/// 分片与下载计划都以 `.part` 命名，只清理这类文件，不动目录里的其他内容
pub(crate) async fn purge_part_files(dir: &Path) {
    let Ok(mut entries) = tokio::fs::read_dir(dir).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let is_file = entry
            .file_type()
            .await
            .map(|kind| kind.is_file())
            .unwrap_or(false);
        if !is_file {
            continue;
        }
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.contains(".part") {
            let _ = tokio::fs::remove_file(entry.path()).await;
        }
    }
}

/// 任务结束后删掉分片目录；目录里还有别的文件时保留，避免误删用户内容
pub(crate) async fn remove_staging(dir: &Path) {
    purge_part_files(dir).await;
    let _ = tokio::fs::remove_dir(dir).await;
}

/// 用户指定的文件名优先；留空或清理后为空时回退到链接推导
pub(crate) fn resolve_filename(url: &str, custom: Option<&str>) -> String {
    let name = custom.map(sanitize_filename).unwrap_or_default();
    if name.is_empty() {
        filename_from_url(url)
    } else {
        name
    }
}

/// 从链接路径最后一段取文件名；路径为空、以 `/` 结尾或只有 `.`/`..` 时返回 None
pub(crate) fn filename_from_path(raw: &str) -> Option<String> {
    let url = reqwest::Url::parse(raw).ok()?;
    let last = url.path_segments()?.next_back()?;
    let name = sanitize_filename(&percent_decode(last));
    if name.is_empty() || name == "." || name == ".." {
        None
    } else {
        Some(name)
    }
}

/// 从链接最后一段取文件名；取不到时用时间戳兜底。
/// 注意：这里只看原始链接。入口是脚本（`download.php?pro=x`）时，
/// 真实文件名在重定向之后，由 [`suggest_filename`] 负责取。
pub fn filename_from_url(raw: &str) -> String {
    filename_from_path(raw).unwrap_or_else(|| {
        format!(
            "download-{}.bin",
            chrono::Local::now().format("%Y%m%d-%H%M%S")
        )
    })
}

/// 从 `Content-Disposition` 取文件名：优先 RFC 5987 的 `filename*`，其次 `filename`。
pub(crate) fn filename_from_disposition(value: &str) -> Option<String> {
    let mut plain = None;
    for part in value.split(';').skip(1) {
        let Some((key, raw)) = part.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let raw = raw.trim();
        if key == "filename*" {
            // 形如 UTF-8''%E4%B8%AD%E6%96%87.zip：取第二个单引号之后的部分
            let encoded = raw.splitn(3, '\'').nth(2).unwrap_or(raw);
            let name = sanitize_filename(&percent_decode(encoded.trim_matches('"')));
            if !name.is_empty() {
                return Some(name);
            }
        } else if key == "filename" {
            let name = sanitize_filename(raw.trim_matches('"'));
            if !name.is_empty() {
                plain = Some(name);
            }
        }
    }
    plain
}

/// 重名时追加 ` (1)`、` (2)`…，不覆盖用户已有文件
pub fn unique_dest(dir: &Path, filename: &str) -> PathBuf {
    let candidate = dir.join(filename);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(filename);
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(filename);
    let ext = path.extension().and_then(|s| s.to_str());
    for n in 1..10_000 {
        let name = match ext {
            Some(ext) => format!("{stem} ({n}).{ext}"),
            None => format!("{stem} ({n})"),
        };
        let next = dir.join(name);
        if !next.exists() {
            return next;
        }
    }
    dir.join(format!(
        "{stem}-{}.bin",
        chrono::Local::now().format("%Y%m%d-%H%M%S")
    ))
}

pub(crate) fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) = (hex(bytes[index + 1]), hex(bytes[index + 2])) {
                out.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub(crate) fn hex(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

/// Windows 不允许的字符统一换成下划线，避免下载完才发现存不下来
pub(crate) fn sanitize_filename(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim().to_string();
    if trimmed.chars().count() > 120 {
        trimmed.chars().take(120).collect()
    } else {
        trimmed
    }
}

/* ---------- 工具箱命令 ---------- */

