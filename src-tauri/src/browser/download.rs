use super::*;

/// 接管一次网页下载。
///
/// 内核下载已经被取消（`on_download` 返回 false），这里用 [`crate::download`] 重新拉取：
/// 分片多线程、失败清理、进度写进窗口状态供工具栏轮询。Cookie 与 Referer 从网页
/// WebView 现场取出，登录态 / 防盗链都不会丢；身份头复用窗口指纹，不另起随机 UA。
pub(crate) fn start_browser_download(
    app: AppHandle,
    content: Webview,
    url: Url,
    suggested: Option<String>,
    headers: HeaderMap,
) {
    let label = content.label().to_string();
    let id = next_download_id();
    let control = Control::new();
    if let Ok(mut map) = download_controls().lock() {
        map.insert(id, control.clone());
    }

    tauri::async_runtime::spawn(async move {
        let dir = match crate::download::default_dir(&app) {
            Ok(dir) => dir,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename: crate::download::filename_from_url(url.as_str()),
                        path: String::new(),
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };

        let name = suggested
            .map(|name| name.trim().to_string())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| crate::download::filename_from_url(url.as_str()));
        let dest = crate::download::unique_dest(&dir, &name);
        let temp_name = dest
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or(&name)
            .to_string();
        let filename = temp_name.clone();
        let path = dest.to_string_lossy().to_string();

        // 分片放 download/<文件名>/（与工具箱一致），最终文件仍落在下载根目录
        let staging = match crate::download::prepare_staging(
            &dir,
            &crate::download::staging_name(&temp_name),
        )
        .await
        {
            Ok(staging) => staging,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename,
                        path,
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };
        let temp_dest = staging.join(&temp_name);
        // 上次异常退出可能留下已合并完成的临时文件，先清掉，避免最终改名失败
        let _ = tokio::fs::remove_file(&temp_dest).await;

        // 浏览器会话头：登录态靠 Cookie，防盗链靠 Referer
        let mut extra = HeaderMap::new();
        if let Ok(cookies) = content.cookies_for_url(url.clone()) {
            let pairs = cookies
                .iter()
                .map(|cookie| format!("{}={}", cookie.name(), cookie.value()))
                .collect::<Vec<_>>();
            if !pairs.is_empty() {
                if let Ok(value) = HeaderValue::from_str(&pairs.join("; ")) {
                    extra.insert(COOKIE, value);
                }
            }
        }
        if let Ok(page) = content.url() {
            if matches!(page.scheme(), "http" | "https") {
                if let Ok(value) = HeaderValue::from_str(page.as_str()) {
                    extra.insert(REFERER, value);
                }
            }
        }

        // 设置里关掉随机指纹时窗口用的是内核真实身份，这里没有可复用的头；
        // 退回下载模块自己的浏览器指纹，至少保证请求带一个正常的 UA。
        let client = match if headers.is_empty() {
            crate::download::client()
        } else {
            crate::download::client_with_headers(headers)
        } {
            Ok(client) => client,
            Err(error) => {
                update_download(
                    &label,
                    DownloadView {
                        id,
                        filename,
                        path,
                        downloaded: 0,
                        total: 0,
                        parallel: 0,
                        speed: 0.0,
                        state: "error",
                        error: Some(error),
                    },
                );
                drop_download_control(id);
                return;
            }
        };

        update_download(
            &label,
            DownloadView {
                id,
                filename: filename.clone(),
                path: path.clone(),
                downloaded: 0,
                total: 0,
                parallel: 0,
                speed: 0.0,
                state: "start",
                error: None,
            },
        );

        let threads = crate::download::threads(&app);
        let last_done = AtomicU64::new(0);
        let last_total = AtomicU64::new(0);
        let report = |done: u64, total: u64, parallel: usize, active: &[crate::download::SegmentProgress]| {
            last_done.store(done, Ordering::Relaxed);
            last_total.store(total, Ordering::Relaxed);
            let speed = active.iter().map(|segment| segment.speed).sum();
            update_download(
                &label,
                DownloadView {
                    id,
                    filename: filename.clone(),
                    path: path.clone(),
                    downloaded: done,
                    total,
                    parallel,
                    speed,
                    state: "progress",
                    error: None,
                },
            );
        };

        /*
         * 暂停时 fetch 返回 PAUSED：分片留在暂存目录里，用户点「继续」后
         * 重新调用 fetch，从已有分段长度续传；取消才清理临时文件。
         */
        let mut size = None;
        loop {
            match crate::download::fetch(
                &client,
                url.as_str(),
                &temp_dest,
                threads,
                Some(&control),
                Some(&extra),
                &report,
            )
            .await
            {
                Ok(bytes) => {
                    size = Some(bytes);
                    break;
                }
                Err(error) => {
                    if control.is_cancelled() {
                        crate::download::cleanup(&temp_dest).await;
                        crate::download::remove_staging(&staging).await;
                        update_download(
                            &label,
                            cancelled_view(
                                id,
                                &filename,
                                &path,
                                last_done.load(Ordering::Relaxed),
                                last_total.load(Ordering::Relaxed),
                            ),
                        );
                        break;
                    }
                    // 按返回原因判断：用户暂停后马上点「继续」时，标记可能已经清掉，
                    // 但分片仍要留着重新接上，不能当失败清理
                    if control.is_paused() || error == crate::download::PAUSED {
                        // 用户已经点了「继续」时不再回写暂停状态，直接接着下载
                        if control.is_paused() {
                            update_download(
                                &label,
                                paused_view(
                                    id,
                                    &filename,
                                    &path,
                                    last_done.load(Ordering::Relaxed),
                                    last_total.load(Ordering::Relaxed),
                                ),
                            );
                        }
                        while control.is_paused() && !control.is_cancelled() {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                        }
                        if control.is_cancelled() {
                            crate::download::cleanup(&temp_dest).await;
                            crate::download::remove_staging(&staging).await;
                            update_download(
                                &label,
                                cancelled_view(
                                    id,
                                    &filename,
                                    &path,
                                    last_done.load(Ordering::Relaxed),
                                    last_total.load(Ordering::Relaxed),
                                ),
                            );
                            break;
                        }
                        continue;
                    }
                    crate::download::cleanup(&temp_dest).await;
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: filename.clone(),
                            path: path.clone(),
                            downloaded: 0,
                            total: 0,
                            parallel: 0,
                            speed: 0.0,
                            state: "error",
                            error: Some(error),
                        },
                    );
                    break;
                }
            }
        }

        if let Some(size) = size {
            // 下载期间目标名可能被其他程序占用，落盘前再确认一次
            let final_dest = crate::download::unique_dest(&dir, &temp_name);
            let final_filename = final_dest
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&temp_name)
                .to_string();
            let final_path = final_dest.to_string_lossy().to_string();
            match tokio::fs::rename(&temp_dest, &final_dest).await {
                Ok(()) => {
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: final_filename,
                            path: final_path,
                            downloaded: size,
                            total: size,
                            parallel: 1,
                            speed: 0.0,
                            state: "done",
                            error: None,
                        },
                    );
                }
                Err(error) => {
                    crate::download::cleanup(&temp_dest).await;
                    crate::download::remove_staging(&staging).await;
                    update_download(
                        &label,
                        DownloadView {
                            id,
                            filename: final_filename,
                            path: final_path,
                            downloaded: 0,
                            total: 0,
                            parallel: 0,
                            speed: 0.0,
                            state: "error",
                            error: Some(format!("保存文件失败：{error}")),
                        },
                    );
                }
            }
        }

        drop_download_control(id);
    });
}

/// 暂停中的任务快照：保留已下载字节数，进度条停在原地
pub(crate) fn paused_view(id: u64, filename: &str, path: &str, downloaded: u64, total: u64) -> DownloadView {
    DownloadView {
        id,
        filename: filename.to_string(),
        path: path.to_string(),
        downloaded,
        total,
        parallel: 0,
        speed: 0.0,
        state: "paused",
        error: None,
    }
}

pub(crate) fn cancelled_view(id: u64, filename: &str, path: &str, downloaded: u64, total: u64) -> DownloadView {
    DownloadView {
        id,
        filename: filename.to_string(),
        path: path.to_string(),
        downloaded,
        total,
        parallel: 0,
        speed: 0.0,
        state: "cancelled",
        error: None,
    }
}

