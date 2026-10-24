//! 索引 worker：唯一的后台索引线程。
//!
//! 轮询而非事件驱动：脏数据就在库里（`note_index_state` 与 `notes.updated_at` 对比），
//! 这样新建 / 编辑 / 导入 / 恢复备份都自动被覆盖，不需要在每个写入口都记得去通知。
//!
//! 并发纪律：读一批 → **放锁** → 推理 → 再加锁写事务。推理期间绝不持数据库锁。

use std::sync::atomic::Ordering;
use std::time::Duration;

use rusqlite::{params, Connection};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use super::chunk::{self, split_note};
use super::model::{self, ModelSpec};
use super::search::vec_to_blob;
use super::{enabled, engine_for_spec, set_meta};
use crate::AppState;

const POLL_INTERVAL: Duration = Duration::from_secs(2);
const ERROR_BACKOFF: Duration = Duration::from_secs(30);
const BATCH_NOTES: usize = 4;

struct DirtyNote {
    id: i64,
    title: String,
    content: String,
    updated_at: String,
}

pub fn spawn_worker(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL_INTERVAL);
        // 下载/校验期间不开工：文件已落盘但自检未过时，索引可能读到不可用的模型
        let downloading = {
            let state = app.state::<AppState>();
            let guard = state.semantic.download_model.lock();
            guard.map(|guard| guard.is_some()).unwrap_or(true)
        };
        let spec = model::selected(&app);
        if downloading || !enabled(&app) || !model::is_ready(&app, &spec) {
            continue;
        }
        let state = app.state::<AppState>();
        let auto_index = crate::read_setting_bool(&app, super::AUTO_INDEX_KEY, true);
        // 手动「重建索引」放行一轮；只在真正具备开工条件时才消费这个标记
        let manual = state.semantic.index_requested.swap(false, Ordering::SeqCst);
        if !auto_index && !manual {
            continue;
        }
        if let Err(e) = run_once(&app, &spec) {
            eprintln!("[semantic] 索引失败：{e}");
            let _ = set_meta(&app, "last_error", &e);
            emit_progress(&app, 0, 0, false, Some(&e));
            std::thread::sleep(ERROR_BACKOFF);
        }
    });
}

struct RunningGuard<'a>(&'a super::SemanticState);

impl Drop for RunningGuard<'_> {
    fn drop(&mut self) {
        self.0.index_running.store(false, Ordering::SeqCst);
    }
}

fn run_once(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    let state = app.state::<AppState>();

    let total = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        sweep_orphans(&conn)?;
        dirty_count(&conn, &spec.id)?
    };
    if total == 0 {
        return Ok(());
    }

    // 显式按本轮捕获的模型加载：中途切模型时，不能把新模型的向量写进旧模型的索引
    let engine = engine_for_spec(app, spec)?;
    state.semantic.index_running.store(true, Ordering::SeqCst);
    let _running = RunningGuard(&state.semantic);
    emit_progress(app, 0, total, true, None);

    let mut done = 0i64;
    loop {
        if state.semantic.index_cancel.swap(false, Ordering::SeqCst) {
            break;
        }
        // 用户在索引途中切换了模型：本轮到此为止，下一轮按新模型重新开始
        if model::selected(app).id != spec.id {
            break;
        }

        let batch = {
            let conn = state
                .conn
                .lock()
                .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
            load_dirty(&conn, BATCH_NOTES, &spec.id)?
        };
        if batch.is_empty() {
            break;
        }

        for note in &batch {
            let chunked = split_note(&note.title, &note.content);
            if chunked.truncated {
                eprintln!("[semantic] 笔记 {} 超过分块上限，已截断", note.id);
            }
            let texts: Vec<String> = chunked
                .chunks
                .iter()
                .map(|text| chunk::embedding_text(&note.title, text))
                .collect();
            // 推理在锁外：这里只算向量
            let vectors = engine.embed(&texts)?;
            if vectors.len() != chunked.chunks.len() {
                return Err(format!(
                    "笔记 {} 的向量数量({})与分块数量({})不一致",
                    note.id,
                    vectors.len(),
                    chunked.chunks.len()
                ));
            }
            store_note(&state, note, &chunked.chunks, &vectors, &spec.id)?;
        }

        done += batch.len() as i64;
        state.semantic.cache_version.fetch_add(1, Ordering::SeqCst);
        emit_progress(app, done, total.max(done), true, None);
    }

    state.semantic.cache_version.fetch_add(1, Ordering::SeqCst);
    // 先落下 running=false 再发 done：前端收到 done 后立刻查状态时不会读到「仍在索引」
    drop(_running);
    let (notes, chunks) = {
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        counts(&conn, &spec.id).unwrap_or((0, 0))
    };
    let _ = app.emit(
        "semantic-index-done",
        json!({ "indexed": notes, "chunks": chunks }),
    );
    Ok(())
}

