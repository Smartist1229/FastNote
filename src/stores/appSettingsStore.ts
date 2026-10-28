import * as settingsApi from "@/api/settings";
import type { AppSettings, EditorSettings } from "@/interface/settings";
import { DEFAULT_APP_SETTINGS } from "@/config/appDefaults";
import { EDITOR_SPEC_BY_FIELD } from "@/config/editorSettingSpecs";
import type { EditorSettingSpec } from "@/config/editorSettingSpecs";
import { SEMANTIC_MODEL_IDS } from "@/config/semanticModels";
import { normalizeHex, normalizeHexList } from "@/lib/theme";

/**
 * 软件设置的持久化层（模块内无 React 状态）。
 *
 * 数据源是 SQLite 的 app_settings 表，与 AI 设置同表、只靠前缀区分：
 *   app.config.<分类>.<字段>
 *     general：cleanTrashOnStartup / trayEnabled / closeBehavior / autostart /
 *              minimizeToTray / enableAI / singleInstance / noteSearchRegex /
 *              semanticSearch / semanticAutoIndex / semanticModel / downloadThreads /
 *              noteHistoryLimit / noteHistoryIntervalMinutes
 *     editor： 见 interface/settings.ts 的 EditorSettings（config/editorSettingSpecs.ts 里的规格表）
 *     layout： sidebarCollapsed / aiPanelOpen
 *     view：   sortBy / sortOrder
 *
 * 默认值统一来自 config/appDefaults.ts，本文件不重复写数字。
 * 读取：一次取回整表 → 逐字段校验 → 缺键 / 类型不符 / 越界都回退默认值，
 *       并把这些键的默认值补写回库 —— 首次启动即等于把整套默认设置写进数据库，
 *       后续新增设置项也会在下次启动时自动补上。
 *       反过来，已下线的设置项（不再出现在默认值里）会在读取时被清掉，避免废弃键越积越多。
 * 写入：只写被改的那一个键，由 App.tsx 在用户操作时立即调用。
 * 重置：删除全部 app.config.* 键（下次启动重新回退并补写默认），不碰 AI 设置的键；
 *       也可以只重置 editor 分类，其他分类与主题保持不动。
 */

const PREFIX = "app.config.";

/** 分类 + 字段名 → 完整键名；读写与删除都经由它，避免手拼字符串 */
const configKey = (category: string, field: string) => `${PREFIX}${category}.${field}`;

/** 五个分类的遍历顺序：与 AppSettings 的键一致 */
const CATEGORIES = ["general", "editor", "layout", "view", "webdav"] as const;

/**
 * 非编辑器分类里需要白名单校验的字段。
 * typeof 只挡类型，挡不住手工改库写进来的非法字符串；编辑器分类的约束在规格表里。
 */
const ENUM_BY_KEY: Record<string, readonly string[]> = {
  "app.config.general.language": ["system", "zh-CN", "en-US"],
  "general.closeBehavior": ["minimize", "exit"],
  "view.sortOrder": ["asc", "desc"],
  "webdav.autoTarget": ["local", "cloud", "both"],
};

/** 非编辑器分类里需要夹到区间的数值字段（与后端 clamp 保持同一范围） */
const RANGE_BY_KEY: Record<string, readonly [number, number]> = {
  "general.downloadThreads": [1, 128],
  "general.noteHistoryLimit": [1, 100],
  "general.noteHistoryIntervalMinutes": [1, 60],
  "webdav.autoIntervalHours": [1, 720],
  "webdav.autoMaxLocal": [1, 200],
};

/**
 * 语义模型 id：内置项走白名单，本地导入的自定义项形如 `custom-<16 位十六进制>`
 * （由后端按文件内容哈希生成）。不能用固定白名单，否则自定义模型在下次启动时会被重置。
 */
const CUSTOM_MODEL_ID = /^custom-[0-9a-f]{16}$/;

const normalizeSemanticModelId = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  if (CUSTOM_MODEL_ID.test(value)) return value;
  return SEMANTIC_MODEL_IDS.includes(value as (typeof SEMANTIC_MODEL_IDS)[number])
    ? value
    : undefined;
};

