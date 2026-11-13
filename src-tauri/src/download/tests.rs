use super::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filename_comes_from_url_path() {
        assert_eq!(
            filename_from_url("https://example.com/a/b/report.pdf?x=1"),
            "report.pdf"
        );
        assert_eq!(
            filename_from_url("https://example.com/%E6%8A%A5%E5%91%8A%20v2.zip"),
            "报告 v2.zip"
        );
        assert!(filename_from_url("https://example.com/").starts_with("download-"));
    }

    #[test]
    fn custom_filename_overrides_url_and_falls_back_when_blank() {
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("我的报告.zip")),
            "我的报告.zip"
        );
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("x/y")),
            "x_y"
        );
        assert_eq!(
            resolve_filename("https://example.com/a.zip", Some("   ")),
            "a.zip"
        );
        assert_eq!(resolve_filename("https://example.com/a.zip", None), "a.zip");
    }

    #[test]
    fn filename_is_sanitized() {
        assert_eq!(sanitize_filename("a:b*c?.txt"), "a_b_c_.txt");
        assert_eq!(sanitize_filename("  ..name..txt.. "), "name..txt");
    }

    #[test]
    fn filename_comes_from_content_disposition() {
        assert_eq!(
            filename_from_disposition("attachment; filename=\"Comfy-Desktop-Setup.exe\""),
            Some("Comfy-Desktop-Setup.exe".to_string())
        );
        assert_eq!(
            filename_from_disposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip; filename=fallback.zip"),
            Some("报告.zip".to_string())
        );
        assert_eq!(
            filename_from_disposition("attachment; filename=plain.zip"),
            Some("plain.zip".to_string())
        );
        assert_eq!(filename_from_disposition("inline"), None);
    }

    #[test]
    fn segments_cover_whole_file_without_overlap() {
        let total = 10 * 1024 * 1024u64;
        let chunk = chunk_size(total, 32);
        assert_eq!(
            chunk, MIN_SEGMENT,
            "10 MiB / (32 × 3) 低于下限，按 4 MiB 切"
        );
        let parts = plan_segments(total, chunk);
        assert_eq!(parts[0].0, 0);
        assert_eq!(parts.last().unwrap().1, total - 1);
        for pair in parts.windows(2) {
            assert_eq!(pair[0].1 + 1, pair[1].0);
        }
        assert_eq!(parts.len(), 3, "10 MiB 按 4 MiB 切，得到 3 片");
    }

    #[test]
    fn chunk_plan_keeps_extra_work_queued_for_fast_threads() {
        let total = 1024 * 1024 * 1024u64; // 1 GiB
        let parts = plan_segments(total, chunk_size(total, 8));
        assert!(
            parts.len() >= 8 * 2,
            "分片数要明显多于线程数，先下完的线程才有片段可抢"
        );
        assert_eq!(parts[0].0, 0);
        assert_eq!(parts.last().unwrap().1, total - 1);

        // 超大文件受分片总数上限约束，不会生成海量临时文件
        let huge = u64::MAX / 2;
        assert!(plan_segments(huge, chunk_size(huge, 128)).len() <= MAX_SEGMENTS);

        // 小文件只切一颗
        assert_eq!(plan_segments(1024, chunk_size(1024, 32)).len(), 1);
    }

    #[test]
    fn content_range_total_parses() {
        assert_eq!(content_range_total("bytes 0-0/12345"), Some(12345));
        assert_eq!(content_range_total("bytes 0-0/*"), None);
    }

    #[test]
    fn unique_dest_appends_counter() {
        let dir = std::env::temp_dir().join(format!("fastnote-dl-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let first = unique_dest(&dir, "a.txt");
        std::fs::write(&first, b"x").unwrap();
        let second = unique_dest(&dir, "a.txt");
        assert_eq!(second.file_name().unwrap(), "a (1).txt");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn staging_folder_follows_download_filename() {
        assert_eq!(staging_name("FastNote_2.5.6.exe"), "FastNote_2.5.6");
        assert_eq!(staging_name("archive.tar.gz"), "archive.tar");
        assert_eq!(staging_name("installer"), "installer-parts");
        assert_eq!(staging_name("说明文档.pdf"), "说明文档");
    }

    #[test]
    fn staging_folder_keeps_unrelated_files() {
        let root = std::env::temp_dir().join(format!("fastnote-staging-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("FastNote"), b"x").unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let staging = prepare_staging(&root, "FastNote").await.unwrap();
            assert_eq!(staging.file_name().unwrap(), "FastNote-1");

            tokio::fs::write(staging.join("file.bin.part.0"), b"x")
                .await
                .unwrap();
            tokio::fs::write(staging.join("keep.txt"), b"x").await.unwrap();
            remove_staging(&staging).await;
            assert!(staging.exists(), "目录里还有其他文件时不能整个删掉");
            assert!(!staging.join("file.bin.part.0").exists());

            tokio::fs::remove_file(staging.join("keep.txt")).await.unwrap();
            remove_staging(&staging).await;
            assert!(!staging.exists(), "分片清空后临时目录应删除");
        });
        let _ = std::fs::remove_dir_all(&root);
    }

    use std::io::{BufRead, BufReader, Write};
    use std::sync::atomic::AtomicUsize;
    use std::sync::Arc;

    /// 本地 Range 服务器：支持 206 分片，也提供忽略 Range 的 200 路径。
    /// 返回值里的计数器记录“真正的分段请求”数量（不含 `bytes=0-0` 探测）。
    fn spawn_server(payload: Arc<Vec<u8>>, ranges: bool) -> (String, Arc<AtomicUsize>) {
        spawn_throttled_server(payload, ranges, Duration::ZERO)
    }

    /// 与 [`spawn_server`] 相同，但每发送 64 KiB 停 `delay`：
    /// 本地回环下载只有几十毫秒，不加限速就没有暂停的触发窗口。
    fn spawn_throttled_server(
        payload: Arc<Vec<u8>>,
        ranges: bool,
        delay: Duration,
    ) -> (String, Arc<AtomicUsize>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let segment_requests = Arc::new(AtomicUsize::new(0));
        let counter = segment_requests.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let payload = payload.clone();
                let counter = counter.clone();
                std::thread::spawn(move || {
                    let mut reader = BufReader::new(stream.try_clone().unwrap());
                    let mut request = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                            break;
                        }
                        request.push_str(&line);
                    }
                    let range = request.lines().find_map(|line| {
                        let (key, value) = line.split_once(':')?;
                        key.eq_ignore_ascii_case("range")
                            .then(|| value.trim().to_string())
                    });
                    if range.as_deref().is_some_and(|spec| spec != "bytes=0-0") {
                        counter.fetch_add(1, Ordering::Relaxed);
                    }
                    let total = payload.len();
                    let (status, start, end, body): (&str, usize, usize, &[u8]) = match range {
                        Some(spec) if ranges => {
                            let spec = spec.strip_prefix("bytes=").unwrap_or("");
                            let (from, to) = spec.split_once('-').unwrap_or(("0", ""));
                            let start: usize = from.trim().parse().unwrap_or(0);
                            let end = if to.trim().is_empty() {
                                total - 1
                            } else {
                                to.trim()
                                    .parse::<usize>()
                                    .unwrap_or(total - 1)
                                    .min(total - 1)
                            };
                            ("206 Partial Content", start, end, &payload[start..=end])
                        }
                        _ => ("200 OK", 0, total - 1, payload.as_slice()),
                    };
                    let mut head = format!(
                        "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\nAccept-Ranges: bytes\r\n",
                        body.len()
                    );
                    if status.starts_with("206") {
                        head.push_str(&format!("Content-Range: bytes {start}-{end}/{total}\r\n"));
                    }
                    head.push_str("\r\n");
                    if stream.write_all(head.as_bytes()).is_err() {
                        return;
                    }
                    if delay.is_zero() {
                        let _ = stream.write_all(body);
                    } else {
                        // 客户端暂停会直接断开连接，后续写入失败就收工，别在测试里 panic
                        for slice in body.chunks(64 * 1024) {
                            if stream.write_all(slice).is_err() {
                                return;
                            }
                            std::thread::sleep(delay);
                        }
                    }
                    let _ = stream.flush();
                });
            }
        });
        (format!("http://{addr}/file.bin"), segment_requests)
    }

    #[test]
    fn downloads_segmented_and_single_from_local_server() {
        let payload: Arc<Vec<u8>> = Arc::new((0..20_000_000).map(|i| (i % 251) as u8).collect());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();

        for ranges in [true, false] {
            let (url, segment_requests) = spawn_server(payload.clone(), ranges);
            let dir = std::env::temp_dir()
                .join(format!("fastnote-dl-it-{}-{ranges}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            let dest = dir.join("file.bin");
            let seen_segments = AtomicUsize::new(0);
            runtime.block_on(async {
                let client = client().unwrap();
                let progress = |_done: u64, _total: u64, segments: usize, _: &[SegmentProgress]| {
                    seen_segments.fetch_max(segments, Ordering::Relaxed);
                };
                let size = fetch(&client, &url, &dest, 8, None, None, &progress)
                    .await
                    .unwrap();
                assert_eq!(size, payload.len() as u64);
            });
            assert_eq!(std::fs::read(&dest).unwrap(), *payload);
            if ranges {
                assert!(
                    segment_requests.load(Ordering::Relaxed) >= 2,
                    "支持 Range 的服务器应发出多个分段请求"
                );
                assert!(seen_segments.load(Ordering::Relaxed) > 1);
                let leftovers: Vec<String> = std::fs::read_dir(&dir)
                    .unwrap()
                    .filter_map(|entry| entry.ok())
                    .map(|entry| entry.file_name().to_string_lossy().to_string())
                    .filter(|name| name != "file.bin")
                    .collect();
                assert!(leftovers.is_empty(), "分段文件未清理：{leftovers:?}");
            } else {
                assert_eq!(segment_requests.load(Ordering::Relaxed), 0);
                assert_eq!(seen_segments.load(Ordering::Relaxed), 1);
            }
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// 暂停只停传输、保留分段；继续时从已有分段接着下，最终文件完整。
    #[test]
    fn pause_keeps_segments_and_resume_finishes_file() {
        let payload: Arc<Vec<u8>> = Arc::new((0..20_000_000).map(|i| (i % 251) as u8).collect());
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .unwrap();
        let (url, _) = spawn_throttled_server(payload.clone(), true, Duration::from_millis(12));
        let dir = std::env::temp_dir().join(format!("fastnote-dl-pause-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("file.bin");
        let control = Control::new();

        // 收到第一份“已下载 > 0”的进度就暂停，模拟用户点暂停按钮
        let pause_once = AtomicBool::new(false);
        runtime.block_on(async {
            let client = client().unwrap();
            let progress = |done: u64, _total: u64, _segments: usize, _: &[SegmentProgress]| {
                if done > 0 && !pause_once.swap(true, Ordering::Relaxed) {
                    control.set_paused(true);
                }
            };
            let error = fetch(&client, &url, &dest, 8, Some(&control), None, &progress)
                .await
                .unwrap_err();
            assert_eq!(error, PAUSED, "暂停应让下载以 PAUSED 结束");
        });

        assert!(!dest.exists(), "暂停不应产出最终文件");
        let parts: Vec<PathBuf> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.contains(".part"))
            })
            .collect();
        assert!(!parts.is_empty(), "暂停后应保留分段文件用于续传");
        assert!(
            parts.iter().any(|path| file_len(path) > 0),
            "暂停前已下载的数据要留在分段文件里"
        );

        control.set_paused(false);
        runtime.block_on(async {
            let client = client().unwrap();
            let progress = |_done: u64, _total: u64, _segments: usize, _: &[SegmentProgress]| {};
            let size = fetch(&client, &url, &dest, 8, Some(&control), None, &progress)
                .await
                .unwrap();
            assert_eq!(size, payload.len() as u64);
        });
        assert_eq!(std::fs::read(&dest).unwrap(), *payload, "续传后内容要完整");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 入口脚本服务器：任何请求都 301 到 `location`，模拟 `download.php?pro=x` 这类入口
    fn spawn_redirect_server(location: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let head = format!(
                    "HTTP/1.1 301 Moved Permanently\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/product/download.php?pro=x")
    }

    /// 落地页服务器：任何请求都返回一段 HTML，模拟文件地址写在页面里的下载页
    fn spawn_html_server(html: String) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                }
                let head = format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    html.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(html.as_bytes());
                let _ = stream.flush();
            }
        });
        format!("http://{addr}/downloads/app")
    }

    #[test]
    fn redirected_entry_takes_filename_from_final_url() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![9u8; 4096]);
        let (target, _) = spawn_server(payload, true);
        let entry = spawn_redirect_server(target.clone());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = client().unwrap();
            let found = resolve_entry(&client, &entry, None).await.unwrap();
            assert_eq!(
                found.filename.as_deref(),
                Some("file.bin"),
                "入口是 download.php 时，文件名要取重定向后的最终地址"
            );
            assert_eq!(found.url, entry, "普通跳转沿用原始链接，保留 Referer 跟随");
        });
    }

    #[test]
    fn landing_page_urls_are_extracted() {
        let base = reqwest::Url::parse("https://example.com/download/page.html").unwrap();
        let meta = r#"<meta http-equiv="refresh" content="0;URL='/files/app.exe'">"#;
        assert_eq!(
            download_url_from_html(meta, &base).unwrap().as_str(),
            "https://example.com/files/app.exe"
        );
        let js = r#"<script>window.location.href = "/files/app.zip";</script>"#;
        assert_eq!(
            download_url_from_html(js, &base).unwrap().as_str(),
            "https://example.com/files/app.zip"
        );
        let assign = r#"<script>location.assign('/files/setup.msi')</script>"#;
        assert_eq!(
            download_url_from_html(assign, &base).unwrap().as_str(),
            "https://example.com/files/setup.msi"
        );
        let anchor = r#"<a class="btn" href="/files/tool-1.2.dmg">下载</a>"#;
        assert_eq!(
            download_url_from_html(anchor, &base).unwrap().as_str(),
            "https://example.com/files/tool-1.2.dmg"
        );
        // 普通导航链接、JS 取值调用都不算下载地址
        assert!(download_url_from_html(r#"<a href="/about">关于</a>"#, &base).is_none());
        assert!(
            download_url_from_html(r#"<script>if (location.href.indexOf("x") > 0) {}</script>"#, &base)
                .is_none()
        );
    }

    #[test]
    fn landing_page_resolves_to_real_file() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![3u8; 4096]);
        let (target, _) = spawn_server(payload, true);
        for template in [
            r#"<html><head><meta http-equiv="refresh" content="0; url=TARGET"></head></html>"#,
            r#"<html><script>window.location = "TARGET";</script></html>"#,
        ] {
            let entry_url = spawn_html_server(template.replace("TARGET", &target));
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            runtime.block_on(async {
                let client = client().unwrap();
                let found = resolve_entry(&client, &entry_url, None).await.unwrap();
                assert_eq!(found.url, target);
                assert_eq!(found.filename.as_deref(), Some("file.bin"));
            });
        }
    }

    #[test]
    fn landing_page_without_file_link_errors() {
        let entry_url = spawn_html_server("<html><body>没有下载链接</body></html>".to_string());
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let client = client().unwrap();
            assert!(resolve_entry(&client, &entry_url, None).await.is_err());
        });
    }

    #[test]
    fn cancelled_download_returns_without_touching_disk() {
        let payload: Arc<Vec<u8>> = Arc::new(vec![7u8; 100_000]);
        let (url, _) = spawn_server(payload, true);
        let dir = std::env::temp_dir().join(format!("fastnote-dl-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("file.bin");
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let control = Control::new();
        control.cancel();
        runtime.block_on(async {
            let client = client().unwrap();
            let progress = |_done: u64, _total: u64, _segments: usize, _: &[SegmentProgress]| {};
            let error = fetch(&client, &url, &dest, 4, Some(&control), None, &progress)
                .await
                .unwrap_err();
            assert_eq!(error, CANCELLED);
        });
        assert!(!dest.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

