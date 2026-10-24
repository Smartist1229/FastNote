//! 语义检索：内存向量缓存 + 暴力余弦。
//!
//! 笔记量级（≤1 万篇 / ≤10 万块）下暴力扫描只要几十毫秒，不需要 ANN 索引。
//! 缓存只在写操作 / 导入后失效（`SemanticState.cache_version`），查询路径不碰 BLOB 解析。

use std::collections::{HashMap, HashSet};
use std::sync::atomic::Ordering;
use std::sync::Arc;

use rusqlite::Connection;

use super::SemanticState;

pub const DEFAULT_LIMIT: usize = 15;
pub const MAX_LIMIT: usize = 50;
const SNIPPET_CHARS: usize = 120;

pub struct CachedChunk {
    pub note_id: i64,
    pub seq: i64,
    pub text: String,
    pub vector: Vec<f32>,
}

pub struct VectorCache {
    version: u64,
    /// 缓存只属于一个模型：切换模型后必须重建，避免两种向量混着算
    model_id: String,
    chunks: Vec<CachedChunk>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SemanticHit {
    pub note_id: i64,
    pub score: f32,
    pub chunk_seq: i64,
    pub snippet: String,
}

/// 从数据库全量构建缓存。只取未删除、且已用当前模型索引过的笔记：
/// 回收站内容不该出现在任何搜索结果里（包括 AI 工具），旧模型的块也不能混入。
pub fn build_cache(conn: &Connection, version: u64, model_id: &str) -> Result<VectorCache, String> {
    let mut stmt = conn
        .prepare(
            "SELECT c.note_id, c.seq, c.text, c.embedding
             FROM note_chunks c
             JOIN notes n ON n.id = c.note_id AND n.is_deleted = 0
             JOIN note_index_state s ON s.note_id = c.note_id AND s.model_id = ?1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([model_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Vec<u8>>(3)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut chunks = Vec::new();
    for row in rows {
        let (note_id, seq, text, blob) = row.map_err(|e| e.to_string())?;
        let vector = blob_to_vec(&blob);
        if vector.is_empty() {
            continue;
        }
        chunks.push(CachedChunk {
            note_id,
            seq,
            text,
            vector,
        });
    }
    Ok(VectorCache {
        version,
        model_id: model_id.to_string(),
        chunks,
    })
}

/// 取缓存；版本或所选模型不一致就重建。
/// 并发查询同时重建时，后写入的覆盖先写入的，结果一致。
pub fn get_or_build_cache(
    state: &SemanticState,
    conn: &Connection,
    model_id: &str,
) -> Result<Arc<VectorCache>, String> {
    let version = state.cache_version.load(Ordering::SeqCst);
    {
        let guard = state
            .cache
            .read()
            .map_err(|_| "向量缓存锁被占用".to_string())?;
        if let Some(cache) = guard.as_ref() {
            if cache.version == version && cache.model_id == model_id {
                return Ok(cache.clone());
            }
        }
    }

    let built = Arc::new(build_cache(conn, version, model_id)?);
    let mut guard = state
        .cache
        .write()
        .map_err(|_| "向量缓存锁被占用".to_string())?;
    *guard = Some(built.clone());
    Ok(built)
}

/// 一个查询向量扫完全部块，按笔记取最高分块。
pub fn search(
    cache: &VectorCache,
    query: &[f32],
    limit: usize,
    min_score: f32,
    allowed: Option<&HashSet<i64>>,
) -> Vec<SemanticHit> {
    let limit = limit.clamp(1, MAX_LIMIT);
    let mut best: HashMap<i64, (f32, i64, &str)> = HashMap::new();

    for chunk in &cache.chunks {
        if chunk.vector.len() != query.len() {
            continue;
        }
        if let Some(allowed) = allowed {
            if !allowed.contains(&chunk.note_id) {
                continue;
            }
        }
        let score = dot(query, &chunk.vector);
        if score < min_score {
            continue;
        }
        match best.get(&chunk.note_id) {
            Some((current, _, _)) if *current >= score => {}
            _ => {
                best.insert(chunk.note_id, (score, chunk.seq, chunk.text.as_str()));
            }
        }
    }

    let mut hits: Vec<SemanticHit> = best
        .into_iter()
        .map(|(note_id, (score, chunk_seq, text))| SemanticHit {
            note_id,
            score,
            chunk_seq,
            snippet: snippet(text),
        })
        .collect();
    // 分数高在前；同分按 id 保证顺序稳定，避免界面抖动
    hits.sort_by(|a, b| {
        b.score
            .partial_cmp(&a.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.note_id.cmp(&b.note_id))
    });
    hits.truncate(limit);
    hits
}

fn dot(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(x, y)| x * y).sum()
}

/// 折叠空白后截断；片段里不标黄（语义命中本来就没有字面区间）。
fn snippet(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let chars: Vec<char> = collapsed.chars().collect();
    if chars.len() <= SNIPPET_CHARS {
        collapsed
    } else {
        format!("{}…", chars[..SNIPPET_CHARS].iter().collect::<String>())
    }
}

pub fn vec_to_blob(vector: &[f32]) -> Vec<u8> {
    vector.iter().flat_map(|v| v.to_le_bytes()).collect()
}

pub fn blob_to_vec(blob: &[u8]) -> Vec<f32> {
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
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

    fn insert_note(conn: &Connection, id: i64, deleted: bool) {
        conn.execute(
            "INSERT INTO notes (id, title, content, is_deleted) VALUES (?1, 't', 'c', ?2)",
            rusqlite::params![id, if deleted { 1 } else { 0 }],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO note_index_state (note_id, note_updated_at, model_id, indexed_at)
             VALUES (?1, 'now', 'test-model', 'now')",
            rusqlite::params![id],
        )
        .unwrap();
    }

    fn insert_chunk(conn: &Connection, note_id: i64, seq: i64, vector: &[f32], text: &str) {
        conn.execute(
            "INSERT INTO note_chunks (note_id, seq, text, dim, embedding) VALUES (?1, ?2, ?3, ?4, ?5)",
            rusqlite::params![note_id, seq, text, vector.len() as i64, vec_to_blob(vector)],
        )
        .unwrap();
    }

    #[test]
    fn blob_roundtrip() {
        let vector = vec![0.25f32, -1.5, 3.0];
        assert_eq!(blob_to_vec(&vec_to_blob(&vector)), vector);
        assert!(blob_to_vec(&[1, 2, 3]).is_empty());
    }

    #[test]
    fn cache_skips_trashed_notes() {
        let conn = memory_db();
        insert_note(&conn, 1, false);
        insert_note(&conn, 2, true);
        insert_chunk(&conn, 1, 0, &[1.0, 0.0], "保留");
        insert_chunk(&conn, 2, 0, &[1.0, 0.0], "回收站");

        let cache = build_cache(&conn, 0, "test-model").unwrap();
        assert_eq!(cache.chunks.len(), 1);
        assert_eq!(cache.chunks[0].note_id, 1);
    }

    #[test]
    fn cache_only_contains_selected_model_vectors() {
        let conn = memory_db();
        insert_note(&conn, 1, false);
        insert_chunk(&conn, 1, 0, &[1.0, 0.0], "旧模型");

        assert_eq!(build_cache(&conn, 0, "test-model").unwrap().chunks.len(), 1);
        assert!(build_cache(&conn, 0, "another-model")
            .unwrap()
            .chunks
            .is_empty());
    }

    #[test]
    fn search_filters_by_score_limit_and_allowlist() {
        let conn = memory_db();
        for id in 1..=3 {
            insert_note(&conn, id, false);
        }
        insert_chunk(&conn, 1, 0, &[1.0, 0.0], "最相关");
        insert_chunk(&conn, 2, 0, &[0.8, 0.6], "次相关");
        insert_chunk(&conn, 3, 0, &[0.0, 1.0], "无关");

        let cache = build_cache(&conn, 0, "test-model").unwrap();
        let query = [1.0, 0.0];

        let hits = search(&cache, &query, 10, 0.5, None);
        assert_eq!(hits.len(), 2, "低于 min_score 的块应被过滤");
        assert_eq!(hits[0].note_id, 1);
        assert_eq!(hits[1].note_id, 2);

        let allowed: HashSet<i64> = [2].into_iter().collect();
        let hits = search(&cache, &query, 10, 0.5, Some(&allowed));
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, 2);

        let hits = search(&cache, &query, 1, 0.5, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, 1);
    }

    #[test]
    fn per_note_score_is_max_chunk() {
        let conn = memory_db();
        insert_note(&conn, 1, false);
        insert_chunk(&conn, 1, 0, &[0.5, 0.866], "低分块");
        insert_chunk(&conn, 1, 1, &[1.0, 0.0], "高分块");

        let cache = build_cache(&conn, 0, "test-model").unwrap();
        let hits = search(&cache, &[1.0, 0.0], 10, 0.5, None);
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].chunk_seq, 1);
        assert!((hits[0].score - 1.0).abs() < 1e-5);
    }
}
