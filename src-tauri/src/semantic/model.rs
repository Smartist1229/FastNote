//! 本地嵌入模型的文件管理：内置模型清单、自定义模型导入、下载、校验、删除。
//!
//! 模型不随安装包分发（几十到上百 MB，且换模型就作废），首次使用时按需下载到
//! 数据目录下的 `models/<模型 id>/`。数据目录沿用数据库的便携规则：优先 exe
//! 同级的 `data`（安装目录不可写时才退回应用数据目录），整个目录拷走即可迁移。
//! 网络策略：先走 hf-mirror（国内可达），失败再回退 HuggingFace 官方；
//! 传输交给通用下载模块（`crate::download`），按设置里的线程数分段并发，
//! 中断留下的分段文件在参数不变时可续传。
//!
//! 自定义模型只支持本地目录导入（不抓取任意 URL）：文件先复制到临时目录，
//! 用用户填写的元数据真实跑一次推理自检，通过后才以内容哈希命名的目录落盘。

use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager};

/// 设置里保存所选模型的键；读不到或值非法时回退到推荐模型
pub const SETTING_KEY: &str = "app.config.general.semanticModel";

const MODEL_FILE: &str = "model.onnx";
const TOKENIZER_FILE: &str = "tokenizer.json";
const MANIFEST_FILE: &str = "manifest.json";
const CUSTOM_PREFIX: &str = "custom-";
/// 自定义模型 id 用两个文件 SHA-256 的摘要拼成，取前 16 位十六进制
const CUSTOM_ID_HEX_LEN: usize = 16;

const MIN_MODEL_BYTES: u64 = 4 * 1024;
const MIN_TOKENIZER_BYTES: u64 = 256;
const MAX_MODEL_BYTES: u64 = 1536 * 1024 * 1024;
const MAX_TOKENIZER_BYTES: u64 = 64 * 1024 * 1024;

const MIN_DIM: usize = 16;
const MAX_DIM: usize = 4096;
const MIN_TOKENS: usize = 8;
const MAX_TOKENS: usize = 4096;
pub const DEFAULT_MIN_SCORE: f32 = 0.35;

/// 句向量池化方式：BGE 用 CLS，MiniLM 系列用掩码平均
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Pooling {
    Cls,
    Mean,
}

impl Pooling {
    /// 前端表单传 "cls" / "mean"（大小写不敏感）
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "cls" => Some(Self::Cls),
            "mean" => Some(Self::Mean),
            _ => None,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Cls => "CLS",
            Self::Mean => "Mean",
        }
    }
}

#[derive(Clone, Debug)]
pub struct ModelSpec {
    pub id: String,
    /// 设置面板里的名称（推荐标记单独由 `recommended` 控制）
    pub name: String,
    pub description: String,
    /// 语言标签，如「中文」「多语言」「自定义」
    pub tag: String,
    pub dim: usize,
    pub max_tokens: usize,
    pub pooling: Pooling,
    /// 余弦相似度阈值：不同模型的分值分布不同，不能共用一个数
    pub min_score: f32,
    pub recommended: bool,
    /// 本地导入的模型：不可在线下载，元数据来自 manifest
    pub custom: bool,
    /// 内置模型的下载仓库与文件路径；自定义模型为 None
    repo: Option<String>,
    onnx_path: Option<String>,
    tokenizer_path: Option<String>,
    model_bytes: u64,
    tokenizer_bytes: u64,
}

impl ModelSpec {
    /// 两个模型文件的总字节数（展示与下载进度用）
    pub fn size(&self) -> u64 {
        self.model_bytes.saturating_add(self.tokenizer_bytes)
    }

