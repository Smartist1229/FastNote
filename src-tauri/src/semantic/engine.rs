//! ONNX 推理封装：ort + tokenizers。
//!
//! 对外只暴露 `Engine::load` 与 `Engine::embed`，把 ort 的 API 全部关在这个文件里：
//! ort 2.0 还在 RC 期，升级时只需要改这里。
//!
//! 句向量由模型决定：BGE 用 CLS（首 token），MiniLM 用注意力掩码加权平均；
//! 池化后统一做 L2 归一化，检索侧相似度就是点积，不需要再做除法。

use std::borrow::Cow;
use std::path::Path;
use std::sync::Mutex;

use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use tokenizers::utils::padding::{PaddingDirection, PaddingParams, PaddingStrategy};
use tokenizers::utils::truncation::{TruncationDirection, TruncationParams, TruncationStrategy};
use tokenizers::Tokenizer;

use super::model::{ModelSpec, Pooling};

/// 单次推理的条数。索引与查询共用；查询只有 1 条，走同一路径。
const BATCH_SIZE: usize = 8;

pub struct Engine {
    // Environment 必须在进程内唯一，且要比 Session 活得久
    _environment: Environment,
    // ort 的 Session::run 需要 &mut self
    session: Mutex<Session>,
    tokenizer: Tokenizer,
    input_names: Vec<String>,
    dim: usize,
    pooling: Pooling,
}

// 全局唯一环境：ONNX Runtime 一个进程只允许创建一次环境
static ENVIRONMENT: Mutex<Option<Environment>> = Mutex::new(None);

fn environment() -> Result<Environment, String> {
    let mut guard = ENVIRONMENT
        .lock()
        .map_err(|_| "ONNX 环境锁被占用".to_string())?;
    if guard.is_none() {
        let env = ort::init()
            .with_name("fastnote")
            .build()
            .map_err(|e| format!("初始化 ONNX Runtime 失败：{e}"))?;
        *guard = Some(env);
    }
    Ok(guard.as_ref().unwrap().clone())
}

impl Engine {
    pub fn load(
        spec: &ModelSpec,
        model_path: &Path,
        tokenizer_path: &Path,
    ) -> Result<Self, String> {
        let environment = environment()?;

        let intra_threads = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 4);

        let mut builder = Session::builder(&environment)
            .map_err(|e| format!("创建推理会话失败：{e}"))?
            .with_optimization_level(GraphOptimizationLevel::Level3)
            .map_err(|e| format!("配置推理会话失败：{e}"))?
            .with_intra_threads(intra_threads)
            .map_err(|e| format!("配置推理线程失败：{e}"))?;

        let session = builder
            .commit_from_file(model_path)
            .map_err(|e| format!("加载模型失败：{e}"))?;

        let input_names = session
            .inputs()
            .iter()
            .map(|outlet| outlet.name().to_string())
            .collect::<Vec<_>>();

