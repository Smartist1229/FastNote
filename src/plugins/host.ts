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
import { listen } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";

import * as pluginsApi from "@/api/system/plugins";
import type { PluginConfigField, PluginManifest } from "@/interface/system/plugins";
import { getNote } from "@/api/note/notes";
import { getAppSettings, setAppSetting } from "@/api/settings/settings";
import type { PluginModalOptions, PluginModalResult, ToastType } from "@/interface/app/ui";
import type { AiSettings } from "@/interface/ai/ai";
import { getLocale, subscribeLocale, translate } from "@/i18n";
import { interpolate } from "@/i18n/locale";
import {
  clearPluginShortcuts,
  globalShortcutFailures,
  pluginShortcutCombos,
  registerPluginShortcut,
  unregisterPluginShortcut,
} from "@/features/shortcuts/runtime";
import { startPluginSandbox, type PluginSandbox } from "./sandbox";
import { compareVersions } from "./version";
import * as registry from "./registry";
import type { PluginSettingsSection } from "./registry";
import type { PluginContext, PluginCurrentNote, PluginHook } from "./types";
import { errorText } from "@/lib/app/errorText";

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

/** 运行在沙箱里的插件：dirName → 隐藏 iframe 句柄（停用 / 重激活 / 卸载时销毁） */
const sandboxes = new Map<string, PluginSandbox>();

/** 拆掉沙箱：移除 iframe 与消息监听（宿主侧注册的资源由 disposers 统一清） */
const disposeSandbox = (dirName: string): void => {
  const sandbox = sandboxes.get(dirName);
  if (!sandbox) return;
  sandboxes.delete(dirName);
  try {
    sandbox.dispose();
  } catch (e) {
    console.error(`销毁插件沙箱「${dirName}」失败：`, e);
  }
};

/* ---------------- 插件快捷键 ----------------
 * 键位不分两张表：注册、冲突判定、app / global 两种作用域的分发统一在
 * `features/shortcuts/runtime.ts`。宿主的键位、其它插件的键位、系统注册失败
 * 都在那里一次判完 —— 这里只做权限校验与 disposer 登记。
 */

/* ---------------- 插件间消息总线 ----------------
 * 只在插件之间转发：topic 不做命名空间强制，但回调会带上发送方 dirName，
 * 方便插件自己过滤（也方便排查「谁把消息发出来的」）。
 */
interface BusSubscriber {
  dirName: string;
  handler: (payload: unknown, from: string) => void;
}

const busTopics = new Map<string, Set<BusSubscriber>>();

/** 注销某个插件的全部总线订阅（停用 / 卸载 / 重激活时调用） */
const clearPluginBus = (dirName: string): void => {
  for (const [topic, set] of [...busTopics]) {
    for (const sub of [...set]) {
      if (sub.dirName === dirName) set.delete(sub);
    }
    if (set.size === 0) busTopics.delete(topic);
  }
};

const dispatchBus = (topic: string, payload: unknown, from: string): void => {
  const set = busTopics.get(topic);
  if (!set) return;
  for (const sub of [...set]) {
    // 异步派发：handler 里再同步 emit 另一个 topic 也不会递归爆栈
    queueMicrotask(() => {
      try {
        sub.handler(payload, from);
      } catch (e) {
        console.error(`插件总线「${topic}」回调失败：`, e);
      }
    });
  }
};

/* ---------------- 应用版本（兼容性校验用） ---------------- */
let appVersionPromise: Promise<string> | null = null;
const getAppVersion = (): Promise<string> => {
  if (!appVersionPromise) {
    appVersionPromise = getVersion().catch(() => "0.0.0");
  }
  return appVersionPromise;
};

