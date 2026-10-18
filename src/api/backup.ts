/**
 * 数据备份/恢复前端 API 层（export_backup / import_backup）。
 * 备份是带 format 标记的 JSON；恢复为覆盖式：事务内清空各表后按备份写回。
 * 两个命令都返回 BackupSummary，失败以字符串 reject。
 */

import { invoke } from '@tauri-apps/api/core';

import type { BackupSummary } from '@/interface/backup';

/**
 * 导出整库到指定路径（export_backup），返回统计 BackupSummary。
 * `includeApiKeys` 为 true 时，额外导出**解密后的明文** API Key（文件需妥善保管）；
 * 为 false 时只保留服务商配置，不含 Key。
 */
export const exportBackup = async (path: string, includeApiKeys: boolean): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_backup', { path, includeApiKeys });
};

/**
 * 用备份覆盖当前数据（import_backup），返回恢复后的统计。
 * 备份带明文 Key 时会重新加密入库；未带 Key 的同机恢复会按「名称+类型+地址」接回原 Key。
 */
export const importBackup = async (path: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_backup', { path });
};
