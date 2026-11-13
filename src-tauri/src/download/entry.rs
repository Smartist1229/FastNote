use super::*;

/// 入口预检结果：实际要下载的地址 + 能拿到的文件名
pub(crate) struct Entry {
    /// 实际发起请求的地址。普通跳转沿用原始链接（保留 Referer 跟随），
    /// 落地页则换成页面里解析出的真实地址。
    pub(crate) url: String,
    /// 建议文件名：优先 `Content-Disposition`，其次跳转后地址的路径名
    pub(crate) filename: Option<String>,
}

/// 预检入口链接：跟随 HTTP 跳转；如果最终拿到的是网页（下载落地页），
/// 就从 HTML 里找真实文件地址（meta refresh / JS 跳转 / 带文件扩展名的链接），
/// 最多跟 [`ENTRY_HOPS`] 跳。
///
/// 两类“看不到文件地址”的链接都在这里解决：
/// - 入口脚本 301/302 到真实文件（`downloadHr60.php?pro=hr60` → `….exe`）：
///   传输本来就会跟随跳转，但文件名要取最终地址，入口脚本名没有意义；
/// - 下载落地页：文件地址由页面里的 JS 拼出来，HTTP 层没有跳转，
///   只能解析页面。解析不到就报错——把网页当文件存下来只会让人困惑。
pub(crate) async fn resolve_entry(
    client: &Client,
    url: &str,
    control: Option<&Control>,
) -> Result<Entry, String> {
    let no_file = "这个链接返回的是网页，没有找到可下载的文件地址".to_string();
    let mut current = url.to_string();
    for _ in 0..ENTRY_HOPS {
        let response = entry_response(client, &current, control).await?;
        let final_url = response.url().clone();
        let disposition = response
            .headers()
            .get(reqwest::header::CONTENT_DISPOSITION)
            .and_then(|value| value.to_str().ok())
            .and_then(filename_from_disposition);

        if !is_html(&response) {
            return Ok(Entry {
                url: current,
                filename: disposition.or_else(|| filename_from_path(final_url.as_str())),
            });
        }

        // 带 Range 的探测对网页只拿到了 1 字节，得整页重取一次
        let page = if response.status() == StatusCode::PARTIAL_CONTENT {
            send_get(client, final_url.as_str(), control).await?
        } else {
            response
        };
        let html = read_limited(page, HTML_LIMIT).await;
        let Some(next) = download_url_from_html(&html, &final_url) else {
            return Err(no_file);
        };
        if next == final_url {
            return Err(no_file);
        }
        current = next.to_string();
    }
    Err("链接经过多次跳转仍未指向文件".to_string())
}

/// 先带 `Range: bytes=0-0` 探测（支持分段的站点只回 1 字节），
/// 被拒时退回普通 GET——有些站对带 Range 的请求直接 400/403。
pub(crate) async fn entry_response(
    client: &Client,
    url: &str,
    control: Option<&Control>,
) -> Result<Response, String> {
    let response = tokio::select! {
        reason = wait_stop(control) => return Err(reason.to_string()),
        result = client.get(url).header(reqwest::header::RANGE, "bytes=0-0").send() => {
            result.map_err(|e| format!("请求失败：{e}"))?
        }
    };
    if response.status().is_success() {
        return Ok(response);
    }
    send_get(client, url, control).await
}

pub(crate) async fn send_get(
    client: &Client,
    url: &str,
    control: Option<&Control>,
) -> Result<Response, String> {
    let response = tokio::select! {
        reason = wait_stop(control) => return Err(reason.to_string()),
        result = client.get(url).send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    if response.status().is_success() {
        Ok(response)
    } else {
        Err(format!("HTTP {}", response.status()))
    }
}

pub(crate) fn is_html(response: &Response) -> bool {
    response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| {
            let value = value.to_ascii_lowercase();
            value.contains("text/html") || value.contains("application/xhtml")
        })
}

/// 读响应体前 `limit` 字节：落地页解析只需要页面开头的链接，不整页拉下来
pub(crate) async fn read_limited(response: Response, limit: usize) -> String {
    let mut buffer = Vec::with_capacity(8192);
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let Ok(chunk) = chunk else { break };
        buffer.extend_from_slice(&chunk);
        if buffer.len() >= limit {
            break;
        }
    }
    buffer.truncate(limit);
    String::from_utf8_lossy(&buffer).into_owned()
}

/// 页面里只有带这些扩展名的链接才当作下载地址，避免把导航、图标、样式表误认成文件
pub(crate) const DOWNLOAD_EXTS: &[&str] = &[
    "exe", "msi", "msix", "zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst",
    "dmg", "pkg", "deb", "rpm", "apk", "iso", "pdf", "whl", "jar", "bin", "appimage",
    "mp4", "mkv", "mp3",
];

/// 从落地页里找真实下载地址，依次看：
/// 1. `<meta http-equiv="refresh" content="0;url=...">`
/// 2. JS 跳转：`location.href =` / `window.location =` / `location.replace(...)` / `assign(...)`
/// 3. `<a href="...">` 里带文件扩展名的链接
pub(crate) fn download_url_from_html(html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    // 只做 ASCII 小写：非 ASCII 字节原样保留，下标与原文一一对应，
    // 定位用小写副本，取值回原文（URL 大小写敏感）
    let lower = html.to_ascii_lowercase();
    meta_refresh_target(&lower, html, base)
        .or_else(|| js_location_target(&lower, html, base))
        .or_else(|| anchor_target(&lower, html, base))
}

