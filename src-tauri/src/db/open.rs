use super::*;

/**
 * 打开数据库并在必要时自愈。这是启动链上唯一"失败也能给用户留条路"的地方。
 *
 * 三件事：
 * 1. **升级前备份**：`app.runtime.lastVersion` 与当前版本不同时，先 `VACUUM INTO`
 *    一份 `pre-migration-<旧>-to-<新>-<时间>.db`。迁移是唯一会动结构、且失败后
 *    两代数据都残缺的操作，留一份旧库才有"退回去"的选项。
 * 2. **损坏兜底**：断电 / 磁盘坏块会让库文件坏掉。严重损坏时 `Connection::open`
 *    往往还能成功，报错发生在第一次查询——也就是 `init_database`。命中损坏类错误时
 *    把原文件改名 `.corrupt-<时间>` 并建新库启动，而不是 panic 掉整个应用
 *    （panic 的表现是窗口一闪而过，用户连"数据还在哪"都看不到）。
 * 3. **恢复通知**：隔离后往新库写一条 `app.runtime.recovered`，前端启动时取走并提示。
 */
pub(crate) fn open_database(
    data_dir: &std::path::Path,
    db_path: &std::path::Path,
    version: &str,
) -> Connection {
    match open_and_migrate(data_dir, db_path, version) {
        Ok(conn) => conn,
        Err(error) if is_corruption(&error) => {
            crate::log_error!("database is corrupted, quarantining and rebuilding: {error}");
            let quarantined = quarantine(db_path);
            let conn = Connection::open(db_path).expect("重建数据库失败");
            configure(&conn);
            init_database(&conn).expect("重建后初始化失败");
            let name = quarantined
                .as_ref()
                .and_then(|path| path.file_name())
                .and_then(|name| name.to_str())
                .map(|name| name.to_string());
            write_recovery_note(&conn, name.as_deref());
            crate::log_warn!(
                "started with an empty database; corrupted file kept as {}",
                name.as_deref().unwrap_or("(quarantine failed)")
            );
            conn
        }
        Err(error) => panic!("failed to initialize database: {error}"),
    }
}

pub(crate) fn open_and_migrate(
    data_dir: &std::path::Path,
    db_path: &std::path::Path,
    version: &str,
) -> rusqlite::Result<Connection> {
    let conn = Connection::open(db_path)?;
    configure(&conn);
    backup_before_migration(&conn, data_dir, version);
    init_database(&conn)?;
    record_version(&conn, version);
    Ok(conn)
}

/**
 * 连接级参数。
 *
 * 全库只有一个可写连接（`AppState::conn` 里的 Mutex），但手动保存、AI 工具写入、
 * 历史快照、语义索引 worker 都要抢它，默认的 rollback journal 加上没有超时，
 * 会让"正在写"直接返回 SQLITE_BUSY。
 *
 * - WAL：读不挡写、写不挡读，自动保存期间列表查询不会被卡住；
 *   代价是多出 -wal / -shm 两个附属文件。备份不受影响：快照走 `VACUUM INTO`
 *   （与日志模式无关），webdav 也是先快照再上传，不直接拷活库。
 * - synchronous=NORMAL：WAL 下的推荐值，断电最多丢最后一个事务、不会坏库；
 *   默认 FULL 会让每次 500ms 防抖的自动保存都 fsync 一次。
 * - busy_timeout：等锁最多 5 秒再报错，而不是立刻把 SQLITE_BUSY 抛给界面。
 * - secure_delete：删除/覆盖加密前的明文行时清零旧页。
 *   **WAL 下被覆盖的页会留在 -wal 里直到 checkpoint**，所以"落盘即净"的路径
 *   必须显式 checkpoint：加解密后统一走 encryption.rs 的 `scrub()` →
 *   `wal_checkpoint(TRUNCATE)`，空闲时 `crypto_scrub_flush` 再做一次 checkpoint + VACUUM。
 * - temp_store=MEMORY：VACUUM / 排序的临时结构留在内存，不落磁盘临时目录。
 */
pub(crate) fn configure(conn: &Connection) {
    let _ = conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA busy_timeout = 5000;
         PRAGMA secure_delete = ON;
         PRAGMA temp_store = MEMORY;",
    );
}

/// 损坏类错误：只看 code 不够（有些版本报的是 generic failure），再兜一层文本匹配
pub(crate) fn is_corruption(error: &rusqlite::Error) -> bool {
    if let rusqlite::Error::SqliteFailure(inner, _) = error {
        if matches!(
            inner.code,
            rusqlite::ErrorCode::DatabaseCorrupt | rusqlite::ErrorCode::NotADatabase
        ) {
            return true;
        }
    }
    let text = error.to_string().to_ascii_lowercase();
    text.contains("malformed")
        || text.contains("not a database")
        || text.contains("file is encrypted")
}

/// 上一个跑过的版本；表还没建（全新库 / 极老库）时返回 None
pub(crate) fn read_last_version(conn: &Connection) -> Option<String> {
    if !has_table(conn, "app_settings") {
        return None;
    }
    let raw: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = 'app.runtime.lastVersion'",
            [],
            |row| row.get(0),
        )
        .optional()
        .ok()??;
    serde_json::from_str::<String>(&raw).ok()
}

pub(crate) fn record_version(conn: &Connection, version: &str) {
    let value = serde_json::to_string(version).unwrap_or_else(|_| format!("\"{version}\""));
    let _ = conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('app.runtime.lastVersion', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![value, Local::now().to_rfc3339()],
    );
}

