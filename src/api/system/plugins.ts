/**
 * 插件系统 API 层：已安装列表、zip 安装、卸载、资源读取与插件目录。
 *
 * 均为 Tauri invoke 薄封装；安装/卸载失败以字符串 reject，由调用方 toast。
 * 插件文件在 <exe 同级>/plugin/<dirName>/ 下，前端只认 dirName 这个实例键。
 */

import { invoke } from '@tauri-apps/api/core';

import { openAppFolder } from '@/api/system/system';
import type { PluginManifest } from '@/interface/system/plugins';

export type { PluginManifest } from '@/interface/system/plugins';

/** 列出已安装插件（plugin_list_installed）：扫描 plugin/ 下每个子目录的 plugin.json */
export const listInstalledPlugins = async (): Promise<PluginManifest[]> => {
  return await invoke('plugin_list_installed');
};

/** 安装插件包（plugin_install_zip）：按目录规则落盘，返回带 dirName 的清单。
 * skipConfirm 为 true 时跳过权限白名单校验（内部可信场景用）；默认严格校验。
 * 设置页的对外安装流程不要传这个参数，让默认值生效。 */
export const installPluginZip = async (
  zipPath: string,
  skipConfirm?: boolean,
): Promise<PluginManifest> => {
  return await invoke('plugin_install_zip', { zipPath, skipConfirm });
};

/** 卸载插件（plugin_uninstall）：删除 plugin/<dirName>/ 目录 */
export const uninstallPlugin = async (dirName: string): Promise<void> => {
  return await invoke('plugin_uninstall', { dirName });
};

/** 读取插件目录内的文本资源（plugin_read_resource），如 style.css */
export const readPluginResource = async (dirName: string, relPath: string): Promise<string> => {
  return await invoke('plugin_read_resource', { dirName, relPath });
};

/**
 * 生成插件模块的完整协议 URL（plugin_module_url）：
 * Windows / Android 为 http://fastnote-plugin.localhost/<dirName>/<path>，
 * macOS / Linux 为 fastnote-plugin://localhost/<dirName>/<path>。
 * 动态 import 该 URL 时，模块内的相对路径 import 由浏览器原生解析到同协议下，
 * 插件因此可以拆成多文件 ESM。
 */
export const pluginModuleUrl = async (
  dirName: string,
  relPath: string,
  version?: number,
): Promise<string> => {
  return await invoke('plugin_module_url', { dirName, relPath, version: version ?? null });
};

/**
 * 读取插件配置（plugin_read_config）：返回 schema 默认值与已保存值合并后的对象。
 * 后端不做文件校验之外的兜底，调用方仍需处理失败。
 */
export const readPluginConfig = async (dirName: string): Promise<Record<string, unknown>> => {
  return await invoke('plugin_read_config', { dirName });
};

/**
 * 写入插件配置（plugin_write_config）：后端按 schema 过滤并与已有配置浅合并，
 * 因此可以只传改动项；传全量同样安全。
 */
export const writePluginConfig = async (
  dirName: string,
  config: Record<string, unknown>,
): Promise<void> => {
  await invoke('plugin_write_config', { dirName, config });
};

/** 插件目录路径（plugin_folder_path） */
export const pluginFolderPath = async (): Promise<string> => {
  return await invoke('plugin_folder_path');
};

/** 在文件管理器中打开插件文件夹（路径由后端给出，再走已有的 open_app_folder） */
export const openPluginFolder = async (): Promise<void> => {
  const path = await pluginFolderPath();
  await openAppFolder(path);
};

/**
 * 安装 / 覆盖内置演示插件（plugin_install_demo）。
 * 设置页的「安装演示插件」按钮走它；开发预览下「刷新」也会调用来同步演示插件。
 * 无条件写一份最新的，插件自己的 config.json 保留。
 */
export const installDemoPlugin = async (): Promise<void> => {
  await invoke('plugin_install_demo');
};

/* ---------------- 插件私有表（plugin_db_*） ----------------
 * 表名由插件写裸名（records），后端强制加 plugin_<目录名>__ 前缀，
 * 所以插件只能碰自己建的表；宿主表与其它插件的表都够不到。
 */

/** 建表列定义：kind 只认 text / integer / real */
export interface PluginDbColumn {
  name: string;
  kind: 'text' | 'integer' | 'real';
}

/** 查询参数：等值过滤 + 排序 + 分页 */
export interface PluginDbQueryOptions {
  filter?: Record<string, unknown>;
  orderBy?: string;
  /** 默认 true（新的在前） */
  descending?: boolean;
  /** 默认 200，上限 1000 */
  limit?: number;
  offset?: number;
}

/** 建表（幂等）：已存在时不动 */
export const pluginDbCreateTable = async (
  dirName: string,
  table: string,
  columns: PluginDbColumn[],
): Promise<void> => {
  await invoke('plugin_db_create_table', { dirName, table, columns });
};

/** 删表（只删本插件的表） */
export const pluginDbDropTable = async (dirName: string, table: string): Promise<void> => {
  await invoke('plugin_db_drop_table', { dirName, table });
};

/** 列出本插件自己的表（裸名） */
export const pluginDbTables = async (dirName: string): Promise<string[]> => {
  return await invoke('plugin_db_tables', { dirName });
};

/** 插入一行，返回新行 id */
export const pluginDbInsert = async (
  dirName: string,
  table: string,
  values: Record<string, unknown>,
): Promise<number> => {
  return await invoke('plugin_db_insert', { dirName, table, values });
};

