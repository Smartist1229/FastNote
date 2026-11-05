/**
 * 插件宿主：非 React 单例，管理从 <exe>/plugin/ 安装的插件生命周期。
 *
 * 目录名（dirName）是插件实例键：启用状态、卸载、读资源、注册贡献全部按它走；
 * plugin.json 的 id 只是插件身份，不能当主键（同 id 可能来自不同作者）。
 *
 * 生命周期：
 * - init()（幂等，StrictMode 双调用安全）：读启用状态持久化 →
 *   拉 plugin_list_installed → 逐个激活启用的插件（entry 经 fastnote-plugin
 *   自定义协议 URL 动态 import，模块内相对路径 import 由浏览器原生解析，
 *   插件可拆多文件；约定 default export { activate(ctx) }；style 读文本后注入
 *   <style data-plugin-id>）。非 Tauri 环境直接 no-op。
 * - activate 前先执行该插件已登记的 disposers、registry.removePlugin 清掉旧贡献；
 *   activate 抛错时同样执行 disposers、清贡献并标记 failed 并 toast。
 * - setPluginEnabled：持久化后启用（重新 activate）或禁用（执行 disposers + removePlugin + 移除样式标签）。
 * - installZip / refresh / uninstall：调 API 后 reload 重新同步列表并激活。
 *
 * disposers 由插件通过 ctx.onDispose 登记，用于撤销 registry 覆盖不到的副作用
 * （自己创建的 DOM、定时器、全局变量），按 dirName 分桶、停用时 LIFO 执行。
 *
 * 启用状态持久化在 app_settings 表（get/set_app_setting），键 plugin.states 存
 * JSON { [dirName]: boolean }；默认取 manifest.defaultEnabled。
 */

import { isTauri } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";

import * as pluginsApi from "@/api/system/plugins";
import type { PluginConfigField, PluginManifest } from "@/interface/system/plugins";
import { getNote } from "@/api/note/notes";
import { getAppSettings, setAppSetting } from "@/api/settings/settings";
import type { PluginModalOptions, PluginModalResult, ToastType } from "@/interface/app/ui";
import type { AiSettings } from "@/interface/ai/ai";
import { getLocale, subscribeLocale, translate } from "@/i18n";
import { interpolate } from "@/i18n/locale";
import * as registry from "./registry";
import type { PluginSettingsSection } from "./registry";
import type { PluginContext, PluginCurrentNote, PluginHook } from "./types";

/** 启用状态在 app_settings 表里的持久化键 */
const STATES_KEY = "plugin.states";

/** 插件列表里的一项：供设置分区展示；dirName 是实例键 */
export interface PluginEntry {
  /** 插件身份（plugin.json 的 id），仅用于展示 / 排查 */
  id: string;
  /** 实例键：插件目录名，运行时操作都用它 */
  dirName: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  /** 插件图标的本应用协议 URL；没有图标时为空，界面回落到默认图标 */
  iconUrl?: string;
  /** 展示用标签与主页（来自 manifest） */
  tags?: string[];
  homepage?: string;
  /** 配置 schema（来自 manifest）；为空表示该插件没有配置项 */
  config?: PluginConfigField[];
  /** 插件声明的权限标识符数组；为空表示不需要特殊权限 */
  permissions?: string[];
  enabled: boolean;
  /** activate 抛错时置位，错误信息展示在设置分区 */
  failed?: boolean;
  error?: string;
  /** 激活次数（内部状态，不展示）：递增后作为协议 URL 的 ?v= 参数 bust 入口模块缓存 */
  activations?: number;
}

type ToastDispatcher = (message: string, type?: ToastType) => void;

/* ---------------- 模块级状态 ---------------- */

