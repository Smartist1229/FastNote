use super::*;

/// 给请求附加调用方给的额外头（浏览器下载用它带 Cookie / Referer）。
pub(crate) fn with_extra(request: reqwest::RequestBuilder, extra: Option<&HeaderMap>) -> reqwest::RequestBuilder {
    match extra {
        Some(extra) => request.headers(extra.clone()),
        None => request,
    }
}

/// 下载一个文件到 `dest`。`progress` 会被高频调用，节流由本模块负责；
/// 第三个数值参数是并发连接数（1 表示单流），最后一个参数是正在进行的分片列表。
/// `extra` 会附加到每一个请求上；工具箱与模型下载传 `None`，行为不变。
pub async fn fetch(
    client: &Client,
    url: &str,
    dest: &Path,
    threads: usize,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    ensure_running(control)?;
    if let Some(parent) = dest.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|e| format!("创建目录失败：{e}"))?;
    }

    let probe = probe(client, url, control, extra).await?;
    let total = probe.total;
    if probe.ranges && total.unwrap_or(0) >= MIN_SEGMENT * 2 && threads > 1 {
        if let Some(total) = total {
            return download_segmented(client, url, dest, total, threads, control, extra, progress)
                .await;
        }
    }

    // 单流路径用不上分段文件，顺手清掉上次可能留下的分段进度
    remove_segment_files(dest).await;
    remove_plan(dest).await;
    download_single(client, url, dest, total, probe.response, control, extra, progress).await
}

/// 取消或失败后清理临时文件；保留的分段只对“可重试的网络错误”有意义，取消一律清掉
pub async fn cleanup(dest: &Path) {
    let _ = tokio::fs::remove_file(dest.with_extension("part")).await;
    remove_segment_files(dest).await;
    remove_plan(dest).await;
}

/// 目标是否支持 Range：用 `Range: bytes=0-0` 探测。
/// 返回 206 说明支持；返回 200 时把响应直接留给单流下载，省一次请求。
pub(crate) struct Probe {
    total: Option<u64>,
    ranges: bool,
    response: Option<Response>,
}

