/**
 * 用户动作日志：只记「一个有意义的操作」，不记按键、滚动、拖拽中间态。
 *
 * 两条硬线：
 * - **节流**：自动保存每 500ms 一次、主题滑杆每拖一个像素一次，直接写会把日志刷成
 *   几万行噪音，真正有用的记录被埋掉。默认同一动作 1 秒内只落一条，可按 key 单独放宽。
 * - **失败静默**：调用方通常正处在用户操作的成功路径上，日志出错绝不能再抛。
 *
 * 写入走 `log_user_action`，后端只负责落盘（`[action]` 前缀，日志正文一律英文）。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";

const lastAt = new Map<string, number>();

/**
 * @param action 动作名，例如「新建笔记」「切换设置」
 * @param detail 附带的上下文（标题、字段、数量…），**不要放正文**
 * @param options.key 节流分组键（默认用 action）；同一篇笔记的自动保存共用一个 key
 * @param options.throttleMs 节流窗口，默认 1000ms
 */
export const logAction = (
  action: string,
  detail?: string,
  options: { key?: string; throttleMs?: number } = {},
): void => {
  if (!isTauri()) return;
  const key = options.key ?? action;
  const interval = options.throttleMs ?? 1000;
  const now = Date.now();
  const previous = lastAt.get(key) ?? 0;
  if (now - previous < interval) return;
  // 动作种类有限，这里只是防御性兜底（不至于无限增长）
  if (lastAt.size > 300) lastAt.clear();
  lastAt.set(key, now);
  void invoke("log_user_action", { action, detail: detail ?? null }).catch(() => undefined);
};

/** 节流窗口：自动保存这类高频动作按笔记 id 单独放长 */
export const SAVE_THROTTLE_MS = 60_000;

/**
 * 设置变更专用：**防抖记最终值**。
 *
 * 主题色滑杆、数字输入会连续触发 applyAppSetting，按 1 秒节流只会记下拖动的第一个值，
 * 而排查问题时真正有用的是「用户最后设成了什么」。所以这里等 400ms 没有新值再落一条。
 */
const pendingSettings = new Map<string, number>();

export const logSettingChange = (key: string, value: string): void => {
  if (!isTauri()) return;
  const previous = pendingSettings.get(key);
  if (previous !== undefined) window.clearTimeout(previous);
  const timer = window.setTimeout(() => {
    pendingSettings.delete(key);
    void invoke("log_user_action", { action: "settings.change", detail: `${key}=${value}` }).catch(
      () => undefined,
    );
  }, 400);
  pendingSettings.set(key, timer);
};