    /// (本地文件名, 仓库内路径, 最小合法字节数)；自定义模型没有下载源
    fn files(&self) -> Option<[(&'static str, &str, u64); 2]> {
        Some([
            (
                MODEL_FILE,
                self.onnx_path.as_deref()?,
                min_bytes(self.model_bytes),
            ),
            (
                TOKENIZER_FILE,
                self.tokenizer_path.as_deref()?,
                min_bytes(self.tokenizer_bytes),
            ),
        ])
    }
}

/// 允许同一模型的不同量化/修订版略有出入；低于九成视为下载不完整。
fn min_bytes(expected: u64) -> u64 {
    expected.saturating_mul(9) / 10
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct FileDigest {
    size: u64,
    sha256: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct Manifest {
    model_id: String,
    dim: usize,
    #[serde(default)]
    source_url: String,
    #[serde(default)]
    downloaded_at: String,
    /// 自定义模型标记；内置模型的旧清单没有这个字段
    #[serde(default)]
    custom: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pooling: Option<Pooling>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    max_tokens: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    min_score: Option<f32>,
    /// 自定义模型记录文件指纹，导入后文件被替换时状态会变为不可用
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model_file: Option<FileDigest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokenizer_file: Option<FileDigest>,
}

/// 状态面板用的模型条目
#[derive(Debug, Serialize)]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub description: String,
    pub tag: String,
    pub dim: usize,
    pub approx_size: u64,
    pub recommended: bool,
    pub custom: bool,
    pub installed: bool,
    pub installed_size: u64,
    pub dir: String,
}

/// 内置模型清单。新增内置模型只改这里，前端从 `semantic_status` 读取。
pub fn builtins() -> &'static [ModelSpec] {
    static BUILTINS: OnceLock<Vec<ModelSpec>> = OnceLock::new();
    BUILTINS.get_or_init(|| {
        vec![
            ModelSpec {
                id: "bge-small-zh-v1.5-int8".to_string(),
                name: "BGE Small 中文".to_string(),
                description:
                    "体积小、速度快，中文笔记的通用选择；纯 CPU 也能流畅建索引。".to_string(),
                tag: "中文".to_string(),
                dim: 512,
                max_tokens: 384,
                pooling: Pooling::Cls,
                min_score: 0.42,
                recommended: true,
                custom: false,
                repo: Some("Xenova/bge-small-zh-v1.5".to_string()),
                onnx_path: Some("onnx/model_quantized.onnx".to_string()),
                tokenizer_path: Some("tokenizer.json".to_string()),
                model_bytes: 24_010_842,
                tokenizer_bytes: 439_125,
            },
            ModelSpec {
                id: "bge-base-zh-v1.5-int8".to_string(),
                name: "BGE Base 中文".to_string(),
                description:
                    "模型更大，近义与换述的区分更细，检索更准；索引与查询会明显变慢。".to_string(),
                tag: "中文".to_string(),
                dim: 768,
                max_tokens: 384,
                pooling: Pooling::Cls,
                min_score: 0.40,
                recommended: false,
                custom: false,
                repo: Some("Xenova/bge-base-zh-v1.5".to_string()),
                onnx_path: Some("onnx/model_quantized.onnx".to_string()),
                tokenizer_path: Some("tokenizer.json".to_string()),
                model_bytes: 102_868_746,
                tokenizer_bytes: 439_124,
            },
            ModelSpec {
                id: "paraphrase-multilingual-MiniLM-L12-v2-int8".to_string(),
                name: "Multilingual MiniLM".to_string(),
                description:
                    "支持中英等 50 多种语言，适合中英混写或外文笔记；体积最大。".to_string(),
                tag: "多语言".to_string(),
                dim: 384,
                max_tokens: 256,
                pooling: Pooling::Mean,
                min_score: 0.35,
                recommended: false,
                custom: false,
                repo: Some("Xenova/paraphrase-multilingual-MiniLM-L12-v2".to_string()),
                onnx_path: Some("onnx/model_quantized.onnx".to_string()),
                tokenizer_path: Some("tokenizer.json".to_string()),
                model_bytes: 118_308_126,
                tokenizer_bytes: 17_082_913,
            },
        ]
    })
}

pub fn default_model() -> &'static ModelSpec {
    &builtins()[0]
}

/// 只在内置清单里查（测试等没有 AppHandle 的场景）
pub fn find_builtin(id: &str) -> Option<ModelSpec> {
    builtins().iter().find(|model| model.id == id).cloned()
}

/// 在内置 + 已导入的自定义模型里查。
///
/// 自定义模型从模型目录里的 manifest 现扫：导入/删除后不需要维护内存注册表，
/// 用户手动删掉目录也能立刻反映到状态里。
pub fn find(app: &AppHandle, id: &str) -> Option<ModelSpec> {
    find_builtin(id).or_else(|| custom_models(app).into_iter().find(|model| model.id == id))
}

/// 当前选中的模型；库里的值来自前端设置，模型被删除或值非法时静默回退推荐项。
pub fn selected(app: &AppHandle) -> ModelSpec {
    let id = crate::read_setting_string(app, SETTING_KEY, &default_model().id);
    find(app, &id).unwrap_or_else(|| default_model().clone())
}

pub fn catalog(app: &AppHandle) -> Vec<ModelInfo> {
    builtins()
        .iter()
        .chain(custom_models(app).iter())
        .map(|spec| info(app, spec))
        .collect()
}

fn info(app: &AppHandle, spec: &ModelSpec) -> ModelInfo {
    ModelInfo {
        id: spec.id.clone(),
        name: spec.name.clone(),
        description: spec.description.clone(),
        tag: spec.tag.clone(),
        dim: spec.dim,
        approx_size: spec.size(),
        recommended: spec.recommended,
        custom: spec.custom,
        installed: is_ready(app, spec),
        installed_size: size(app, spec),
        dir: dir(app, spec)
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    }
}

/// 模型根目录：`<数据目录>/models/`（与 fastnote.db 同一个便携目录）
pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app.path().app_data_dir().ok();
    Ok(crate::resolve_data_dir(app_data).join("models"))
}

/// 模型目录：`<数据目录>/models/<模型 id>/`
pub fn dir(app: &AppHandle, spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(base_dir(app)?.join(&spec.id))
}

