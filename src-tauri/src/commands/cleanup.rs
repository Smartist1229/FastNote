//! 设置 · 清理：语义索引缓存与临时残留的统计 / 回收。
//!
//! 这里的对象是**可重建的派生数据**，删了不丢笔记：
//!
//! - `note_chunks` / `note_index_state`：语义检索的向量索引。重建代价是重新推理一遍，
//!   但索引里每条都是 `dim × 4` 字节的 BLOB，几百篇长笔记就能占几十 MB，且换模型后
//!   旧向量全是垃圾。删掉之后索引 worker 会因为「查不到 note_index_state 行」把它们
//!   判成脏笔记重新索引（见 `semantic/index.rs` 的 `s.note_id IS NULL`）。
//! - `%TEMP%/fastnote-*`：恢复备份前的整库快照（`fastnote-preserve-*.db`）等。
//!   正常路径由 Drop 清掉，但崩溃 / 强杀会留下整份数据库副本，几百 MB 也是它。
//!
//! **不在这里做的事**：`semantic_meta` 一行都不动。它记的是「当前模型 id / 维度 / 上次错误」，
//! 属于配置而不是缓存，删了会让状态面板读不到所选模型。
//!
//! 临时文件带两道闸：只认 `fastnote-` 前缀、只删落盘超过一天的。正在进行的恢复/导出
//! 刚写过这些文件，mtime 是新的；同进程正在用的那份还额外按 pid 跳过。

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::AppState;

/// 临时目录里属于本软件的条目前缀
const TEMP_PREFIX: &str = "fastnote-";

/// 临时残留的宽限期。恢复备份可能在几分钟里反复写，短于此值的一律当成"正在用"
const TEMP_MIN_AGE: Duration = Duration::from_secs(24 * 60 * 60);

/// 索引小于这个体积就不做压缩：几 MB 的回收不值得锁库全量重写一次
const VACUUM_MIN_BYTES: i64 = 16 * 1024 * 1024;

/// 索引占库文件的比例低于这个值也不压缩。
///
/// 这一条比绝对体积重要：649 MB 的库（1500 条历史快照）里索引可能只有几 MB，
/// 为它 VACUUM 要重写整个库——几十秒卡顿，而且 WAL 会涨到和库一样大，
/// 之后每次读写都要在大 WAL 里翻页，整个软件都跟着慢。
const VACUUM_MIN_RATIO: f64 = 0.2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheUsage {
    /// 数据库主文件大小（含索引与笔记本身，只用来给用户一个量级）
    pub db_bytes: i64,
    /// 向量索引占的字节（embedding + 分块文本）
    pub index_bytes: i64,
    /// 向量索引的分块数
    pub index_chunks: i64,
    /// 临时目录里可清理的残留体积
    pub temp_bytes: i64,
    /// 临时目录里可清理的条目数
    pub temp_files: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CacheClearReport {
    /// 删掉的分块数
    pub index_chunks: i64,
    /// 删掉的索引字节（VACUUM 前）
    pub index_bytes: i64,
    /// VACUUM 之后数据库文件实际缩小的字节数（拿不到就是 0）
    pub db_freed: i64,
    pub temp_files: i64,
    pub temp_freed: i64,
}

/* ---------------- 路径 ---------------- */

fn db_path(app: &AppHandle) -> PathBuf {
    crate::resolve_data_dir(app.path().app_data_dir().ok()).join(crate::DB_FILE_NAME)
}

fn file_len(path: &Path) -> i64 {
    std::fs::metadata(path)
        .map(|m| m.len() as i64)
        .unwrap_or(0)
}

/* ---------------- 临时残留 ---------------- */

/// 递归求一个条目的体积（目录要进去算，`fastnote-preserve-*` 是文件，但暂存目录是文件夹）
fn entry_size(path: &Path) -> i64 {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(_) => return 0,
    };
    if meta.is_file() {
        return meta.len() as i64;
    }
    let mut total = 0;
    if let Ok(entries) = std::fs::read_dir(path) {
        for entry in entries.flatten() {
            total += entry_size(&entry.path());
        }
    }
    total
}

fn modified_at(path: &Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// 扫一遍临时目录，返回 `(条目数, 字节数)`；`remove` 为 true 时顺手删掉。
fn sweep_temp(remove: bool) -> (i64, i64) {
    sweep_temp_at(&std::env::temp_dir(), remove, TEMP_MIN_AGE)
}

/// `sweep_temp` 的实现体：目录与宽限期都从参数进来，测试才好用。
///
/// 两道过滤：前缀必须是 `fastnote-`，mtime 必须早于宽限期。
/// 本进程自己正在用的那份（文件名带 `-<pid>-`）无条件跳过——恢复备份时它正被 SQLite 打开着。
fn sweep_temp_at(dir: &Path, remove: bool, min_age: Duration) -> (i64, i64) {
    let mut files = 0;
    let mut bytes = 0;

    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(_) => return (0, 0),
    };

    let now = SystemTime::now();
    let own_pid_tag = format!("-{}-", std::process::id());

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with(TEMP_PREFIX) || name.contains(&own_pid_tag) {
            continue;
        }
        let path = entry.path();
        let fresh = modified_at(&path)
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age < min_age)
            .unwrap_or(true); // 拿不到 mtime 就当新的：宁可少删
        if fresh {
            continue;
        }
        let size = entry_size(&path);
        if remove {
            let ok = if path.is_dir() {
                std::fs::remove_dir_all(&path).is_ok()
            } else {
                std::fs::remove_file(&path).is_ok()
            };
            if !ok {
                continue;
            }
        }
        files += 1;
        bytes += size;
    }

    (files, bytes)
}

