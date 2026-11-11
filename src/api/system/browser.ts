/**
 * 内置浏览器 API 层。
 *
 * 窗口由 Rust 创建，前端不持有浏览器状态：单窗口设置下复用同一个窗口并导航，
 * 多窗口设置下每次打开链接都新建窗口。每个新窗口分配一份随机指纹（设置可关闭），
 * 窗口内跳转不换身份。`fingerprint` 不传时由 Rust 按设置生成；传一份
 * `randomFingerprint()` 的结果即可指定该窗口的指纹。
 */
import { invoke } from "@tauri-apps/api/core";

/** 在软件内置的浏览器窗口里打开网址（单窗口模式下复用同一个窗口并导航） */
export const openInAppBrowser = async (url: string, fingerprint?: unknown): Promise<void> => {
  await invoke("browser_open", { url, fingerprint: fingerprint ?? null });
};

/** 生成一份随机指纹（JSON），可直接作为 openInAppBrowser 的 fingerprint 参数 */
export const randomFingerprint = async (): Promise<unknown> => {
  return await invoke<unknown>("browser_random_fingerprint");
};
