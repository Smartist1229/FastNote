/**
 * 语义模型的默认选择与内置模型 id 白名单。
 *
 * 必须与 src-tauri/src/semantic/model.rs 的 `builtins()` 保持一致：
 * 前端用它校验库里保存的内置模型值、决定默认项；模型名称、体积等展示信息仍以后端
 * `semantic_status` 返回的清单为准，避免两处各写一份。
 * 本地导入的自定义模型 id 形如 `custom-<16 位十六进制>`，由 store 里的格式规则单独放行。
 */
export const DEFAULT_SEMANTIC_MODEL_ID = "bge-small-zh-v1.5-int8";

export const SEMANTIC_MODEL_IDS = [
  "bge-small-zh-v1.5-int8",
  "bge-base-zh-v1.5-int8",
  "paraphrase-multilingual-MiniLM-L12-v2-int8",
] as const;
