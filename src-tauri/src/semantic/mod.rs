//! 语义搜索：本地 ONNX 嵌入 + SQLite 向量 + 暴力余弦。
//!
//! 模块分工：
//! - `engine`：ort / tokenizers 封装，对外只有 load / embed
//! - `chunk`：Markdown 分块
//! - `model`：模型清单与文件下载 / 校验 / 删除
//! - `index`：后台索引 worker
//! - `search`：向量缓存与检索
//!
//! 本文件只放状态、跨模块 helper 和 Tauri 命令（薄壳）。

pub mod chunk;
pub mod engine;
pub mod index;
pub mod model;
pub mod search;

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use engine::Engine;
use model::ModelSpec;
use search::SemanticHit;

const SETTING_KEY: &str = "app.config.general.semanticSearch";
/// 模型下载完成 / 笔记改动后是否自动建立索引；关闭后只能手动「重建索引」
pub const AUTO_INDEX_KEY: &str = "app.config.general.semanticAutoIndex";

#[derive(Default)]
pub struct SemanticState {
    /// 引擎连同它来自哪个模型一起缓存：切换模型后必须重新加载
    pub engine: Mutex<Option<(String, Arc<Engine>)>>,
    pub cache: RwLock<Option<Arc<search::VectorCache>>>,
    /// 任何会改变向量 / 可见性的写操作都要 +1，查询时据此判断缓存是否过期
    pub cache_version: AtomicU64,
    pub index_running: AtomicBool,
    pub index_cancel: AtomicBool,
    /// 关闭自动索引时，手动点「重建索引」置位；worker 消费后清掉，只跑一轮
    pub index_requested: AtomicBool,
    /// 正在下载的模型 id；同时用作「同一时间只允许一个下载任务」的锁
    pub download_model: Mutex<Option<String>>,
}

#[derive(Serialize)]
pub struct SemanticStatus {
    pub enabled: bool,
    /// 当前选中的模型 id（来自 app.config.general.semanticModel）
    pub selected_model: String,
    pub model_ready: bool,
    pub model_size: u64,
    pub model_dir: String,
    pub downloading: bool,
    pub downloading_model: Option<String>,
    pub indexing: bool,
    pub total_notes: i64,
    pub indexed_notes: i64,
    pub total_chunks: i64,
    pub dim: i64,
    pub last_error: Option<String>,
    /// 可选模型清单及各自的安装状态
    pub models: Vec<model::ModelInfo>,
}

pub fn spawn_worker(app: AppHandle) {
    index::spawn_worker(app);
}

pub fn enabled(app: &AppHandle) -> bool {
    crate::read_setting_bool(app, SETTING_KEY, false)
}

pub fn invalidate(state: &SemanticState) {
    state.cache_version.fetch_add(1, Ordering::SeqCst);
}

/// 取指定模型的引擎；没有就现场加载（约几百毫秒）。加载失败不会缓存错误，下次会重试。
///
/// 索引 worker 必须显式传自己本轮捕获的模型：中途切换模型时，
/// 不能让新模型的向量被写进旧模型的索引。
pub fn engine_for_spec(app: &AppHandle, spec: &ModelSpec) -> Result<Arc<Engine>, String> {
    let state = app.state::<AppState>();
    let mut guard = state
        .semantic
        .engine
        .lock()
        .map_err(|_| "推理引擎锁被占用".to_string())?;
    if let Some((id, engine)) = guard.as_ref() {
        if id == &spec.id {
            return Ok(engine.clone());
        }
    }
    if !model::is_ready(app, spec) {
        return Err("语义模型尚未下载".to_string());
    }
    let engine = Arc::new(Engine::load(
        spec,
        &model::model_path(app, spec)?,
        &model::tokenizer_path(app, spec)?,
    )?);
    // 手动放入的模型没有 manifest：加载成功就补写，之后状态查询才能稳定认它
    let _ = model::write_manifest_if_missing(app, spec);
    *guard = Some((spec.id.to_string(), engine.clone()));
    Ok(engine)
}

/// 当前所选模型的引擎（仅开发期自检使用）
#[cfg(debug_assertions)]
pub fn engine_for(app: &AppHandle) -> Result<Arc<Engine>, String> {
    let spec = model::selected(app);
    engine_for_spec(app, &spec)
}

fn finish_download(state: &SemanticState) {
    if let Ok(mut guard) = state.download_model.lock() {
        *guard = None;
    }
}

fn clear_engine_if(state: &SemanticState, model_id: &str) {
    if let Ok(mut guard) = state.engine.lock() {
        let matches = guard
            .as_ref()
            .map(|(id, _)| id == model_id)
            .unwrap_or(false);
        if matches {
            *guard = None;
        }
    }
}

