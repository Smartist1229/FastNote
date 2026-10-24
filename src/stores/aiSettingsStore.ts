import * as settingsApi from "@/api/settings";
import type { AiPromptEntry, AiSettings, LoadedAiConfig } from "@/interface/ai";
import { DEFAULT_AI_SETTINGS, normalizeAiSettings } from "@/config/aiDefaults";

/**
 * AI 设置的持久化层（模块内无 React 状态）。
 *
 * 唯一数据源是 SQLite 的 app_settings 表；运行时状态由 App.tsx 的 useState 持有，
 * 本模块只提供「读出来归一化」与「按字段写回去」，由 App 的 effect 调用。
 *
 * 键名规则：
 *   ai.setting.<字段名> → 单值设置，值为 JSON 序列化后的字符串
 *   ai.prompts          → 前置提示词 / 长期记忆，JSON 数组
 *
 * 读取流程（loadAiConfig）：
 *   1. 一次取回整表，缺键 / 类型不符一律回退 DEFAULT_AI_SETTINGS；
 *   2. 表里没有任何 AI 键时视为首次运行，把老版本 localStorage 的数据迁进库；
 *   3. 迁移写库失败则不清 localStorage，下次启动可以重试。
 */

const KEY_PREFIX = "ai.setting.";
const PROMPTS_KEY = "ai.prompts";
/** 老版本存在 localStorage 时的键名，只在首次运行迁移时读取 */
const LEGACY_SETTINGS_KEY = "fastnote.aiSettings";
const LEGACY_PROMPTS_KEY = "fastnote.aiPrompts";

/** 字段名 → 数据库键名；所有读写都经由它，避免键名散落在各处 */
export const settingKey = (field: keyof AiSettings) => `${KEY_PREFIX}${field}`;

/**
 * 库里存的是 JSON 字符串；解析失败说明不是合法 JSON（手工写入或更早的数据），
 * 此时原样返回，交给 normalizeAiSettings 的类型逐项校验兜底。
 */
const safeParse = (raw: string | undefined): unknown => {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
};

/** 读老版本的设置对象；缺失或损坏都返回空对象，调用方据此判断是否需要迁移 */
const readLegacy = (): Record<string, unknown> => {
  try {
    const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);
    return raw ? (JSON.parse(raw) || {}) : {};
  } catch { return {}; }
};

/** 读老版本的记忆列表；非数组一律当空处理 */
const readLegacyPrompts = (): AiPromptEntry[] => {
  try {
    const raw = localStorage.getItem(LEGACY_PROMPTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch { return []; }
};

/** 迁移成功后删除旧键，避免 localStorage 与数据库两份数据长期并存 */
const clearLegacy = () => {
  try {
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
    localStorage.removeItem(LEGACY_PROMPTS_KEY);
  } catch {}
};

/**
 * 读取 AI 设置与记忆列表。
 *
 * 返回的 migrated 表示本次是否从 localStorage 迁移过数据，
 * 调用方据此决定要不要调用 ensureSettingsSeeded 把每个字段补成显式行。
 * 数据库读取失败时 api 层返回空表，等价于「一条 AI 键都没有」；无旧数据可迁时结果是默认值。
 */
export const loadAiConfig = async (): Promise<LoadedAiConfig> => {
  const rows = await settingsApi.getAppSettings();
  const hasAnySetting = Object.keys(rows).some((k) => k.startsWith(KEY_PREFIX));
  const hasPrompts = typeof rows[PROMPTS_KEY] === "string";

  // 表里一个 AI 键都没有 → 视为首次运行，把老版本 localStorage 的数据迁进来
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
          if (typeof value !== "undefined") await settingsApi.setAppSetting(settingKey(field), JSON.stringify(value));
        }
        if (legacyPrompts.length > 0) await settingsApi.setAppSetting(PROMPTS_KEY, JSON.stringify(legacyPrompts));
        clearLegacy();
      } catch (e) {
        console.error("迁移旧设置失败（继续用默认值）：", e);
      }
    }
  }

  // 逐字段取值：库里有就用库里的，否则用刚读出的迁移值；两者都没有时由归一化补默认值
  const mergedRaw: Record<string, unknown> = {};
  for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    const fromDb = safeParse(rows[settingKey(field)]);
    mergedRaw[field] = fromDb !== undefined ? fromDb : legacy[field];
  }
  const settings = normalizeAiSettings(mergedRaw);

  // 记忆条目可能来自库或迁移值：丢弃没有正文的脏条目，补齐 id，enabled 只有显式 false 才算停用
  let prompts: AiPromptEntry[] = [];
  const fromDbPrompts = safeParse(rows[PROMPTS_KEY]);
  const promptSource = Array.isArray(fromDbPrompts) ? fromDbPrompts : legacyPrompts;
  prompts = (promptSource as any[])
    .filter((e) => e && typeof e.text === "string")
    .map((e) => ({ id: String(e.id || Math.random().toString(36).slice(2)), text: e.text, enabled: e.enabled !== false }));

  return { settings, prompts, migrated };
};

/**
 * 保存单个设置项。
 * 只写变化的键（diff 在 App 的 effect 里做），避免每次改动重写整表；
 * 写失败只记日志，不让持久化异常打断用户操作。
 */
export const saveSetting = async <K extends keyof AiSettings>(field: K, value: AiSettings[K]): Promise<void> => {
  try {
    await settingsApi.setAppSetting(settingKey(field), JSON.stringify(value));
  } catch (e) {
    console.error(`保存设置 ${String(field)} 失败：`, e);
  }
};

/** 把整份设置逐字段写入数据库（App 首次读回后调用，保证库里有一份完整记录） */
export const saveAllSettings = async (settings: AiSettings): Promise<void> => {
  try {
    for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
      await settingsApi.setAppSetting(settingKey(field), JSON.stringify(settings[field]));
    }
  } catch (e) {
    console.error("保存设置失败：", e);
  }
};

/** 保存前置提示词 / 记忆列表：整数组覆盖写，条目 id 由调用方维护 */
export const savePrompts = async (prompts: AiPromptEntry[]): Promise<void> => {
  try {
    await settingsApi.setAppSetting(PROMPTS_KEY, JSON.stringify(prompts));
  } catch (e) {
    console.error("保存记忆列表失败：", e);
  }
};

/**
 * 补齐缺失的设置键（只在发生过旧数据迁移后调用）。
 * 已存在的键保持用户当前值不覆盖；补齐后「库里没有 = 默认值」与「库里有 = 用户值」界限清晰，便于排查。
 */
export const ensureSettingsSeeded = async (settings: AiSettings): Promise<void> => {
  const rows = await settingsApi.getAppSettings();
  for (const field of Object.keys(DEFAULT_AI_SETTINGS) as (keyof AiSettings)[]) {
    if (typeof rows[settingKey(field)] === "undefined") {
      await saveSetting(field, settings[field]);
    }
  }
};