        let mut tokenizer =
            Tokenizer::from_file(tokenizer_path).map_err(|e| format!("加载分词器失败：{e}"))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: spec.max_tokens,
                strategy: TruncationStrategy::LongestFirst,
                stride: 0,
                direction: TruncationDirection::Right,
            }))
            .map_err(|e| format!("配置截断失败：{e}"))?;
        tokenizer.with_padding(Some(PaddingParams {
            strategy: PaddingStrategy::BatchLongest,
            direction: PaddingDirection::Right,
            pad_to_multiple_of: None,
            pad_id: 0,
            pad_type_id: 0,
            pad_token: "[PAD]".to_string(),
        }));

        Ok(Self {
            _environment: environment,
            session: Mutex::new(session),
            tokenizer,
            input_names,
            dim: spec.dim,
            pooling: spec.pooling,
        })
    }

    /// 批量嵌入；返回顺序与输入一致，每条向量已做 L2 归一化。
    pub fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let mut out = Vec::with_capacity(texts.len());
        for batch in texts.chunks(BATCH_SIZE) {
            out.extend(self.embed_batch(batch)?);
        }
        Ok(out)
    }

    fn embed_batch(&self, texts: &[String]) -> Result<Vec<Vec<f32>>, String> {
        let encodings = self
            .tokenizer
            .encode_batch(texts.to_vec(), true)
            .map_err(|e| format!("分词失败：{e}"))?;
        if encodings.is_empty() {
            return Ok(Vec::new());
        }

        let batch = encodings.len();
        let seq_len = encodings[0].get_ids().len();
        if seq_len == 0 {
            return Err("分词结果为空".to_string());
        }

        let mut ids: Vec<i64> = Vec::with_capacity(batch * seq_len);
        let mut mask: Vec<i64> = Vec::with_capacity(batch * seq_len);
        let mut type_ids: Vec<i64> = Vec::with_capacity(batch * seq_len);
        for encoding in &encodings {
            if encoding.get_ids().len() != seq_len {
                return Err("同一批次的分词长度不一致（padding 未生效）".to_string());
            }
            ids.extend(encoding.get_ids().iter().map(|v| *v as i64));
            mask.extend(encoding.get_attention_mask().iter().map(|v| *v as i64));
            type_ids.extend(encoding.get_type_ids().iter().map(|v| *v as i64));
        }

        let shape = vec![batch as i64, seq_len as i64];
        // 少数模型（如部分 BERT 变体）会显式要求 position_ids，按行从 0 递增即可
        let position_ids: Vec<i64> = (0..batch)
            .flat_map(|_| 0..seq_len)
            .map(|position| position as i64)
            .collect();
        let mut inputs: Vec<(Cow<'_, str>, Tensor<i64>)> =
            Vec::with_capacity(self.input_names.len());
        for name in &self.input_names {
            let data = match name.as_str() {
                "input_ids" => ids.clone(),
                "attention_mask" => mask.clone(),
                "token_type_ids" => type_ids.clone(),
                "position_ids" => position_ids.clone(),
                other => return Err(format!("模型包含未知输入：{other}")),
            };
            let tensor = Tensor::from_array((shape.clone(), data))
                .map_err(|e| format!("构造输入张量失败：{e}"))?;
            inputs.push((Cow::Owned(name.clone()), tensor));
        }

        let mut session = self
            .session
            .lock()
            .map_err(|_| "推理会话锁被占用".to_string())?;
        let outputs = session.run(inputs).map_err(|e| format!("推理失败：{e}"))?;

        let value = outputs
            .get("last_hidden_state")
            .or_else(|| outputs.get("sentence_embedding"))
            .unwrap_or_else(|| &outputs[0]);
        let (shape, data) = value
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("读取模型输出失败：{e}"))?;
        let dims: &[i64] = shape;

        // sentence_embedding 直接是 [batch, dim]；last_hidden_state 是 [batch, seq, dim]，需要池化
        if dims.len() == 2 {
            let hidden = dims[1] as usize;
            if hidden != self.dim {
                return Err(self.dim_mismatch(hidden));
            }
            if data.len() < batch * hidden {
                return Err("模型输出长度与 batch 不匹配".to_string());
            }
            return Ok((0..batch)
                .map(|index| normalize(data[index * hidden..(index + 1) * hidden].to_vec()))
                .collect());
        }
        if dims.len() != 3 {
            return Err(format!("模型输出维度不符合预期：{dims:?}"));
        }
        let hidden = dims[2] as usize;
        if hidden != self.dim {
            return Err(self.dim_mismatch(hidden));
        }

        let mut vectors = Vec::with_capacity(batch);
        for index in 0..batch {
            let row = index * seq_len * hidden;
            let mut vector = match self.pooling {
                Pooling::Cls => data[row..row + hidden].to_vec(),
                Pooling::Mean => {
                    let mut sum = vec![0f32; hidden];
                    let mut count = 0f32;
                    for token in 0..seq_len {
                        if mask[index * seq_len + token] == 0 {
                            continue;
                        }
                        count += 1.0;
                        let offset = row + token * hidden;
                        for (slot, value) in sum.iter_mut().zip(&data[offset..offset + hidden]) {
                            *slot += *value;
                        }
                    }
                    if count > 0.0 {
                        for value in &mut sum {
                            *value /= count;
                        }
                    }
                    sum
                }
            };
            normalize_in_place(&mut vector);
            vectors.push(vector);
        }
        Ok(vectors)
    }

    fn dim_mismatch(&self, actual: usize) -> String {
        format!(
            "模型输出维度为 {actual}，与预期的 {} 不一致（模型文件与所选模型不匹配）",
            self.dim
        )
    }
}

fn normalize(mut vector: Vec<f32>) -> Vec<f32> {
    normalize_in_place(&mut vector);
    vector
}

fn normalize_in_place(vector: &mut [f32]) {
    let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm > f32::EPSILON {
        for value in vector {
            *value /= norm;
        }
    }
}

/// 真实模型自检（需要先下载模型）：
/// `FASTNOTE_MODEL_DIR=<含 model.onnx 的目录> cargo test --lib semantic::engine -- --ignored --nocapture`
/// 可选 `FASTNOTE_MODEL_ID=<模型 id>`，默认测推荐模型。
#[cfg(test)]
mod tests {
    use super::*;
    use crate::semantic::model;

    fn dot(a: &[f32], b: &[f32]) -> f32 {
        a.iter().zip(b).map(|(x, y)| x * y).sum()
    }

    #[test]
    #[ignore = "需要本地模型文件"]
    fn similar_sentences_score_higher_than_unrelated() {
        let dir = std::env::var("FASTNOTE_MODEL_DIR").expect("设置 FASTNOTE_MODEL_DIR");
        let dir = std::path::Path::new(&dir);
        let spec = std::env::var("FASTNOTE_MODEL_ID")
            .ok()
            .and_then(|id| model::find_builtin(&id))
            .unwrap_or_else(|| model::default_model().clone());
        let engine =
            Engine::load(&spec, &dir.join("model.onnx"), &dir.join("tokenizer.json")).unwrap();

        let vectors = engine
            .embed(&[
                "怎么改善睡眠质量".to_string(),
                "最近总是失眠，凌晨三点还睡不着".to_string(),
                "咖啡因摄入过多会影响睡眠".to_string(),
                "今天股市大跌，科技股领跌".to_string(),
            ])
            .unwrap();

        assert_eq!(vectors.len(), 4);
        for vector in &vectors {
            assert_eq!(vector.len(), spec.dim);
            let norm = vector.iter().map(|v| v * v).sum::<f32>().sqrt();
            assert!((norm - 1.0).abs() < 1e-4, "向量未归一化：{norm}");
        }

        let query = &vectors[0];
        let insomnia = dot(query, &vectors[1]);
        let caffeine = dot(query, &vectors[2]);
        let stock = dot(query, &vectors[3]);
        println!("失眠={insomnia:.4} 咖啡因={caffeine:.4} 股市={stock:.4}");
        // 不同模型（CLS/均值池化、不同维度）的余弦绝对值差异较大，只断言相对差距
        assert!(
            insomnia > stock + 0.2,
            "失眠与无关句区分度不足：{insomnia} vs {stock}"
        );
        assert!(
            caffeine > stock + 0.2,
            "咖啡因与无关句区分度不足：{caffeine} vs {stock}"
        );
        assert!(stock < 0.35, "无关句相似度过高：{stock}");
    }
}