pub(crate) async fn probe(
    client: &Client,
    url: &str,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
) -> Result<Probe, String> {
    let request =
        with_extra(client.get(url), extra).header(reqwest::header::RANGE, "bytes=0-0");
    let response = tokio::select! {
        reason = wait_stop(control) => return Err(reason.to_string()),
        result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    let status = response.status();
    // 416 或 4xx：有些站直接拒绝带 Range 的请求（403/400），换成普通 GET 再试一次
    if !status.is_success() {
        let request = with_extra(client.get(url), extra);
        let fallback = tokio::select! {
            reason = wait_stop(control) => return Err(reason.to_string()),
            result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
        };
        if !fallback.status().is_success() {
            return Err(format!("HTTP {}", fallback.status()));
        }
        let total = fallback.content_length();
        return Ok(Probe {
            total,
            ranges: false,
            response: Some(fallback),
        });
    }
    if status == StatusCode::PARTIAL_CONTENT {
        let total = response
            .headers()
            .get(reqwest::header::CONTENT_RANGE)
            .and_then(|value| value.to_str().ok())
            .and_then(content_range_total);
        return Ok(Probe {
            total,
            ranges: total.is_some(),
            response: None,
        });
    }
    // 服务器忽略 Range，这个 200 响应就是完整文件
    let total = response.content_length();
    Ok(Probe {
        total,
        ranges: false,
        response: Some(response),
    })
}

pub(crate) fn content_range_total(value: &str) -> Option<u64> {
    // 形如 `bytes 0-0/12345`；`*` 表示总长未知
    value.rsplit('/').next()?.trim().parse().ok()
}

pub(crate) async fn download_segmented(
    client: &Client,
    url: &str,
    dest: &Path,
    total: u64,
    threads: usize,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    ensure_running(control)?;
    let chunk = chunk_size(total, threads);
    let plan = plan_segments(total, chunk);
    reset_plan_if_changed(dest, total, chunk).await?;

    // 旧版本只留了一个 `<文件>.part`：能塞进第一段就当作第 0 段继续用
    let legacy = dest.with_extension("part");
    let first = segment_path(dest, 0);
    let first_len = plan[0].1 - plan[0].0 + 1;
    if file_len(&legacy) > 0 && !first.exists() {
        if file_len(&legacy) <= first_len {
            let _ = tokio::fs::rename(&legacy, &first).await;
        } else {
            let _ = tokio::fs::remove_file(&legacy).await;
        }
    }

    // 先扫一遍已有分片：能续传的计入总进度，超长的直接作废
    let mut existing = 0u64;
    let mut existing_lens = vec![0u64; plan.len()];
    for (index, (start, end)) in plan.iter().enumerate() {
        let part = segment_path(dest, index);
        let expected = end - start + 1;
        let len = file_len(&part);
        if len > expected {
            let _ = tokio::fs::remove_file(&part).await;
        } else {
            existing_lens[index] = len;
            existing = existing.saturating_add(len);
        }
    }

    let parallelism = threads
        .clamp(1, MAX_THREADS as usize)
        .min(plan.len())
        .max(1);
    let meter = Progress::new(
        &plan,
        &existing_lens,
        existing,
        total,
        parallelism,
        progress,
    );
    meter.emit();

    // 动态调度：所有线程共用一个分片游标，先下完的线程直接取下一片。
    // 单片的下载速度受服务器/线路影响差别很大，谁快谁多干，慢的不会拖住整体。
    let cursor = AtomicUsize::new(0);
    let cursor = &cursor;
    let plan_ref = &plan;
    let lens_ref = &existing_lens;
    let meter_ref: &Progress<'_> = &meter;
    let results = join_all((0..parallelism).map(|_| async move {
        loop {
            ensure_running(control)?;
            let index = cursor.fetch_add(1, Ordering::Relaxed);
            let Some(&(start, end)) = plan_ref.get(index) else {
                break;
            };
            let expected = end - start + 1;
            if lens_ref[index] >= expected {
                continue;
            }
            let part = segment_path(dest, index);
            meter_ref.begin(index);
            let result =
                download_segment(client, url, &part, start, end, control, extra, meter_ref, index)
                    .await;
            meter_ref.end(index);
            result?;
        }
        Ok::<(), String>(())
    }))
    .await;
    for result in results {
        result?;
    }
    ensure_running(control)?;

    let parts: Vec<PathBuf> = plan
        .iter()
        .enumerate()
        .map(|(i, _)| segment_path(dest, i))
        .collect();
    let dest_owned = dest.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || join_parts(&parts, &dest_owned, total))
        .await
        .map_err(|e| format!("合并分段失败：{e}"))??;

    remove_segment_files(dest).await;
    remove_plan(dest).await;
    meter.finish(total);
    Ok(total)
}