/* ---------------- 索引 ---------------- */

fn index_usage(conn: &Connection) -> Result<(i64, i64), String> {
    conn.query_row(
        "SELECT COUNT(*), COALESCE(SUM(LENGTH(embedding) + LENGTH(text)), 0) FROM note_chunks",
        [],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .map_err(|e| format!("统计索引占用失败：{e}"))
}

/* ---------------- 命令 ---------------- */

#[tauri::command]
pub fn cache_usage(app: AppHandle, state: State<AppState>) -> Result<CacheUsage, String> {
    let (index_chunks, index_bytes) = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        index_usage(&conn)?
    };
    let (temp_files, temp_bytes) = sweep_temp(false);

    Ok(CacheUsage {
        db_bytes: file_len(&db_path(&app)),
        index_bytes,
        index_chunks,
        temp_bytes,
        temp_files,
    })
}

/// 清空向量索引 + 临时残留，并尝试 VACUUM 把文件真正缩小。
///
/// 必须 async：VACUUM 在大库上要几秒，同步命令会冻住窗口。
#[tauri::command(async)]
pub fn clear_cache(app: AppHandle, state: State<AppState>) -> Result<CacheClearReport, String> {
    let path = db_path(&app);
    let db_before = file_len(&path);

    // 1) 清索引（两表必须一起清：只删块会让 worker 以为笔记"已索引"而永不重建）
    let (index_chunks, index_bytes) = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        let (chunks, bytes) = index_usage(&conn)?;
        conn.execute("DELETE FROM note_chunks", [])
            .map_err(|e| format!("清空索引失败：{e}"))?;
        conn.execute("DELETE FROM note_index_state", [])
            .map_err(|e| format!("清空索引状态失败：{e}"))?;
        if bytes >= VACUUM_MIN_BYTES
            && db_before > 0
            && (bytes as f64) / (db_before as f64) >= VACUUM_MIN_RATIO
        {
            /*
             * 删行只是把页标成空闲，文件不会缩；这一步失败也不影响「已清空」这个事实。
             *
             * VACUUM 在 WAL 下是整库重写进 -wal，必须立刻 TRUNCATE 合并回去，
             * 否则主库文件没变、WAL 却涨到和库一样大，之后所有读写都变慢。
             */
            let _ = conn.execute_batch("VACUUM");
            let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
        }
        (chunks, bytes)
    };

    // 2) 内存里的向量缓存跟着失效，否则下一次搜索还会命中已删掉的块
    crate::semantic::invalidate(&state.semantic);

    let db_freed = (db_before - file_len(&path)).max(0);

    // 3) 临时残留
    let (temp_files, temp_freed) = sweep_temp(true);

    Ok(CacheClearReport {
        index_chunks,
        index_bytes,
        db_freed,
        temp_files,
        temp_freed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 只删「自己的前缀 + 够老」的条目，别人的文件与目录外的内容一概不碰
    #[test]
    fn sweep_only_removes_own_prefix() {
        let root = std::env::temp_dir().join(format!("fastnote-cleanup-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("建测试目录");

        let mine = root.join("fastnote-legacy.db");
        std::fs::write(&mine, vec![0u8; 1024]).expect("写自己的残留");
        // 目录也要递归算体积后整个删掉
        let mine_dir = root.join("fastnote-staging");
        std::fs::create_dir_all(&mine_dir).expect("建暂存目录");
        std::fs::write(mine_dir.join("part.bin"), vec![0u8; 512]).expect("写分片");
        let other = root.join("other-app.db");
        std::fs::write(&other, b"keep").expect("写别人的文件");

        let (files, bytes) = sweep_temp_at(&root, true, Duration::ZERO);

        assert_eq!(files, 2, "只应删掉两个 fastnote- 条目");
        assert_eq!(bytes, 1024 + 512);
        assert!(!mine.exists());
        assert!(!mine_dir.exists());
        assert!(other.exists(), "别的前缀不能被删");

        let _ = std::fs::remove_dir_all(&root);
    }

    /// 宽限期内的条目不删：正在进行的恢复/导出就是这种
    #[test]
    fn sweep_keeps_fresh_entries() {
        let root = std::env::temp_dir().join(format!("fastnote-cleanup-fresh-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("建测试目录");

        let fresh = root.join("fastnote-preserve-1-a.db");
        std::fs::write(&fresh, b"x").expect("写文件");

        let (files, _) = sweep_temp_at(&root, true, TEMP_MIN_AGE);

        assert_eq!(files, 0);
        assert!(fresh.exists(), "刚写过的文件不能被当成残留");

        let _ = std::fs::remove_dir_all(&root);
    }
}

/* ---------------- 日志 ---------------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogUsage {
    /// 可清理的部分：今天之前的所有日志
    pub old_bytes: u64,
    pub old_files: usize,
    /// 今天的日志：只展示，清理时跳过（它可能正被写入）
    pub today_bytes: u64,
}

/// 统计日志占用（只算本软件自己写的 `fastnote-YYYY-MM-DD.log`）
#[tauri::command]
pub fn log_usage() -> LogUsage {
    let old = crate::logger::old_log_files();
    LogUsage {
        old_bytes: old.iter().map(|(_, size)| *size).sum(),
        old_files: old.len(),
        today_bytes: crate::logger::today_bytes(),
    }
}

/// 删除今天之前的日志，返回释放的字节数。今天的日志一定保留。
#[tauri::command]
pub fn clear_old_logs() -> u64 {
    let (bytes, files) = crate::logger::prune_before_today();
    crate::log_info!("cleared old logs: {files} files, freed {:.1} MB", bytes as f64 / 1_048_576.0);
    bytes
}
