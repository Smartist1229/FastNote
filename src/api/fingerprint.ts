/**
 * 浏览器指纹 API 层。
 *
 * 指纹在 Rust 进程内只生成一次，这里每次调用拿到的都是同一份。
 */

import { invoke } from '@tauri-apps/api/core';

import type { BrowserFingerprint } from '@/interface/fingerprint';

/** 获取当前进程使用的完整仿真指纹（fingerprint_info） */
export const getFingerprint = async (): Promise<BrowserFingerprint> => {
  return await invoke<BrowserFingerprint>('fingerprint_info');
};
