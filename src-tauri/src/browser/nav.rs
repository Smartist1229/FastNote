use super::*;

/// 地址规范化：完整 URL 直接使用，裸域名补 https（本机地址补 http），搜索词走 Bing。
/// 非 http / https 的协议（mailto:、obsidian:、javascript: 等）一律拒绝，
/// 由调用方回退到系统浏览器。
pub(crate) fn normalize_url(raw: &str) -> Result<Url, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("链接为空".to_string());
    }
    let lower = raw.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return Url::parse(raw).map_err(|e| format!("地址无效：{e}"));
    }
    if let Some(scheme) = explicit_scheme(raw) {
        return Err(format!("不在软件内打开 {scheme}: 链接"));
    }
    let host_like = !raw.chars().any(char::is_whitespace)
        && (raw.contains('.')
            || lower.starts_with("localhost")
            || raw.starts_with("127.")
            || raw.starts_with("[::1]"));
    if host_like {
        /*
         * 本机地址用 http：localhost / 127.x / [::1] 的开发服务器默认没有 TLS，
         * 补成 https 会因证书或协议不匹配直接打不开。
         */
        let scheme = if is_loopback(raw) { "http" } else { "https" };
        return Url::parse(&format!("{scheme}://{}", raw))
            .map_err(|e| format!("地址无效：{e}"));
    }
    Url::parse(&format!(
        "https://www.bing.com/search?q={}",
        encode_query(raw)
    ))
    .map_err(|e| e.to_string())
}

/// 本机地址（`localhost` / `127.x` / `[::1]`）：这类开发服务器默认只监听 http。
pub(crate) fn is_loopback(raw: &str) -> bool {
    let lower = raw.to_ascii_lowercase();
    let host = lower.split(['/', '?', '#']).next().unwrap_or_default();
    host == "localhost"
        || host.starts_with("localhost:")
        || host.starts_with("127.")
        || host.starts_with("[::1]")
}

/// 提取「协议:」里的协议名；`host:port` 不算协议（端口是数字）。
pub(crate) fn explicit_scheme(raw: &str) -> Option<&str> {
    let (head, rest) = raw.split_once(':')?;
    if rest.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }
    let mut chars = head.chars();
    if !chars.next()?.is_ascii_alphabetic() {
        return None;
    }
    if head.contains('.')
        || !head
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-'))
    {
        return None;
    }
    Some(head)
}

pub(crate) fn encode_query(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{:02X}", other)),
        }
    }
    out
}