pub fn model_path(app: &AppHandle, spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(dir(app, spec)?.join(MODEL_FILE))
}

pub fn tokenizer_path(app: &AppHandle, spec: &ModelSpec) -> Result<PathBuf, String> {
    Ok(dir(app, spec)?.join(TOKENIZER_FILE))
}

/// 已导入的自定义模型。只认带 `custom: true` 清单且目录名格式正确的模型，
/// 避免用户随手放进来的目录被当成可选模型。
pub fn custom_models(app: &AppHandle) -> Vec<ModelSpec> {
    let Ok(base) = base_dir(app) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&base) else {
        return Vec::new();
    };
    let mut models = Vec::new();
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        // 目录符号链接不跟随：导入流程也只接受普通文件，避免把模型指向任意位置
        if !file_type.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if !is_custom_id(&dir_name) {
            continue;
        }
        if let Some(spec) = read_custom_spec(&entry.path(), &dir_name) {
            models.push(spec);
        }
    }
    models.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    models
}

fn is_custom_id(id: &str) -> bool {
    let Some(rest) = id.strip_prefix(CUSTOM_PREFIX) else {
        return false;
    };
    rest.len() == CUSTOM_ID_HEX_LEN
        && rest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn read_custom_spec(dir: &Path, dir_name: &str) -> Option<ModelSpec> {
    let raw = std::fs::read_to_string(dir.join(MANIFEST_FILE)).ok()?;
    let manifest: Manifest = serde_json::from_str(&raw).ok()?;
    if !manifest.custom || manifest.model_id != dir_name {
        return None;
    }
    let model_file = manifest.model_file?;
    let tokenizer_file = manifest.tokenizer_file?;
    if model_file.size < MIN_MODEL_BYTES
        || tokenizer_file.size < MIN_TOKENIZER_BYTES
        || model_file.size > MAX_MODEL_BYTES
        || tokenizer_file.size > MAX_TOKENIZER_BYTES
    {
        return None;
    }
    if !(MIN_DIM..=MAX_DIM).contains(&manifest.dim) {
        return None;
    }
    let max_tokens = manifest.max_tokens?;
    if !(MIN_TOKENS..=MAX_TOKENS).contains(&max_tokens) {
        return None;
    }
    let min_score = manifest.min_score.unwrap_or(DEFAULT_MIN_SCORE);
    if !is_valid_score(min_score) {
        return None;
    }
    let pooling = manifest.pooling.unwrap_or(Pooling::Cls);
    let name = manifest
        .name
        .filter(|name| is_valid_name(name))
        .unwrap_or_else(|| format!("自定义模型 {}", &dir_name[CUSTOM_PREFIX.len()..]));
    let description = manifest.description.unwrap_or_else(|| {
        format!(
            "本地导入的模型；使用 {} 池化，请在设置里按模型实际能力调整阈值。",
            pooling.label()
        )
    });
    let tag = manifest.tag.unwrap_or_else(|| "自定义".to_string());

    Some(ModelSpec {
        id: dir_name.to_string(),
        name,
        description,
        tag,
        dim: manifest.dim,
        max_tokens,
        pooling,
        min_score,
        recommended: false,
        custom: true,
        repo: None,
        onnx_path: None,
        tokenizer_path: None,
        model_bytes: model_file.size,
        tokenizer_bytes: tokenizer_file.size,
    })
}

/// 模型是否可用：两个文件都在、大小达标、manifest 记录的模型标识与维度都对得上。
///
/// 只做文件级判断，不加载 ONNX（加载要几百毫秒，状态查询不该付这个代价）；
/// 真正的可用性由 `Engine::load` + 自检兜底。
pub fn is_ready(app: &AppHandle, spec: &ModelSpec) -> bool {
    dir(app, spec)
        .map(|dir| is_ready_dir(&dir, spec))
        .unwrap_or(false)
}

fn is_ready_dir(dir: &Path, spec: &ModelSpec) -> bool {
    // 自定义模型记录的是导入时的精确大小：文件被替换/截断时立刻变为不可用；
    // 内置模型的下载允许量化版略有出入，只要求达到九成。
    let size_ok = |len: u64, expected: u64| {
        if spec.custom {
            len == expected
        } else {
            len >= min_bytes(expected)
        }
    };
    let model_ok = std::fs::metadata(dir.join(MODEL_FILE))
        .map(|m| size_ok(m.len(), spec.model_bytes))
        .unwrap_or(false);
    let tokenizer_ok = std::fs::metadata(dir.join(TOKENIZER_FILE))
        .map(|m| size_ok(m.len(), spec.tokenizer_bytes))
        .unwrap_or(false);
    if !model_ok || !tokenizer_ok {
        return false;
    }
    match std::fs::read_to_string(dir.join(MANIFEST_FILE)) {
        Ok(raw) => serde_json::from_str::<Manifest>(&raw)
            .map(|m| m.model_id == spec.id && m.dim == spec.dim)
            .unwrap_or(false),
        // 离线手动放置的内置模型没有清单：文件大小已达标就先认，
        // 模型是否真的可用由 Engine::embed 的维度校验兜底；首次成功加载后会补写清单
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && !spec.custom => true,
        Err(_) => false,
    }
}

/// 手动放置的内置模型没有清单：首次成功加载后补写一份，后续模型 ID 校验才有依据。
pub fn write_manifest_if_missing(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    let path = dir(app, spec)?.join(MANIFEST_FILE);
    if path.exists() {
        return Ok(());
    }
    let manifest = Manifest {
        model_id: spec.id.clone(),
        dim: spec.dim,
        source_url: "manual".to_string(),
        downloaded_at: chrono::Local::now().to_rfc3339(),
        custom: false,
        name: None,
        description: None,
        tag: None,
        pooling: None,
        max_tokens: None,
        min_score: None,
        model_file: None,
        tokenizer_file: None,
    };
    std::fs::write(
        path,
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写入模型清单失败：{e}"))
}

/// 已下载模型的字节数（用于设置面板展示）；未下完的文件也计入占用
pub fn size(app: &AppHandle, spec: &ModelSpec) -> u64 {
    let Ok(dir) = dir(app, spec) else {
        return 0;
    };
    [MODEL_FILE, TOKENIZER_FILE]
        .iter()
        .map(|name| {
            std::fs::metadata(dir.join(name))
                .map(|m| m.len())
                .unwrap_or(0)
        })
        .sum()
}

pub fn delete(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    let dir = dir(app, spec)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("删除模型失败：{e}"))?;
    }
    Ok(())
}

