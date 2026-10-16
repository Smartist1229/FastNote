/* 应用设置（app_settings 键值读写）与托盘/开机启动等本机行为下发。 */

import { invoke } from '@tauri-apps/api/core';

/** 读取全部设置键值；表不存在/读取失败时返回空对象，由调用方回退到默认值 */
export const getAppSettings = async (): Promise<Record<string, string>> => {
  try {
    return await invoke<Record<string, string>>('get_app_settings');
  } catch (e) {
    console.error('读取设置失败：', e);
    return {};
  }
};

export const setAppSetting = async (key: string, value: string): Promise<void> => {
  return await invoke('set_app_setting', { key, value });
};

export const deleteAppSetting = async (key: string): Promise<void> => {
  return await invoke('delete_app_setting', { key });
};

/* ---------------- 单实例 / 托盘 / 窗口管理 ----------------
 * 单实例、托盘、关闭到托盘全部由 Rust 侧负责，前端只负责下发设置变更。
 */

/** 启用/禁用托盘图标（托盘由 Rust 持有，前端不做任何图标绘制） */
export const setTrayEnabled = async (enabled: boolean): Promise<void> => {
  return await invoke('set_tray_enabled', { enabled });
};

/* ---------------- 开机启动 ---------------- */

/** 启用/禁用开机自启动（快捷方式固定带 --autostart，「开机后是否最小化」在启动时读库决定） */
export const setAutostart = async (enabled: boolean): Promise<void> => {
  try {
    await invoke('set_autostart_enabled', { enabled });
  } catch (e) {
    console.error('设置开机启动失败：', e);
  }
};