/** 查询，返回对象数组 */
export const pluginDbQuery = async (
  dirName: string,
  table: string,
  options?: PluginDbQueryOptions,
): Promise<Record<string, unknown>[]> => {
  return await invoke('plugin_db_query', {
    dirName,
    table,
    filter: options?.filter ?? null,
    orderBy: options?.orderBy ?? null,
    descending: options?.descending ?? null,
    limit: options?.limit ?? null,
    offset: options?.offset ?? null,
  });
};

/** 更新（必须带 filter），返回影响行数 */
export const pluginDbUpdate = async (
  dirName: string,
  table: string,
  filter: Record<string, unknown>,
  values: Record<string, unknown>,
): Promise<number> => {
  return await invoke('plugin_db_update', { dirName, table, filter, values });
};

/** 删除（必须带 filter），返回影响行数 */
export const pluginDbDelete = async (
  dirName: string,
  table: string,
  filter: Record<string, unknown>,
): Promise<number> => {
  return await invoke('plugin_db_delete', { dirName, table, filter });
};

/* ---------------- 插件窗口（plugin_*_window*） ---------------- */

/** 用插件目录里的文件开一个独立窗口，返回窗口标签 */
export const openPluginWindow = async (
  dirName: string,
  relPath: string,
  options?: { title?: string; width?: number; height?: number },
): Promise<string> => {
  return await invoke('plugin_open_window', {
    dirName,
    relPath,
    title: options?.title ?? null,
    width: options?.width ?? null,
    height: options?.height ?? null,
  });
};

/**
 * 关掉某个插件窗口。label 是窗口标签（`plugin-<目录名>-<序号>`）：
 * 插件窗口外壳从 `__TAURI_INTERNALS__.metadata.currentWindow.label` 取自己的标签传进来。
 */
export const closePluginWindow = async (dirName: string, label: string): Promise<void> => {
  await invoke('plugin_close_window', { dirName, label });
};

/**
 * 请求宿主重新激活某个插件（plugin_reactivate → 主窗口收到事件后重跑 activate）。
 * 插件在自己的窗口里改了数据（快捷键、菜单项等）之后调用，注册类副作用才会用上新值。
 */
export const reactivatePlugin = async (dirName: string): Promise<void> => {
  await invoke('plugin_reactivate', { dirName });
};

/** 删除某个插件的全部私有表（卸载时用户选择「删除表」），返回删掉的表数 */
export const pluginDbDropAll = async (dirName: string): Promise<number> => {
  return await invoke('plugin_db_drop_all', { dirName });
};

/** 关掉某个插件打开的所有窗口（插件停用 / 卸载时宿主调用） */
export const closePluginWindows = async (dirName: string): Promise<void> => {
  await invoke('plugin_close_windows', { dirName });
};

/* ---------------- 私有表扩展（count / addColumn / createIndex） ---------------- */

/** 统计行数（不把数据拉回前端） */
export const pluginDbCount = async (
  dirName: string,
  table: string,
  filter?: Record<string, unknown>,
): Promise<number> => {
  return await invoke('plugin_db_count', { dirName, table, filter: filter ?? null });
};

/** 加一列（迁移用，幂等）：true = 这次真的加了 */
export const pluginDbAddColumn = async (
  dirName: string,
  table: string,
  column: PluginDbColumn,
): Promise<boolean> => {
  return await invoke('plugin_db_add_column', { dirName, table, column });
};

/** 建索引（幂等） */
export const pluginDbCreateIndex = async (
  dirName: string,
  table: string,
  name: string,
  columns: string[],
  unique = false,
): Promise<void> => {
  await invoke('plugin_db_create_index', { dirName, table, name, columns, unique });
};

/** 列出某插件建过的全部表（宿主卸载时用，不看插件当前是否还有 db 权限） */
export const pluginDbListAllTables = async (dirName: string): Promise<string[]> => {
  return await invoke('plugin_db_list_all_tables', { dirName });
};

/* ---------------- 插件文件存储（ctx.fs） ---------------- */

/** 数据目录里的一项 */
export interface PluginFsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export const pluginFsRoot = async (dirName: string): Promise<string> => {
  return await invoke('plugin_fs_root', { dirName });
};

export const pluginFsList = async (dirName: string, relDir?: string): Promise<PluginFsEntry[]> => {
  return await invoke('plugin_fs_list', { dirName, relDir: relDir ?? null });
};

export const pluginFsRead = async (dirName: string, relPath: string): Promise<string> => {
  return await invoke('plugin_fs_read', { dirName, relPath });
};

export const pluginFsWrite = async (
  dirName: string,
  relPath: string,
  content: string,
): Promise<number> => {
  return await invoke('plugin_fs_write', { dirName, relPath, content });
};

export const pluginFsRemove = async (dirName: string, relPath: string): Promise<void> => {
  await invoke('plugin_fs_remove', { dirName, relPath });
};

/* ---------------- 插件联网（ctx.net，宿主代理） ---------------- */

/** 联网响应：body 超过 1MB 时截断并置 truncated */
export interface PluginNetResponse {
  status: number;
  body: string;
  truncated: boolean;
}

export const pluginNetFetch = async (
  dirName: string,
  url: string,
  options?: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
): Promise<PluginNetResponse> => {
  return await invoke('plugin_net_fetch', {
    dirName,
    url,
    method: options?.method ?? 'GET',
    headers: options?.headers ?? null,
    body: options?.body ?? null,
  });
};