/// 旧版本把模型放在应用数据目录：启动时搬进当前数据目录，避免用户重新下载。
/// 只在目标位置还没有模型、且源目录文件完整时搬；失败就留在原处（下次下载会覆盖）。
pub fn migrate_legacy(app: &AppHandle) {
    let Ok(base) = base_dir(app) else {
        return;
    };
    cleanup_stale_imports(&base);
    let Some(legacy) = app.path().app_data_dir().ok().map(|p| p.join("models")) else {
        return;
    };
    // 安装目录不可写时本来就退回应用数据目录，两边是同一个位置
    if legacy == base {
        return;
    }

    for spec in builtins() {
        let src = legacy.join(&spec.id);
        let dst = base.join(&spec.id);
        if !src.is_dir() || dst.exists() || !is_ready_dir(&src, spec) {
            continue;
        }
        if let Err(e) = move_dir(&src, &dst) {
            eprintln!("迁移模型 {} 失败：{e}", spec.id);
        }
    }
    // 搬空后顺手删掉空壳；还有其他文件时 remove_dir 会失败，忽略即可
    let _ = std::fs::remove_dir(&legacy);
}

/// 导入过程崩溃会留下 `.import-*` 临时目录（里面是复制了一半的大文件）。
/// 启动时还没有导入任务，直接清掉即可；正常失败路径已经自行清理。
fn cleanup_stale_imports(base: &Path) {
    let Ok(entries) = std::fs::read_dir(base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with(".import-") {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 同卷直接 rename；跨卷（应用装在 D 盘、数据在 C 盘）退化为复制后删除源目录。
fn move_dir(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(src, dst).is_ok() {
        return Ok(());
    }

    std::fs::create_dir_all(dst).map_err(|e| e.to_string())?;
    let copy = || -> std::io::Result<()> {
        for entry in std::fs::read_dir(src)? {
            let entry = entry?;
            if entry.file_type()?.is_file() {
                std::fs::copy(entry.path(), dst.join(entry.file_name()))?;
            }
        }
        Ok(())
    };
    if let Err(e) = copy() {
        // 复制到一半的目录不能留：否则下次会被当成「目标已存在」而永远跳过
        let _ = std::fs::remove_dir_all(dst);
        return Err(e.to_string());
    }
    std::fs::remove_dir_all(src).map_err(|e| e.to_string())
}

/// 下载并校验全部模型文件；已存在的合格文件会跳过。
pub async fn download(app: &AppHandle, spec: &ModelSpec) -> Result<(), String> {
    if spec.custom {
        return Err("自定义模型不支持在线下载，请重新导入".to_string());
    }
    let Some(files) = spec.files() else {
        return Err("该模型没有下载源".to_string());
    };
    let Some(bases) = bases(spec) else {
        return Err("该模型没有下载源".to_string());
    };

    let dir = dir(app, spec)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("创建模型目录失败：{e}"))?;

    let client = crate::download::client()?;
    let threads = crate::download::threads(app);

    let expected_total = spec.size();
    let mut done_bytes = 0u64;

    // 先报一次 0%，别让前端在等待首个响应（可能走镜像回退）时一直停在「准备中」
    emit_progress(app, &spec.id, "download", 0, expected_total, 0, None);

    for (local_name, remote_path, min_bytes) in files {
        let dest = dir.join(local_name);
        let actual = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if actual >= min_bytes {
            done_bytes = done_bytes.saturating_add(actual);
            continue;
        }

        let mut last_error = String::new();
        let mut downloaded = false;
        for base in &bases {
            let url = format!("{base}{remote_path}");
            let progress = |file_done: u64, _: u64, segments: usize| {
                emit_progress(
                    app,
                    &spec.id,
                    "download",
                    done_bytes.saturating_add(file_done),
                    expected_total,
                    segments,
                    None,
                );
            };
            match crate::download::fetch(&client, &url, &dest, threads, None, &progress).await {
                Ok(_) => {
                    downloaded = true;
                    break;
                }
                Err(e) => last_error = e,
            }
        }
        if !downloaded {
            return Err(format!("{local_name} 下载失败：{last_error}"));
        }
        let actual = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);
        if actual < min_bytes {
            return Err(format!(
                "{local_name} 文件不完整（{actual} 字节，至少应为 {min_bytes}）"
            ));
        }
        done_bytes = done_bytes.saturating_add(actual);
    }

    let manifest = Manifest {
        model_id: spec.id.clone(),
        dim: spec.dim,
        source_url: bases[0].clone(),
        downloaded_at: chrono::Local::now().to_rfc3339(),
        custom: false,
        name: None,
        description: None,
        tag: None,
        pooling: None,
        max_tokens: None,
        min_score: None,
        model_file: None,
        tokenizer_file: None,
    };
    tokio::fs::write(
        dir.join(MANIFEST_FILE),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .await
    .map_err(|e| format!("写入模型清单失败：{e}"))?;

    // 文件已齐全，但真正可用性要等推理自检；前端凭 verify 阶段继续显示进度条
    let actual_total = size(app, spec);
    emit_progress(app, &spec.id, "verify", actual_total, actual_total, 0, None);
    Ok(())
}

/// 下载源：镜像优先，官方兜底（官方在部分网络环境不可达）
fn bases(spec: &ModelSpec) -> Option<[String; 2]> {
    let repo = spec.repo.as_deref()?;
    Some([
        format!("https://hf-mirror.com/{repo}/resolve/main/"),
        format!("https://huggingface.co/{repo}/resolve/main/"),
    ])
}

fn emit_progress(
    app: &AppHandle,
    model_id: &str,
    stage: &str,
    downloaded: u64,
    total: u64,
    segments: usize,
    error: Option<&str>,
) {
    let _ = app.emit(
        "semantic-model-progress",
        json!({
            "model_id": model_id,
            "stage": stage,
            "downloaded": downloaded,
            "total": total,
            "segments": segments,
            "error": error,
        }),
    );
}

/// 导入请求：由设置面板收集，全部在 Rust 侧再校验一遍。
#[derive(Debug, Deserialize)]
pub struct ImportRequest {
    pub source_dir: String,
    pub name: String,
    pub dim: usize,
    pub max_tokens: usize,
    pub pooling: String,
    #[serde(default)]
    pub min_score: Option<f32>,
}

/// 从本地目录导入模型，返回新模型 id。
///
/// 安全边界：
/// - 只读源目录，不移动/删除用户文件；源内必须是普通文件，拒绝符号链接；
/// - 文件大小有上下限，导入过程按上限读取，避免异常大文件拖垮应用；
/// - 先复制到临时目录，再用真实文件跑一次推理自检（维度、有限值、归一化）；
/// - 通过后写入含 SHA-256 的清单，并以内容哈希命名目录，重复导入不会覆盖已有模型。
pub fn import(app: &AppHandle, request: ImportRequest) -> Result<ModelSpec, String> {
    import_into(&base_dir(app)?, request)
}

fn import_into(base: &Path, request: ImportRequest) -> Result<ModelSpec, String> {
    let name = request.name.trim().to_string();
    if !is_valid_name(&name) {
        return Err("模型名称需为 1–60 个字符，且不能包含换行等控制字符".to_string());
    }
    if !(MIN_DIM..=MAX_DIM).contains(&request.dim) {
        return Err(format!("向量维度需在 {MIN_DIM}–{MAX_DIM} 之间"));
    }
    if !(MIN_TOKENS..=MAX_TOKENS).contains(&request.max_tokens) {
        return Err(format!("最大 token 数需在 {MIN_TOKENS}–{MAX_TOKENS} 之间"));
    }
    let pooling = Pooling::parse(&request.pooling)
        .ok_or_else(|| "池化方式只能是 cls 或 mean".to_string())?;
    let min_score = request.min_score.unwrap_or(DEFAULT_MIN_SCORE);
    if !is_valid_score(min_score) {
        return Err("相似度阈值需在 0.05–0.95 之间".to_string());
    }

    let source = PathBuf::from(request.source_dir.trim())
        .canonicalize()
        .map_err(|_| "所选目录不存在或无法访问".to_string())?;
    if !source.is_dir() {
        return Err("所选路径不是目录".to_string());
    }
    let source_model = regular_file(&source.join(MODEL_FILE), "model.onnx")?;
    let source_tokenizer = regular_file(&source.join(TOKENIZER_FILE), "tokenizer.json")?;
    ensure_size(&source_model, MIN_MODEL_BYTES, MAX_MODEL_BYTES, "model.onnx")?;
    ensure_size(
        &source_tokenizer,
        MIN_TOKENIZER_BYTES,
        MAX_TOKENIZER_BYTES,
        "tokenizer.json",
    )?;

    std::fs::create_dir_all(base).map_err(|e| format!("创建模型目录失败：{e}"))?;
    let temp = base.join(format!(
        ".import-{}-{}",
        std::process::id(),
        chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
    ));
    std::fs::create_dir_all(&temp).map_err(|e| format!("创建导入临时目录失败：{e}"))?;

    let outcome = (|| -> Result<ModelSpec, String> {
        let model_digest = copy_with_digest(&source_model, &temp.join(MODEL_FILE), MAX_MODEL_BYTES)?;
        let tokenizer_digest = copy_with_digest(
            &source_tokenizer,
            &temp.join(TOKENIZER_FILE),
            MAX_TOKENIZER_BYTES,
        )?;
        let id = custom_id(&model_digest, &tokenizer_digest);

        let spec = ModelSpec {
            id: id.clone(),
            name: name.clone(),
            description: format!(
                "本地导入的模型：{} 维，{} 池化，最大 {} token。",
                request.dim,
                pooling.label(),
                request.max_tokens
            ),
            tag: "自定义".to_string(),
            dim: request.dim,
            max_tokens: request.max_tokens,
            pooling,
            min_score,
            recommended: false,
            custom: true,
            repo: None,
            onnx_path: None,
            tokenizer_path: None,
            model_bytes: model_digest.size,
            tokenizer_bytes: tokenizer_digest.size,
        };

        self_check(&spec, &temp)?;

        let manifest = Manifest {
            model_id: id.clone(),
            dim: spec.dim,
            source_url: source.display().to_string(),
            downloaded_at: chrono::Local::now().to_rfc3339(),
            custom: true,
            name: Some(spec.name.clone()),
            description: Some(spec.description.clone()),
            tag: Some(spec.tag.clone()),
            pooling: Some(spec.pooling),
            max_tokens: Some(spec.max_tokens),
            min_score: Some(spec.min_score),
            model_file: Some(model_digest),
            tokenizer_file: Some(tokenizer_digest),
        };
        std::fs::write(
            temp.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("写入模型清单失败：{e}"))?;

        let final_dir = base.join(&id);
        if final_dir.exists() {
            return Err("这个模型已经导入过了，无需重复导入".to_string());
        }
        std::fs::rename(&temp, &final_dir).map_err(|e| format!("保存模型失败：{e}"))?;
        Ok(spec)
    })();

    if outcome.is_err() {
        let _ = std::fs::remove_dir_all(&temp);
    }
    outcome
}

/// 用用户填写的元数据真实加载一次模型并嵌入一句话，避免「导入成功但不可用」。
fn self_check(spec: &ModelSpec, dir: &Path) -> Result<(), String> {
    let engine = super::engine::Engine::load(
        spec,
        &dir.join(MODEL_FILE),
        &dir.join(TOKENIZER_FILE),
    )
    .map_err(|e| format!("模型无法加载：{e}"))?;
    let vector = engine
        .embed(&["语义搜索自检".to_string()])?
        .into_iter()
        .next()
        .ok_or_else(|| "模型没有返回向量".to_string())?;
    if vector.len() != spec.dim {
        return Err(format!(
            "模型实际输出 {} 维，与填写的 {} 维不一致",
            vector.len(),
            spec.dim
        ));
    }
    if vector.iter().any(|value| !value.is_finite()) {
        return Err("模型输出包含无效数值，无法用于检索".to_string());
    }
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if norm < 0.5 {
        return Err("模型输出全为零，可能不是句向量模型".to_string());
    }
    Ok(())
}

fn regular_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let meta = std::fs::symlink_metadata(path)
        .map_err(|_| format!("模型目录里缺少 {label}"))?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(format!("{label} 必须是普通文件（不支持符号链接）"));
    }
    Ok(path.to_path_buf())
}

