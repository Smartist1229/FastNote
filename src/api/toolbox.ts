/**
 * 工具箱 API 层：通用下载工具。
 *
 * `toolbox_download` 只负责启动后台任务，立即 resolve；进度靠事件推送。
 */

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

import type { ToolboxDownloadProgress } from '@/interface/toolbox';

/** 下载进度的数据结构由下载模块统一导出，界面直接引用，避免两边各写一份 */
export type { ToolboxDownloadProgress, ToolboxSegmentProgress } from '@/interface/toolbox';

/** 默认下载目录（安装目录下的 download，不可写时退回应用数据目录） */
export const getDownloadDir = async (): Promise<string> => {
  return await invoke('toolbox_download_dir');
};

/** 启动下载：只接受 http/https 链接；同一时间只允许一个任务。filename 留空时按链接自动取名 */
export const startDownload = async (url: string, filename?: string): Promise<void> => {
  return await invoke('toolbox_download', { url, filename: filename || null });
};

/** 取消当前下载；没有进行中的任务时返回 false */
export const cancelDownload = async (): Promise<boolean> => {
  return await invoke('toolbox_download_cancel');
};

/** 订阅下载进度；返回取消订阅函数 */
export const onDownloadProgress = async (
  handler: (progress: ToolboxDownloadProgress) => void,
): Promise<UnlistenFn> => {
  return await listen<ToolboxDownloadProgress>('toolbox-download-progress', (event) =>
    handler(event.payload),
  );
};
