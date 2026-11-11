use crate::models::*;
use chrono::{DateTime, Duration, Local};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use tauri::{AppHandle, State};
use crate::AppState;
use crate::semantic;
use crate::encryption;
use crate::map_row_to_note;

const NOTE_HISTORY_LIMIT_KEY: &str = "app.config.general.noteHistoryLimit";

const NOTE_HISTORY_INTERVAL_KEY: &str = "app.config.general.noteHistoryIntervalMinutes";

/// 历史版本上限：默认 10，夹到 1–100，避免手工改库写出几万条历史把库撑大
pub(crate) fn note_history_limit(app: &AppHandle) -> u64 {
    crate::read_setting_u64(app, NOTE_HISTORY_LIMIT_KEY, 10).clamp(1, 100)
}

/// 两条自动历史之间的最小间隔（秒）：默认 5 分钟，夹到 1–60 分钟。
/// 自动保存是 500ms 防抖，若每次保存都记历史，反复停顿打字几分钟就能把保留窗口刷满。
pub(crate) fn note_history_interval_secs(app: &AppHandle) -> i64 {
    (crate::read_setting_u64(app, NOTE_HISTORY_INTERVAL_KEY, 5).clamp(1, 60) as i64) * 60
}

pub(crate) const HISTORY_KIND_AUTO: &str = "auto";

pub(crate) const HISTORY_KIND_SESSION: &str = "session";

pub(crate) const HISTORY_KIND_MANUAL: &str = "manual";

pub(crate) const HISTORY_KIND_PRE_ROLLBACK: &str = "pre-rollback";

/// 未知来源（旧备份/手工改库）一律按自动版本处理，避免把脏 kind 带进界面
pub(crate) fn normalize_history_kind(kind: &str) -> String {
    match kind {
        HISTORY_KIND_MANUAL | HISTORY_KIND_SESSION | HISTORY_KIND_PRE_ROLLBACK => kind.to_string(),
        _ => HISTORY_KIND_AUTO.to_string(),
    }
}

/// 把笔记当前状态写进历史表（调用前不要先 UPDATE，否则存进去的是新版本）
pub(crate) fn snapshot_note(
    conn: &Connection,
    note_id: &str,
    saved_at: &str,
    kind: &str,
) -> Result<bool, String> {
    let inserted = conn
        .execute(
            "INSERT INTO notes_history (note_id, title, content, category_id, is_pinned, kind, saved_at)
             SELECT id, title, content, category_id, is_pinned, ?2, ?3 FROM notes WHERE id = ?1",
            params![note_id, kind, saved_at],
        )
        .map_err(|e| e.to_string())?;
    Ok(inserted > 0)
}

/// 历史快照字段顺序：标题 / 正文 / 分组 / 保存时间
type HistorySnapshot = (String, String, Option<String>, String);