fn ensure_size(path: &Path, min: u64, max: u64, label: &str) -> Result<(), String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("读取 {label} 失败：{e}"))?
        .len();
    if size < min {
        return Err(format!("{label} 太小（{size} 字节），可能不是有效的模型文件"));
    }
    if size > max {
        return Err(format!(
            "{label} 太大（{size} 字节），上限为 {max} 字节"
        ));
    }
    Ok(())
}

/// 复制文件并同时计算 SHA-256；超过上限立即中止，不会把异常大文件读进内存。
fn copy_with_digest(src: &Path, dst: &Path, max: u64) -> Result<FileDigest, String> {
    let mut input = File::open(src).map_err(|e| format!("读取模型文件失败：{e}"))?;
    let mut output = File::create(dst).map_err(|e| format!("写入模型文件失败：{e}"))?;
    let mut hasher = Sha256::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = input
            .read(&mut buffer)
            .map_err(|e| format!("读取模型文件失败：{e}"))?;
        if read == 0 {
            break;
        }
        size += read as u64;
        if size > max {
            return Err("模型文件超过大小上限，导入已中止".to_string());
        }
        hasher.update(&buffer[..read]);
        output
            .write_all(&buffer[..read])
            .map_err(|e| format!("写入模型文件失败：{e}"))?;
    }
    output
        .flush()
        .map_err(|e| format!("写入模型文件失败：{e}"))?;
    Ok(FileDigest {
        size,
        sha256: format!("{:x}", hasher.finalize()),
    })
}

