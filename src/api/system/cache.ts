/**
 * 设置 · 清理相关命令的封装：语义索引缓存与临时残留。
 *
 * 两者都是**可重建的派生数据**，删了不丢笔记；代价是语义索引要重新推理一遍。
 * 真正的清理语义（宽限期、VACUUM、哪些临时文件算残留）全在 Rust 侧，
 * 这里不做二次判断，避免前后端各有一套「什么算缓存」的口径。
 */

import { invoke } from "@tauri-apps/api/core";

export interface CacheUsage {
  /** 数据库主文件大小 */
  dbBytes: number;
  /** 向量索引占的字节 */
  indexBytes: number;
  /** 向量索引的分块数 */
  indexChunks: number;
  /** 临时目录里可清理的残留体积 */
  tempBytes: number;
  /** 临时目录里可清理的条目数 */
  tempFiles: number;
}

export interface CacheClearReport {
  indexChunks: number;
  indexBytes: number;
  /** VACUUM 之后数据库实际缩小的字节数 */
  dbFreed: number;
  tempFiles: number;
  tempFreed: number;
}

/** 当前缓存占用 */
export const cacheUsage = async (): Promise<CacheUsage> => {
  return await invoke<CacheUsage>("cache_usage");
};

/** 清空向量索引与临时残留；大库上要几秒，命令本身是异步的 */
export const clearCache = async (): Promise<CacheClearReport> => {
  return await invoke<CacheClearReport>("clear_cache");
};

/* ---------------- WebView2 缓存 ---------------- */

/**
 * 软件里每个网页视图都是一份 WebView2 profile：主窗口一份，内置浏览器的
 * 网页 / 工具栏 / 下载面板 / 插件窗口各一份。这里统计的是 profile 里的**纯缓存**
 * （Cache、Code Cache、GPU 缓存），站点数据单独给一个数字。
 */
export interface WebviewUsage {
  /** 主窗口 profile 里可清的纯缓存（界面自己的） */
  appBytes: number;
  /** 内置浏览器一组 profile 的纯缓存 */
  browserBytes: number;
  /** 内置浏览器的站点数据（Cookie / LocalStorage / IndexedDB） */
  siteBytes: number;
  /** 有上次没清完、等下次启动的登记 */
  pending: boolean;
}

export interface WebviewCleanReport {
  /** 本次实际释放的字节 */
  freed: number;
  /** 其中属于站点数据的部分 */
  siteFreed: number;
  /** 还有残留，已登记下次启动清理 */
  pending: boolean;
}

export const webviewUsage = async (): Promise<WebviewUsage> => {
  return await invoke<WebviewUsage>("webview_usage");
};

/**
 * `sites` 为 false 时只清纯缓存，不动任何登录态；
 * 为 true 时连内置浏览器的 Cookie / LocalStorage / IndexedDB 一起清。
 * 主窗口的站点数据在两边都不会被删——那里存着主题快照与语言包缓存。
 */
export const cleanWebviewCache = async (sites: boolean): Promise<WebviewCleanReport> => {
  return await invoke<WebviewCleanReport>("clean_webview_cache", { sites });
};
