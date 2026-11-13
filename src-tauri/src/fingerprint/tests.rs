use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprints_vary_between_calls() {
        let samples: Vec<BrowserFingerprint> =
            (0..16).map(|_| BrowserFingerprint::random()).collect();
        assert!(
            samples
                .iter()
                .map(|fp| fp.canvas_seed)
                .collect::<std::collections::HashSet<_>>()
                .len()
                > 1
        );
        assert!(samples.windows(2).any(|pair| {
            pair[0].user_agent != pair[1].user_agent
                || pair[0].canvas_seed != pair[1].canvas_seed
                || pair[0].webgl.unmasked_renderer != pair[1].webgl.unmasked_renderer
                || pair[0].language != pair[1].language
        }));
    }

    #[test]
    fn browser_identity_matches_the_local_timezone() {
        let fp = BrowserFingerprint::for_browser("156", "156.0.3456.78");
        if let Ok(local) = iana_time_zone::get_timezone() {
            if LOCALES.iter().any(|locale| locale.timezone == local) {
                assert_eq!(fp.timezone, local);
                return;
            }
        }
        let js_offset = -(chrono::Local::now().offset().local_minus_utc() / 60);
        if LOCALES
            .iter()
            .any(|locale| locale.timezone_offset_minutes == js_offset)
        {
            assert_eq!(fp.timezone_offset_minutes, js_offset);
        }
    }

    #[test]
    fn random_fingerprints_still_cover_other_platforms() {
        // 原始的随机指纹（下载 / 工具箱）保留「绝大多数是本机平台、少数是其他平台」的分布
        let platforms = (0..128)
            .map(|_| BrowserFingerprint::random().ua_platform)
            .collect::<std::collections::HashSet<_>>();
        assert!(platforms.len() > 1);
    }

    #[test]
    fn headers_match_fingerprint() {
        for _ in 0..32 {
            let fp = BrowserFingerprint::random();
            let headers = fp.headers();
            assert_eq!(
                headers.get("user-agent").unwrap().to_str().unwrap(),
                fp.user_agent
            );
            let ch_ua = headers.get("sec-ch-ua").unwrap().to_str().unwrap();
            assert!(ch_ua.contains(&format!("v=\"{}\"", fp.chrome_major)));
            assert!(ch_ua.contains("Chromium"));
            assert!(ch_ua.contains("Google Chrome"));
            assert_eq!(
                headers.get("sec-ch-ua-platform").unwrap().to_str().unwrap(),
                format!("\"{}\"", fp.ua_platform)
            );
            assert_eq!(
                headers
                    .get("sec-ch-ua-full-version")
                    .unwrap()
                    .to_str()
                    .unwrap(),
                fp.chrome_version
            );
            assert_eq!(
                headers.get("accept-language").unwrap().to_str().unwrap(),
                fp.accept_language()
            );
            assert_eq!(headers.get("sec-fetch-mode").unwrap(), "navigate");
            assert_eq!(
                headers.get("sec-ch-viewport-width").unwrap().to_str().unwrap(),
                format!("\"{}\"", fp.window.inner_width)
            );
            // 下载拿原始字节：不能声明压缩，否则 Range / Content-Length 会对不上
            assert!(headers.get("accept-encoding").is_none());
        }
    }

    #[test]
    fn user_agent_and_platform_agree() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            match fp.ua_platform {
                "Windows" => {
                    assert!(fp.user_agent.contains("Windows NT"));
                    assert_eq!(fp.platform, "Win32");
                    assert!(fp.webgl.unmasked_renderer.contains("Direct3D11"));
                }
                "macOS" => {
                    assert!(fp.user_agent.contains("Macintosh"));
                    assert_eq!(fp.platform, "MacIntel");
                    assert!(fp.webgl.unmasked_renderer.contains("Metal"));
                }
                _ => {
                    assert!(fp.user_agent.contains("X11; Linux"));
                    assert_eq!(fp.platform, "Linux x86_64");
                    assert!(fp.webgl.unmasked_renderer.contains("OpenGL"));
                }
            }
            assert_eq!(fp.language, fp.languages[0]);
            assert!(fp.accept_language().starts_with(fp.languages[0]));
            assert_eq!(
                fp.navigator.app_version,
                fp.user_agent.trim_start_matches("Mozilla/")
            );
            assert_eq!(fp.screen.avail_width, fp.screen.width);
            assert!(fp.screen.avail_height < fp.screen.height);
            assert!(fp.screen.device_pixel_ratio > 0.0);
            assert_eq!(fp.screen.color_depth, fp.screen.pixel_depth);
            assert_eq!(fp.window.device_pixel_ratio, fp.screen.device_pixel_ratio);
            assert!(fp.window.inner_width <= fp.window.outer_width);
            assert!(fp.window.inner_height <= fp.window.outer_height);
            assert!(fp.window.outer_width <= fp.screen.width);
            assert!(fp.window.outer_height <= fp.screen.avail_height);
            assert!(fp.window.screen_x >= 0 && fp.window.screen_y >= 0);
        }
    }

    #[test]
    fn ua_ch_versions_are_coherent() {
        for _ in 0..32 {
            let fp = BrowserFingerprint::random();
            let chrome = fp
                .brands
                .iter()
                .find(|brand| brand.brand == "Google Chrome")
                .unwrap();
            assert_eq!(chrome.version, fp.chrome_major.to_string());
            let full = fp
                .full_version_list
                .iter()
                .find(|brand| brand.brand == "Google Chrome")
                .unwrap();
            assert_eq!(full.version, fp.chrome_version);
            assert!(full.version.starts_with(&format!("{}.", fp.chrome_major)));
            assert_eq!(fp.brands.len(), fp.full_version_list.len());
            assert_eq!(fp.ua_form_factors, vec!["Desktop"]);
        }
    }

    #[test]
    fn chrome_version_can_come_from_the_running_engine() {
        let fp = BrowserFingerprint::for_browser("156", "156.0.3456.78");
        assert_eq!(fp.chrome_major, 156);
        assert_eq!(fp.chrome_version, "156.0.3456.78");
        assert!(fp.user_agent.ends_with("Chrome/156.0.0.0 Safari/537.36"));
        assert!(fp.navigator.app_version.contains("Chrome/156.0.0.0"));
        for brand in fp.brands.iter().filter(|brand| brand.brand != "Not_A Brand") {
            assert_eq!(brand.version, "156");
        }
        for brand in fp
            .full_version_list
            .iter()
            .filter(|brand| brand.brand != "Not_A Brand")
        {
            assert_eq!(brand.version, "156.0.3456.78");
        }
    }

    #[test]
    fn hardware_and_media_are_coherent() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            assert!(fp.hardware_concurrency >= 4);
            assert!(fp.device_memory_gb >= 4);
            assert_eq!(
                fp.media.device_ids.len() as u8,
                fp.media.audio_inputs + fp.media.video_inputs + fp.media.audio_outputs
            );
            assert!(fp.media.device_ids.iter().all(|id| id.len() == 64));
            assert!(fp.storage.quota_bytes > fp.storage.usage_bytes);
            assert!(fp.storage.quota_bytes < (1u64 << 53));
            assert!(fp.battery.level > 0.0 && fp.battery.level <= 1.0);
            assert!(fp.network.rtt_ms >= 50);
            assert!(fp.network.downlink_mbps > 0.0);
            assert!(!fp.navigator.webdriver);
            assert!(fp.navigator.cookie_enabled);
            assert!(fp.navigator.on_line);
            assert!(fp.navigator.pdf_viewer_enabled);
        }
    }

    #[test]
    fn graphics_and_audio_are_coherent() {
        for _ in 0..64 {
            let fp = BrowserFingerprint::random();
            assert!(fp.webgl.version.contains("WebGL 1.0"));
            assert!(fp.webgl.webgl2_version.contains("WebGL 2.0"));
            assert!(fp
                .webgl
                .webgl2_shading_language_version
                .contains("GLSL ES 3.00"));
            assert!(!fp.webgl.extensions.is_empty());
            assert!(fp.webgl.max_texture_size >= 8192);
            assert!(fp.webgl.max_samples == 4 || fp.webgl.max_samples == 8);
            assert!(fp.webgpu.available);
            assert!(!fp.webgpu.features.is_empty());
            assert!(fp
                .webgl
                .unmasked_vendor
                .to_lowercase()
                .contains(fp.webgpu.vendor));
            assert!(fp.audio.sample_rate == 44100 || fp.audio.sample_rate == 48000);
            assert!(fp.audio.max_channel_count >= 2);
            assert!(fp.audio.compressor.ratio > 0.0);
            assert!(!fp.voices.is_empty());
            assert!(fp.voices.iter().filter(|voice| voice.default).count() <= 1);
            assert!(!fp.mime_types.is_empty());
            assert!(!fp.api_features.is_empty());
        }
    }

    #[test]
    fn seeds_serialize_as_hex_strings() {
        let value = serde_json::to_value(BrowserFingerprint::random()).unwrap();
        // u64 走 JSON number 会超出 JS 安全整数范围，必须序列化成字符串
        assert!(value["canvas_seed"].is_string());
        assert!(value["audio_seed"].is_string());
        assert_eq!(value["canvas_seed"].as_str().unwrap().len(), 16);
        assert_eq!(value["audio_seed"].as_str().unwrap().len(), 16);
        assert_eq!(value["language"], value["languages"][0]);
        assert!(value["navigator"]["app_version"].is_string());
        assert_eq!(
            value["window"]["device_pixel_ratio"],
            value["screen"]["device_pixel_ratio"]
        );
    }
}

