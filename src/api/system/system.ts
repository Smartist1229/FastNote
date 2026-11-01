/**
 * 系统级操作。
 *
 * 打开目录由后端校验路径归属后执行，不用 plugin-opener 的 `openPath`：
 * 它的 ACL 作用域在 Windows 上用 `$EXE` 解析不出安装目录，调用一定被拒绝。
 */
import { invoke } from '@tauri-apps/api/core';

/** 打开应用自己的目录（下载目录、模型目录） */
export const openAppFolder = async (path: string): Promise<void> => {
  await invoke('open_app_folder', { path });
};