let entries: PluginEntry[] = [];
const listeners = new Set<() => void>();
let snapshotCache: readonly PluginEntry[] = [];
let toastDispatcher: ToastDispatcher | null = null;
let initialized = false;
let enabledStates: Record<string, boolean> = {};
let installedManifests = new Map<string, PluginManifest>();
/** 各插件最近一次激活时读到的配置值：供菜单 / 命令等回调创建上下文时复用 */
const configCache = new Map<string, Record<string, unknown>>();
/** 各插件实例登记的清理回调：停用 / 卸载 / 重新激活时按 LIFO 执行并清空 */
const disposers = new Map<string, Set<() => void>>();
/** 各插件实例激活时加载的语言包：语言切换会重新激活并覆盖 */
const i18nCache = new Map<string, Record<string, unknown>>();

/* ---------------- store 契约（useSyncExternalStore 直接引用，不依赖 this） ---------------- */

export const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const snapshot = (): readonly PluginEntry[] => snapshotCache;

const emit = (): void => {
  snapshotCache = [...entries];
  listeners.forEach((fn) => fn());
};

/* ---------------- toast 桥接 ---------------- */

/** App 里用 useToast 注册进来；未注册时降级为 console.warn */
export const setToastDispatcher = (fn: ToastDispatcher | null): void => {
  toastDispatcher = fn;
};

const dispatchToast = (message: string, type: ToastType = "info"): void => {
  if (toastDispatcher) toastDispatcher(message, type);
  else console.warn("插件 toast：", message);
};

/* ---------------- 当前笔记桥接 ---------------- */

/**
 * App 的笔记选择状态注册进来的桥：插件的 ctx.notes.getCurrent() 走它取当前编辑器打开的笔记。
 * 外部文件 / 临时草稿 / 未选中时返回 null。App 未挂载时为 null。
 */
let currentNoteProvider: (() => PluginCurrentNote | null) | null = null;

export const setCurrentNoteProvider = (fn: (() => PluginCurrentNote | null) | null): void => {
  currentNoteProvider = fn;
};

/* ---------------- AI 设置桥接 ---------------- */

/**
 * AI 设置的运行时持有者（App 的 useAiState）注册进来的桥：
 * 插件的 ctx.ai.updateSettings 走它改 React 状态，由 useAiState 的 diff 效应落库，
 * 与设置页改动走完全相同的生效路径。App 未挂载（如纯设置窗口）时为 null。
 */
export interface AiSettingsBridge {
  get(): AiSettings;
  set(next: AiSettings): void;
  /** 从存储异步读回（App 未挂载的场景由桥自行处理，宿主不直连 AI 模块） */
  load(): Promise<AiSettings>;
  /** 默认设置（插件写入时用于类型校验） */
  defaults(): Record<string, unknown>;
  /** 合并后的边界归一化 */
  normalize(settings: AiSettings): AiSettings;
}

let aiSettingsBridge: AiSettingsBridge | null = null;

/** 注册 / 注销 AI 设置桥（App 挂载时注册，卸载时置 null） */
export const setAiSettingsBridge = (bridge: AiSettingsBridge | null): void => {
  aiSettingsBridge = bridge;
};

/**
 * 插件可写的 AI 设置键白名单：只含"行为参数"，
 * 刻意排除 API Key、服务商列表（不在 AiSettings 里）与访问档位
 * （aiAccessEnabled / defaultNoteAiAccess / defaultCategoryAiAccess 管的是数据可见性，不放给插件）。
 */
const AI_SETTINGS_WRITABLE_KEYS = new Set<string>([
  "minThinkingLen",
  "maxRounds",
  "contextBudget",
  "keepRecent",
  "toolResultChars",
  "retryShallowThinking",
  "autoTitle",
  "streaming",
  "confirmByDefault",
  "showToolTrace",
  "maxTokens",
  "composerHeight",
]);

/* ---------------- plugin modal 桥接 ---------------- */

/** 待渲染的 modal 队列：同一时刻只渲染队列头，其余等待 */
const modalQueue: { id: number; options: PluginModalOptions; resolve: (r: PluginModalResult) => void }[] = [];
/** modal 当前 id（自增，避免 Date.now 冲突） */
let modalSeq = 0;
/** 订阅者集合：管理器每次变更（push/shift）都通知 React 侧重渲染 */
const modalListeners = new Set<() => void>();

