/**
 * WebDAV 云备份前端 API 层。
 *
 * 服务器 / 账号 / 文件夹等配置仍走 appSettingsStore，这里只负责：
 * 保存密码（单独加密入库）、测试连接、手动备份、云端与本地备份列表、恢复。
 * 自动备份由 Rust 后台任务按 `app.config.webdav.*` 自行轮询，前端只需读写设置。
 */

import { invoke } from '@tauri-apps/api/core';

import type { BackupSummary } from '@/interface/backup';

/** webdav_status：密码是否已保存、最近一次自动备份结果、本地备份目录 */
export interface WebdavStatus {
  has_password: boolean;
  last_backup_at: string | null;
  last_error: string | null;
  last_file: string | null;
  backup_dir: string;
}

/** 云端 / 本地备份文件条目 */
export interface BackupFileEntry {
  name: string;
  size: number;
  /** ISO 字符串；服务器未给出时为 '' */
  modified: string;
}

/** webdav_backup：上传后的文件名与备份统计 */
export interface CloudBackupResult {
  file: string;
  summary: BackupSummary;
}

/** 读取自动备份状态（webdav_status） */
export const getWebdavStatus = async (): Promise<WebdavStatus> => {
  return await invoke<WebdavStatus>('webdav_status');
};

/** 保存 WebDAV 密码（webdav_set_password）；传空串表示清除 */
export const setWebdavPassword = async (password: string): Promise<void> => {
  return await invoke('webdav_set_password', { password });
};

/**
 * 测试连接（webdav_test）。
 * 参数有值就覆盖库里已保存的配置，方便「还没保存就先测一下」；
 * 成功后云端文件夹已创建并验证可读，返回服务器上的完整路径。
 */
export const testWebdav = async (config: {
  server?: string;
  username?: string;
  password?: string;
  folder?: string;
}): Promise<string> => {
  return await invoke<string>('webdav_test', config);
};

/** 手动备份到云端（webdav_backup）；两个开关决定备份是否包含 API Key 与 WebDAV 配置 */
export const backupToWebdav = async (
  includeApiKeys: boolean,
  includeWebdav: boolean,
): Promise<CloudBackupResult> => {
  return await invoke<CloudBackupResult>('webdav_backup', { includeApiKeys, includeWebdav });
};

/** 获取云端备份列表（webdav_list_remote），按修改时间倒序 */
export const listRemoteBackups = async (): Promise<BackupFileEntry[]> => {
  return await invoke<BackupFileEntry[]>('webdav_list_remote');
};

/** 从云端下载指定备份并覆盖恢复（webdav_restore_remote） */
export const restoreRemoteBackup = async (name: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('webdav_restore_remote', { name });
};

/** 获取本地备份目录里的备份列表（webdav_list_local），按修改时间倒序 */
export const listLocalBackups = async (): Promise<BackupFileEntry[]> => {
  return await invoke<BackupFileEntry[]>('webdav_list_local');
};

/** 从本地备份目录恢复（webdav_restore_local）；按扩展名分派 JSON / SQLite */
export const restoreLocalBackup = async (name: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('webdav_restore_local', { name });
};

/** 读取本地自动备份目录（webdav_backup_dir） */
export const getBackupDir = async (): Promise<string> => {
  return await invoke<string>('webdav_backup_dir');
};
