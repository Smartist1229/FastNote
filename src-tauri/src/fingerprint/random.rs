use super::*;

/// 系统随机源；拿不到随机数属于环境异常，直接 panic 比悄悄退化成固定指纹更安全
pub(crate) fn next_u64() -> u64 {
    let mut bytes = [0u8; 8];
    SystemRandom::new()
        .fill(&mut bytes)
        .expect("系统随机源不可用");
    u64::from_le_bytes(bytes)
}

pub(crate) fn pick<T>(items: &[T]) -> &T {
    &items[(next_u64() % items.len() as u64) as usize]
}

/// 内置浏览器用：按本机时区挑语言画像。时区与语言必须跟出口 IP 对得上，
/// 否则指纹检测会直接判「时区不同 / 语言不符」。
///
/// 先按本机时区的完整名字精确匹配：同一偏移的不同时区（Asia/Shanghai 与
/// Asia/Taipei 都是 UTC+8）在检测方看来是两个地方，随机挑错一样会被判不符。
/// 名字不在表里（例如 Windows 返回 Asia/Chongqing）才退回按偏移匹配，最后全量随机。
pub(crate) fn pick_locale() -> &'static LocaleProfile {
    if let Ok(local) = iana_time_zone::get_timezone() {
        if let Some(matched) = LOCALES.iter().find(|locale| locale.timezone == local) {
            return matched;
        }
    }
    // chrono 的偏移是「东经为正」，JS 的 getTimezoneOffset 正好相反
    let js_offset = -(chrono::Local::now().offset().local_minus_utc() / 60);
    let same_offset: Vec<&'static LocaleProfile> = LOCALES
        .iter()
        .filter(|locale| locale.timezone_offset_minutes == js_offset)
        .collect();
    if same_offset.is_empty() {
        pick(LOCALES)
    } else {
        *pick(&same_offset)
    }
}

pub(crate) fn chance(percent: u64) -> bool {
    next_u64() % 100 < percent
}

pub(crate) fn shuffle<T>(items: &mut [T]) {
    for index in (1..items.len()).rev() {
        let swap = (next_u64() % (index as u64 + 1)) as usize;
        items.swap(index, swap);
    }
}

pub(crate) fn device_id() -> String {
    (0..4)
        .map(|_| format!("{:016x}", next_u64()))
        .collect::<String>()
}

pub(crate) fn brand_list(brands: &[BrandVersion]) -> String {
    brands
        .iter()
        .map(|brand| format!("\"{}\";v=\"{}\"", brand.brand, brand.version))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 加引号（UA-CH 的结构化头要求字符串值带引号）
pub(crate) fn quoted(value: &str) -> String {
    format!("\"{value}\"")
}

pub(crate) fn quoted_list(values: &[&str]) -> String {
    values
        .iter()
        .map(|value| quoted(value))
        .collect::<Vec<_>>()
        .join(", ")
}

/// 种子按十六进制字符串传输：u64 直接走 JSON 会超出 JS 的安全整数范围，显示出来是错的
pub(crate) fn serialize_hex<S: serde::Serializer>(value: &u64, serializer: S) -> Result<S::Ok, S::Error> {
    serializer.serialize_str(&format!("{value:016x}"))
}

pub(crate) fn insert(map: &mut HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = HeaderValue::from_str(value) {
        map.insert(HeaderName::from_static(name), value);
    }
}

