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

/**
 * 日志目录（`log_dir`）：安装目录下的 `log`，不可写时在应用数据目录下。
 *
 * 出问题时让用户去这里拿文件 —— 比「你重试一下」能排障得多。
 * 路径本身可以直接交给 `openAppFolder`（它允许 exe 同级与应用数据目录）。
 */
export const getLogDir = async (): Promise<string> => {
  return await invoke<string>('log_dir');
};

/**
 * 前端异常写进后端日志（`log_frontend`）。
 *
 * 调用方通常正处在异常路径上，所以这里自己吞掉错误 ——
 * 日志失败绝不能再抛出去，否则会引发第二轮崩溃。
 */
export const logFrontend = async (
  level: "error" | "warn",
  message: string,
): Promise<void> => {
  try {
    await invoke('log_frontend', { level, message });
  } catch {
    /* 日志本身失败就算了 */
  }
};

/**
 * 导出诊断包（`export_diagnostics`）：环境信息 + 最近两份日志打成 zip。
 *
 * 不含数据库与笔记正文 —— 用户报问题时把它发过来，比让他自己找日志现实得多。
 */
export const exportDiagnostics = async (path: string): Promise<string> => {
  return await invoke<string>('export_diagnostics', { path });
};

/**
 * 取走「上次启动数据库损坏被重建」的通知（`take_recovery_notice`）。
 *
 * 取走即清空：只该提示一次。返回被隔离的原库文件名，没发生过损坏时返回 null。
 */
export const takeRecoveryNotice = async (): Promise<string | null> => {
  return await invoke<string | null>('take_recovery_notice');
};