/**
 * 安全解析 JSON 值：解析失败或类型与 expected 不符都返回 undefined，
 * 调用方据此决定是否采用，脏数据不会顶掉默认值。
 */
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

/**
 * 按规格收敛一个值：不合规返回 undefined（调用方回退默认值并补写库）。
 * 枚举走白名单，数值夹到 [min, max]，没有规格的（普通布尔 / 自由字符串）按类型已校验过直接用。
 */
const normalizeValue = (
  value: unknown,
  spec: EditorSettingSpec | undefined,
  whitelist: readonly string[] | undefined,
): unknown => {
  if (whitelist) return typeof value === "string" && whitelist.includes(value) ? value : undefined;
  if (!spec) return value;
  if (spec.kind === "toggle") return typeof value === "boolean" ? value : undefined;
  if (spec.kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
    return Math.min(spec.max, Math.max(spec.min, value));
  }
  if (spec.kind === "color") {
    const hex = typeof value === "string" ? normalizeHex(value) : null;
    return hex ?? undefined;
  }
  if (spec.kind === "colorList") {
    if (typeof value !== "string") return undefined;
    const list = normalizeHexList(value);
    return list.length ? list.join(", ") : undefined;
  }
  // 分段 / 下拉：选项值以字符串声明，但数值项（如 Tab 宽度）在设置对象里是 number，
  // 两边都按字符串比较，命中后保留原类型，避免读库时把用户选的 4 当成非法值重置。
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  return spec.options.some((o) => o.value === String(value)) ? value : undefined;
};

/**
 * 调整过出厂默认值的设置项：老库里如果还停在**旧默认值**上，读取时顺手升级一次。
 *
 * 判定条件是「值恰好等于旧默认值」：用户自己调过的（哪怕只调到 1.8）不会被覆盖。
 * 升级后写一个 `app.migrations.*` 标记，避免用户手动改回旧值、下次启动又被顶上去；
 * 这类标记键不以 `app.config.` 开头，不会被下面的「清理下线键」逻辑误删。
 */
const DEFAULT_UPGRADES = [
  { category: "editor", field: "sourceLineHeight", from: 1.75, to: 1.9, flag: "app.migrations.editorLineHeight" },
  /*
   * 命中上限 2000 → 20000：四万字左右的笔记里查一个常用字就会超过 2000，
   * 后半段的命中既高亮不出来也跳不过去，看着像「搜索坏了」。老库停在这个默认值上的一并升级。
   */
  { category: "editor", field: "searchMaxMatches", from: 2000, to: 20000, flag: "app.migrations.searchMaxMatches" },
  /*
   * 编辑字间距 0.5 → 1：中英混排贴得太紧，光标夹在两个字符中间时视觉上更挤，放宽一点。
   */
  { category: "editor", field: "letterSpacing", from: 0.5, to: 1, flag: "app.migrations.editorLetterSpacing" },
] as const;

/**
 * 读取全部软件设置。
 *
 * 每个分类先展开默认值，再用库里通过校验的字段覆盖，因此返回值永远是完整对象；
 * 底层 getAppSettings 已把读失败吞成空对象，这里的 catch 是第二层兜底。
 * 缺键 / 脏数据的补写是 fire-and-forget：不阻塞首屏，单次写失败只记日志。
 */
