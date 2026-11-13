use super::*;

/// 单个分片的计数与测速：下载线程写入，emit 时读取快照
pub(crate) struct SegmentSlot {
    start: u64,
    end: u64,
    done: AtomicU64,
    active: AtomicBool,
    last_bytes: AtomicU64,
    last_ms: AtomicU64,
    /// f64 的位模式；原子类型只有整数操作
    speed: AtomicU64,
}

impl SegmentSlot {
    pub(crate) fn new(start: u64, end: u64, done: u64) -> Self {
        Self {
            start,
            end,
            done: AtomicU64::new(done),
            active: AtomicBool::new(false),
            last_bytes: AtomicU64::new(done),
            last_ms: AtomicU64::new(0),
            speed: AtomicU64::new(0f64.to_bits()),
        }
    }

    pub(crate) fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    /// 两次 emit 之间的瞬时速度做指数平滑，避免界面数字乱跳
    pub(crate) fn measure(&self, now_ms: u64) -> f64 {
        let prev = f64::from_bits(self.speed.load(Ordering::Relaxed));
        let last_ms = self.last_ms.load(Ordering::Relaxed);
        if now_ms <= last_ms {
            return prev;
        }
        let last_bytes = self.last_bytes.load(Ordering::Relaxed);
        let done = self.done.load(Ordering::Relaxed);
        if self
            .last_ms
            .compare_exchange(last_ms, now_ms, Ordering::Relaxed, Ordering::Relaxed)
            .is_err()
        {
            return prev;
        }
        let instant = done.saturating_sub(last_bytes) as f64 * 1000.0 / (now_ms - last_ms) as f64;
        let next = if prev > 0.0 {
            prev * 0.6 + instant * 0.4
        } else {
            instant
        };
        self.last_bytes.store(done, Ordering::Relaxed);
        self.speed.store(next.to_bits(), Ordering::Relaxed);
        next
    }
}

/// 进度汇聚：总计数 + 各分片计数，250ms 最多回调一次，避免事件把前端刷爆
pub(crate) struct Progress<'a> {
    start: Instant,
    last_emit_ms: AtomicU64,
    done: AtomicU64,
    total: u64,
    /// 并发连接数；1 表示单流
    parallelism: usize,
    slots: Vec<SegmentSlot>,
    callback: ProgressSink<'a>,
}

impl<'a> Progress<'a> {
    pub(crate) fn new(
        plan: &[(u64, u64)],
        existing_lens: &[u64],
        done: u64,
        total: u64,
        parallelism: usize,
        callback: ProgressSink<'a>,
    ) -> Self {
        let slots = plan
            .iter()
            .zip(existing_lens)
            .map(|((start, end), len)| SegmentSlot::new(*start, *end, *len))
            .collect();
        Self {
            start: Instant::now(),
            last_emit_ms: AtomicU64::new(0),
            done: AtomicU64::new(done),
            total,
            parallelism,
            slots,
            callback,
        }
    }

    pub(crate) fn single(done: u64, total: u64, callback: ProgressSink<'a>) -> Self {
        Self {
            start: Instant::now(),
            last_emit_ms: AtomicU64::new(0),
            done: AtomicU64::new(done),
            total,
            parallelism: 1,
            slots: Vec::new(),
            callback,
        }
    }

    /// 分片开始下载：重置测速基准并尽快把新分片送到界面
    pub(crate) fn begin(&self, index: usize) {
        let slot = &self.slots[index];
        let now = self.start.elapsed().as_millis() as u64;
        slot.last_bytes
            .store(slot.done.load(Ordering::Relaxed), Ordering::Relaxed);
        slot.last_ms.store(now, Ordering::Relaxed);
        slot.speed.store(0f64.to_bits(), Ordering::Relaxed);
        slot.active.store(true, Ordering::Relaxed);
        self.maybe_emit();
    }

    pub(crate) fn end(&self, index: usize) {
        self.slots[index].active.store(false, Ordering::Relaxed);
    }

    pub(crate) fn add(&self, index: usize, bytes: u64) {
        self.slots[index].done.fetch_add(bytes, Ordering::Relaxed);
        self.add_global(bytes);
    }

    pub(crate) fn add_global(&self, bytes: u64) {
        self.done.fetch_add(bytes, Ordering::Relaxed);
        self.maybe_emit();
    }

    pub(crate) fn maybe_emit(&self) {
        let now = self.start.elapsed().as_millis() as u64;
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        if now.saturating_sub(last) >= EMIT_INTERVAL_MS
            && self
                .last_emit_ms
                .compare_exchange(last, now, Ordering::Relaxed, Ordering::Relaxed)
                .is_ok()
        {
            (self.callback)(
                self.done.load(Ordering::Relaxed),
                self.total,
                self.parallelism,
                &self.snapshot(now),
            );
        }
    }

    pub(crate) fn set_done(&self, done: u64) {
        self.done.store(done, Ordering::Relaxed);
    }