/* ---------------- 列表同步与初始化 ---------------- */
/** 插件声明的最低软件版本与当前不兼容时返回原因，否则 null */
const compatibilityProblem = async (manifest: PluginManifest): Promise<string | null> => {
  if (manifest.minAppVersion && manifest.minAppVersion.trim()) {
    const current = await getAppVersion();
    if (compareVersions(current, manifest.minAppVersion.trim()) < 0) {
      return translate("需要 FastNote ≥ {value1}，当前是 {value2}", {
        value1: manifest.minAppVersion.trim(),
        value2: current,
      });
    }
  }
  return null;
};

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

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行文案 */

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
  const hasDb = perms.includes("db.read_write");
  const hasFs = perms.includes("fs.read_write");
  const hasNet = perms.includes("net.fetch");
  const hasPluginWindow = perms.includes("window.open");
  const hasShortcut = perms.includes("shortcut.register");

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

  /** 插件私有表权限守卫 */
  const guardDb = (): void => {
    if (!hasDb) throw new Error(`插件未声明 db.read_write 权限`);
  };

  /** 文件存储权限守卫 */
  const guardFs = (): void => {
    if (!hasFs) throw new Error(`插件未声明 fs.read_write 权限`);
  };

  /** 联网权限守卫 */
  const guardNet = (): void => {
    if (!hasNet) throw new Error(`插件未声明 net.fetch 权限`);
  };

  /** 插件窗口权限守卫 */
  const guardWindow = (): void => {
    if (!hasPluginWindow) throw new Error(`插件未声明 window.open 权限`);
  };

  /** 快捷键权限守卫 */
  const guardShortcut = (): void => {
    if (!hasShortcut) throw new Error(`插件未声明 shortcut.register 权限`);
  };

  /** 登记清理回调：ctx.onDispose 与新扩展点内部共用同一份登记表（LIFO 执行） */
  const addDisposer = (fn: () => void): void => {
    const set = disposers.get(dirName);
    if (set) set.add(fn);
    else disposers.set(dirName, new Set([fn]));
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
    /**
     * 给宿主 <body> / <html> 加 / 去一个 class。
     * 沙箱插件的 document 是 iframe 自己的，改不到宿主页面，主题、隐藏统计这类效果走这里；
     * 停用 / 卸载时宿主自动移除（不用自己清）。
     */
    setBodyClass: (name, on) => {
      const cls = String(name ?? "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(cls)) {
        throw new Error(`非法的 class 名：「${cls}」`);
      }
      document.body.classList.toggle(cls, on !== false);
      addDisposer(() => document.body.classList.remove(cls));
    },
    /** 同 setBodyClass，作用在 <html> 上（主题类常挂这里） */
    setHtmlClass: (name, on) => {
      const cls = String(name ?? "").trim();
      if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(cls)) {
        throw new Error(`非法的 class 名：「${cls}」`);
      }
      document.documentElement.classList.toggle(cls, on !== false);
      addDisposer(() => document.documentElement.classList.remove(cls));
    },
    /**
     * 往宿主界面的某个元素里挂一个节点（装饰、状态块、工具条都靠它）。
     * target 传选择器或元素；返回移除函数，并自动登记到 onDispose——
     * 插件停用 / 卸载时宿主会摘掉，界面恢复原样。
     */
    mount: (target, node) => {
      const host =
        typeof target === "string" ? document.querySelector(target) : (target as Element | null);
      if (!host) throw new Error(`挂载点不存在：${String(target)}`);
      host.appendChild(node);
      const remove = (): void => {
        node.parentNode?.removeChild(node);
      };
      addDisposer(remove);
      return remove;
    },
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
  /**
   * 插件私有数据表：表名由宿主强制加 `plugin_<目录名>__` 前缀，插件只写裸名。
   * 宿主的表、其它插件的表都碰不到；update / remove 必须带过滤条件，防止手滑清表。
   */
  db: {
    createTable: async (table, columns) => {
      guardDb();
      await pluginsApi.pluginDbCreateTable(dirName, table, columns);
    },
    dropTable: async (table) => {
      guardDb();
      await pluginsApi.pluginDbDropTable(dirName, table);
    },
    tables: async () => {
      guardDb();
      return await pluginsApi.pluginDbTables(dirName);
    },
    insert: async (table, values) => {
      guardDb();
      return await pluginsApi.pluginDbInsert(dirName, table, values);
    },
    query: async (table, options) => {
      guardDb();
      return await pluginsApi.pluginDbQuery(dirName, table, options);
    },
    update: async (table, filter, values) => {
      guardDb();
      return await pluginsApi.pluginDbUpdate(dirName, table, filter, values);
    },
    remove: async (table, filter) => {
      guardDb();
      return await pluginsApi.pluginDbDelete(dirName, table, filter);
    },
    count: async (table, filter) => {
      guardDb();
      return await pluginsApi.pluginDbCount(dirName, table, filter);
    },
    addColumn: async (table, column) => {
      guardDb();
      return await pluginsApi.pluginDbAddColumn(dirName, table, column);
    },
    createIndex: async (table, name, columns, unique) => {
      guardDb();
      await pluginsApi.pluginDbCreateIndex(dirName, table, name, columns, unique);
    },
  },
  /**
   * 插件文件存储：只能碰自己的数据目录（插件目录会被升级整体覆盖，不适合放数据）。
   * 需要 fs.read_write 权限。
   */
  fs: {
    root: async () => {
      guardFs();
      return await pluginsApi.pluginFsRoot(dirName);
    },
    list: async (relDir) => {
      guardFs();
      return await pluginsApi.pluginFsList(dirName, relDir);
    },
    read: async (relPath) => {
      guardFs();
      return await pluginsApi.pluginFsRead(dirName, relPath);
    },
    write: async (relPath, content) => {
      guardFs();
      return await pluginsApi.pluginFsWrite(dirName, relPath, content);
    },
    remove: async (relPath) => {
      guardFs();
      await pluginsApi.pluginFsRemove(dirName, relPath);
    },
  },
  /**
   * 联网：宿主代发，只允许 manifest.netDomains 里声明的主机。
   * 前端 CSP 的 connect-src 不放宽，插件自己也 fetch 不到外网——想联网只能走这里。
   */
  net: {
    fetch: async (url, options) => {
      guardNet();
      return await pluginsApi.pluginNetFetch(dirName, url, options);
    },
  },
  /**
   * 插件间消息总线：无需权限，停用 / 卸载 / 重激活时宿主自动退订。
   */
  bus: {
    on: (topic, handler) => {
      const key = String(topic ?? "");
      if (!key) throw new Error("总线 topic 不能为空");
      const subscriber: BusSubscriber = { dirName, handler };
      const set = busTopics.get(key) ?? new Set<BusSubscriber>();
      set.add(subscriber);
      busTopics.set(key, set);
      const off = (): void => {
        const current = busTopics.get(key);
        current?.delete(subscriber);
        if (current && current.size === 0) busTopics.delete(key);
      };
      addDisposer(off);
      return off;
    },
    emit: (topic, payload) => {
      const key = String(topic ?? "");
      if (!key) throw new Error("总线 topic 不能为空");
      dispatchBus(key, payload, dirName);
    },
  },
  /**
   * 插件自己的窗口：加载插件目录里的 html（走 fastnote-plugin 协议），
   * 页面 / 样式 / 脚本全归插件。插件停用 / 卸载时宿主把它开的窗口全部关掉。
   */
  window: {
    open: async (relPath, options) => {
      guardWindow();
      return await pluginsApi.openPluginWindow(dirName, relPath, options);
    },
    /** 关掉指定标签的插件窗口（标签由 ctx.window.open 返回） */
    close: async (label) => {
      guardWindow();
      await pluginsApi.closePluginWindow(dirName, label);
    },
  },
  /**
   * 快捷键：注册即生效，插件停用 / 卸载 / 重激活时自动注销。
   *
   * `options.scope`：
   * - `"app"`（默认）窗口有焦点才生效；
   * - `"global"` 系统级热键，最小化 / 托盘里也能按到。
   *
   * 与宿主键位、其它插件、以及系统里已注册的热键冲突时**抛错**（不静默覆盖）：
   * 覆盖会让另一个功能凭空失效，而插件作者看不到任何反馈。
   */
  shortcut: {
    register: (combo, handler, options) => {
      guardShortcut();
      /*
       * 插件只允许窗口内快捷键。旧插件可能还传 scope: "global"，
       * 这里不吞掉它——原样交给 registerPluginShortcut 抛错，
       * 插件作者才能看到「这个能力不存在」，而不是以为自己注册成功了。
       */
      const requested = (options as { scope?: string } | undefined)?.scope;
      const scope = requested === "global" ? "global" : "app";
      const dispose = registerPluginShortcut(dirName, combo, scope, handler);
      // 注册即登记注销：重激活时 runDisposers 会先把它摘掉，不会越积越多
      addDisposer(dispose);
      return dispose;
    },
    unregister: (combo) => {
      unregisterPluginShortcut(dirName, combo);
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
  onDispose: addDisposer,
  };
};

