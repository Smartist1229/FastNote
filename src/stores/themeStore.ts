/**
 * 主题设置的持久化层。
 *
 * 主题是一个嵌套结构（模式 + 预设 + 亮暗两套令牌 + 保存列表），
 * 因此整份以 JSON 存在 app_settings 的单个键里，而不是拆成几十个键：
 *   app.config.theme.settings → ThemeSettings
 *
 * 与 appSettingsStore 的关系：同表、同前缀，但独立成键。
 * 「恢复默认」按前缀删除 app.config.*，会连它一起清掉，符合预期；
 * 只恢复主题时走 resetThemeSettings，只删本键，不碰其他软件设置。
 *
 * 读取失败或结构非法时返回默认主题（normalizeThemeSettings 逐项兜底），
 * 写失败只打日志——主题坏了不该影响记笔记。
 */
import * as settingsApi from "@/api/settings";
import type { ThemeSettings } from "@/interface/theme";
import { DEFAULT_THEME_SETTINGS } from "@/config/themes";
import { normalizeThemeSettings } from "@/lib/theme";

const THEME_KEY = "app.config.theme.settings";

/** 读库；没有记录时返回默认主题 */
export const loadThemeSettings = async (): Promise<ThemeSettings> => {
  const rows: Record<string, string> = await settingsApi.getAppSettings().catch(() => ({}));
  const raw = rows[THEME_KEY];
  if (!raw) return normalizeThemeSettings(DEFAULT_THEME_SETTINGS);
  try {
    return normalizeThemeSettings(JSON.parse(raw));
  } catch (e) {
    console.error("主题设置解析失败，已回退默认主题：", e);
    return normalizeThemeSettings(DEFAULT_THEME_SETTINGS);
  }
};

/**
 * 落库防抖窗口。
 *
 * 取色盘拖动时 onChange 会每帧回调一次，而主题是「整份覆盖」写单键的，
 * 不防抖的话一次拖动就是上百次 SQLite 写入。界面预览走 CSS 变量（同步、即时），
 * 落库晚几百毫秒没有任何可感知差异。
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
/** 待落库的最新一份；定时器触发时用它，保证冲下去的是最后一次改动 */
let pending: ThemeSettings | null = null;

const writeNow = async (settings: ThemeSettings): Promise<void> => {
  try {
    await settingsApi.setAppSetting(THEME_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error("保存主题设置失败：", e);
  }
};

/** 真正提交：清掉计时器并写出 pending */
const commit = (): Promise<void> => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const next = pending;
  pending = null;
  if (!next) return Promise.resolve();
  return writeNow(next);
};

/** 写库；唯一写入口，整份覆盖，防抖合并连续改动 */
export const saveThemeSettings = (settings: ThemeSettings): Promise<void> => {
  pending = settings;
  if (saveTimer) clearTimeout(saveTimer);
  return new Promise((resolve) => {
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void commit().finally(resolve);
    }, SAVE_DEBOUNCE_MS);
  });
};

/**
 * 立刻把挂起的写入冲下去（关窗、退出前兜底）。
 * 没有待写入内容时调用是安全的。
 */
export const flushThemeSettings = (): Promise<void> => commit();

/**
 * 只恢复主题：丢弃尚未落库的改动并删除主题键，下次读取回退默认主题。
 *
 * 必须先清掉防抖计时器和 pending——否则删除之后计时器照常触发，
 * 会把恢复前那份主题重新写回库里。
 */
export const resetThemeSettings = async (): Promise<void> => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  pending = null;
  try {
    await settingsApi.deleteAppSetting(THEME_KEY);
  } catch (e) {
    console.error("恢复默认主题失败：", e);
  }
};
