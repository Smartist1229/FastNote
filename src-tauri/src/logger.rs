//! 运行日志：写到安装目录的 `log/`（不可写时回退数据目录下的 `log/`），按天分文件。
//!
//! 为什么不用 tauri-plugin-log：它能省掉这个文件的大半代码，但会给 Cargo.lock 添一条
//! 新依赖链，离线构建就断了。我们要的只是「用户出事时能导出一份文本」——
//! 按天分文件、保留 14 天、单日封顶，已经够排障。
//!
//! 三条硬线：
//! - 写日志**绝不能**让主流程失败：目录不可写、磁盘满都只影响日志本身；
//! - 单日文件到上限就停写（只留 stderr），避免某个死循环把磁盘写满；
//! - 路径与 `resolve_data_dir` 同一套策略：优先便携（exe 同级），否则用户数据目录。
//!
//! 日志里只放路径、数量、错误文本，**不放**笔记正文与密码。

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use chrono::{Duration, Local, NaiveDate};

/// 单日文件上限：超过就只留 stderr
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;
/// 日志保留天数
const KEEP_DAYS: i64 = 14;
const FILE_PREFIX: &str = "fastnote-";

struct Sink {
    file: File,
    date: NaiveDate,
    bytes: u64,
    /// 当天已写满：后续只进 stderr，不再碰磁盘
    capped: bool,
}

/// `None` = 日志目录不可用（只输出到 stderr）
static DIR: OnceLock<Option<PathBuf>> = OnceLock::new();
static SINK: Mutex<Option<Sink>> = Mutex::new(None);

/// 日志目录：安装目录下的 `log`，不可写时退回数据目录（与 `resolve_data_dir` 同规则）
pub fn dir() -> PathBuf {
    DIR.get_or_init(candidate_dir)
        .clone()
        .unwrap_or_else(|| PathBuf::from("log"))
}

fn candidate_dir() -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let path = parent.join("log");
            if std::fs::create_dir_all(&path).is_ok() {
                return Some(path);
            }
        }
    }
    // 装在 Program Files 里时 exe 同级不可写，退回用户数据目录
    let path = crate::resolve_data_dir(None).join("log");
    std::fs::create_dir_all(&path).ok().map(|_| path)
}

fn open_sink(dir: &Path, date: NaiveDate) -> Option<Sink> {
    let path = dir.join(format!("{FILE_PREFIX}{}.log", date.format("%Y-%m-%d")));
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .ok()?;
    // 同一天多次启动：按已有大小累计，避免每次重启都能再写满 8MB
    let bytes = file.metadata().map(|m| m.len()).unwrap_or(0);
    Some(Sink {
        file,
        date,
        bytes,
        capped: bytes >= MAX_FILE_BYTES,
    })
}

/// 启动：建目录、清过期文件、写一条启动行
pub fn init(version: &str) {
    let dir = dir();
    prune(&dir);
    emit(
        "INFO",
        &format!(
            "===== FastNote v{version} 启动 · {} {} =====",
            std::env::consts::OS,
            std::env::consts::ARCH
        ),
    );
}

/// 删掉超过保留期的日志；文件名里就是日期，不用看 mtime
fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let cutoff = Local::now().date_naive() - Duration::days(KEEP_DAYS);
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix(FILE_PREFIX) else {
            continue;
        };
        let Some(stamp) = rest.strip_suffix(".log") else {
            continue;
        };
        let Ok(date) = NaiveDate::parse_from_str(stamp, "%Y-%m-%d") else {
            continue;
        };
        if date < cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// 落一行日志：stderr + 文件。任何失败都静默 —— 日志不该拖垮主流程
pub fn emit(level: &str, message: &str) {
    eprintln!("[fastnote] {level} {message}");

    let now = Local::now();
    let today = now.date_naive();
    let Ok(mut guard) = SINK.lock() else {
        return;
    };

    // 首次、跨天、或当天已封顶后的新一天：换文件
    if guard.as_ref().map(|sink| sink.date) != Some(today) {
        *guard = open_sink(&dir(), today);
    }
    let Some(sink) = guard.as_mut() else {
        return;
    };
    if sink.capped {
        return;
    }

    // 多行消息缩进续行，保证「一行一条」的解析习惯不被 Panic 的堆栈打破
    let line = format!(
        "{} {level} {}\n",
        now.format("%Y-%m-%d %H:%M:%S%.3f"),
        message.replace('\n', "\n    ")
    );
    if sink.file.write_all(line.as_bytes()).is_ok() {
        sink.bytes += line.len() as u64;
        if sink.bytes >= MAX_FILE_BYTES {
            sink.capped = true;
        }
    }
}

/// panic 也进日志：否则用户只看到窗口消失，我们连「哪一行」都不知道
pub fn install_panic_hook() {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        emit("PANIC", &info.to_string());
        default_hook(info);
    }));
}

/// 日常信息：启动、备份成功这类「事后想确认发生了什么」的节点
#[macro_export]
macro_rules! log_info {
    ($($arg:tt)*) => {{
        $crate::logger::emit("INFO", &format!($($arg)*));
    }};
}

/// 警告：还能继续，但值得看一眼
#[macro_export]
macro_rules! log_warn {
    ($($arg:tt)*) => {{
        $crate::logger::emit("WARN", &format!($($arg)*));
    }};
}

/// 错误：功能失败，用户会感知到
#[macro_export]
macro_rules! log_error {
    ($($arg:tt)*) => {{
        $crate::logger::emit("ERROR", &format!($($arg)*));
    }};
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("fastnote-log-{tag}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    /// 同一天多次启动要累加已有大小，否则每次重启都能再写满 8MB
    #[test]
    fn reopen_continues_byte_count() {
        let dir = temp_dir("reopen");
        let date = Local::now().date_naive();

        let mut sink = open_sink(&dir, date).expect("首次打开");
        sink.file.write_all(b"first line\n").expect("写入");
        sink.file.flush().expect("flush");

        let again = open_sink(&dir, date).expect("再次打开");
        assert!(again.bytes >= 11, "应累计已有大小：{}", again.bytes);
        assert!(again.file.metadata().expect("meta").len() >= 11);

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 过期日志必须被清掉，当天的必须留着（文件名里的日期就是判据，不看 mtime）
    #[test]
    fn prune_removes_expired_files_only() {
        let dir = temp_dir("prune");
        let today = Local::now().date_naive();
        let old = today - Duration::days(KEEP_DAYS + 1);

        let old_path = dir.join(format!("{FILE_PREFIX}{}.log", old.format("%Y-%m-%d")));
        let today_path = dir.join(format!("{FILE_PREFIX}{}.log", today.format("%Y-%m-%d")));
        let other_path = dir.join("notes.txt");
        for path in [&old_path, &today_path, &other_path] {
            std::fs::write(path, b"x").expect("造文件");
        }

        prune(&dir);

        assert!(!old_path.exists(), "过期日志应被删除");
        assert!(today_path.exists(), "当天的日志不能删");
        assert!(other_path.exists(), "不是日志的文件不能碰");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