/* ---------------- 激活 / 停用 ---------------- */

const removeStyleTag = (dirName: string): void => {
  document.head
    .querySelectorAll(`style[data-plugin-id="${dirName}"]`)
    .forEach((el) => el.remove());
};

/** 每个插件实例当前生效的样式表（Constructable Stylesheet，卸载时从 adoptedStyleSheets 摘掉） */
const pluginSheets = new Map<string, CSSStyleSheet>();

const removePluginStyle = (dirName: string): void => {
  removeStyleTag(dirName);
  const sheet = pluginSheets.get(dirName);
  if (!sheet) return;
  pluginSheets.delete(dirName);
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
};

/**
 * 写插件样式：优先用 Constructable Stylesheet，退路才是 <style> 元素。
 *
 * 生产包里必须走前者：`index.html` 的启动页内联 <style> 在打包时被 Tauri 打上了
 * nonce 并写进 CSP 的 style-src，按 CSP3「源列表里出现 nonce/hash 时 'unsafe-inline'
 * 失效」的规则，运行时新建的 <style> 会被整段拒绝（控制台报 CSP 违规），
 * 开发模式没有这条 CSP 所以看不出来——插件菜单（JS 贡献）照常，只有样式类效果
 * （主题 class、隐藏统计、装饰元素）静默失效。adoptedStyleSheets 不经过内联样式检查，
 * 也不依赖 CSP 放行，两种模式表现一致。
 *
 * `replaceSync` 会丢掉 @import，插件样式表不支持 @import（拆文件用 manifest.style 单文件）；
 * 老引擎或解析失败时退回 <style> 元素。
 */
