/**
 * 图片地址解析：把正文里的相对路径换成内核能加载的协议地址。
 *
 * 正文里写的是 `attachments/xx/hash.ext`（相对路径，可移植：把 .md 与 attachments/
 * 一起给 Typora / Obsidian 也能显示），渲染前换成本软件的自定义协议：
 *
 * - Windows / Android（WebView2）：`http://fastnote-asset.localhost/attachments/...`
 * - macOS / Linux / iOS（WKWebView / WebKitGTK）：`fastnote-asset://localhost/attachments/...`
 *
 * 这是 Tauri 对自定义协议的平台封装差异，与 `fastnote-plugin` 完全一致；
 * 协议 handler 只读 URI 的 path，两种形式拿到的都是 `/attachments/xx/hash.ext`。
 *
 * 同一张图的宽高只查一次库，之后走内存缓存：`resolveImage` 必须是同步的，
 * 异步查会逼着预览为每张图处理 Promise。
 */

import type { ImageResolveResult } from "@/markdown-editor";
import { getAttachmentMeta } from "@/api/system/attachments";

/** 附件相对路径（与后端 `parse_rel_path` 同一套规则：2 位分桶 + 16 位哈希 + 图片扩展名） */
const ATTACHMENT_RE = /^attachments\/([0-9a-f]{2})\/([0-9a-f]{16})\.(png|jpe?g|gif|webp|svg)$/i;

/** 正文里所有附件路径（去重，供批量拉元数据用） */
const ATTACHMENT_SCAN_RE = /attachments\/[0-9a-f]{2}\/[0-9a-f]{16}\.(?:png|jpe?g|gif|webp|svg)/gi;

const ASSET_ORIGIN = /Windows|Android/i.test(navigator.userAgent)
  ? "http://fastnote-asset.localhost"
  : "fastnote-asset://localhost";

/** 图片原始像素尺寸缓存：key 是相对路径（一个路径只对应一份内容） */
const sizeCache = new Map<string, { width: number; height: number }>();

/** 本进程里已经查过的路径，避免同一批重复请求 */
const probed = new Set<string>();

/** 是不是本软件的附件相对路径 */
export const isAttachmentPath = (src: string): boolean => ATTACHMENT_RE.test(src);

/** 从一段 Markdown 里收集附件相对路径（去重） */
export const extractAttachmentPaths = (text: string): string[] => {
  if (!text.includes("attachments/")) return [];
  const found = new Set<string>();
  for (const match of text.matchAll(ATTACHMENT_SCAN_RE)) found.add(match[0]);
  return [...found];
};

/** 记下刚保存/刚查到的尺寸，后续渲染直接用（粘贴进来的图不用等第二次渲染） */
export const cacheImageSize = (path: string, width: number, height: number): void => {
  if (width > 0 && height > 0) sizeCache.set(path, { width, height });
};

/**
 * 同步解析图片地址（传给编辑器的 `resolveImage`）。
 *
 * - 附件相对路径 → 自定义协议地址 + 已知宽高（给预览提前占位）
 * - 其它（`https://`、`http://`、`data:`、不认识的相对路径）→ 原样返回
 *
 * 认出是附件但尺寸还没缓存时只返回地址：图片会正常显示，只是没有预先占位。
 */
export const resolveImageSource = (src: string): ImageResolveResult => {
  if (!isAttachmentPath(src)) return src;
  const size = sizeCache.get(src);
  return size ? { src: `${ASSET_ORIGIN}/${src}`, width: size.width, height: size.height } : `${ASSET_ORIGIN}/${src}`;
};

/** 批量补尺寸缓存；返回是否有新数据（宿主据此决定要不要重渲染） */
export const primeAttachmentMeta = async (paths: string[]): Promise<boolean> => {
  const pending = paths.filter((path) => !probed.has(path));
  if (pending.length === 0) return false;
  pending.forEach((path) => probed.add(path));
  const metas = await getAttachmentMeta(pending);
  let filled = false;
  metas.forEach((meta, index) => {
    if (!meta || meta.width <= 0 || meta.height <= 0) return;
    cacheImageSize(pending[index], meta.width, meta.height);
    filled = true;
  });
  return filled;
};
