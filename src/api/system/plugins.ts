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
export const pluginModuleUrl = async (dirName: string, relPath: string): Promise<string> => {
  return await invoke('plugin_module_url', { dirName, relPath });
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