    pub(crate) fn emit(&self) {
        let now = self.start.elapsed().as_millis() as u64;
        (self.callback)(
            self.done.load(Ordering::Relaxed),
            self.total,
            self.parallelism,
            &self.snapshot(now),
        );
    }

    pub(crate) fn finish(&self, done: u64) {
        self.set_done(done);
        self.emit();
    }

    /// 只输出仍在下载的分片：下完的立刻从列表里消失，接替它的新分片自然出现
    pub(crate) fn snapshot(&self, now_ms: u64) -> Vec<SegmentProgress> {
        self.slots
            .iter()
            .enumerate()
            .filter_map(|(index, slot)| {
                if !slot.active.load(Ordering::Relaxed) {
                    return None;
                }
                Some(SegmentProgress {
                    index,
                    start: slot.start,
                    end: slot.end,
                    downloaded: slot.done.load(Ordering::Relaxed).min(slot.len()),
                    total: slot.len(),
                    speed: slot.measure(now_ms),
                })
            })
            .collect()
    }
}

/// 分片大小：并发越多分片越多，队列里始终有可抢的份数；
/// 夹在 4 MiB–256 MiB 之间——大分片让连接有足够时间跑满带宽，小分片只留作兜底。
pub(crate) fn chunk_size(total: u64, threads: usize) -> u64 {
    let threads = threads.clamp(1, MAX_THREADS as usize) as u64;
    (total / (threads * SEGMENTS_PER_THREAD as u64)).clamp(MIN_SEGMENT, MAX_SEGMENT)
}

/// 分片范围（闭区间）；个数有上限，超大文件按上限反推单片长度
pub(crate) fn plan_segments(total: u64, chunk: u64) -> Vec<(u64, u64)> {
    let chunk = chunk.max(1);
    let count = total.div_ceil(chunk).clamp(1, MAX_SEGMENTS as u64);
    let chunk = total.div_ceil(count).max(1);
    let last = total.saturating_sub(1);
    let mut out = Vec::with_capacity(count as usize);
    let mut begin = 0u64;
    for _ in 0..count {
        let end = begin.saturating_add(chunk - 1).min(last);
        out.push((begin, end));
        if end >= last {
            break;
        }
        begin = end + 1;
    }
    out
}

pub(crate) fn segment_path(dest: &Path, index: usize) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!("{name}.part.{index}"))
}

pub(crate) fn plan_path(dest: &Path) -> PathBuf {
    let name = dest
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("download");
    dest.with_file_name(format!("{name}.part.plan"))
}

/// 分片布局（总长或单片长度）变了，旧分段的位置就不能复用：清掉重下
pub(crate) async fn reset_plan_if_changed(dest: &Path, total: u64, chunk: u64) -> Result<(), String> {
    let path = plan_path(dest);
    let expected = json!({ "total": total, "chunk": chunk }).to_string();
    if let Ok(raw) = tokio::fs::read_to_string(&path).await {
        if raw.trim() == expected {
            return Ok(());
        }
    }
    remove_segment_files(dest).await;
    tokio::fs::write(&path, expected)
        .await
        .map_err(|e| format!("写入下载计划失败：{e}"))
}

pub(crate) async fn remove_segment_files(dest: &Path) {
    let Some(parent) = dest.parent() else { return };
    let Some(name) = dest.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let prefix = format!("{name}.part.");
    if let Ok(mut entries) = tokio::fs::read_dir(parent).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if file_name.starts_with(&prefix) {
                let _ = tokio::fs::remove_file(entry.path()).await;
            }
        }
    }
}

pub(crate) async fn remove_plan(dest: &Path) {
    let _ = tokio::fs::remove_file(plan_path(dest)).await;
}

pub(crate) fn join_parts(parts: &[PathBuf], dest: &Path, total: u64) -> Result<(), String> {
    let temp = dest.with_extension("part");
    let _ = std::fs::remove_file(&temp);
    let mut output = std::fs::File::create(&temp).map_err(|e| format!("创建文件失败：{e}"))?;
    let mut buffer = vec![0u8; 256 * 1024];
    for part in parts {
        let mut input = std::fs::File::open(part).map_err(|e| format!("打开分段失败：{e}"))?;
        loop {
            let read = input.read(&mut buffer).map_err(|e| e.to_string())?;
            if read == 0 {
                break;
            }
            output
                .write_all(&buffer[..read])
                .map_err(|e| e.to_string())?;
        }
    }
    output.flush().map_err(|e| e.to_string())?;
    drop(output);

    let size = file_len(&temp);
    if size != total {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("合并后大小不符（{size}/{total} 字节）"));
    }
    std::fs::rename(&temp, dest).map_err(|e| format!("保存文件失败：{e}"))?;
    Ok(())
}

pub(crate) fn file_len(path: &Path) -> u64 {
    std::fs::metadata(path).map(|meta| meta.len()).unwrap_or(0)
}