fn dirty_count(conn: &Connection, model_id: &str) -> Result<i64, String> {
    conn.query_row(
        "SELECT COUNT(*)
         FROM notes n
         LEFT JOIN note_index_state s ON s.note_id = n.id
         WHERE n.is_deleted = 0
           AND (s.note_id IS NULL OR s.note_updated_at <> n.updated_at OR s.model_id <> ?1)",
        params![model_id],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

fn load_dirty(conn: &Connection, limit: usize, model_id: &str) -> Result<Vec<DirtyNote>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT n.id, n.title, n.content, n.updated_at
             FROM notes n
             LEFT JOIN note_index_state s ON s.note_id = n.id
             WHERE n.is_deleted = 0
               AND (s.note_id IS NULL OR s.note_updated_at <> n.updated_at OR s.model_id <> ?1)
             ORDER BY n.updated_at DESC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![model_id, limit as i64], |row| {
            Ok(DirtyNote {
                id: row.get(0)?,
                title: row.get(1)?,
                content: row.get(2)?,
                updated_at: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

fn store_note(
    state: &AppState,
    note: &DirtyNote,
    chunks: &[String],
    vectors: &[Vec<f32>],
    model_id: &str,
) -> Result<(), String> {
    let now = chrono::Local::now().to_rfc3339();
    let mut conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM note_chunks WHERE note_id = ?1",
        params![note.id],
    )
    .map_err(|e| e.to_string())?;
    {
        let mut stmt = tx
            .prepare(
                "INSERT INTO note_chunks (note_id, seq, text, dim, embedding)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| e.to_string())?;
        for (seq, (text, vector)) in chunks.iter().zip(vectors.iter()).enumerate() {
            stmt.execute(params![
                note.id,
                seq as i64,
                text,
                vector.len() as i64,
                vec_to_blob(vector)
            ])
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute(
        "INSERT INTO note_index_state (note_id, note_updated_at, model_id, indexed_at)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(note_id) DO UPDATE SET
             note_updated_at = excluded.note_updated_at,
             model_id = excluded.model_id,
             indexed_at = excluded.indexed_at",
        params![note.id, note.updated_at, model_id, now],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

/// 永久删除的笔记会留下孤儿块；每轮索引前清一次，避免索引文件越积越大。
fn sweep_orphans(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "DELETE FROM note_chunks WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM note_index_state WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn counts(conn: &Connection, model_id: &str) -> Result<(i64, i64), String> {
    let notes = conn
        .query_row(
            "SELECT COUNT(*) FROM note_index_state s
             JOIN notes n ON n.id = s.note_id
             WHERE n.is_deleted = 0 AND s.model_id = ?1",
            params![model_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let chunks = conn
        .query_row(
            "SELECT COUNT(*) FROM note_chunks c
             JOIN notes n ON n.id = c.note_id AND n.is_deleted = 0
             JOIN note_index_state s ON s.note_id = c.note_id AND s.model_id = ?1",
            params![model_id],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok((notes, chunks))
}

fn emit_progress(app: &AppHandle, done: i64, total: i64, running: bool, error: Option<&str>) {
    let _ = app.emit(
        "semantic-index-progress",
        json!({
            "done": done,
            "total": total,
            "running": running,
            "error": error,
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
                id INTEGER PRIMARY KEY,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                is_deleted INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE note_chunks (
                note_id INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                text TEXT NOT NULL,
                dim INTEGER NOT NULL,
                embedding BLOB NOT NULL,
                PRIMARY KEY (note_id, seq)
            );
            CREATE TABLE note_index_state (
                note_id INTEGER PRIMARY KEY,
                note_updated_at TEXT NOT NULL,
                model_id TEXT NOT NULL,
                indexed_at TEXT NOT NULL
            );",
        )
        .unwrap();
        conn
    }

    fn insert_note(conn: &Connection, id: i64, updated_at: &str, deleted: bool) {
        conn.execute(
            "INSERT INTO notes (id, title, content, updated_at, is_deleted)
             VALUES (?1, 't', 'c', ?2, ?3)",
            params![id, updated_at, if deleted { 1 } else { 0 }],
        )
        .unwrap();
    }

    fn mark_indexed(conn: &Connection, id: i64, updated_at: &str, model_id: &str) {
        conn.execute(
            "INSERT OR REPLACE INTO note_index_state (note_id, note_updated_at, model_id, indexed_at)
             VALUES (?1, ?2, ?3, 'now')",
            params![id, updated_at, model_id],
        )
        .unwrap();
    }

    #[test]
    fn dirty_tracks_updated_at_and_model() {
        let conn = memory_db();
        insert_note(&conn, 1, "2026-01-01T00:00:00", false);
        insert_note(&conn, 2, "2026-01-02T00:00:00", false);
        insert_note(&conn, 3, "2026-01-03T00:00:00", true);
        mark_indexed(&conn, 1, "2026-01-01T00:00:00", "test-model");

        assert_eq!(
            dirty_count(&conn, "test-model").unwrap(),
            1,
            "未索引的笔记才算脏"
        );
        let dirty = load_dirty(&conn, 10, "test-model").unwrap();
        assert_eq!(dirty.len(), 1);
        assert_eq!(dirty[0].id, 2);

        // 内容变过（updated_at 变了）→ 重新变脏
        conn.execute(
            "UPDATE notes SET updated_at = '2026-01-04T00:00:00' WHERE id = 1",
            [],
        )
        .unwrap();
        assert_eq!(dirty_count(&conn, "test-model").unwrap(), 2);

        // 换了模型 → 已索引的也要重建
        mark_indexed(&conn, 1, "2026-01-04T00:00:00", "other-model");
        let dirty = load_dirty(&conn, 10, "test-model").unwrap();
        assert!(dirty.iter().any(|n| n.id == 1));
    }

    #[test]
    fn trashed_notes_are_never_dirty() {
        let conn = memory_db();
        insert_note(&conn, 1, "2026-01-01T00:00:00", true);
        assert_eq!(dirty_count(&conn, "test-model").unwrap(), 0);
        assert!(load_dirty(&conn, 10, "test-model").unwrap().is_empty());
    }

    #[test]
    fn orphan_sweep_removes_deleted_note_rows() {
        let conn = memory_db();
        insert_note(&conn, 1, "2026-01-01T00:00:00", false);
        for id in [1, 99] {
            conn.execute(
                "INSERT INTO note_chunks (note_id, seq, text, dim, embedding) VALUES (?1, 0, 'x', 2, x'0000000000000000')",
                params![id],
            )
            .unwrap();
            mark_indexed(&conn, id, "2026-01-01T00:00:00", "test-model");
        }

        sweep_orphans(&conn).unwrap();
        let chunks: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_chunks", [], |row| row.get(0))
            .unwrap();
        let states: i64 = conn
            .query_row("SELECT COUNT(*) FROM note_index_state", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((chunks, states), (1, 1));
    }
}
