import * as settingsApi from "@/api/settings";
import type { AppSettings } from "@/interface/settings";
import { DEFAULT_APP_SETTINGS } from "@/config/appDefaults";

/**
 * 软件设置持久化：**以 SQLite 的 app_settings 表为准**（与 AI 设置同一张表，只是键前缀不同）。
 *
 * 键名规则：app.config.<分类>.<字段>
 *   - app.config.general.cleanTrashOnStartup
 *   - app.config.general.trayEnabled
 *   - app.config.general.closeBehavior
 *   - app.config.general.autostart
 *   - app.config.general.minimizeToTray
 *   - app.config.general.enableAI
 *   - app.config.editor.fontSize
 *   - app.config.editor.ctrlScrollZoom
 *   - app.config.layout.sidebarCollapsed
 *   - app.config.layout.aiPanelOpen
 *   - app.config.view.sortBy
 *   - app.config.view.sortOrder
 *
 * 读取流程：一次取回整表 → 逐项解析 → 类型不对 / 缺键一律回退到 DEFAULT_APP_SETTINGS。
 * 写入流程：修改单个字段只写那一个键；「恢复默认值」删掉全部 app.config.* 键，下次启动回退默认。
 */

const PREFIX = "app.config.";

/** 把分类 + 字段名拼成完整的键名 */
const configKey = (category: string, field: string) => `${PREFIX}${category}.${field}`;

/** 安全解析 JSON 值；解析失败或类型不匹配就返回 undefined（调用方回退默认） */
const safeParse = <T>(raw: string | undefined, expected: "number" | "string" | "boolean"): T | undefined => {
  if (raw === undefined) return undefined;
  try {
    const val = JSON.parse(raw);
    if (typeof val === expected) return val as T;
    return undefined;
  } catch {
    return undefined;
  }
};

/** 从数据库读取全部软件设置，读不到的键回退默认值，返回完整的 AppSettings */
export const loadAppSettings = async (): Promise<AppSettings> => {
  const rows: Record<string, string> = await settingsApi.getAppSettings().catch(() => ({}));

  // ---- general ----
  const general = { ...DEFAULT_APP_SETTINGS.general };
  const cleanTrashOnStartup = safeParse<boolean>(rows[configKey("general", "cleanTrashOnStartup")], "boolean");
  if (cleanTrashOnStartup !== undefined) general.cleanTrashOnStartup = cleanTrashOnStartup;

  const trayEnabled = safeParse<boolean>(rows[configKey("general", "trayEnabled")], "boolean");
  if (trayEnabled !== undefined) general.trayEnabled = trayEnabled;

  const closeBehavior = safeParse<string>(rows[configKey("general", "closeBehavior")], "string");
  if (closeBehavior === "minimize" || closeBehavior === "exit") general.closeBehavior = closeBehavior;

  const autostart = safeParse<boolean>(rows[configKey("general", "autostart")], "boolean");
  if (autostart !== undefined) general.autostart = autostart;

  const minimizeToTray = safeParse<boolean>(rows[configKey("general", "minimizeToTray")], "boolean");
  if (minimizeToTray !== undefined) general.minimizeToTray = minimizeToTray;

  const enableAI = safeParse<boolean>(rows[configKey("general", "enableAI")], "boolean");
  if (enableAI !== undefined) general.enableAI = enableAI;

  // ---- editor ----
  const editor = { ...DEFAULT_APP_SETTINGS.editor };
  const fontSize = safeParse<number>(rows[configKey("editor", "fontSize")], "number");
  if (fontSize !== undefined) editor.fontSize = fontSize;
  const ctrlScrollZoom = safeParse<boolean>(rows[configKey("editor", "ctrlScrollZoom")], "boolean");
  if (ctrlScrollZoom !== undefined) editor.ctrlScrollZoom = ctrlScrollZoom;

  // ---- layout ----
  const layout = { ...DEFAULT_APP_SETTINGS.layout };
  const sidebarCollapsed = safeParse<boolean>(rows[configKey("layout", "sidebarCollapsed")], "boolean");
  if (sidebarCollapsed !== undefined) layout.sidebarCollapsed = sidebarCollapsed;
  const aiPanelOpen = safeParse<boolean>(rows[configKey("layout", "aiPanelOpen")], "boolean");
  if (aiPanelOpen !== undefined) layout.aiPanelOpen = aiPanelOpen;

  // ---- view ----
  const view = { ...DEFAULT_APP_SETTINGS.view };
  const sortBy = safeParse<string>(rows[configKey("view", "sortBy")], "string");
  if (sortBy !== undefined) view.sortBy = sortBy;
  const sortOrder = safeParse<string>(rows[configKey("view", "sortOrder")], "string");
  if (sortOrder === "asc" || sortOrder === "desc") view.sortOrder = sortOrder;

  return { general, editor, layout, view };
};

/** 保存单个设置字段到数据库（值统一 JSON 序列化） */
export const saveAppSetting = async <K extends keyof AppSettings>(
  category: K,
  field: keyof AppSettings[K],
  value: AppSettings[K][typeof field],
): Promise<void> => {
  const key = configKey(category as string, field as string);
  try {
    await settingsApi.setAppSetting(key, JSON.stringify(value));
  } catch (e) {
    console.error(`保存设置 ${key} 失败：`, e);
  }
};

/** 批量写入整份设置（用于「恢复默认值」后补齐） */
export const saveAllAppSettings = async (settings: AppSettings): Promise<void> => {
  for (const [category, fields] of Object.entries(settings) as [keyof AppSettings, Record<string, unknown>][]) {
    for (const [field, value] of Object.entries(fields)) {
      await saveAppSetting(category, field as never, value as never);
    }
  }
};

/** 删除全部软件设置键，下次启动时自动回退到默认值 */
export const resetAppSettings = async (): Promise<void> => {
  const rows: Record<string, string> = await settingsApi.getAppSettings().catch(() => ({}));
  for (const key of Object.keys(rows)) {
    if (!key.startsWith(PREFIX)) continue;
    try {
      await settingsApi.deleteAppSetting(key);
    } catch (e) {
      console.error(`删除设置 ${key} 失败：`, e);
    }
  }
};
