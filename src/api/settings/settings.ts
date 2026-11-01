/**
 * 设置读写与本机行为下发。
 *
 * app_settings 是 key/value 表：读不到的键由调用方回退默认值，新增设置项无需迁移。
 * getAppSettings 失败时返回 {} 并打日志；setAppSetting/deleteAppSetting/setTrayEnabled
 * 会正常 reject；setAutostart 吞错，只打日志。单实例/托盘由 Rust 持有，前端只下发开关。
 */

import { invoke } from '@tauri-apps/api/core';

/** 读取全部设置（get_app_settings）；读取失败时返回 {} 并打印错误，调用方回退默认值 */
export const getAppSettings = async (): Promise<Record<string, string>> => {
  try {
    return await invoke<Record<string, string>>('get_app_settings');
  } catch (e) {
    console.error('读取设置失败：', e);
    return {};
  }
};

/** 写入或覆盖一个设置项（set_app_setting），失败会 reject */
export const setAppSetting = async (key: string, value: string): Promise<void> => {
  return await invoke('set_app_setting', { key, value });
};

/** 删除一个设置项（delete_app_setting），下次读取即回退默认值 */
export const deleteAppSetting = async (key: string): Promise<void> => {
  return await invoke('delete_app_setting', { key });
};

/* ---------- 单实例 / 托盘 / 窗口管理 ---------- */

/** 启用/禁用托盘图标（set_tray_enabled）；单实例、托盘与关闭到托盘均由 Rust 实现 */
export const setTrayEnabled = async (enabled: boolean): Promise<void> => {
  return await invoke('set_tray_enabled', { enabled });
};

/* ---------- 开机启动 ---------- */

/**
 * 启用/禁用开机自启（set_autostart_enabled）；快捷方式固定带 --autostart，
 * 「开机后是否最小化」由 Rust 启动时读库决定。失败只打日志，不向调用方抛出。
 */
export const setAutostart = async (enabled: boolean): Promise<void> => {
  try {
    await invoke('set_autostart_enabled', { enabled });
  } catch (e) {
    console.error('设置开机启动失败：', e);
  }
};
