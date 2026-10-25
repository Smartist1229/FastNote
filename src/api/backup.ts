/**
 * 数据备份/恢复前端 API 层。
 *
 * 两种格式：
 *   - JSON（export_backup / import_backup）：带 format 标记，字段级兼容旧版本，适合换机迁移；
 *   - SQLite（export_sqlite_backup / import_sqlite_backup）：整库快照，本机备份恢复更快。
 * 恢复都是覆盖式：事务内清空各表后按备份写回；失败以字符串 reject。
 */

import { invoke } from '@tauri-apps/api/core';

import type { BackupSummary } from '@/interface/backup';

/**
 * 导出整库到指定路径（export_backup），返回统计 BackupSummary。
 * `includeApiKeys` 为 true 时，额外导出**解密后的明文** API Key（文件需妥善保管）；
 * 为 false 时只保留服务商配置，不含 Key。
 * `includeWebdav` 为 true 时一并导出 WebDAV 配置（密码为明文），默认完全不含。
 */
export const exportBackup = async (
  path: string,
  includeApiKeys: boolean,
  includeWebdav: boolean,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_backup', { path, includeApiKeys, includeWebdav });
};

/**
 * 用 JSON 备份覆盖当前数据（import_backup），返回恢复后的统计。
 * 备份带明文 Key 时会重新加密入库；未带 Key 的同机恢复会按「名称+类型+地址」接回原 Key。
 */
export const importBackup = async (path: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_backup', { path });
};

/**
 * 导出为 SQLite 数据库快照（export_sqlite_backup）。
 * `includeApiKeys` 为 true 时保留本机加密值（密钥文件不随备份走，换机可能无法解密）；
 * 为 false 时快照里的 api_key 全部清空。
 * `includeWebdav` 为 true 时保留 WebDAV 配置（密码同样为本机密文）。
 */
export const exportSqliteBackup = async (
  path: string,
  includeApiKeys: boolean,
  includeWebdav: boolean,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_sqlite_backup', { path, includeApiKeys, includeWebdav });
};

/**
 * 用 SQLite 快照覆盖当前数据（import_sqlite_backup）。
 * 快照必须带 FastNote 备份标记；无 Key 或解不开时会沿用本机同名服务商的 Key。
 */
export const importSqliteBackup = async (path: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_sqlite_backup', { path });
};
