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
  /** 实际分段数：1 表示单流（服务器不支持 Range），>1 表示分片并发 */
  segments: number;
  error: string | null;
}