/// 最新一条历史；没有历史时返回 None
pub(crate) fn latest_history(
    conn: &Connection,
    note_id: &str,
) -> Result<Option<HistorySnapshot>, String> {
    let latest = conn.query_row(
        "SELECT title, content, category_id, saved_at
         FROM notes_history WHERE note_id = ?1 ORDER BY id DESC LIMIT 1",
        params![note_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        },
    );
    match latest {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 当前内容是否与最新一条历史完全相同（没有历史时为 false）
pub(crate) fn history_matches_latest(
    conn: &Connection,
    note_id: &str,
    title: &str,
    content: &str,
    category: Option<&str>,
) -> Result<bool, String> {
    Ok(latest_history(conn, note_id)?
        .map(|(last_title, last_content, last_category, _)| {
            last_title == title && last_content == content && last_category.as_deref() == category
        })
        .unwrap_or(false))
}

/// 本次自动改动是否值得写一条历史。
///
/// - 还没有任何历史：写。保证「最初版本」一定留得下来（老笔记第一次被编辑时也走这条）。
/// - 与最新一条内容完全相同：不写。用户改回原样时不该再堆一条重复版本。
/// - 距最新一条不足间隔：不写。打字停顿触发的自动保存不等于一个值得回看的版本。
/// - 时间不可解析 / 系统时间回拨：写。宁可多记一条，也不要因为脏时间戳从此不再记录。
pub(crate) fn should_snapshot_history(
    conn: &Connection,
    note_id: &str,
    old_title: &str,
    old_content: &str,
    old_category: Option<&str>,
    now: &str,
    interval_secs: i64,
) -> Result<bool, String> {
    let Some((last_title, last_content, last_category, last_saved_at)) =
        latest_history(conn, note_id)?
    else {
        return Ok(true);
    };

    if last_title == old_title && last_content == old_content && last_category.as_deref() == old_category {
        return Ok(false);
    }

    let (now_at, last_at) = match (
        DateTime::parse_from_rfc3339(now),
        DateTime::parse_from_rfc3339(&last_saved_at),
    ) {
        (Ok(now_at), Ok(last_at)) => (now_at, last_at),
        _ => return Ok(true),
    };
    let elapsed = now_at.signed_duration_since(last_at).num_seconds();
    Ok(elapsed < 0 || elapsed >= interval_secs)
}

/// 历史保留策略：
///
/// - 固定版本（pinned）与手动版本（manual）永不自动删除；
/// - 自动版本保留最新 `limit` 条；
/// - 最早一条自动版本始终保留（找回最初内容）；
/// - 更早的自动版本按天抽样：最近 30 天里每天最多留一条，避免密集自动版本把库撑大，
///   同时保留一条远期时间线。
///
/// 已保留版本覆盖到的日期不再补抽样，否则同一天的中间版本会挤占配额。
pub(crate) fn prune_note_history(
    conn: &Connection,
    note_id: &str,
    limit: u64,
    now: &str,
) -> Result<(), String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, kind, pinned, saved_at FROM notes_history
             WHERE note_id = ?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![note_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(stmt);

    if rows.is_empty() {
        return Ok(());
    }

    let mut keep: HashSet<i64> = HashSet::new();
    let mut newest_auto = 0u64;
    let mut oldest_auto: Option<i64> = None;

    for (id, kind, pinned, _) in &rows {
        let is_manual = kind.as_str() == HISTORY_KIND_MANUAL;
        let is_pinned = *pinned != 0;
        if is_pinned || is_manual {
            keep.insert(*id);
        } else if newest_auto < limit {
            keep.insert(*id);
            newest_auto += 1;
        }
        if !is_pinned && !is_manual {
            oldest_auto = Some(*id);
        }
    }
    if let Some(id) = oldest_auto {
        keep.insert(id);
    }

    let now_date = DateTime::parse_from_rfc3339(now)
        .map(|d| d.date_naive())
        .unwrap_or_else(|_| Local::now().date_naive());
    let cutoff = now_date - Duration::days(30);

    let mut covered_dates = HashSet::new();
    for (id, _, _, saved_at) in &rows {
        if !keep.contains(id) {
            continue;
        }
        if let Ok(dt) = DateTime::parse_from_rfc3339(saved_at) {
            covered_dates.insert(dt.date_naive());
        }
    }

    for (id, kind, pinned, saved_at) in &rows {
        if *pinned != 0 || kind.as_str() == HISTORY_KIND_MANUAL || keep.contains(id) {
            continue;
        }
        let Ok(dt) = DateTime::parse_from_rfc3339(saved_at) else {
            continue;
        };
        let date = dt.date_naive();
        if date < cutoff {
            continue;
        }
        if covered_dates.insert(date) {
            keep.insert(*id);
        }
    }

    if keep.len() == rows.len() {
        return Ok(());
    }

    let mut delete = conn
        .prepare("DELETE FROM notes_history WHERE id = ?1")
        .map_err(|e| e.to_string())?;
    for (id, _, _, _) in &rows {
        if !keep.contains(id) {
            delete.execute(params![id]).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 回滚时丢弃目标版本及其之后的所有历史：id 自增，`id >= from_entry_id` 即更新的版本。
pub(crate) fn truncate_note_history(
    conn: &Connection,
    note_id: &str,
    from_entry_id: i64,
) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notes_history WHERE note_id = ?1 AND id >= ?2",
        params![note_id, from_entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn purge_note_history(conn: &Connection, note_id: &str) -> Result<(), String> {
    conn.execute(
        "DELETE FROM notes_history WHERE note_id = ?1",
        params![note_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod note_history_tests {
    use super::*;

    fn setup() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE notes_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                note_id TEXT NOT NULL,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                category_id TEXT,
                is_pinned INTEGER NOT NULL DEFAULT 0,
                kind TEXT NOT NULL DEFAULT 'auto',
                pinned INTEGER NOT NULL DEFAULT 0,
                saved_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO notes (id, title, content, category_id, is_pinned) VALUES ('1', '标题', '正文', NULL, 1)",
            [],
        )
        .unwrap();
        conn
    }

    fn insert_version_at(
        conn: &Connection,
        note_id: &str,
        title: &str,
        content: &str,
        saved_at: &str,
    ) {
        conn.execute(
            "INSERT INTO notes_history (note_id, title, content, saved_at) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, title, content, saved_at],
        )
        .unwrap();
    }

    fn insert_version(conn: &Connection, note_id: &str, title: &str) {
        insert_version_at(
            conn,
            note_id,
            title,
            "正文",
            "2026-10-25T10:00:00+08:00",
        );
    }

    fn insert_version_kind(
        conn: &Connection,
        note_id: &str,
        title: &str,
        kind: &str,
        pinned: bool,
        saved_at: &str,
    ) {
        conn.execute(
            "INSERT INTO notes_history (note_id, title, content, kind, pinned, saved_at)
             VALUES (?1, ?2, '正文', ?3, ?4, ?5)",
            params![note_id, title, kind, if pinned { 1 } else { 0 }, saved_at],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_copies_current_note() {
        let conn = setup();
        assert!(snapshot_note(&conn, "1", "2026-10-25T10:00:00+08:00", HISTORY_KIND_AUTO).unwrap());
        let (title, content, note_pinned, kind, pinned): (String, String, i64, String, i64) = conn
            .query_row(
                "SELECT title, content, is_pinned, kind, pinned FROM notes_history WHERE note_id = '1'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
            )
            .unwrap();
        assert_eq!(title, "标题");
        assert_eq!(content, "正文");
        assert_eq!(note_pinned, 1);
        assert_eq!(kind, HISTORY_KIND_AUTO);
        assert_eq!(pinned, 0);
    }

    fn titles_of(conn: &Connection, note_id: &str) -> Vec<String> {
        let mut stmt = conn
            .prepare("SELECT title FROM notes_history WHERE note_id = ?1 ORDER BY id")
            .unwrap();
        let rows = stmt
            .query_map(params![note_id], |row| row.get::<_, String>(0))
            .unwrap();
        rows.map(Result::unwrap).collect()
    }

    #[test]
    fn prune_keeps_latest_versions_and_the_earliest() {
        let conn = setup();
        for title in ["v1", "v2", "v3", "v4"] {
            insert_version(&conn, "1", title);
        }
        insert_version(&conn, "2", "other");

        prune_note_history(&conn, "1", 2, NOW).unwrap();

        // 最新 2 条 + 最早 1 条：v1 不能被挤出窗口
        assert_eq!(titles_of(&conn, "1"), vec!["v1", "v3", "v4"]);
        // 另一篇笔记的历史不受影响
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes_history WHERE note_id = '2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(others, 1);
    }

    #[test]
    fn truncate_drops_target_and_newer_versions() {
        let conn = setup();
        for title in ["v1", "v2", "v3", "v4"] {
            insert_version(&conn, "1", title);
        }
        // 更新的历史即使被固定，也随回滚一起删除
        insert_version_kind(
            &conn,
            "1",
            "v5",
            HISTORY_KIND_MANUAL,
            true,
            "2026-10-25T10:00:00+08:00",
        );
        insert_version(&conn, "2", "other");

        let target_id: i64 = conn
            .query_row(
                "SELECT id FROM notes_history WHERE note_id = '1' AND title = 'v2'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        truncate_note_history(&conn, "1", target_id).unwrap();

        assert_eq!(titles_of(&conn, "1"), vec!["v1"]);
        assert_eq!(titles_of(&conn, "2"), vec!["other"]);
    }

    #[test]
    fn prune_keeps_earliest_even_with_limit_one() {
        let conn = setup();
        for title in ["v1", "v2", "v3"] {
            insert_version(&conn, "1", title);
        }

        prune_note_history(&conn, "1", 1, NOW).unwrap();

        assert_eq!(titles_of(&conn, "1"), vec!["v1", "v3"]);
    }

    #[test]
    fn prune_keeps_pinned_and_manual_versions() {
        let conn = setup();
        insert_version_kind(
            &conn,
            "1",
            "v1",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:00:00+08:00",
        );
        insert_version_kind(
            &conn,
            "1",
            "v2",
            HISTORY_KIND_MANUAL,
            false,
            "2026-10-25T09:10:00+08:00",
        );
        insert_version_kind(
            &conn,
            "1",
            "v3",
            HISTORY_KIND_SESSION,
            true,
            "2026-10-25T09:20:00+08:00",
        );
        insert_version_kind(
            &conn,
            "1",
            "v4",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:30:00+08:00",
        );
        insert_version_kind(
            &conn,
            "1",
            "v5",
            HISTORY_KIND_AUTO,
            false,
            "2026-10-25T09:40:00+08:00",
        );

        prune_note_history(&conn, "1", 1, NOW).unwrap();

        // 手动 / 固定永不删除；自动版本仍按「最新 1 条 + 最早 1 条」保留
        assert_eq!(titles_of(&conn, "1"), vec!["v1", "v2", "v3", "v5"]);
    }

    #[test]
    fn prune_keeps_one_auto_per_day_in_recent_month() {
        let conn = setup();
        let rows = [
            ("v1", "2026-08-01T09:00:00+08:00"), // 超出 30 天窗口，只作为最早版本保留
            ("v2", "2026-09-26T09:00:00+08:00"),
            ("v3", "2026-09-26T12:00:00+08:00"), // 同日第二条，让位给当天较新的一条
            ("v4", "2026-09-27T09:00:00+08:00"),
            ("v5", "2026-10-24T09:00:00+08:00"),
            ("v6", "2026-10-24T20:00:00+08:00"),
            ("v7", "2026-10-25T09:00:00+08:00"),
        ];
        for (title, saved_at) in rows {
            insert_version_kind(&conn, "1", title, HISTORY_KIND_AUTO, false, saved_at);
        }

        prune_note_history(&conn, "1", 2, NOW).unwrap();

        // 最新 2 条(v7,v6) + 最早 1 条(v1) + 每个更早日期各 1 条(v4,v3)
        assert_eq!(titles_of(&conn, "1"), vec!["v1", "v3", "v4", "v6", "v7"]);
    }

    #[test]
    fn unknown_history_kind_normalizes_to_auto() {
        assert_eq!(normalize_history_kind("tampered"), HISTORY_KIND_AUTO);
        assert_eq!(
            normalize_history_kind(HISTORY_KIND_MANUAL),
            HISTORY_KIND_MANUAL
        );
    }

    const NOW: &str = "2026-10-25T10:06:00+08:00";

    #[test]
    fn snapshot_required_when_note_has_no_history() {
        let conn = setup();
        assert!(should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_skipped_for_identical_latest_version() {
        let conn = setup();
        insert_version_at(
            &conn,
            "1",
            "标题",
            "正文",
            "2026-10-25T10:00:00+08:00",
        );
        assert!(!should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_throttled_within_interval() {
        let conn = setup();
        insert_version_at(
            &conn,
            "1",
            "旧标题",
            "旧正文",
            "2026-10-25T10:04:00+08:00",
        );
        assert!(!should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_after_interval() {
        let conn = setup();
        insert_version_at(
            &conn,
            "1",
            "旧标题",
            "旧正文",
            "2026-10-25T10:00:00+08:00",
        );
        assert!(should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_when_saved_at_is_unparsable() {
        let conn = setup();
        insert_version_at(&conn, "1", "旧标题", "旧正文", "not-a-time");
        assert!(should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    #[test]
    fn snapshot_allowed_when_clock_moved_backwards() {
        let conn = setup();
        insert_version_at(
            &conn,
            "1",
            "旧标题",
            "旧正文",
            "2026-10-25T10:10:00+08:00",
        );
        assert!(should_snapshot_history(&conn, "1", "标题", "正文", None, NOW, 300).unwrap());
    }

    /// 按 update_note 的顺序模拟「每 30 秒一次自动保存、间隔 1 分钟、只留 1 条最近版本」：
    /// 无论保存多频繁，最早那一版都必须还在。
    #[test]
    fn frequent_autosaves_do_not_evict_the_original_version() {
        let conn = setup();
        conn.execute("UPDATE notes SET content = 'v0' WHERE id = '1'", [])
            .unwrap();

        let base = DateTime::parse_from_rfc3339("2026-10-25T10:00:00+08:00").unwrap();
        let mut current = "v0".to_string();
        for i in 1..=20 {
            let at = (base + Duration::seconds(30 * i)).to_rfc3339();
            if should_snapshot_history(&conn, "1", "标题", &current, None, &at, 60).unwrap() {
                snapshot_note(&conn, "1", &at, HISTORY_KIND_AUTO).unwrap();
            }
            prune_note_history(&conn, "1", 1, &at).unwrap();

            current = format!("v{i}");
            conn.execute(
                "UPDATE notes SET content = ?1 WHERE id = '1'",
                params![current],
            )
            .unwrap();
        }

        let contents: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT content FROM notes_history WHERE note_id = '1' ORDER BY id")
                .unwrap();
            let rows = stmt.query_map([], |row| row.get::<_, String>(0)).unwrap();
            rows.map(Result::unwrap).collect()
        };
        assert_eq!(contents, vec!["v0", "v18"]);
    }
}

#[derive(Debug, Serialize)]
pub struct NoteHistoryEntry {
    id: i64,
    note_id: String,
    title: String,
    content: String,
    category_id: Option<String>,
    is_pinned: bool,
    /// auto = 自动 / session = 打开笔记时 / manual = 手动保存 / pre-rollback = 早期回滚快照
    kind: String,
    /// 固定版本：不会被自动清理
    pinned: bool,
    saved_at: String,
}

/// 某篇笔记的历史版本，新的在前。
#[tauri::command]
pub fn get_note_history(note_id: String, state: State<AppState>) -> Result<Vec<NoteHistoryEntry>, String> {
    let conn = state.conn.lock().unwrap();
    let (enc_mode, category_id): (i64, Option<String>) = conn
        .query_row(
            "SELECT COALESCE(enc_mode, 0), category_id FROM notes WHERE id = ?1",
            params![&note_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, title, content, category_id, is_pinned, kind, pinned, saved_at
             FROM notes_history WHERE note_id = ?1 ORDER BY id DESC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![&note_id], |row| {
            Ok(NoteHistoryEntry {
                id: row.get(0)?,
                note_id: row.get(1)?,
                title: row.get(2)?,
                content: row.get(3)?,
                category_id: row.get(4)?,
                is_pinned: row.get::<_, i64>(5)? != 0,
                kind: normalize_history_kind(&row.get::<_, String>(6)?),
                pinned: row.get::<_, i64>(7)? != 0,
                saved_at: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        let mut entry = row.map_err(|e| e.to_string())?;
        if enc_mode != 0 {
            // 历史行与 notes 行共用 DEK + AAD，锁定时这里直接报 locked，前端提示先解锁
            let (title, content) = encryption::decrypt_history_fields(
                &state.encryption,
                &note_id,
                enc_mode,
                category_id.as_deref(),
                &entry.title,
                &entry.content,
            )?;
            entry.title = title;
            entry.content = content;
        }
        out.push(entry);
    }
    Ok(out)
}

/// 删除单条历史版本（只动历史表，不碰笔记本身）
#[tauri::command]
pub fn delete_note_history_entry(entry_id: i64, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    conn.execute(
        "DELETE FROM notes_history WHERE id = ?1",
        params![entry_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清空某篇笔记的全部历史版本
#[tauri::command]
pub fn clear_note_history(note_id: String, state: State<AppState>) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    purge_note_history(&conn, &note_id)
}

/// 手动保存当前状态为历史版本；与最新一条内容相同时不重复写。
#[tauri::command]
pub fn create_note_history_version(
    note_id: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<bool, String> {
    let limit = note_history_limit(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (title, content, category): (String, String, Option<String>) = tx
        .query_row(
            "SELECT title, content, category_id FROM notes WHERE id = ?1",
            params![&note_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;

    if history_matches_latest(&tx, &note_id, &title, &content, category.as_deref())? {
        return Ok(false);
    }
    let inserted = snapshot_note(&tx, &note_id, &now, HISTORY_KIND_MANUAL)?;
    prune_note_history(&tx, &note_id, limit, &now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// 打开笔记时记录会话基线：当前内容与最新历史不同才写，存成 `session` 版本。
/// 这样长时间编辑里「这次打开时的样子」不会被自动保存的节流漏掉。
#[tauri::command]
pub fn snapshot_note_session(
    note_id: String,
    app: AppHandle,
    state: State<AppState>,
) -> Result<bool, String> {
    let limit = note_history_limit(&app);
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let current = tx.query_row(
        "SELECT title, content, category_id FROM notes WHERE id = ?1",
        params![&note_id],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        },
    );
    let (title, content, category) = match current {
        Ok(row) => row,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(false),
        Err(e) => return Err(e.to_string()),
    };

    // 还没有任何历史时不写：第一次编辑时 update_note 会把编辑前内容存成 auto，
    // 仅仅是打开一篇从未记录过的笔记不应该凭空多出一条历史。
    if latest_history(&tx, &note_id)?.is_none() {
        return Ok(false);
    }
    if history_matches_latest(&tx, &note_id, &title, &content, category.as_deref())? {
        return Ok(false);
    }
    let inserted = snapshot_note(&tx, &note_id, &now, HISTORY_KIND_SESSION)?;
    prune_note_history(&tx, &note_id, limit, &now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

/// 固定 / 取消固定一条历史版本。固定版本不会被自动清理，只能手动删除。
#[tauri::command]
pub fn set_note_history_pinned(
    entry_id: i64,
    pinned: bool,
    state: State<AppState>,
) -> Result<(), String> {
    let conn = state.conn.lock().unwrap();
    let changed = conn
        .execute(
            "UPDATE notes_history SET pinned = ?1 WHERE id = ?2",
            params![if pinned { 1 } else { 0 }, entry_id],
        )
        .map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("历史版本不存在或已被清理".to_string());
    }
    Ok(())
}

/// 回滚到某个历史版本：目标版本和所有更新的版本一起删除，不生成新的历史。
/// 回到更早的状态后，那些更新的版本已不属于当前分支，留着只会让列表越回滚越长。
#[tauri::command]
pub fn rollback_note_history(entry_id: i64, state: State<AppState>) -> Result<Note, String> {
    let mut conn = state.conn.lock().unwrap();
    let now = Local::now().to_rfc3339();
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (note_id, title, content, category_id, is_pinned): (
        String,
        String,
        String,
        Option<String>,
        i64,
    ) = tx
        .query_row(
            "SELECT note_id, title, content, category_id, is_pinned FROM notes_history WHERE id = ?1",
            params![entry_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .map_err(|_| "历史版本不存在或已被清理".to_string())?;

    let (cur_title, cur_content, cur_category, cur_is_pinned, cur_enc_mode): (
        String,
        String,
        Option<String>,
        i64,
        i64,
    ) = tx
        .query_row(
            "SELECT title, content, category_id, is_pinned, COALESCE(enc_mode, 0) FROM notes WHERE id = ?1",
            params![&note_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)),
        )
        .map_err(|_| "笔记不存在，可能已被删除".to_string())?;

    // 加密笔记：库里两边都是密文，且随机 nonce 让「密文相等」不代表「明文相等」，
    // 必须先用 DEK 解开再比；锁定时 open_* 会返回 locked。
    let (cmp_cur_title, cmp_cur_content, cmp_hist_title, cmp_hist_content) = if cur_enc_mode != 0 {
        if cur_category != category_id {
            return Err(json!({ "code": "note_encrypted", "reason": "move" }).to_string());
        }
        let (cur_t, cur_c) = encryption::open_note_fields(
            &tx,
            &state.encryption,
            &note_id,
            cur_enc_mode,
            cur_category.as_deref(),
            &cur_title,
            &cur_content,
        )?;
        let (hist_t, hist_c) = encryption::decrypt_history_fields(
            &state.encryption,
            &note_id,
            cur_enc_mode,
            category_id.as_deref(),
            &title,
            &content,
        )?;
        (cur_t, cur_c, hist_t, hist_c)
    } else {
        (
            cur_title.clone(),
            cur_content.clone(),
            title.clone(),
            content.clone(),
        )
    };

    let changed = cmp_cur_title != cmp_hist_title
        || cmp_cur_content != cmp_hist_content
        || cur_category != category_id
        || cur_is_pinned != is_pinned;

    // 即使回滚目标与当前内容一致，也要丢弃这条及之后的历史
    truncate_note_history(&tx, &note_id, entry_id)?;

    if changed {
        // 回滚会删掉目标版本之后的全部历史：先给「回滚前」的当前内容留一条快照，
        // 否则误点回滚就再也回不来了。加密笔记这里复制的是密文正文，与其他历史行同源。
        // 必须在 truncate 之后插入，否则新快照会被一起删掉。
        snapshot_note(&tx, &note_id, &now, HISTORY_KIND_PRE_ROLLBACK)?;
        // 标题一律写明文（旧历史行的标题密文已在上面的比较里解出）；
        // 加密笔记的正文直接写历史行里的密文：同一 DEK、同一 AAD，写回去就能照常解开
        let write_title = cmp_hist_title;
        let write_content = if cur_enc_mode != 0 { content } else { cmp_hist_content };
        tx.execute(
            "UPDATE notes SET title = ?1, content = ?2, category_id = ?3, is_pinned = ?4, updated_at = ?5 WHERE id = ?6",
            params![write_title, write_content, category_id, is_pinned, now, &note_id],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM note_chunks WHERE note_id = ?1", params![&note_id])
            .map_err(|e| e.to_string())?;
        tx.execute(
            "DELETE FROM note_index_state WHERE note_id = ?1",
            params![&note_id],
        )
        .map_err(|e| e.to_string())?;
    }

    let mut note = tx
        .query_row(
            "SELECT id, title, content, category_id, created_at, updated_at, is_deleted, deleted_at, is_pinned, ai_access, COALESCE(enc_mode, 0) AS enc_mode
             FROM notes WHERE id = ?1",
            params![&note_id],
            map_row_to_note,
        )
        .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    encryption::apply_lock_state(&conn, &state.encryption, std::slice::from_mut(&mut note));
    drop(conn);

    semantic::invalidate(&state.semantic);
    Ok(note)
}