pub(crate) async fn download_segment(
    client: &Client,
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    meter: &Progress<'_>,
    index: usize,
) -> Result<(), String> {
    let expected = end - start + 1;
    let mut last_error = String::new();
    for attempt in 0..MAX_ATTEMPTS {
        ensure_running(control)?;
        match segment_once(
            client, url, part, start, end, expected, control, extra, meter, index,
        )
        .await
        {
            Ok(()) => return Ok(()),
            Err(e) => {
                if let Some(reason) = control.and_then(Control::stop_reason) {
                    return Err(reason.to_string());
                }
                last_error = e;
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(format!("分段 {start}–{end} 下载失败：{last_error}"))
}

pub(crate) async fn segment_once(
    client: &Client,
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    expected: u64,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    meter: &Progress<'_>,
    index: usize,
) -> Result<(), String> {
    ensure_running(control)?;
    let mut existing = file_len(part);
    if existing > expected {
        let _ = tokio::fs::remove_file(part).await;
        existing = 0;
    }
    if existing == expected {
        return Ok(());
    }

    let from = start + existing;
    let request = with_extra(client.get(url), extra)
        .header(reqwest::header::RANGE, format!("bytes={from}-{end}"));
    let response = tokio::select! {
        reason = wait_stop(control) => return Err(reason.to_string()),
        result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
    };
    match response.status() {
        StatusCode::PARTIAL_CONTENT => {}
        StatusCode::RANGE_NOT_SATISFIABLE => {
            let _ = tokio::fs::remove_file(part).await;
            return Err("续传位置无效，已清理该分段".to_string());
        }
        status if status.is_success() => return Err("服务器不再支持分段下载".to_string()),
        status => return Err(format!("HTTP {status}")),
    }

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if existing > 0 {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|e| format!("打开分段文件失败：{e}"))?;

    let mut written = existing;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            reason = wait_stop(control) => return Err(reason.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        written += chunk.len() as u64;
        meter.add(index, chunk.len() as u64);
    }
    file.flush().await.map_err(|e| format!("写入失败：{e}"))?;

    if written != expected {
        return Err(format!("分段不完整（{written}/{expected} 字节）"));
    }
    Ok(())
}

pub(crate) async fn download_single(
    client: &Client,
    url: &str,
    dest: &Path,
    known_total: Option<u64>,
    initial: Option<Response>,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    progress: ProgressSink<'_>,
) -> Result<u64, String> {
    let part = dest.with_extension("part");
    let meter = Progress::single(file_len(&part), known_total.unwrap_or(0), progress);
    // 先把总长与「单线程」模式送给界面，避免长连接建立期间只有「准备下载…」
    meter.emit();
    let mut response = initial;
    let mut last_error = String::new();

    for attempt in 0..MAX_ATTEMPTS {
        ensure_running(control)?;
        let existing = file_len(&part);
        // 探测得到的 200 响应是最新快照，已有续传数据时不能用它覆盖
        let initial_response = if attempt == 0 && existing == 0 {
            response.take()
        } else {
            None
        };
        match single_once(
            client,
            url,
            &part,
            existing,
            known_total,
            initial_response,
            control,
            extra,
            &meter,
        )
        .await
        {
            Ok(downloaded) => {
                if let Some(total) = known_total {
                    if downloaded < total {
                        let _ = tokio::fs::remove_file(&part).await;
                        return Err(format!("下载不完整（{downloaded}/{total} 字节）"));
                    }
                }
                tokio::fs::rename(&part, dest)
                    .await
                    .map_err(|e| format!("保存文件失败：{e}"))?;
                meter.finish(downloaded);
                return Ok(downloaded);
            }
            Err(e) => {
                if let Some(reason) = control.and_then(Control::stop_reason) {
                    return Err(reason.to_string());
                }
                last_error = e;
                if attempt + 1 < MAX_ATTEMPTS {
                    tokio::time::sleep(Duration::from_millis(400 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last_error)
}

pub(crate) async fn single_once(
    client: &Client,
    url: &str,
    part: &Path,
    existing: u64,
    known_total: Option<u64>,
    initial: Option<Response>,
    control: Option<&Control>,
    extra: Option<&HeaderMap>,
    meter: &Progress<'_>,
) -> Result<u64, String> {
    ensure_running(control)?;
    let response = match initial {
        Some(response) => response,
        None => {
            let mut request = with_extra(client.get(url), extra);
            if existing > 0 {
                request = request.header(reqwest::header::RANGE, format!("bytes={existing}-"));
            }
            let response = tokio::select! {
                reason = wait_stop(control) => return Err(reason.to_string()),
                result = request.send() => result.map_err(|e| format!("请求失败：{e}"))?,
            };
            if response.status() == StatusCode::RANGE_NOT_SATISFIABLE {
                let _ = tokio::fs::remove_file(part).await;
                return Err("续传位置无效，已清理临时文件".to_string());
            }
            if !response.status().is_success() {
                return Err(format!("HTTP {}", response.status()));
            }
            response
        }
    };

    // 200 表示服务器没理会 Range：从头写，进度也要归零重算
    let resumed = existing > 0 && response.status() == StatusCode::PARTIAL_CONTENT;
    let start_at = if resumed { existing } else { 0 };
    let expected = known_total.or_else(|| {
        response
            .content_length()
            .map(|remaining| remaining + start_at)
    });

    let mut options = tokio::fs::OpenOptions::new();
    options.create(true).write(true);
    if resumed {
        options.append(true);
    } else {
        options.truncate(true);
    }
    let mut file = options
        .open(part)
        .await
        .map_err(|e| format!("打开临时文件失败：{e}"))?;

    meter.set_done(start_at);
    meter.emit();

    let mut downloaded = start_at;
    let mut stream = response.bytes_stream();
    loop {
        let next = tokio::select! {
            reason = wait_stop(control) => return Err(reason.to_string()),
            next = stream.next() => next,
        };
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| format!("写入失败：{e}"))?;
        downloaded += chunk.len() as u64;
        meter.add_global(chunk.len() as u64);
    }
    file.flush().await.map_err(|e| format!("写入失败：{e}"))?;

    if let Some(total) = expected {
        if downloaded < total {
            return Err(format!("下载中断（{downloaded}/{total} 字节）"));
        }
    }
    Ok(downloaded)
}

