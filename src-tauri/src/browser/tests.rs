use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_inputs_are_normalized() {
        assert_eq!(
            normalize_url("https://example.com/a").unwrap().as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            normalize_url("example.com/a").unwrap().as_str(),
            "https://example.com/a"
        );
        assert_eq!(
            normalize_url("localhost:3000").unwrap().as_str(),
            "http://localhost:3000/"
        );
        assert_eq!(
            normalize_url("127.0.0.1:8080/a").unwrap().as_str(),
            "http://127.0.0.1:8080/a"
        );
        assert_eq!(
            normalize_url("example.com:8080/a").unwrap().as_str(),
            "https://example.com:8080/a"
        );
        assert!(normalize_url("tauri://localhost").is_err());
        assert!(normalize_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn non_web_schemes_are_rejected() {
        assert!(normalize_url("mailto:me@example.com").is_err());
        assert!(normalize_url("obsidian://open?vault=x").is_err());
        assert!(normalize_url("file:///C:/a.txt").is_err());
    }

    #[test]
    fn search_terms_go_to_bing() {
        let url = normalize_url("指纹 浏览器").unwrap();
        assert_eq!(url.host_str(), Some("www.bing.com"));
        assert_eq!(
            url.query(),
            Some("q=%E6%8C%87%E7%BA%B9+%E6%B5%8F%E8%A7%88%E5%99%A8")
        );
    }

    #[test]
    fn fingerprint_scripts_embed_the_payload() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let user_agent = fingerprint["user_agent"].as_str().unwrap();
        let script = fingerprint_script(&fingerprint);
        assert!(!script.contains("__FASTNOTE_FINGERPRINT__"));
        assert!(!script.contains("__FASTNOTE_WORKER_SCRIPT__"));
        assert!(script.contains(user_agent));
        // Worker 预载脚本里也有同一份指纹，且不再嵌套包装 Worker
        assert!(script.contains("const WORKER_SOURCE = \""));
        assert!(script.contains("importScripts("));
    }

    #[test]
    fn identity_commands_carry_the_spoofed_identity() {
        let fingerprint = serde_json::json!({
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
            "chrome_version": "142.0.7444.175",
            "brands": [{ "brand": "Chromium", "version": "142" }],
            "full_version_list": [{ "brand": "Chromium", "version": "142.0.7444.175" }],
            "ua_platform": "Windows",
            "ua_platform_version": "19.0.0",
            "ua_architecture": "x86",
            "ua_bitness": "64",
            "ua_model": "",
            "ua_mobile": false,
            "ua_wow64": false,
            "platform": "Win32",
            "languages": ["zh-CN", "zh", "en"],
            "do_not_track": "1",
        });
        let commands = identity_override_commands(&fingerprint).unwrap();
        assert_eq!(commands[0].0, "Network.setUserAgentOverride");
        let params: Value = serde_json::from_str(&commands[0].1).unwrap();
        assert_eq!(params["userAgent"], fingerprint["user_agent"]);
        assert_eq!(params["platform"], "Win32");
        // 只能给标签：内核会把它拆进 navigator.languages，q 值留在数组里就是硬伤
        assert_eq!(params["acceptLanguage"], "zh-CN,zh,en");
        assert!(!params["acceptLanguage"].as_str().unwrap().contains(';'));
        assert_eq!(params["userAgentMetadata"]["brands"][0]["brand"], "Chromium");
        assert_eq!(
            params["userAgentMetadata"]["fullVersionList"][0]["version"],
            "142.0.7444.175"
        );
        assert_eq!(commands[1].0, "Network.setExtraHTTPHeaders");
        assert!(commands[1].1.contains("\"DNT\":\"1\""));
    }

    #[test]
    fn random_fingerprints_produce_identity_commands() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let commands = identity_override_commands(&fingerprint).unwrap();
        let params: Value = serde_json::from_str(&commands[0].1).unwrap();
        assert_eq!(params["userAgent"], fingerprint["user_agent"]);
        assert_eq!(params["userAgentMetadata"]["brands"], fingerprint["brands"]);
        assert_eq!(
            params["userAgentMetadata"]["fullVersionList"],
            fingerprint["full_version_list"]
        );
        assert!(params["acceptLanguage"]
            .as_str()
            .unwrap()
            .starts_with(fingerprint["languages"][0].as_str().unwrap()));
    }

    #[test]
    fn identity_commands_need_a_user_agent() {
        assert!(identity_override_commands(&serde_json::json!({})).is_none());
    }

    #[test]
    fn cdp_languages_are_bare_tags_but_the_header_keeps_quality_values() {
        for _ in 0..32 {
            let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
            let commands = identity_override_commands(&fingerprint).unwrap();
            let params: Value = serde_json::from_str(&commands[0].1).unwrap();
            let cdp_languages = params["acceptLanguage"].as_str().unwrap();
            assert!(!cdp_languages.contains(';'), "CDP 语言里不能带 q 值：{cdp_languages}");
            let expected = fingerprint["languages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|language| language.as_str().unwrap())
                .collect::<Vec<_>>()
                .join(",");
            assert_eq!(cdp_languages, expected);
            // 请求头仍要是浏览器正常的 q 值格式
            let header = request_headers(&fingerprint)
                .into_iter()
                .find(|(name, _)| name == "Accept-Language")
                .map(|(_, value)| value)
                .unwrap();
            assert_eq!(header, accept_language(&fingerprint).unwrap());
            assert!(header.starts_with(fingerprint["languages"][0].as_str().unwrap()));
        }
    }

    #[test]
    fn engine_versions_are_parsed() {
        assert_eq!(
            parse_engine_version("156.0.3456.78"),
            Some(("156".to_string(), "156.0.3456.78".to_string()))
        );
        assert_eq!(
            parse_engine_version("156.0.3456.78 (Official build) stable"),
            Some(("156".to_string(), "156.0.3456.78".to_string()))
        );
        assert_eq!(parse_engine_version(""), None);
        assert_eq!(parse_engine_version("156"), None);
        assert_eq!(parse_engine_version("unknown"), None);
    }

    #[test]
    fn request_headers_match_the_fingerprint() {
        let fingerprint = serde_json::json!({
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36",
            "chrome_version": "142.0.7444.175",
            "brands": [
                { "brand": "Chromium", "version": "142" },
                { "brand": "Google Chrome", "version": "142" },
                { "brand": "Not_A Brand", "version": "24" },
            ],
            "full_version_list": [
                { "brand": "Chromium", "version": "142.0.7444.175" },
                { "brand": "Google Chrome", "version": "142.0.7444.175" },
            ],
            "ua_platform": "Windows",
            "ua_platform_version": "15.0.0",
            "ua_architecture": "x86",
            "ua_bitness": "64",
            "ua_model": "",
            "ua_mobile": false,
            "ua_wow64": false,
            "ua_form_factors": ["Desktop"],
            "languages": ["zh-CN", "zh", "en"],
            "do_not_track": "1",
        });
        let headers = request_headers(&fingerprint);
        let get = |name: &str| {
            headers
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, value)| value.as_str())
        };
        assert_eq!(get("User-Agent"), fingerprint["user_agent"].as_str());
        assert_eq!(get("Accept-Language"), Some("zh-CN,zh;q=0.9,en;q=0.8"));
        assert_eq!(
            get("Sec-CH-UA"),
            Some("\"Chromium\";v=\"142\", \"Google Chrome\";v=\"142\", \"Not_A Brand\";v=\"24\"")
        );
        assert_eq!(get("Sec-CH-UA-Mobile"), Some("?0"));
        assert_eq!(get("Sec-CH-UA-Platform"), Some("\"Windows\""));
        assert_eq!(get("Sec-CH-UA-Platform-Version"), Some("\"15.0.0\""));
        assert_eq!(get("Sec-CH-UA-Arch"), Some("\"x86\""));
        assert_eq!(get("Sec-CH-UA-Bitness"), Some("\"64\""));
        assert_eq!(get("Sec-CH-UA-Model"), Some("\"\""));
        assert_eq!(get("Sec-CH-UA-Full-Version"), Some("142.0.7444.175"));
        assert_eq!(get("Sec-CH-UA-WoW64"), Some("?0"));
        assert_eq!(get("Sec-CH-UA-Form-Factors"), Some("\"Desktop\""));
        assert_eq!(get("DNT"), Some("1"));
        // 不带 Edge 品牌：内核自带的 Edge 身份必须被整组替换
        assert!(!get("Sec-CH-UA").unwrap().contains("Edge"));
    }

    #[test]
    fn random_fingerprints_produce_request_headers() {
        let fingerprint = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        let headers = request_headers(&fingerprint);
        let names = headers.iter().map(|(name, _)| name.as_str()).collect::<Vec<_>>();
        for required in [
            "User-Agent",
            "Accept-Language",
            "Sec-CH-UA",
            "Sec-CH-UA-Platform",
            "Sec-CH-UA-Full-Version-List",
        ] {
            assert!(names.contains(&required), "缺少请求头 {required}");
        }
        let user_agent = headers
            .iter()
            .find(|(name, _)| name == "User-Agent")
            .map(|(_, value)| value.as_str());
        assert_eq!(user_agent, fingerprint["user_agent"].as_str());
    }

    #[test]
    fn toolbar_labels_map_to_content_labels() {
        let window = "inapp-browser-2";
        assert_eq!(
            format!("{window}{CONTENT_SUFFIX}"),
            "inapp-browser-2-content"
        );
        assert_eq!(panel_label(window), "inapp-browser-2-download-panel");
        assert!(is_browser_window(window));
        assert!(is_browser_window(BROWSER_LABEL));
        // 下载气泡也是挂在浏览器窗口下的小窗，不能被当成浏览器窗口（否则会去重排它的子 WebView）
        assert!(!is_browser_window(&panel_label(window)));
        assert!(!is_browser_window(&panel_label(BROWSER_LABEL)));
        assert!(!is_browser_window("main"));
    }
}