pub(crate) fn meta_refresh_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("<meta") {
        let start = cursor + at;
        let Some(close) = lower[start..].find('>') else { break };
        let end = start + close;
        let tag = &lower[start..end];
        if tag.contains("http-equiv") && tag.contains("refresh") {
            if let Some(pos) = tag.find("content") {
                if let Some(value) = attr_value(tag, &html[start..end], pos) {
                    let value_lower = value.to_ascii_lowercase();
                    if let Some(url_pos) = value_lower.find("url") {
                        if let Some((_, raw)) = value[url_pos..].split_once('=') {
                            let raw = raw.trim().trim_matches(|c| c == '\'' || c == '"');
                            if let Some(url) = normalize_url(raw, base) {
                                return Some(url);
                            }
                        }
                    }
                }
            }
        }
        cursor = end + 1;
    }
    None
}

pub(crate) fn js_location_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("location") {
        let start = cursor + at;
        cursor = start + "location".len();
        let tail = &lower[cursor..];
        // 只认 `.href`、`.replace(`、`.assign(`，以及 `location = "..."` 这种直接赋值；
        // `regexp.location` 之类的正文不会被误当成跳转
        let op = if tail.starts_with(".href") {
            cursor + ".href".len()
        } else if tail.starts_with(".replace") {
            cursor + ".replace".len()
        } else if tail.starts_with(".assign") {
            cursor + ".assign".len()
        } else {
            let trimmed = tail.trim_start();
            if !trimmed.starts_with('=') {
                continue;
            }
            cursor + (tail.len() - trimmed.len())
        };
        // 符号前只允许空白，避免把 `location.href.indexOf(` 这类调用当成跳转
        let window = &lower[op..(op + 16).min(lower.len())];
        let Some(sign) = window.find(['=', '(']) else { continue };
        if !window[..sign].trim().is_empty() {
            continue;
        }
        if let Some(raw) = next_quoted(lower, html, op + sign + 1, 256) {
            if let Some(url) = normalize_url(&raw, base) {
                return Some(url);
            }
        }
    }
    None
}

pub(crate) fn anchor_target(lower: &str, html: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let mut cursor = 0;
    while let Some(at) = lower[cursor..].find("<a ") {
        let start = cursor + at;
        let Some(close) = lower[start..].find('>') else { break };
        let end = start + close;
        let (tag_lower, tag) = (&lower[start..end], &html[start..end]);
        if let Some(pos) = tag_lower.find("href") {
            if let Some(raw) = attr_value(tag_lower, tag, pos) {
                if let Some(url) = normalize_url(&raw, base) {
                    if has_download_ext(&url) {
                        return Some(url);
                    }
                }
            }
        }
        cursor = end + 1;
    }
    None
}

/// 取 `pos` 处属性 `key=` 后面的值（`pos` 是属性名起点），支持单/双引号与无引号。
/// `lower` 与 `source` 是同一段文本的大小写两版，返回值保留原文大小写。
pub(crate) fn attr_value(lower: &str, source: &str, pos: usize) -> Option<String> {
    let eq = lower[pos..].find('=')?;
    let rest = &source[pos + eq + 1..];
    let trimmed = rest.trim_start();
    let first = trimmed.chars().next()?;
    if first == '"' || first == '\'' {
        let body = &trimmed[1..];
        let end = body.find(first)?;
        Some(body[..end].to_string())
    } else {
        let end = trimmed
            .find(|c: char| c.is_whitespace() || c == '>' || c == '/')
            .unwrap_or(trimmed.len());
        Some(trimmed[..end].to_string())
    }
}

/// 从 `from` 开始找第一个引号字符串；超过 `limit` 字节说明不是 URL，放弃
pub(crate) fn next_quoted(lower: &str, html: &str, from: usize, limit: usize) -> Option<String> {
    let window = &lower[from..(from + limit).min(lower.len())];
    let offset = window.find(['"', '\''])?;
    let quote_at = from + offset;
    let quote = html.as_bytes()[quote_at];
    let body = &html[quote_at + 1..];
    let end = body.as_bytes().iter().position(|b| *b == quote)?;
    Some(body[..end].to_string())
}

pub(crate) fn normalize_url(raw: &str, base: &reqwest::Url) -> Option<reqwest::Url> {
    let raw = raw.trim().trim_matches(|c| c == '\'' || c == '"');
    if raw.is_empty() || raw.starts_with('#') {
        return None;
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("javascript:")
        || lower.starts_with("mailto:")
        || lower.starts_with("data:")
    {
        return None;
    }
    let url = base.join(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(url)
}

pub(crate) fn has_download_ext(url: &reqwest::Url) -> bool {
    let name = url
        .path()
        .rsplit('/')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    let Some(ext) = name.rsplit('.').next() else { return false };
    name.contains('.') && DOWNLOAD_EXTS.contains(&ext)
}

