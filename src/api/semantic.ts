/**
 * 语义搜索前端 API 层：状态查询、模型下载/删除、索引重建/取消、向量检索。
 *
 * 均为 Tauri invoke 薄封装；失败语义：
 * - 模型未下载时 `semanticSearch` 会 reject「语义模型尚未下载」，调用方按空结果处理即可；
 * - `semantic_download_model` 只负责启动后台任务，立刻 resolve，进度靠事件；
 * - 下载与索引进度事件名固定，统一在这里封装 listen，避免各处拼字符串。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type {
  SemanticHit,
  SemanticImportInput,
  SemanticIndexDone,
  SemanticIndexProgress,
  SemanticModelProgress,
  SemanticStatus,
} from '@/interface/semantic';

/** 查询模型与索引状态（semantic_status），不触发模型加载 */
export const getSemanticStatus = async (): Promise<SemanticStatus> => {
  return await invoke('semantic_status');
};

/**
 * 启动指定模型的下载（semantic_download_model）：立刻返回，进度走 `semantic-model-progress`。
 * 同一时间只允许一个下载任务；下载失败后 Rust 侧会删除残缺文件并写入 last_error。
 */
export const downloadSemanticModel = async (modelId: string): Promise<void> => {
  return await invoke('semantic_download_model', { modelId });
};

/** 删除指定模型文件（semantic_delete_model）；删除当前模型会一并清空全部向量 */
export const deleteSemanticModel = async (modelId: string): Promise<void> => {
  return await invoke('semantic_delete_model', { modelId });
};

/**
 * 从本地目录导入自定义模型（semantic_import_model），返回新模型 id。
 * 后端会复制文件、计算哈希并用填写的元数据跑一次推理自检；
 * 命令会等到校验结束才 resolve，失败时不会留下半成品目录。
 */
export const importSemanticModel = async (input: SemanticImportInput): Promise<string> => {
  return await invoke('semantic_import_model', {
    sourceDir: input.sourceDir,
    name: input.name,
    dim: input.dim,
    maxTokens: input.maxTokens,
    pooling: input.pooling,
    minScore: input.minScore,
  });
};

/** 清空索引，交给后台 worker 全量重建（semantic_rebuild_index） */
export const rebuildSemanticIndex = async (): Promise<void> => {
  return await invoke('semantic_rebuild_index');
};

/** 取消当前这一轮索引（semantic_cancel_index）；已写入的块保留 */
export const cancelSemanticIndex = async (): Promise<void> => {
  return await invoke('semantic_cancel_index');
};

/**
 * 语义检索（semantic_search）。
 *
 * @param query 自然语言查询
 * @param limit 返回条数上限（1–50，默认 15）
 * @param noteIds 只在这些笔记里检索；AI 工具必须传可见笔记 id，权限过滤在 Rust 侧完成
 */
export const semanticSearch = async (
  query: string,
  limit = 15,
  noteIds?: number[],
): Promise<SemanticHit[]> => {
  return await invoke('semantic_search', { query, limit, noteIds });
};

/** 订阅模型下载进度；返回取消订阅函数 */
export const onSemanticModelProgress = async (
  handler: (progress: SemanticModelProgress) => void,
): Promise<UnlistenFn> => {
  return await listen<SemanticModelProgress>('semantic-model-progress', (event) => handler(event.payload));
};

/** 订阅索引进度；返回取消订阅函数 */
export const onSemanticIndexProgress = async (
  handler: (progress: SemanticIndexProgress) => void,
): Promise<UnlistenFn> => {
  return await listen<SemanticIndexProgress>('semantic-index-progress', (event) => handler(event.payload));
};

/** 订阅「一轮索引结束」事件；返回取消订阅函数 */
export const onSemanticIndexDone = async (
  handler: (done: SemanticIndexDone) => void,
): Promise<UnlistenFn> => {
  return await listen<SemanticIndexDone>('semantic-index-done', (event) => handler(event.payload));
};
