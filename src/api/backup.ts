/* 数据备份与恢复：整库导出为 JSON、以及用备份文件覆盖当前数据。 */

import { invoke } from '@tauri-apps/api/core';

import type { BackupSummary } from '@/interface/backup';

/**
 * 把全部数据写入指定路径的 JSON 备份文件。
 * `includeApiKeys` 为 true 时，额外导出**解密后的明文** API Key（请妥善保管该文件）；
 * 为 false 时只保留服务商配置，不含 Key。
 */
export const exportBackup = async (path: string, includeApiKeys: boolean): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_backup', { path, includeApiKeys });
};

/** 用备份文件覆盖当前数据；备份里带明文 Key 时会重新加密入库，同机恢复会保留已填好的 api_key */
export const importBackup = async (path: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_backup', { path });
};
