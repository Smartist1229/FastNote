/**
 * 系统全局热键的 Tauri 薄封装。
 *
 * 注册 / 注销都交给 Rust：热键是进程级资源，webview 关闭、窗口隐藏都不能影响它
 * （这正是「全局」与「窗口内」的区别）。前端只传一张「id + accelerator」清单，
 * 由 Rust 整体替换注册，按下时把 id 原样发回来。
 */
import { invoke } from "@tauri-apps/api/core";

/** 一条注册请求：`id` 是宿主动作 id 或 `plugin:<dir>:<combo>`，`accelerator` 是 Tauri 写法 */
export interface GlobalShortcutRequest {
  id: string;
  accelerator: string;
}

/** 注册失败项：多数是键位已被其它程序占用（如输入法、截图工具） */
export interface GlobalShortcutFailure {
  id: string;
  accelerator: string;
  reason: string;
}

/**
 * 用给定清单**替换**全部热键（sync_global_shortcuts）。
 * 返回注册失败项；成功项不出现在结果里。
 */
export const syncGlobalShortcuts = async (
  items: GlobalShortcutRequest[],
): Promise<GlobalShortcutFailure[]> => {
  return await invoke("sync_global_shortcuts", { items });
};
