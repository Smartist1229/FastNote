/** 单个分片（= 一个下载线程正在负责的片段）的实时进度。 */
export interface ToolboxSegmentProgress {
  /** 分片序号，从 0 开始 */
  index: number;
  /** 分片在文件中的起始字节（含） */
  start: number;
  /** 分片在文件中的结束字节（含） */
  end: number;
  /** 本片已下载字节 */
  downloaded: number;
  /** 本片总字节 */
  total: number;
  /** 本片当前速度（字节/秒） */
  speed: number;
}

/** `toolbox-download-progress` 事件负载：工具箱下载任务的状态与进度。 */
export interface ToolboxDownloadProgress {
  /** download=传输中 / done=完成 / cancelled=已取消 / error=失败 */
  stage: "download" | "done" | "cancelled" | "error";
  /** 保存到磁盘的文件名（后端已处理重名与非法字符） */
  filename: string;
  /** 最终文件路径；失败时可能为空 */
  path: string;
  downloaded: number;
  /** 总字节数；0 表示服务器没给 Content-Length，进度未知 */
  total: number;
  /** 并发连接数：1 表示单流（服务器不支持 Range） */
  segments: number;
  /** 正在进行的分片；下载完的分片会从列表里移除，由下一个分片补位 */
  segment_progress: ToolboxSegmentProgress[];
  /** 已用时（毫秒），从开始传输算起，由后端计时；界面重开不会归零 */
  elapsed: number;
  error: string | null;
}