export const loadAppSettings = async (): Promise<AppSettings> => {
  const rows: Record<string, string> = await settingsApi.getAppSettings().catch(() => ({}));
  const out = {} as Record<(typeof CATEGORIES)[number], Record<string, unknown>>;
  const pending: Promise<void>[] = [];

  for (const category of CATEGORIES) {
    const defaults = DEFAULT_APP_SETTINGS[category] as unknown as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...defaults };
    const categoryPrefix = configKey(category, "");

    // 库里留有本分类已下线的键（删掉的设置项）：顺手清掉，避免废弃键在数据库里堆积
    for (const key of Object.keys(rows)) {
      if (!key.startsWith(categoryPrefix)) continue;
      if (key.slice(categoryPrefix.length) in defaults) continue;
      pending.push(settingsApi.deleteAppSetting(key).catch(() => undefined));
    }

    for (const [field, fallback] of Object.entries(defaults)) {
      const key = configKey(category, field);
      const parsed = safeParse<unknown>(rows[key], typeof fallback as "number" | "string" | "boolean");
      const spec =
        category === "editor"
          ? EDITOR_SPEC_BY_FIELD[field as keyof EditorSettings]
          : undefined;
      const value =
        key === "general.semanticModel"
          ? normalizeSemanticModelId(parsed)
          : parsed === undefined
            ? undefined
            : normalizeValue(parsed, spec, ENUM_BY_KEY[key]);
      // 数值型字段统一夹到区间：手改库写了 100000 也不会把界面和后端拖垮
      const range = RANGE_BY_KEY[key];
      const bounded =
        range && typeof value === "number"
          ? Math.min(range[1], Math.max(range[0], value))
          : value;

      if (bounded === undefined) {
        // 库里没有或值不可信：用默认值，并把这个键补写回库
        merged[field] = fallback;
        pending.push(saveAppSetting(category, field as never, fallback as never));
      } else {
        merged[field] = bounded;
      }
    }

    out[category] = merged;
  }

  // 出厂默认值调整过的键：还停在旧默认值上的老库升级一次（用户改过的不动）
  for (const rule of DEFAULT_UPGRADES) {
    if (rows[rule.flag]) continue;
    const bucket = out[rule.category] as unknown as Record<string, unknown>;
    if (bucket[rule.field] === rule.from) {
      bucket[rule.field] = rule.to;
      pending.push(saveAppSetting(rule.category, rule.field as never, rule.to as never));
    }
    pending.push(settingsApi.setAppSetting(rule.flag, "true").catch(() => undefined));
  }

  if (pending.length > 0) void Promise.all(pending);
  return out as unknown as AppSettings;
};

/** 保存单个字段：值统一 JSON 序列化；失败只记日志，不向 UI 抛错 */
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

/**
 * 把整份设置逐分类写回数据库。
 * 每次调用 saveAppSetting，单个键失败只影响自己；适合「把内存值全量刷库」的场景
 * （如恢复默认后立刻把默认值写回去）。
 */
export const saveAllAppSettings = async (settings: AppSettings): Promise<void> => {
  for (const [category, fields] of Object.entries(settings) as [keyof AppSettings, Record<string, unknown>][]) {
    for (const [field, value] of Object.entries(fields)) {
      await saveAppSetting(category, field as never, value as never);
    }
  }
};

/**
 * 按前缀删除键。存储层只有单键删除接口，所以先取整表再筛选。
 * 单个键删除失败只记日志，不中断其余键。
 */
const deleteByPrefix = async (prefix: string): Promise<void> => {
  const rows: Record<string, string> = await settingsApi.getAppSettings().catch(() => ({}));
  for (const key of Object.keys(rows)) {
    if (!key.startsWith(prefix)) continue;
    try {
      await settingsApi.deleteAppSetting(key);
    } catch (e) {
      console.error(`删除设置 ${key} 失败：`, e);
    }
  }
};

/**
 * 只恢复编辑器分类：先删掉 app.config.editor.* 的全部键（含已下线字段），
 * 再把默认值逐项写回；其他软件设置、主题与 AI 设置都不受影响。
 */
export const resetEditorSettings = async (): Promise<void> => {
  await deleteByPrefix(configKey("editor", ""));
  for (const [field, value] of Object.entries(DEFAULT_APP_SETTINGS.editor)) {
    await saveAppSetting("editor", field as never, value as never);
  }
};

/**
 * 删除全部 app.config.* 键（含主题），下次启动自动回退默认值。
 * 只匹配本前缀，AI 设置（ai.setting.* / ai.prompts）不受影响。
 */
export const resetAppSettings = (): Promise<void> => deleteByPrefix(PREFIX);
