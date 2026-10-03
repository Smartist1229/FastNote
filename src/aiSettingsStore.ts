import * as api from "./api";
import {
  AiPromptEntry,
  AiSettings,
  DEFAULT_AI_SETTINGS,
  normalizeAiSettings,
} from "./types";

/**
 * 设置持久化：**以 SQLite 的 app_settings 表为准**。
 *
 * 读取流程（每一步都保证"读不到就用默认值"）：
 *   1. 一次取回整表；
 *   2. 逐项解析：类型不对/缺键 → 用 DEFAULT_AI_SETTINGS 里的默认值；
 *   3. 首次运行（表是空的）时，把老版本存在 localStorage 里的设置迁移进来；
 *   4. 迁移完就把 localStorage 里的旧数据删掉，避免两份数据打架。
 *
 * 键名规则：
 *   ai.setting.<字段名> → 单值设置（数字/布尔，store 成字符串）
 *   ai.prompts          → 前置提示词/长期记忆列表（JSON 数组）
 */

const KEY_PREFIX = "ai.setting.";
const PROMPTS_KEY = "ai.prompts";
const LEGACY_SETTINGS_KEY = "fastnote.aiSettings";
const LEGACY_PROMPTS_KEY = "fastnote.aiPrompts";

/** 每个设置项的键名 */
export const settingKey = (field: keyof AiSettings) => `${KEY_PREFIX}${field}`;

export interface LoadedAiConfig {
  settings: AiSettings;
  prompts: AiPromptEntry[];
  /** 是否已经把老版本的 localStorage 数据迁移进数据库 */
  migrated: boolean;
}

const safeParse = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
};

const readLegacy = (): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
};

const readLegacyPrompts = (): AiPromptEntry[] => {
  try {
    const raw = localStorage.getItem(LEGACY_PROMPTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
};

const clearLegacy = () => {
  try {
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
    localStorage.removeItem(LEGACY_PROMPTS_KEY);
  } catch {}
};

/** 从数据库读取设置与记忆；数据库没有的键一律回退默认值 */
export const loadAiConfig = async (): Promise<LoadedAiConfig> => {
  const rows = await api.getAppSettings();
  const hasAnySetting = Object.keys(rows).some((k) => k.startsWith(KEY_PREFIX));
  const hasPrompts = typeof rows[PROMPTS_KEY] === "string";

  // 首次运行（库里还没有任何设置）：把老版本 localStorage 的数据迁进来
  let legacy: Record<string, unknown> = {};
  let legacyPrompts: AiPromptEntry[] = [];
  let migrated = false;
  if (!hasAnySetting && !hasPrompts) {
    legacy = readLegacy();
    legacyPrompts = readLegacyPrompts();
    if (Object.keys(legacy).length > 0 || legacyPrompts.length > 0) {
      migrated = true;
      try {
        for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
          const value = legacy[field];
          if (typeof value !== "undefined") await api.setAppSetting(settingKey(field), JSON.stringify(value));
        }
        if (legacyPrompts.length > 0) await api.setAppSetting(PROMPTS_KEY, JSON.stringify(legacyPrompts));
        clearLegacy();
      } catch (e) {
        console.error("迁移旧设置失败（继续用默认值）：", e);
      }
    }
  }

  // 逐项取值：库里有就用库里的，没有就用默认值
  const mergedRaw: Record<string, unknown> = {};
  for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    const fromDb = safeParse(rows[settingKey(field)]);
    mergedRaw[field] = fromDb !== undefined ? fromDb : legacy[field];
  }
  const settings = normalizeAiSettings(mergedRaw);

  let prompts: AiPromptEntry[] = [];
  const fromDbPrompts = safeParse(rows[PROMPTS_KEY]);
  const promptSource = Array.isArray(fromDbPrompts) ? fromDbPrompts : legacyPrompts;
  prompts = (promptSource as any[])
    .filter((e) => e && typeof e.text === "string")
    .map((e) => ({ id: String(e.id || Math.random().toString(36).slice(2)), text: e.text, enabled: e.enabled !== false }));

  return { settings, prompts, migrated };
};

/** 保存单个设置项（只写变化的那一项，避免整表重写） */
export const saveSetting = async <K extends keyof AiSettings>(field: K, value: AiSettings[K]): Promise<void> => {
  try {
    await api.setAppSetting(settingKey(field), JSON.stringify(value));
  } catch (e) {
    console.error(`保存设置 ${String(field)} 失败：`, e);
  }
};

/** 把一批设置项写库（用于"恢复默认值"） */
export const saveAllSettings = async (settings: AiSettings): Promise<void> => {
  try {
    for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
      await api.setAppSetting(settingKey(field), JSON.stringify(settings[field]));
    }
  } catch (e) {
    console.error("保存设置失败：", e);
  }
};

/** 保存前置提示词/记忆列表 */
export const savePrompts = async (prompts: AiPromptEntry[]): Promise<void> => {
  try {
    await api.setAppSetting(PROMPTS_KEY, JSON.stringify(prompts));
  } catch (e) {
    console.error("保存记忆列表失败：", e);
  }
};

/**
 * 让每个设置项在数据库里都有一行显式记录（首次启动时调用）。
 * 这样"表里没有的键用默认值"与"表里存在的键是用户当前值"始终一致，便于排查。
 */
export const ensureSettingsSeeded = async (settings: AiSettings): Promise<void> => {
  const rows = await api.getAppSettings();
  for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    if (typeof rows[settingKey(field)] === "undefined") {
      await saveSetting(field, settings[field]);
    }
  }
};
