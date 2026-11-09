/**
 * 数据备份/恢复前端 API 层。
 *
 * 三种格式：
 *   - JSON（export_backup / import_backup）：带 format 标记，字段级兼容旧版本，适合换机迁移；
 *   - SQLite（export_sqlite_backup / import_sqlite_backup）：整库快照，本机备份恢复更快；
 *   - 加密容器（export_encrypted_backup / import_encrypted_backup）：整库快照
 *     用独立备份口令再加密一层，含加密笔记与密钥元数据，文件本身是密文。
 * 恢复都是覆盖式：事务内清空各表后按备份写回；失败以字符串 reject。
 */

import { invoke } from '@tauri-apps/api/core';

import type {
  BackupPreflight,
  BackupSelection,
  BackupSummary,
} from '@/interface/settings/backup';

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
  includeEncrypted = true,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_sqlite_backup', {
    path,
    includeApiKeys,
    includeWebdav,
    includeEncrypted,
  });
};

/**
 * 用 SQLite 快照覆盖当前数据（import_sqlite_backup）。
 * 快照必须带 FastNote 备份标记；无 Key 或解不开时会沿用本机同名服务商的 Key。
 */
export const importSqliteBackup = async (path: string): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_sqlite_backup', { path });
};

/**
 * 导出加密备份容器（export_encrypted_backup）。
 * 内容是一份**完整**的整库快照（含加密笔记、密钥元数据、根密码元数据、API Key 与 WebDAV 配置），
 * 用独立备份口令 Argon2id + AES-256-GCM 包成密文文件（.fnbak），口令本身不落盘、不进文件。
 */
export const exportEncryptedBackup = async (
  path: string,
  passphrase: string,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('export_encrypted_backup', { path, passphrase });
};

/**
 * 用加密备份容器覆盖当前数据（import_encrypted_backup）。
 * 口令错误或文件被篡改时以 `{"code":"bad_backup_passphrase"}` 拒绝；
 * 恢复后加密笔记仍是密文，需要各自密码或根密码解锁。
 */
export const importEncryptedBackup = async (
  path: string,
  passphrase: string,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_encrypted_backup', { path, passphrase });
};

/**
 * 恢复前预检（preflight_backup）：只读扫描备份，返回「有多少东西 / 和本地冲突几条」。
 *
 * 不写任何数据。界面上先展示这份摘要，用户勾选之后才真正恢复。
 */
export const preflightBackup = async (path: string): Promise<BackupPreflight> => {
  return await invoke<BackupPreflight>('preflight_backup', { path });
};

/**
 * 按勾选恢复（import_backup_selected）：**合并**语义，只写选中分区。
 *
 * 与 `importBackup`（清表重建）的区别：本地多出来的内容根本不会被碰，
 * 所以不需要恢复前快照兜底，也不会出现「恢复后本地笔记少了几篇」。
 */
export const importBackupSelected = async (
  path: string,
  selection: BackupSelection,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_backup_selected', { path, selection });
};

/**
 * 校验「原设备根密码」是否与备份里的根密码材料吻合（verify_backup_root_password）。
 *
 * 只算不写：失败时本机根密码状态完全不受影响。用于换机恢复前先证明密码正确。
 */
export const verifyBackupRootPassword = async (
  path: string,
  password: string,
): Promise<void> => {
  await invoke('verify_backup_root_password', { path, password });
};

/**
 * 采纳备份里的根密码材料（import_backup_root_key）。
 *
 * 笔记密文与 encrypted_keys 在恢复时已入库，写完之后本机就能用原设备根密码解开它们。
 * `allowReplace` 为 false 时本地已有根密码会被拒绝——替换会让本机原有加密笔记全部失效。
 */
export const importBackupRootKey = async (
  path: string,
  password: string,
  allowReplace: boolean,
): Promise<{ replaced: boolean }> => {
  return await invoke<{ replaced: boolean }>('import_backup_root_key', {
    path,
    password,
    allowReplace,
  });
};

/**
 * SQLite 快照的预检（preflight_sqlite_backup）。
 *
 * 与 JSON 版返回同一份结构：快照会被读成与 JSON 备份同构的数据再统计，
 * 所以恢复时两种格式的选择语义完全一致。
 */
export const preflightSqliteBackup = async (path: string): Promise<BackupPreflight> => {
  return await invoke<BackupPreflight>('preflight_sqlite_backup', { path });
};

/**
 * SQLite 快照的按勾选恢复（import_sqlite_selected）。
 *
 * 与 `importSqliteBackup`（整库替换）的区别：只写选中分区，本地独有的内容一条不删。
 */
export const importSqliteSelected = async (
  path: string,
  selection: BackupSelection,
): Promise<BackupSummary> => {
  return await invoke<BackupSummary>('import_sqlite_selected', { path, selection });
};

/**
 * 把备份里的根密钥迁移到本机根密码（migrate_backup_root_wrap）。
 *
 * 备份里的 `wrap_root` 是**原设备根密码**包的；本机根密码换过之后，
 * 直接用新密码解不开（只能退回用每篇笔记自己的密码）。这个命令用旧密码解开 DEK、
 * 再用本机 KEK 重新包回去，之后一把根密码就能全部打开。返回迁移的条数。
 */
export const migrateBackupRootWrap = async (
  path: string,
  oldPassword: string,
  newPassword: string,
): Promise<number> => {
  const res = await invoke<{ migrated: number }>('migrate_backup_root_wrap', {
    path,
    oldPassword,
    newPassword,
  });
  return res.migrated;
};
