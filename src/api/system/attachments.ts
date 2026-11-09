/**
 * 笔记内图片 API：保存 / 查元数据 / 占用统计 / 回收。
 *
 * 为什么字节走 IPC 的 **raw body**：`invoke(cmd, new Uint8Array(...))` 只有把整个
 * payload 当二进制传时才不经过 JSON。若把字节塞进参数对象，序列化结果会是
 * `[137,80,78,71,...]` 这样的数字数组——一张 5 MB 截图膨胀成几十 MB 文本，
 * 解析开销与两侧内存峰值都不可接受。mime 与像素宽高改放在请求头里。
 */

import { invoke } from "@tauri-apps/api/core";

/** 落盘后的图片元数据（`path` 就是写进 Markdown 的相对路径） */
export interface AttachmentMeta {
  hash: string;
  /** `attachments/xx/hash.ext` */
  path: string;
  mime: string;
  bytes: number;
  width: number;
  height: number;
}

export interface AttachmentUsage {
  count: number;
  bytes: number;
}

export interface AttachmentGcReport {
  removed: number;
  freed: number;
}

/**
 * 读图片原始像素尺寸。
 *
 * 优先 `createImageBitmap`（不产生 DOM、可立刻释放）；不支持时回落到 `<img>`。
 * SVG 在没有固有尺寸时可能两边都拿不到，返回 0 由调用方兜底（渲染时就不预占位）。
 */
const readImageSize = async (blob: Blob): Promise<{ width: number; height: number }> => {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (size.width > 0 && size.height > 0) return size;
    } catch {
      // 回落到 <img> 分支
    }
  }
  return await new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const image = new Image();
    const done = (width: number, height: number) => {
      URL.revokeObjectURL(url);
      resolve({ width, height });
    };
    image.onload = () => done(image.naturalWidth, image.naturalHeight);
    image.onerror = () => done(0, 0);
    image.src = url;
  });
};

/** 保存一张图片，返回可写进 Markdown 的相对路径与元数据 */
export const saveAttachment = async (file: Blob): Promise<AttachmentMeta> => {
  const { width, height } = await readImageSize(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = file.type || "image/png";
  return await invoke<AttachmentMeta>("save_attachment", bytes, {
    headers: {
      "x-image-mime": mime,
      "x-image-width": String(width),
      "x-image-height": String(height),
    },
  });
};

/** 批量查元数据：预览按宽高提前占位，避免图片解码完把行高撑开 */
export const getAttachmentMeta = async (paths: string[]): Promise<Array<AttachmentMeta | null>> => {
  if (paths.length === 0) return [];
  return await invoke<Array<AttachmentMeta | null>>("get_attachment_meta", { paths });
};

/** 占用统计（设置页展示） */
export const attachmentsUsage = async (): Promise<AttachmentUsage> => {
  return await invoke<AttachmentUsage>("attachments_usage");
};

/** 回收未引用的图片；默认宽限 7 天（撤销 / 备份未完成时不至于被误删） */
export const gcAttachments = async (graceDays = 7): Promise<AttachmentGcReport> => {
  return await invoke<AttachmentGcReport>("gc_attachments", { graceDays });
};