/// 版本变化（= 将要执行迁移）时先留一份完整快照。
///
/// 用 `VACUUM INTO` 而不是 `fs::copy`：WAL 模式下主库文件与 `-wal` 合起来才是完整数据，
/// 直接拷主库可能拿到一个缺最近事务的版本。
pub(crate) fn backup_before_migration(conn: &Connection, data_dir: &std::path::Path, version: &str) {
    let Some(last) = read_last_version(conn) else {
        return; // 全新库：没有可备份的内容
    };
    if last == version {
        return;
    }

    let name = format!(
        "pre-migration-{last}-to-{version}-{}.db",
        Local::now().format("%Y%m%d-%H%M%S")
    );
    let target = data_dir.join(&name);
    match conn.execute("VACUUM INTO ?1", params![target.to_string_lossy().to_string()]) {
        Ok(_) => {
            crate::log_info!("backed up database before migration: {name}");
            prune_migration_backups(data_dir);
        }
        // 备份失败只警告：挡住启动的代价比"没有退路"更大
        Err(error) => crate::log_warn!("failed to back up database before migration (continuing): {error}"),
    }
}

/// 升级备份只留最近 3 份：这类文件每份都是整库大小，攒多了会吃满磁盘
pub(crate) fn prune_migration_backups(data_dir: &std::path::Path) {
    let Ok(entries) = std::fs::read_dir(data_dir) else {
        return;
    };
    let mut files: Vec<(std::path::PathBuf, std::time::SystemTime)> = entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            name.starts_with("pre-migration-") && name.ends_with(".db")
        })
        .filter_map(|entry| {
            let meta = entry.metadata().ok()?;
            Some((entry.path(), meta.modified().unwrap_or(std::time::UNIX_EPOCH)))
        })
        .collect();
    files.sort_by_key(|(_, time)| std::cmp::Reverse(*time));
    for (path, _) in files.into_iter().skip(3) {
        let _ = std::fs::remove_file(path);
    }
}

/// 把损坏的库连同 `-wal` / `-shm` 一起改名，返回新路径。
///
/// 两个附属文件必须跟着改名：留着它们，新建的同名库会读到上一个库的 WAL 页。
pub(crate) fn quarantine(db_path: &std::path::Path) -> Option<std::path::PathBuf> {
    let file_name = db_path.file_name()?.to_string_lossy().to_string();
    let target = db_path.with_file_name(format!(
        "{file_name}.corrupt-{}",
        Local::now().format("%Y%m%d-%H%M%S")
    ));
    std::fs::rename(db_path, &target).ok()?;
    for suffix in ["-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{suffix}", db_path.display()));
        if from.exists() {
            let to = std::path::PathBuf::from(format!("{}{suffix}", target.display()));
            let _ = std::fs::rename(&from, &to);
        }
    }
    Some(target)
}

/// 在新库里留一条待提示的记录；前端启动时用 `take_recovery_notice` 取走
pub(crate) fn write_recovery_note(conn: &Connection, corrupt_file: Option<&str>) {
    let value = serde_json::json!({
        "corruptFile": corrupt_file,
        "at": Local::now().to_rfc3339(),
    })
    .to_string();
    let _ = conn.execute(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('app.runtime.recovered', ?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![value, Local::now().to_rfc3339()],
    );
}

#[cfg(test)]
mod open_tests {
    use super::*;
    use std::path::PathBuf;

    pub(crate) fn temp_db(tag: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!("fastnote-db-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("建目录");
        let db = dir.join("fastnote.db");
        (dir, db)
    }

    /// 版本号变化 = 将要执行迁移：必须先留一份 pre-migration 快照
    #[test]
    pub(crate) fn records_version_and_backs_up_on_upgrade() {
        let (dir, db) = temp_db("upgrade");
        {
            let conn = open_database(&dir, &db, "1.0.0");
            assert_eq!(read_last_version(&conn).as_deref(), Some("1.0.0"));
        }

        let conn = open_database(&dir, &db, "1.1.0");
        assert_eq!(read_last_version(&conn).as_deref(), Some("1.1.0"));

        let backups: Vec<String> = std::fs::read_dir(&dir)
            .expect("列目录")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.starts_with("pre-migration-1.0.0-to-1.1.0"))
            .collect();
        assert_eq!(backups.len(), 1, "应生成一份升级前备份：{backups:?}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 库文件被写坏时：不能 panic，要隔离原文件、建新库、并留下待提示的通知
    #[test]
    pub(crate) fn corrupt_database_is_quarantined_and_rebuilt() {
        let (dir, db) = temp_db("corrupt");
        std::fs::write(&db, b"this is definitely not a sqlite database").expect("造坏库");

        let conn = open_database(&dir, &db, "2.0.0");
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .expect("新库应可查询");
        assert_eq!(count, 0);

        let quarantined: Vec<String> = std::fs::read_dir(&dir)
            .expect("列目录")
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name.contains(".corrupt-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "原库应被隔离：{quarantined:?}");

        let note: String = conn
            .query_row(
                "SELECT value FROM app_settings WHERE key = 'app.runtime.recovered'",
                [],
                |row| row.get(0),
            )
            .expect("应留下恢复通知");
        assert!(note.contains("corrupt"), "通知里要带隔离文件名：{note}");

        drop(conn);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