/** 订阅队列变更：React 组件用 useSyncExternalStore 消费 */
export const subscribePluginModal = (fn: () => void): (() => void) => {
  modalListeners.add(fn);
  return () => modalListeners.delete(fn);
};

/** 队列快照：React 组件读它来决定要不要渲染 Modal */
export const snapshotPluginModal = (): PluginModalOptions | null =>
  modalQueue.length > 0 ? modalQueue[0].options : null;

const emitModal = (): void => modalListeners.forEach((fn) => fn());

/**
 * 弹出一个宿主统一风格的确认/输入弹窗。Promise 化：resolve({ok:true,value}) 或 {ok:false}。
 * 同一时刻只能渲染一个 Modal，重复调用会被串行排队（跟 Toast 不同：Toast 并行堆叠，Modal 必须串）。
 */
export const showPluginModal = (options: PluginModalOptions): Promise<PluginModalResult> => {
  return new Promise<PluginModalResult>((resolve) => {
    const id = ++modalSeq;
    modalQueue.push({ id, options, resolve });
    emitModal();
  });
};

/** React 组件内部调用：确认时带上可选 value；取消时不带 value */
export const resolvePluginModal = (ok: boolean, value?: unknown): void => {
  const head = modalQueue.shift();
  if (!head) return;
  head.resolve({ ok, value });
  emitModal();
};

/**
 * 主动取消当前 modal（关闭按钮 / Esc 等）：如果有在等的就以 ok:false 结算。
 * 与 resolvePluginModal(false) 等价，但名字更直白，PluginModal 组件用这个也可以。
 */
export const cancelPluginModal = (): void => resolvePluginModal(false);

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行文案 */
const errorText = (e: unknown): string =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

/* ---------------- PluginContext ---------------- */

