pub(crate) fn normalize_locale(language: &str) -> &'static str {
    if language.split(['-', '_']).next().unwrap_or("").eq_ignore_ascii_case("zh") {
        "zh-CN"
    } else {
        "en-US"
    }
}

pub(crate) fn resolve_locale(language: &str, system: Option<&str>) -> &'static str {
    match language {
        "zh-CN" => "zh-CN",
        "en-US" => "en-US",
        _ => normalize_locale(system.unwrap_or("en-US")),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn system_locale() -> Option<String> {
    #[link(name = "kernel32")]
    extern "system" {
        fn GetUserDefaultUILanguage() -> u16;
        fn LCIDToLocaleName(locale: u32, name: *mut u16, length: i32, flags: u32) -> i32;
    }
    let mut name = [0_u16; 85];
    // UI language is distinct from the user's date and number formatting locale.
    let length = unsafe {
        LCIDToLocaleName(GetUserDefaultUILanguage() as u32, name.as_mut_ptr(), name.len() as i32, 0)
    };
    (length > 1).then(|| String::from_utf16_lossy(&name[..length as usize - 1]))
}

#[cfg(target_os = "linux")]
pub(crate) fn system_locale() -> Option<String> {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"].into_iter().find_map(|key| {
        std::env::var(key).ok().filter(|value| !value.is_empty())
    });
    if matches!(locale.as_deref(), Some("C" | "POSIX")) {
        return locale;
    }
    let language = std::env::var("LANGUAGE").ok().and_then(|value| {
        value.split(':').find(|part| !part.is_empty()).map(str::to_string)
    });
    language.or(locale).map(|value| {
        value.split(['.', '@']).next().unwrap_or(&value).to_string()
    })
}

#[cfg(not(any(target_os = "windows", target_os = "linux")))]
pub(crate) fn system_locale() -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "windows")]
    #[test]
    fn reads_windows_display_language() {
        let language = system_locale().expect("Windows should expose a UI language");
        assert!(!language.is_empty());
        assert!(language.chars().all(|ch| ch.is_ascii_alphanumeric() || ch == '-'));
    }

    #[test]
    fn resolves_supported_languages_and_fallback() {
        for language in ["zh", "zh-CN", "zh-TW", "zh_Hant_HK", "ZH-sg"] {
            assert_eq!(normalize_locale(language), "zh-CN");
        }
        for language in ["en-GB", "ja-JP", "fr-FR", "", "zhinvalid"] {
            assert_eq!(normalize_locale(language), "en-US");
        }
    }

    #[test]
    fn explicit_language_overrides_system() {
        assert_eq!(resolve_locale("en-US", Some("zh-CN")), "en-US");
        assert_eq!(resolve_locale("zh-CN", Some("en-US")), "zh-CN");
        assert_eq!(resolve_locale("system", Some("zh-TW")), "zh-CN");
        assert_eq!(resolve_locale("system", None), "en-US");
        assert_eq!(resolve_locale("invalid", Some("zh-CN")), "zh-CN");
    }
}