pub fn set_meta(app: &AppHandle, key: &str, value: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    conn.execute(
        "INSERT INTO semantic_meta (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn read_meta(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM semantic_meta WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .ok()
}

#[tauri::command]
pub fn semantic_status(app: AppHandle) -> Result<SemanticStatus, String> {
    let state = app.state::<AppState>();
    let spec = model::selected(&app);
    let (downloading_model, indexing) = {
        let guard = state
            .semantic
            .download_model
            .lock()
            .map_err(|_| "下载状态锁被占用".to_string())?;
        (
            guard.clone(),
            state.semantic.index_running.load(Ordering::SeqCst),
        )
    };

    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;

    let total_notes = conn
        .query_row(
            "SELECT COUNT(*) FROM notes WHERE is_deleted = 0",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?;
    let indexed_notes = conn
        .query_row(
            "SELECT COUNT(*) FROM note_index_state s
             JOIN notes n ON n.id = s.note_id
             WHERE n.is_deleted = 0 AND s.model_id = ?1",
            params![spec.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    let total_chunks = conn
        .query_row(
            "SELECT COUNT(*) FROM note_chunks c
             JOIN notes n ON n.id = c.note_id AND n.is_deleted = 0
             JOIN note_index_state s ON s.note_id = c.note_id AND s.model_id = ?1",
            params![spec.id],
            |row| row.get::<_, i64>(0),
        )
        .unwrap_or(0);
    let last_error = read_meta(&conn, "last_error");
    drop(conn);

    Ok(SemanticStatus {
        enabled: enabled(&app),
        selected_model: spec.id.to_string(),
        model_ready: model::is_ready(&app, &spec),
        model_size: model::size(&app, &spec),
        model_dir: model::dir(&app, &spec)
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
        downloading: downloading_model.is_some(),
        downloading_model,
        indexing,
        total_notes,
        indexed_notes,
        total_chunks,
        dim: spec.dim as i64,
        last_error,
        models: model::catalog(&app),
    })
}

/// 下载模型并在后台校验。命令立刻返回，进度走 `semantic-model-progress`。
#[tauri::command]
pub async fn semantic_download_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let spec = model::find(&app, &model_id).ok_or_else(|| format!("未知的模型：{model_id}"))?;
    if spec.custom {
        return Err("自定义模型不支持在线下载，请重新导入或删除该模型".to_string());
    }
    // 文件已完整就直接返回：重复点击、或模型目录里本来就有（手动放入/便携迁移）时不再下载
    if model::is_ready(&app, &spec) {
        return Ok(());
    }
    let state = app.state::<AppState>();
    {
        let mut guard = state
            .semantic
            .download_model
            .lock()
            .map_err(|_| "下载状态锁被占用".to_string())?;
        if let Some(current) = guard.as_ref() {
            return Err(format!("模型 {current} 正在下载中，请稍候"));
        }
        *guard = Some(spec.id.clone());
    }

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let was_ready = model::is_ready(&handle, &spec);
        let outcome = download_and_verify(&handle, &spec).await;
        finish_download(&handle.state::<AppState>().semantic);
        match outcome {
            Ok(()) => {
                // download() 里的 verify 事件早于自检完成，这里再发正式 done，
                // 前端收到后刷新状态才能拿到 downloading=false
                let size = model::size(&handle, &spec);
                let _ = handle.emit(
                    "semantic-model-progress",
                    json!({
                        "model_id": spec.id,
                        "stage": "done",
                        "downloaded": size,
                        "total": size,
                        "error": null,
                    }),
                );
            }
            Err(error) => {
                if !was_ready {
                    let _ = model::delete(&handle, &spec);
                }
                let state = handle.state::<AppState>();
                clear_engine_if(&state.semantic, &spec.id);
                if model::selected(&handle).id == spec.id {
                    let _ = set_meta(&handle, "last_error", &error);
                }
                let _ = handle.emit(
                    "semantic-model-progress",
                    json!({
                        "model_id": spec.id,
                        "stage": "error",
                        "downloaded": 0,
                        "total": 0,
                        "error": error,
                    }),
                );
            }
        }
    });
    Ok(())
}

async fn download_and_verify(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    model::download(app, spec).await?;

    // 下载完成后丢掉可能存在的旧引擎，再用真实文件做一次推理自检
    {
        let state = app.state::<AppState>();
        clear_engine_if(&state.semantic, &spec.id);
    }
    let handle = app.clone();
    let spec_for_load = spec.clone();
    let engine = tauri::async_runtime::spawn_blocking(move || {
        engine_for_spec(&handle, &spec_for_load)
    })
    .await
    .map_err(|e| format!("模型校验失败：{e}"))??;
    let probe =
        tauri::async_runtime::spawn_blocking(move || engine.embed(&["语义搜索自检".to_string()]))
            .await
            .map_err(|e| format!("模型校验失败：{e}"))??;
    let vector = probe.into_iter().next().ok_or("模型自检没有返回向量")?;
    if vector.len() != spec.dim {
        return Err(format!(
            "模型输出维度为 {}，与预期的 {} 不一致",
            vector.len(),
            spec.dim
        ));
    }

    let state = app.state::<AppState>();
    let selected = model::selected(app).id;
    if selected != spec.id {
        // 下载的不是当前选中的模型：只落文件，不动索引与元数据
        return Ok(());
    }

    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    for (key, value) in [
        ("model_id", spec.id.to_string()),
        ("dim", spec.dim.to_string()),
    ] {
        conn.execute(
            "INSERT INTO semantic_meta (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )
        .map_err(|e| e.to_string())?;
    }
    conn.execute("DELETE FROM semantic_meta WHERE key = 'last_error'", [])
        .map_err(|e| e.to_string())?;
    drop(conn);
    invalidate(&state.semantic);
    Ok(())
}

#[tauri::command]
pub fn semantic_delete_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let spec = model::find(&app, &model_id).ok_or_else(|| format!("未知的模型：{model_id}"))?;
    let state = app.state::<AppState>();
    {
        let guard = state
            .semantic
            .download_model
            .lock()
            .map_err(|_| "下载状态锁被占用".to_string())?;
        if guard.as_deref() == Some(spec.id.as_str()) {
            return Err("该模型正在下载，请等待下载结束".to_string());
        }
    }

    let selected = model::selected(&app).id == spec.id;
    if selected {
        state.semantic.index_cancel.store(true, Ordering::SeqCst);
    }
    clear_engine_if(&state.semantic, &spec.id);
    model::delete(&app, &spec)?;

    // 只有删掉当前模型才需要清向量；其他模型的块本来就不会被当前缓存读取
    if selected {
        let fallback = model::default_model().id.clone();
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        conn.execute("DELETE FROM note_chunks", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM note_index_state", [])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM semantic_meta", [])
            .map_err(|e| e.to_string())?;
        // 删除当前模型后设置里会留下悬空 id：立刻回退到推荐模型，
        // 否则状态面板会显示一个已经不存在的选中项
        let value = serde_json::to_string(&fallback).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
            params![model::SETTING_KEY, value, chrono::Local::now().to_rfc3339()],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        invalidate(&state.semantic);
    }
    Ok(())
}

/// 从本地目录导入自定义模型，返回模型 id。
///
/// 复制、哈希与推理自检都在阻塞线程里完成；命令会一直等到导入结束，
/// 前端据此显示「正在校验」状态（大模型加载可能需要数秒）。
#[tauri::command]
pub async fn semantic_import_model(
    app: AppHandle,
    source_dir: String,
    name: String,
    dim: usize,
    max_tokens: usize,
    pooling: String,
    min_score: Option<f32>,
) -> Result<String, String> {
    let handle = app.clone();
    let request = model::ImportRequest {
        source_dir,
        name,
        dim,
        max_tokens,
        pooling,
        min_score,
    };
    tauri::async_runtime::spawn_blocking(move || model::import(&handle, request))
        .await
        .map_err(|e| format!("导入任务失败：{e}"))?
        .map(|spec| spec.id)
}

#[tauri::command]
pub fn semantic_rebuild_index(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    let conn = state
        .conn
        .lock()
        .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
    conn.execute("DELETE FROM note_chunks", [])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM note_index_state", [])
        .map_err(|e| e.to_string())?;
    drop(conn);
    invalidate(&state.semantic);
    // 自动索引关闭时 worker 不会自己开工，这里放行一轮；开启时置位也无害
    state.semantic.index_requested.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn semantic_cancel_index(app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    state.semantic.index_cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub async fn semantic_search(
    app: AppHandle,
    query: String,
    limit: Option<usize>,
    note_ids: Option<Vec<i64>>,
) -> Result<Vec<SemanticHit>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let limit = limit.unwrap_or(search::DEFAULT_LIMIT);

    tauri::async_runtime::spawn_blocking(move || {
        let spec = model::selected(&app);
        let engine = engine_for_spec(&app, &spec)?;
        let vector = engine
            .embed(&[query])?
            .into_iter()
            .next()
            .ok_or("查询向量为空")?;

        let state = app.state::<AppState>();
        let conn = state
            .conn
            .lock()
            .map_err(|_| "数据库被占用，请稍后重试".to_string())?;
        let cache = search::get_or_build_cache(&state.semantic, &conn, &spec.id)?;
        drop(conn);

        let allowed: Option<HashSet<i64>> =
            note_ids.map(|ids| ids.into_iter().collect::<HashSet<_>>());
        Ok(search::search(
            &cache,
            &vector,
            limit,
            spec.min_score,
            allowed.as_ref(),
        ))
    })
    .await
    .map_err(|e| format!("语义搜索任务失败：{e}"))?
}

/// 开发期自检：确认模型输出维度与清单一致且向量已归一化。发布构建不注册。
#[cfg(debug_assertions)]
#[tauri::command]
pub async fn semantic_debug_embed(app: AppHandle, text: String) -> Result<Vec<f32>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let engine = engine_for(&app)?;
        engine
            .embed(&[text])?
            .into_iter()
            .next()
            .ok_or_else(|| "模型没有返回向量".to_string())
    })
    .await
    .map_err(|e| format!("自检任务失败：{e}"))?
}