/** 按 schema 收集默认值：读取配置失败时的兜底，避免插件因配置缺失而加载失败 */
const configDefaults = (fields?: PluginConfigField[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const field of fields ?? []) {
    if (field.default !== undefined) out[field.key] = field.default;
  }
  return out;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 按软件当前语言加载插件自己的语言包。
 * 语言标识兼容两种写在插件里的 key：完整 locale（en-US / zh-CN）与基础语言（en / zh）。
 * 回退顺序：当前语言 → 基础语言 → zh → en → manifest.i18n 里的第一个 → 空对象；
 * 读取失败 / JSON 非法只记日志，绝不让插件激活失败。
 */
const loadPluginI18n = async (dirName: string, manifest?: PluginManifest): Promise<Record<string, unknown>> => {
  const map = manifest?.i18n;
  if (!map || Object.keys(map).length === 0) return {};
  const locale = getLocale();
  const baseLocale = locale.split("-")[0];
  const candidates: string[] = [];
  for (const lang of [locale, baseLocale, "zh", "en", ...Object.keys(map)]) {
    if (map[lang] && !candidates.includes(lang)) candidates.push(lang);
  }
  for (const lang of candidates) {
    try {
      const parsed: unknown = JSON.parse(await pluginsApi.readPluginResource(dirName, map[lang]));
      if (isPlainObject(parsed)) return parsed;
      console.warn(`插件「${dirName}」语言包 ${map[lang]} 不是 JSON 对象，已跳过`);
    } catch (e) {
      console.warn(`插件「${dirName}」读取语言包 ${map[lang]} 失败：`, e);
    }
  }
  return {};
};

/** 点号路径取值（menu.greet），只沿普通对象下钻；取不到返回 undefined */
const lookupMessage = (messages: Record<string, unknown>, key: string): unknown => {
  let current: unknown = messages;
  for (const part of key.split(".")) {
    if (!isPlainObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
};

/** 组装 ctx.i18n：语言包在激活时加载，缺 key / 非字符串回退 key 本身 */
const createPluginI18n = (dirName: string): PluginContext["i18n"] => {
  const messages = i18nCache.get(dirName) ?? {};
  return {
    locale: getLocale(),
    t: (key, vars) => {
      const value = lookupMessage(messages, key);
      return typeof value === "string" ? interpolate(value, vars) : key;
    },
    has: (key) => typeof lookupMessage(messages, key) === "string",
  };
};

/** 为指定插件实例构造运行上下文：贡献注册归属到该实例（dirName）名下，disposer 也按它收集 */
export const createPluginContext = (
  dirName: string,
  values?: Record<string, unknown>,
): PluginContext => {
  const manifest = installedManifests.get(dirName);
  const perms = manifest?.permissions ?? [];
  const hasWrite = perms.includes("notes.write");
  const hasRead = perms.includes("notes.read");
  const hasAiTool = perms.includes("ai.tool");
  const hasAiPrompt = perms.includes("ai.prompt");
  const hasAiProvider = perms.includes("ai.provider");
  const hasAiSettings = perms.includes("ai.settings");
  const hasSettingsSection = perms.includes("settings.section");

  /** 写 API 前置校验：没声明 notes.write 时统一抛中文错误 */
  const guardWrite = (): void => {
    if (!hasWrite) throw new Error(`插件未声明 notes.write 权限`);
  };

  /** AI tool 权限守卫：未声明 ai.tool 时拒绝注册 */
  const guardAiTool = (): void => {
    if (!hasAiTool) throw new Error(`插件未声明 ai.tool 权限`);
  };

  /** AI prompt 权限守卫：未声明 ai.prompt 时拒绝注入系统提示词 */
  const guardAiPrompt = (): void => {
    if (!hasAiPrompt) throw new Error(`插件未声明 ai.prompt 权限`);
  };

  /** AI provider 权限守卫：未声明 ai.provider 时拒绝注册服务商模板 */
  const guardAiProvider = (): void => {
    if (!hasAiProvider) throw new Error(`插件未声明 ai.provider 权限`);
  };

  /** AI settings 权限守卫：未声明 ai.settings 时拒绝读写 AI 设置 */
  const guardAiSettings = (): void => {
    if (!hasAiSettings) throw new Error(`插件未声明 ai.settings 权限`);
  };

  /** 设置分区权限守卫：未声明 settings.section 时拒绝注册设置分区 */
  const guardSettingsSection = (): void => {
    if (!hasSettingsSection) throw new Error(`插件未声明 settings.section 权限`);
  };

  /** 设置分区内容校验：groups 与顶层 fields 至少要有一个配置项，空分区在目录里没有意义 */
  const assertSettingsSectionFields = (section: PluginSettingsSection): void => {
    const hasFields =
      (section.fields?.length ?? 0) > 0 ||
      (section.groups ?? []).some((group) => group.fields.length > 0);
    if (!hasFields) throw new Error(`设置分区必须包含至少一个配置项`);
  };

  /**
   * 订阅一个生命周期钩子：hook 名固定，cb payload 类型由 PluginContext.hooks 精确声明。
   * registry 内部统一存 unknown payload，所以 subscribe 的 cb 也接 any。
   */
  const subscribe = (hook: PluginHook) => (cb: (payload: unknown) => void | Promise<void>): void => {
    registry.subscribeHook(hook, dirName, cb);
  };

  return {
  menu: {
    note: (item) => registry.registerNoteMenu(dirName, item),
    group: (item) => registry.registerGroupMenu(dirName, item),
  },
  command: (item) => registry.registerCommand(dirName, item),
  editor: {
    toolbar: (item) => registry.registerEditorToolbar(dirName, item),
    render: (markdown) => ({
      __pluginRender: "markdown" as const,
      markdown: String(markdown ?? ""),
    }),
  },
  ui: {
    toast: (message, type) => dispatchToast(message, type),
    modal: (options) => showPluginModal(options),
  },
  notes: {
    getContent: async (noteId) => (await getNote(noteId)).content,
    getCurrent: () => (hasRead ? currentNoteProvider?.() ?? null : null),
    create: async (title, content, categoryId) => {
      guardWrite();
      const note = await invoke("plugin_create_note", {
        title,
        content: content ?? "",
        categoryId: categoryId ?? null,
        pluginId: dirName,
      });
      return (note as { id: string }).id;
    },
    update: async (id, title, content) => {
      guardWrite();
      await invoke("plugin_update_note", {
        noteId: id,
        title,
        content,
        pluginId: dirName,
      });
    },
    remove: async (id) => {
      guardWrite();
      await invoke("plugin_delete_note", { noteId: id, pluginId: dirName });
    },
  },
  hooks: {
    onNoteCreate: subscribe("note-create") as any,
    onNoteSave: subscribe("note-save") as any,
    onNoteDelete: subscribe("note-delete") as any,
    onNoteSwitch: subscribe("note-switch") as any,
  } as PluginContext["hooks"],
  ai: {
    tool: (item) => {
      guardAiTool();
      registry.registerAiTool(dirName, item);
    },
    systemPrompt: (entry) => {
      guardAiPrompt();
      registry.registerAiPrompt(dirName, entry);
    },
    provider: (provider) => {
      guardAiProvider();
      registry.registerAiProvider(dirName, provider);
    },
    getSettings: async () => {
      guardAiSettings();
      const bridge = aiSettingsBridge;
      if (!bridge) throw new Error("AI 设置尚未就绪，请稍后重试");
      return { ...(await bridge.load()) };
    },
    updateSettings: async (patch) => {
      guardAiSettings();
      const bridge = aiSettingsBridge;
      if (!bridge) throw new Error("AI 设置尚未就绪，请稍后重试");
      const defaults = bridge.defaults();
      for (const [key, value] of Object.entries(patch)) {
        if (!AI_SETTINGS_WRITABLE_KEYS.has(key)) {
          throw new Error(`插件无权修改 AI 设置项「${key}」`);
        }
        if (typeof value !== typeof defaults[key]) {
          throw new Error(`AI 设置项「${key}」类型不正确`);
        }
      }
      // 合并后过一遍归一化收敛边界，再走桥写回（由 useAiState 的 diff 效应落库）
      bridge.set(bridge.normalize({ ...bridge.get(), ...patch }));
    },
  },
  settings: {
    section: (section) => {
      guardSettingsSection();
      assertSettingsSectionFields(section);
      registry.registerSettingsSection(dirName, section);
    },
  },
  config: {
    values:
      values ??
      configCache.get(dirName) ??
      configDefaults(manifest?.config),
    set: (patch) => setConfig(dirName, patch),
  },
  i18n: createPluginI18n(dirName),
  onDispose: (fn) => {
    const set = disposers.get(dirName);
    if (set) set.add(fn);
    else disposers.set(dirName, new Set([fn]));
  },
  };
};

/* ---------------- 激活 / 停用 ---------------- */

const removeStyleTag = (dirName: string): void => {
  document.head
    .querySelectorAll(`style[data-plugin-id="${dirName}"]`)
    .forEach((el) => el.remove());
};

const injectStyleTag = (dirName: string, css: string): void => {
  removeStyleTag(dirName);
  const style = document.createElement("style");
  style.dataset.pluginId = dirName;
  style.textContent = css;
  document.head.appendChild(style);
};

/** 执行并清空该插件登记的清理回调：LIFO 顺序，单个抛错只记日志，不阻断其余清理 */
const runDisposers = (dirName: string): void => {
  const set = disposers.get(dirName);
  if (!set) return;
  disposers.delete(dirName);
  [...set].reverse().forEach((fn) => {
    try {
      fn();
    } catch (e) {
      console.error(`插件「${dirName}」清理回调执行失败：`, e);
    }
  });
};

/** 自动生成的配置分区 id（没有主动贡献分区的插件统一用它） */
const AUTO_CONFIG_SECTION_ID = "config";

/**
 * 没有通过 ctx.settings.section 贡献分区的插件，按 manifest.config 自动生成一个配置分区。
 * 这里直接调 registry 的内部注册入口，不走带 settings.section 权限守卫的 ctx；
 * 插件自己声明了分区时跳过，避免重复。
 */
const registerAutoConfigSection = (dirName: string, entry: PluginEntry): void => {
  const fields = entry.config ?? [];
  if (fields.length === 0) return;
  if (registry.getSettingsSections().some((s) => s.pluginId === dirName)) return;
  registry.registerAutoSettingsSection(dirName, {
    id: AUTO_CONFIG_SECTION_ID,
    title: entry.name,
    icon: "ai-settings",
    fields,
  });
};

/** 激活一个插件实例：先撤销旧副作用并清旧贡献，再经 fastnote-plugin 协议 URL import entry；失败标记 failed 并 toast */
const activate = async (dirName: string): Promise<void> => {
  // 设置分区在激活期间保留旧定义（设置窗口不闪、输入框不失焦），激活完成后再清理
  const sectionEpoch = registry.beginSettingsSectionRefresh(dirName);
  runDisposers(dirName);
  registry.removePlugin(dirName, { keepSettingsSections: true });
  removeStyleTag(dirName);
  const entry = entries.find((e) => e.dirName === dirName);
  if (!entry) {
    registry.removePlugin(dirName);
    return;
  }
  const manifest = installedManifests.get(dirName);
  try {
    // 语言包读取失败只记日志并回退空对象，不能让插件整体加载失败
    i18nCache.set(dirName, await loadPluginI18n(dirName, manifest));
    // 配置读取失败只回退 schema 默认值，不能让插件整体加载失败
    const configValues = await pluginsApi
      .readPluginConfig(dirName)
      .catch(() => configDefaults(manifest?.config));
    configCache.set(dirName, configValues);
    if (manifest?.entry) {
      // 自定义协议 URL：浏览器原生解析模块内的相对 import（插件可拆多文件）；
      // ?v= 递增 bust 入口模块缓存，保证重新激活拿到新代码。
      // 子模块在 webview 模块图里按 URL 缓存，磁盘上改了子模块需重启应用才生效
      // （handler 已发 Cache-Control: no-store，重启后必然拿到最新内容）。
      const base = await pluginsApi.pluginModuleUrl(dirName, manifest.entry);
      entry.activations = (entry.activations ?? 0) + 1;
      const mod = await import(/* @vite-ignore */ `${base}?v=${entry.activations}`);
      await mod.default?.activate?.(createPluginContext(dirName, configValues));
    }
    if (manifest?.style) {
      const css = await pluginsApi.readPluginResource(dirName, manifest.style);
      registry.setPluginStyle(dirName, css);
      injectStyleTag(dirName, css);
    }
    // 记录插件显示名，供 registry 在 getNoteMenuGroups / getPluginCommands 里做分组标题
    registry.setPluginName(dirName, entry.name);
    // 本次没重新注册的旧分区先清掉，再决定要不要补自动配置分区
    registry.pruneSettingsSections(dirName, sectionEpoch);
    // 有 config schema 但没主动贡献设置分区时，宿主补一个「配置」分区（无需 settings.section 权限）
    registerAutoConfigSection(dirName, entry);
    entry.failed = false;
    entry.error = undefined;
  } catch (e) {
    entry.failed = true;
    entry.error = errorText(e);
    registry.removePlugin(dirName);
    removeStyleTag(dirName);
    runDisposers(dirName);
    dispatchToast(
      translate("插件「{name}」加载失败：{value1}", { name: entry.name, value1: entry.error }),
      "error",
    );
  }
};

/** 停用一个插件实例：执行 disposers + 清贡献 + 移除样式标签 */
const deactivate = (dirName: string): void => {
  cancelConfigActivation(dirName);
  runDisposers(dirName);
  registry.removePlugin(dirName);
  removeStyleTag(dirName);
  configCache.delete(dirName);
  i18nCache.delete(dirName);
};

/* ---------------- 列表同步与初始化 ---------------- */

const makeEntry = (manifest: PluginManifest): PluginEntry => ({
  id: manifest.id,
  dirName: manifest.dirName,
  name: manifest.name,
  version: manifest.version,
  author: manifest.author || undefined,
  description: manifest.description || undefined,
  iconUrl: manifest.iconUrl,
  tags: manifest.tags,
  homepage: manifest.homepage || undefined,
  config: manifest.config,
  permissions: manifest.permissions,
  enabled: enabledStates[manifest.dirName] ?? manifest.defaultEnabled,
});

/** 拉取已安装列表并同步进 entries：卸载掉的清贡献并移除，重复安装的更新展示字段 */
const syncInstalled = async (): Promise<void> => {
  const installed = await pluginsApi.listInstalledPlugins().catch(() => []);
  installedManifests = new Map(installed.map((m) => [m.dirName, m]));
  entries = entries.filter((entry) => {
    if (installedManifests.has(entry.dirName)) return true;
    deactivate(entry.dirName);
    return false;
  });
  for (const manifest of installed) {
    const existing = entries.find((e) => e.dirName === manifest.dirName);
    if (existing) {
      existing.id = manifest.id;
      existing.name = manifest.name;
      existing.version = manifest.version;
      existing.author = manifest.author || undefined;
      existing.description = manifest.description || undefined;
      existing.iconUrl = manifest.iconUrl;
      existing.tags = manifest.tags;
      existing.homepage = manifest.homepage || undefined;
      existing.config = manifest.config;
      existing.permissions = manifest.permissions;
    } else {
      entries.push(makeEntry(manifest));
    }
  }
  emit();
};

/** 重新激活所有启用的插件（activate 内部会先清旧贡献，重复激活安全） */
const activateEnabled = async (): Promise<void> => {
  for (const entry of [...entries]) {
    if (entry.enabled) await activate(entry.dirName);
  }
  emit();
};

/** 宿主完成首次激活后才响应语言变化，避免启动阶段重复激活 */
let hostReady = false;
let localeReactivationTimer: ReturnType<typeof setTimeout> | null = null;

/** 语言切换（含系统语言变化）防抖：连续变化只重激活一次 */
const scheduleLocaleReactivation = (): void => {
  if (!hostReady) return;
  if (localeReactivationTimer) clearTimeout(localeReactivationTimer);
  localeReactivationTimer = setTimeout(() => {
    localeReactivationTimer = null;
    void activateEnabled().catch((e) => console.error("语言切换后重新激活插件失败：", e));
  }, 100);
};

let localeSubscriptionStarted = false;
const startLocaleSubscription = (): void => {
  if (localeSubscriptionStarted) return;
  localeSubscriptionStarted = true;
  subscribeLocale(scheduleLocaleReactivation);
};

/** 拉取安装目录后同步并激活（installZip / refresh / uninstall 之后调用） */
const reload = async (): Promise<void> => {
  await syncInstalled();
  await activateEnabled();
};

/* ---------------- 启用状态持久化 ---------------- */

const loadEnabledStates = async (): Promise<Record<string, boolean>> => {
  const all = await getAppSettings();
  const raw = all[STATES_KEY];
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, boolean>;
    }
  } catch {
    // 持久化内容损坏时按无持久化处理，回退各插件默认值
  }
  return {};
};

const persistStates = async (): Promise<void> => {
  await setAppSetting(STATES_KEY, JSON.stringify(enabledStates));
};

/* ---------------- 对外操作 ---------------- */

/** 初始化（幂等）：非 Tauri 环境 no-op；读持久化 → 同步安装列表 → 激活启用的插件 */
export const init = async (): Promise<void> => {
  if (!isTauri() || initialized) return;
  initialized = true;
  enabledStates = await loadEnabledStates();
  await syncInstalled();
  await activateEnabled();
  hostReady = true;
  startLocaleSubscription();
};

/** 切换启用状态：持久化后启用（重新 activate）或禁用（清贡献 + 移除样式标签） */
export const setPluginEnabled = async (dirName: string, enabled: boolean): Promise<void> => {
  const entry = entries.find((e) => e.dirName === dirName);
  if (!entry || entry.enabled === enabled) return;
  entry.enabled = enabled;
  entry.failed = false;
  entry.error = undefined;
  emit();
  enabledStates = { ...enabledStates, [dirName]: enabled };
  try {
    await persistStates();
  } catch (e) {
    console.error("保存插件启用状态失败：", e);
  }
  if (enabled) await activate(dirName);
  else deactivate(dirName);
  emit();
};

/**
 * 配置写入后的重激活防抖：设置页逐字输入 / 连续切换多项时只跑最后一次，
 * 磁盘写入仍然立即发生，不会丢改动。
 */
const pendingConfigActivations = new Map<string, ReturnType<typeof setTimeout>>();

const CONFIG_ACTIVATE_DELAY_MS = 160;

const scheduleConfigActivation = (dirName: string): void => {
  const prev = pendingConfigActivations.get(dirName);
  if (prev !== undefined) clearTimeout(prev);
  const timer = setTimeout(() => {
    pendingConfigActivations.delete(dirName);
    // 延迟期间插件被停用 / 卸载时直接丢弃
    const entry = entries.find((e) => e.dirName === dirName);
    if (!entry?.enabled) return;
    void activate(dirName)
      .then(() => emit())
      .catch((e) => console.error("插件重激活失败：", e));
  }, CONFIG_ACTIVATE_DELAY_MS);
  pendingConfigActivations.set(dirName, timer);
};

/** 取消尚未执行的重激活（禁用 / 卸载插件时调用） */
const cancelConfigActivation = (dirName: string): void => {
  const timer = pendingConfigActivations.get(dirName);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingConfigActivations.delete(dirName);
};

/**
 * 写入插件配置（设置页与 ctx.config.set 共用）：立即落盘，稍后重激活该插件，
 * 让 activate 时应用的副作用（主题 class、隐藏统计、贡献注册等）立刻生效，
 * 不整表 reload，避免其他插件的贡献与样式闪烁。
 */
export const setConfig = async (dirName: string, patch: Record<string, unknown>): Promise<void> => {
  await pluginsApi.writePluginConfig(dirName, patch);
  const cached = configCache.get(dirName);
  if (cached) configCache.set(dirName, { ...cached, ...patch });
  const entry = entries.find((e) => e.dirName === dirName);
  // 停用中的插件没有需要重跑的副作用，只落库即可
  if (entry?.enabled) scheduleConfigActivation(dirName);
};

/** 安装插件包（zip）：失败 reject 由调用方展示 */
export const installZip = async (zipPath: string): Promise<PluginManifest> => {
  const manifest = await pluginsApi.installPluginZip(zipPath);
  await reload();
  return manifest;
};

/** 重新扫描插件目录（用户直接在文件夹里增删插件后手动刷新） */
export const refresh = async (): Promise<void> => {
  await reload();
};

/** 卸载插件：先清贡献，再删目录并同步列表 */
export const uninstall = async (dirName: string): Promise<void> => {
  deactivate(dirName);
  await pluginsApi.uninstallPlugin(dirName);
  delete enabledStates[dirName];
  try {
    await persistStates();
  } catch (e) {
    console.error("保存插件启用状态失败：", e);
  }
  await reload();
};

/** 汇总导出：字段都是不依赖 this 的函数，可整体传给 useSyncExternalStore */
export const pluginHost = {
  subscribe,
  snapshot,
  init,
  setToastDispatcher,
  setAiSettingsBridge,
  setCurrentNoteProvider,
  setPluginEnabled,
  setConfig,
  installZip,
  refresh,
  uninstall,
  createPluginContext,
};