const injectPluginStyle = (dirName: string, css: string): void => {
  removePluginStyle(dirName);
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    pluginSheets.set(dirName, sheet);
    // 赋值而非 push：adoptedStyleSheets 是只读的 FrozenArray，且顺序在文档样式表之后
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return;
  } catch (e) {
    console.warn(`插件「${dirName}」样式表解析失败，退回 <style> 注入：`, e);
  }
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
  // 重激活前先把旧快捷键 / 总线订阅摘干净：disposer 正常会处理，这里再兜一次
  disposeSandbox(dirName);
  clearPluginShortcuts(dirName);
  clearPluginBus(dirName);
  registry.removePlugin(dirName, { keepSettingsSections: true });
  removePluginStyle(dirName);
  const entry = entries.find((e) => e.dirName === dirName);
  if (!entry) {
    registry.removePlugin(dirName);
    return;
  }
  const manifest = installedManifests.get(dirName);
  try {
    // 手工拷进目录的插件没过安装期校验，这里再挡一次：不兼容就别激活，把原因挂在列表上
    if (manifest) {
      const problem = await compatibilityProblem(manifest);
      if (problem) throw new Error(problem);
    }
    // 语言包读取失败只记日志并回退空对象，不能让插件整体加载失败
    i18nCache.set(dirName, await loadPluginI18n(dirName, manifest));
    // 配置读取失败只回退 schema 默认值，不能让插件整体加载失败
    const configValues = await pluginsApi
      .readPluginConfig(dirName)
      .catch(() => configDefaults(manifest?.config));
    configCache.set(dirName, configValues);
    if (manifest?.entry) {
      const ctx = createPluginContext(dirName, configValues);
      // 每次激活递增：入口 URL（含沙箱运行时）都带上它，保证拿到磁盘上的新代码
      entry.activations = (entry.activations ?? 0) + 1;

      if (manifest.runtime === "sandbox") {
        // 沙箱模式：插件代码跑在独立源的隐藏 iframe 里，拿不到 IPC / 父页面；
        // 所有能力走 postMessage RPC，由 sandbox.ts 用上面这份 ctx 复核执行。
        disposeSandbox(dirName);
        const sandbox = await startPluginSandbox({
          dirName,
          manifest,
          entry: manifest.entry,
          version: entry.activations,
          ctx,
          messages: i18nCache.get(dirName) ?? {},
          onFail: (message) => {
            entry.failed = true;
            entry.error = message;
            emit();
          },
          // 沙箱插件的弹窗 content 回调里调 api.close/ok/cancel 时，落到宿主结束当前弹窗
          resolveModal: (ok, value) => resolvePluginModal(ok, value),
        });
        sandboxes.set(dirName, sandbox);
      } else {
        // 自定义协议 URL：浏览器原生解析模块内的相对 import（插件可拆多文件）。
        // 版本号进 URL 的路径段（/<dir>/v<N>/main.js），不是加在 query 上——
        // 子模块的相对 import 会解析成 /<dir>/v<N>/modules/x.js，整张模块图跟着换 URL，
        // 重新激活（含设置页「刷新」装新版）就能拿到磁盘上的新代码，不用重启软件。
        const base = await pluginsApi.pluginModuleUrl(
          dirName,
          manifest.entry,
          entry.activations,
        );
        const mod = await import(/* @vite-ignore */ base);
        await mod.default?.activate?.(ctx);
      }
    }
    if (manifest?.style) {
      const css = await pluginsApi.readPluginResource(dirName, manifest.style);
      injectPluginStyle(dirName, css);
    }
    // 记录插件显示名与配置 schema：前者供菜单分组标题，后者给设置分区补全字段定义
    registry.setPluginName(dirName, entry.name);
    registry.setPluginSchema(dirName, manifest?.config ?? []);
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
    removePluginStyle(dirName);
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
  // 快捷键兜底清理（正常路径由 disposer 逐个摘掉），窗口整批关掉：
  // 「关掉插件就恢复原样」包括它开的窗口与占用的键位
  clearPluginShortcuts(dirName);
  clearPluginBus(dirName);
  void pluginsApi.closePluginWindows(dirName).catch(() => {});
  registry.removePlugin(dirName);
  removePluginStyle(dirName);
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
  // 并行激活：插件之间没有依赖，串行会让启动时间随插件数线性增长。
  // 单个插件失败已在 activate 内部捕获（记 entry.error），不会影响其他插件。
  const targets = [...entries].filter((entry) => entry.enabled);
  await Promise.allSettled(targets.map((entry) => activate(entry.dirName)));
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

/**
 * 插件自己发起的「请求重新激活」事件名 —— 与 Rust 侧 plugin_reactivate 的 emit 一致。
 * 典型场景：插件在自己的窗口里改了数据（例如把快捷键存进私有表），
 * 要让主窗口重跑一遍 activate，注册类副作用（快捷键 / 菜单…）才会用上新值。
 */
const REACTIVATE_EVENT = "plugin:reactivate";

let reactivateSubscriptionStarted = false;
const startReactivateSubscription = (): void => {
  if (reactivateSubscriptionStarted || !isTauri()) return;
  reactivateSubscriptionStarted = true;
  void listen<string>(REACTIVATE_EVENT, (event) => {
    const dirName = event.payload;
    const entry = entries.find((e) => e.dirName === dirName);
    // 停用中的插件不重激活：请求来自它自己的窗口，窗口一旦关掉也没必要再跑
    if (!entry || !entry.enabled) return;
    void activate(dirName).catch((e) => console.error(`重新激活插件「${dirName}」失败：`, e));
  }).catch((e) => console.error("订阅插件重激活事件失败：", e));
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
  startReactivateSubscription();
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
/**
 * 查某个插件的私有表清单（卸载前问用户「要不要删表」用）。
 * 走不带权限校验的版本：老版本插件建过表、新版本又去掉了 db 权限时也要列得出来。
 */
export const pluginTables = async (dirName: string): Promise<string[]> => {
  try {
    return await pluginsApi.pluginDbListAllTables(dirName);
  } catch {
    return [];
  }
};

/** 删除某个插件的全部私有表（卸载时用户选择「删除」），返回删掉的表数 */
export const dropPluginTables = async (dirName: string): Promise<number> => {
  return await pluginsApi.pluginDbDropAll(dirName);
};

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

/** 重新加载单个插件（不重启软件）：等价于停用后再启用，副作用全部重跑 */
export const reloadPlugin = async (dirName: string): Promise<void> => {
  await activate(dirName);
  emit();
};

/** 诊断快照的原始读取：只读内存里的注册表与 manifest，不跑插件代码（同步、便宜） */
const readDiagnostics = (dirName: string) => {
  const entry = entries.find((e) => e.dirName === dirName);
  return {
    name: entry?.name ?? dirName,
    dirName,
    version: entry?.version ?? "",
    enabled: entry?.enabled ?? false,
    failed: entry?.failed ?? false,
    error: entry?.error ?? "",
    permissions: entry?.permissions ?? [],
    runtime: installedManifests.get(dirName)?.runtime ?? "inpage",
    shortcuts: pluginShortcutCombos(dirName),
    // 系统级热键注册失败（被别的软件占用）：插件自己拿不到这个信息，诊断面板必须显示
    shortcutFailures: globalShortcutFailures()
      .filter((failure) => failure.id.startsWith(`plugin:${dirName}:`))
      .map((failure) => `${failure.accelerator}：${failure.reason}`),
    contributions: registry.describePlugin(dirName),
  };
};

/** 诊断快照：注册表读数 + 采集方式标记 */
export type PluginDiagnostics = ReturnType<typeof readDiagnostics> & {
  /** true = 插件当时停用，数字是临时激活一次采集来的（采集完已停回去） */
  probed: boolean;
};

/**
 * 诊断快照：贡献统计 + 占用的快捷键 + 权限（排查「是不是没注册上」用）。
 *
 * 贡献统计来自内存里的注册表，而注册表只有插件跑过一次 activate 才有内容：
 * 停用中的插件，贡献早在 deactivate 里被清空了，直接读必然是清一色 0
 * ——这就是「未启用时要先点重新加载才看得到数字」的原因。
 *
 * 所以默认 probe：停用中的插件临时 activate 一次采集，取完立刻 deactivate 回去。
 * 对用户来说点「诊断」就能看到「它一旦启用会注册什么」，不用先重载再重看；
 * 对状态来说没有任何副作用——启用状态、持久化都不动，插件仍然是停用的。
 */
export const pluginDiagnostics = async (
  dirName: string,
  options?: { probe?: boolean },
): Promise<PluginDiagnostics> => {
  const entry = entries.find((e) => e.dirName === dirName);
  const probe = (options?.probe ?? true) && !entry?.enabled;
  if (!probe) return { ...readDiagnostics(dirName), probed: false };
  try {
    await activate(dirName);
    return { ...readDiagnostics(dirName), probed: true };
  } finally {
    // 诊断不能顺手把插件打开：不管激活成功还是失败，采集完都恢复成停用状态
    if (!entries.find((e) => e.dirName === dirName)?.enabled) deactivate(dirName);
    emit();
  }
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
  pluginTables,
  dropPluginTables,
  reloadPlugin,
  pluginDiagnostics,
  installZip,
  refresh,
  uninstall,
  createPluginContext,
};
