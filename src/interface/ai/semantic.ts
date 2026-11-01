/**
 * 语义搜索的数据层类型：与 Rust 侧 `semantic::SemanticStatus` / `SemanticHit`
 * 以及三个进度事件一一对应，字段保持 snake_case（不做驼峰转换）。
 */

/** 一个可选模型的静态信息 + 本机安装状态 */
export interface SemanticModelInfo {
  id: string;
  name: string;
  description: string;
  /** 语言标签：中文 / 多语言 */
  tag: string;
  /** 向量维度 */
  dim: number;
  /** 下载体积（两个文件之和，字节） */
  approx_size: number;
  /** 是否为推荐项（默认选中） */
  recommended: boolean;
  /** 是否为本地导入的自定义模型（不可在线下载） */
  custom: boolean;
  /** 文件是否完整可用 */
  installed: boolean;
  /** 本机已占用的字节数；未下载时为 0 */
  installed_size: number;
  /** 该模型的目录绝对路径，供离线用户手动放文件 */
  dir: string;
}

/** `semantic_status` 的返回：模型与索引的当前状态，设置面板据此决定显示哪些按钮 */
export interface SemanticStatus {
  /** 设置项 app.config.general.semanticSearch 是否开启 */
  enabled: boolean;
  /** 当前选中的模型 id（app.config.general.semanticModel） */
  selected_model: string;
  /** 选中模型的文件是否完整可用（只看文件，不加载推理引擎） */
  model_ready: boolean;
  /** 选中模型已下载的字节数 */
  model_size: number;
  /** 选中模型的目录绝对路径 */
  model_dir: string;
  /** 是否有下载任务在跑 */
  downloading: boolean;
  /** 正在下载的模型 id；空闲时为 null */
  downloading_model: string | null;
  /** 是否正在建索引 */
  indexing: boolean;
  /** 未删除笔记总数 */
  total_notes: number;
  /** 已用当前模型索引的笔记数 */
  indexed_notes: number;
  /** 当前模型的块数 */
  total_chunks: number;
  /** 当前模型的向量维度 */
  dim: number;
  /** 最近一次索引/下载失败的原因；成功后不清除，便于排查 */
  last_error: string | null;
  /** 全部可选模型及其安装状态 */
  models: SemanticModelInfo[];
}

/** 一条语义命中：一个笔记取它得分最高的块 */
export interface SemanticHit {
  note_id: number;
  /** 余弦相似度（向量已归一化，即点积），越大越相关 */
  score: number;
  /** 命中块在笔记内的序号（从 0 开始） */
  chunk_seq: number;
  /** 命中块折叠空白后截断的片段，可直接展示 */
  snippet: string;
}

/** `semantic_import_model` 的入参：从本地目录导入自定义模型 */
export interface SemanticImportInput {
  /** 含 model.onnx 与 tokenizer.json 的目录绝对路径 */
  sourceDir: string;
  name: string;
  /** 向量维度，16–4096 */
  dim: number;
  /** 最大 token 数，8–4096 */
  maxTokens: number;
  /** cls=首 token；mean=有效 token 平均 */
  pooling: "cls" | "mean";
  /** 相似度阈值，0.05–0.95；不传用默认 0.35 */
  minScore?: number;
}

/** `semantic-model-progress` 事件负载 */
export interface SemanticModelProgress {
  /** 产生进度的模型 id */
  model_id: string;
  /**
   * download=传输中 / verify=文件已下载、正在推理自检 /
   * done=全部完成 / error=失败
   */
  stage: "download" | "verify" | "done" | "error";
  downloaded: number;
  total: number;
  /** 并发连接数：1 表示单流（服务器不支持 Range），>1 表示分片并发；verify/done 为 0 */
  segments: number;
  error: string | null;
}

/** `semantic-index-progress` 事件负载 */
export interface SemanticIndexProgress {
  done: number;
  total: number;
  running: boolean;
  error: string | null;
}

/** `semantic-index-done` 事件负载：一轮索引结束时的最终计数 */
export interface SemanticIndexDone {
  indexed: number;
  chunks: number;
}