fn custom_id(model: &FileDigest, tokenizer: &FileDigest) -> String {
    let mut hasher = Sha256::new();
    hasher.update(model.sha256.as_bytes());
    hasher.update(b":");
    hasher.update(tokenizer.sha256.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    format!("{CUSTOM_PREFIX}{}", &digest[..CUSTOM_ID_HEX_LEN])
}

fn is_valid_name(name: &str) -> bool {
    let trimmed = name.trim();
    !trimmed.is_empty() && trimmed.chars().count() <= 60 && !trimmed.chars().any(char::is_control)
}

fn is_valid_score(value: f32) -> bool {
    value.is_finite() && (0.05..=0.95).contains(&value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_has_one_recommended_model_with_unique_ids() {
        assert_eq!(
            builtins().iter().filter(|model| model.recommended).count(),
            1,
            "必须恰好有一个推荐项"
        );
        let mut ids = std::collections::HashSet::new();
        for model in builtins() {
            assert!(ids.insert(model.id.clone()), "模型 id 重复：{}", model.id);
            assert!(model.dim > 0 && model.max_tokens > 0);
            assert!(model.min_score > 0.0 && model.min_score < 1.0);
            assert!(model.size() > 0);
            assert!(!model.custom);
            assert!(model.files().is_some());
        }
    }

    #[test]
    fn unknown_model_falls_back_to_none() {
        assert!(find_builtin("not-a-model").is_none());
        assert!(find_builtin(&default_model().id).is_some());
    }

    #[test]
    fn custom_ids_are_strictly_validated() {
        assert!(is_custom_id("custom-0123456789abcdef"));
        assert!(!is_custom_id("custom-0123"));
        assert!(!is_custom_id("custom-0123456789ABCDEF"));
        assert!(!is_custom_id("bge-small-zh-v1.5-int8"));
        assert!(!is_custom_id("custom-0123456789abcde/"));
    }

    #[test]
    fn import_metadata_validation() {
        assert!(is_valid_name("我的模型"));
        assert!(!is_valid_name("   "));
        assert!(!is_valid_name(&"长".repeat(61)));
        assert!(!is_valid_name("换\n行"));
        assert!(is_valid_score(0.35));
        assert!(!is_valid_score(0.0));
        assert!(!is_valid_score(1.0));
        assert!(!is_valid_score(f32::NAN));
        assert_eq!(Pooling::parse("CLS"), Some(Pooling::Cls));
        assert_eq!(Pooling::parse("mean"), Some(Pooling::Mean));
        assert_eq!(Pooling::parse("max"), None);
    }

    #[test]
    fn custom_id_is_content_addressed_and_stable() {
        let a = FileDigest {
            size: 1,
            sha256: "aa".to_string(),
        };
        let b = FileDigest {
            size: 2,
            sha256: "bb".to_string(),
        };
        let id = custom_id(&a, &b);
        assert_eq!(id, custom_id(&a, &b));
        assert!(is_custom_id(&id));
        assert_ne!(
            id,
            custom_id(
                &FileDigest {
                    size: 1,
                    sha256: "ab".to_string()
                },
                &b
            )
        );
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "fastnote-model-{tag}-{}-{}",
            std::process::id(),
            chrono::Local::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn copy_with_digest_hashes_content_and_enforces_cap() {
        let dir = temp_dir("copy");
        let src = dir.join("src.bin");
        let dst = dir.join("dst.bin");
        let data = vec![7u8; 10_000];
        std::fs::write(&src, &data).unwrap();

        let digest = copy_with_digest(&src, &dst, 20_000).unwrap();
        assert_eq!(digest.size, 10_000);
        assert_eq!(digest.sha256, format!("{:x}", Sha256::digest(&data)));
        assert_eq!(std::fs::read(&dst).unwrap(), data);

        // 超过上限必须在写完之前中止
        let small = dir.join("small.bin");
        assert!(copy_with_digest(&src, &small, 1_000).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    #[ignore = "需要真实模型目录"]
    fn self_check_accepts_real_model_and_rejects_wrong_dim() {
        let dir = std::env::var("FASTNOTE_MODEL_DIR").expect("设置 FASTNOTE_MODEL_DIR");
        let dir = std::path::Path::new(&dir);
        let spec = |dim: usize| ModelSpec {
            id: "custom-test".to_string(),
            name: "测试".to_string(),
            description: String::new(),
            tag: "自定义".to_string(),
            dim,
            max_tokens: 384,
            pooling: Pooling::Cls,
            min_score: DEFAULT_MIN_SCORE,
            recommended: false,
            custom: true,
            repo: None,
            onnx_path: None,
            tokenizer_path: None,
            model_bytes: 0,
            tokenizer_bytes: 0,
        };
        assert!(self_check(&spec(768), dir).is_ok(), "正确维度应通过自检");
        let error = self_check(&spec(512), dir).unwrap_err();
        assert!(
            error.contains("不一致"),
            "维度填错应给出明确错误：{error}"
        );
    }

    #[test]
    #[ignore = "需要真实模型目录"]
    fn import_copies_real_model_writes_manifest_and_rejects_duplicates() {
        let source = std::env::var("FASTNOTE_MODEL_DIR").expect("设置 FASTNOTE_MODEL_DIR");
        let base = temp_dir("import-base");
        let request = |dim: usize| ImportRequest {
            source_dir: source.clone(),
            name: "导入测试".to_string(),
            dim,
            max_tokens: 384,
            pooling: "cls".to_string(),
            min_score: None,
        };

        // 维度填错：自检失败，不能留下任何模型目录或临时目录
        let error = import_into(&base, request(512)).unwrap_err();
        assert!(error.contains("不一致"), "应报维度不一致：{error}");
        assert_eq!(custom_dirs(&base).len(), 0);
        assert_eq!(std::fs::read_dir(&base).unwrap().count(), 0, "临时目录应被清理");

        let spec = import_into(&base, request(768)).expect("正确维度应导入成功");
        assert!(is_custom_id(&spec.id));
        assert!(is_ready_dir(&base.join(&spec.id), &spec));
        let manifest_raw =
            std::fs::read_to_string(base.join(&spec.id).join(MANIFEST_FILE)).unwrap();
        let manifest: Manifest = serde_json::from_str(&manifest_raw).unwrap();
        assert!(manifest.custom);
        assert_eq!(manifest.model_id, spec.id);
        assert_eq!(manifest.dim, 768);
        assert_eq!(
            manifest.model_file.unwrap().size,
            std::fs::metadata(base.join(&spec.id).join(MODEL_FILE))
                .unwrap()
                .len()
        );

        // 同一份文件再次导入：内容哈希相同，明确提示已存在，不覆盖已有目录
        let error = import_into(&base, request(768)).unwrap_err();
        assert!(error.contains("已经导入"), "应提示重复导入：{error}");
        assert_eq!(custom_dirs(&base).len(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    fn custom_dirs(base: &Path) -> Vec<String> {
        std::fs::read_dir(base)
            .map(|entries| {
                entries
                    .flatten()
                    .filter_map(|entry| {
                        let name = entry.file_name().to_string_lossy().to_string();
                        is_custom_id(&name).then_some(name)
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    #[test]
    fn custom_manifest_roundtrip_and_validation() {
        let dir = temp_dir("manifest");
        let id = "custom-0123456789abcdef";
        let model_dir = dir.join(id);
        std::fs::create_dir_all(&model_dir).unwrap();
        let manifest = Manifest {
            model_id: id.to_string(),
            dim: 768,
            source_url: "source".to_string(),
            downloaded_at: "now".to_string(),
            custom: true,
            name: Some("测试模型".to_string()),
            description: None,
            tag: None,
            pooling: Some(Pooling::Mean),
            max_tokens: Some(512),
            min_score: Some(0.3),
            model_file: Some(FileDigest {
                size: 8192,
                sha256: "aa".to_string(),
            }),
            tokenizer_file: Some(FileDigest {
                size: 1024,
                sha256: "bb".to_string(),
            }),
        };
        std::fs::write(
            model_dir.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();

        let spec = read_custom_spec(&model_dir, id).unwrap();
        assert_eq!(spec.id, id);
        assert_eq!(spec.dim, 768);
        assert_eq!(spec.name, "测试模型");
        assert_eq!(spec.pooling, Pooling::Mean);
        assert_eq!(spec.min_score, 0.3);
        assert!(spec.custom);
        assert!(spec.files().is_none(), "自定义模型没有下载源");

        // 目录名与清单 id 不一致时不认，避免手工摆放的目录混入清单
        assert!(read_custom_spec(&model_dir, "custom-ffffffffffffffff").is_none());

        let mut wrong = manifest;
        wrong.custom = false;
        std::fs::write(
            model_dir.join(MANIFEST_FILE),
            serde_json::to_vec(&wrong).unwrap(),
        )
        .unwrap();
        assert!(read_custom_spec(&model_dir, id).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
