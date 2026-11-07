/**
 * 插件贡献注册表：按插件 id 分桶存放菜单 / 命令 / 编辑器工具栏 / 样式贡献。
 *
 * 写入端只有 host（activate 时传入 PluginContext），读取端是右键菜单、命令面板与编辑器工具栏。
 * 插件禁用、卸载或 activate 抛错时，host 调 removePlugin 一次性清空该插件的全部贡献。
 * 本文件只做数据存取，不 import 任何 React 组件——icon 保持字符串名，由调用方转 JSX。
 *
 * 工具栏读取依赖当前笔记状态（when 过滤），而插件启停发生在组件渲染之外：
 * subscribeContributions + getContributionsVersion 提供一个稳定的 number 快照，
 * 供 useSyncExternalStore 感知变更（不要直接暴露数组，否则每次 getSnapshot 都是新引用）。
 */

import type { Note } from "@/interface/note/note";
import type { PluginConfigField } from "@/interface/system/plugins";
import type {
  EditorToolbarContext,
  PluginCommand,
  PluginContext,
  PluginEditorToolbarItem,
  PluginGroupMenuItem,
  PluginHook,
  PluginMenuItem,
} from "./types";

/** AI 工具贡献项（插件注册的只读工具） */
export interface PluginAiTool {
  id: string;
  /** 给模型看的一句话说明，如"统计指定笔记的字数" */
  desc: string;
  /** 给模型看的完整功能描述；缺省时用 desc */
  description?: string;
  /** UI 显示名；缺省时用 id */
  label?: string;
  /** 入参说明（与内置 TOOL_DEFS 相同的 {参数名: "类型说明"} 格式），如 { noteId: "笔记ID" } */
  args?: Record<string, string>;
  /** 执行器签名：args 来自模型，ctx 为只读的笔记访问接口 */
  handler: (args: Record<string, unknown>, ctx: PluginAiToolContext) => Promise<unknown>;
}

/** AI 系统提示词贡献项：向每次请求的系统提示词里注入一段文本 */
export interface PluginAiPromptContribution {
  id: string;
  /** 注入的提示词文本（空串会被忽略） */
  text: string;
  /** prepend = 放在内置提示词之前；append（默认）= 放在最后 */
  position?: "append" | "prepend";
}

/**
 * AI 服务商模板贡献项：只作为"新建服务商"的预填模板展示，
 * 不落库、不做运行时依赖；用户填好 API Key 保存后才写入 ai_providers 表。
 */
export interface PluginAiProvider {
  /** 插件内唯一 */
  id: string;
  /** 显示名 */
  name: string;
  /** API 地址 */
  baseUrl: string;
  /** 预置模型列表 */
  models?: string[];
  /** 提示用户去哪拿 key（可选） */
  apiKeyHint?: string;
  /** 请求头之外的自定义 headers（可选，当前不落库，仅作契约预留） */
  headers?: Record<string, string>;
}

/**
 * 设置分区内的字段分类：把 fields 收进一个带小标题的组。
 * 与分区顶层 fields 可同时存在，渲染时先按 groups 顺序、再渲染顶层 fields。
 */
/**
 * 分区里的一个字段：**只写 key 就够**——kind / default / options / min / max / step
 * 由宿主动从 manifest.config 里继承（唯一事实源），插件只在这里覆盖 label / description。
 * 这样就不会出现「分区声明的 kind 与 manifest 不一致 → 后端按 schema 过滤后写入被静默丢弃」。
 */
export type PluginSectionField = { key: string } & Partial<Omit<PluginConfigField, "key">>;

export interface PluginSettingsGroup {
  /** 分区内唯一 */
  id: string;
  /** 组标题 */
  title: string;
  /** 可选说明，渲染在组标题下方 */
  description?: string;
  /** 组内字段（可只写 key，其余继承 manifest.config） */
  fields: PluginSectionField[];
}

/**
 * 设置分区贡献项：插件在设置弹窗里加一个自己的分区。
 * 不写 UI 代码——fields / groups 与 plugin.json 的 config schema 同构，
 * 由宿主的通用渲染器复用设置控件渲染；值存到该插件自己的 config.json，改一项立即写盘。
 * 同一插件注册多个分区时，设置导航以插件名为父级形成二级菜单。
 */
export interface PluginSettingsSection {
  /** 插件内唯一 */
  id: string;
  /** 侧栏显示名 */
  title: string;
  /** 图标名（Icon 组件的 name）；缺省用 toolbox */
  icon?: string;
  /** 可选：把字段分成若干类，按顺序渲染 */
  groups?: PluginSettingsGroup[];
  /** 不分类的字段（或作为「通用」部分渲染在分组之后） */
  fields?: PluginSectionField[];
  /** 宿主按 manifest.config 自动生成的分区（不是插件通过 ctx.settings.section 主动声明） */
  auto?: boolean;
}

/** AI 工具只读 ctx：只能读笔记正文，不暴露写能力 */
export interface PluginAiToolContext {
  notes: {
    getContent(id: string): Promise<string>;
  };
}

/** 钩子回调签名：payload 由 emit 方决定，插件按 hook 类型自己收窄 */
export type PluginHookHandler = (payload: unknown) => void | Promise<void>;

/** 桶内一条笔记菜单贡献 */
interface NoteMenuEntry {
  pluginId: string;
  item: PluginMenuItem;
}

/** 桶内一条分组菜单贡献 */
interface GroupMenuEntry {
  pluginId: string;
  item: PluginGroupMenuItem;
}

/** 桶内一条编辑器工具栏贡献 */
interface EditorToolbarEntry {
  pluginId: string;
  item: PluginEditorToolbarItem;
}

/** 桶内一条 AI 工具贡献 */
interface AiToolEntry {
  pluginId: string;
  item: PluginAiTool;
}

/** 桶内一条 AI 提示词贡献 */
interface AiPromptBucketEntry {
  pluginId: string;
  item: PluginAiPromptContribution;
}

/** 桶内一条 AI 服务商模板贡献 */
interface AiProviderBucketEntry {
  pluginId: string;
  item: PluginAiProvider;
}

/** 桶内一条设置分区贡献 */
interface SettingsSectionBucketEntry {
  pluginId: string;
  item: PluginSettingsSection;
  /** 重激活代号：激活期间旧分区继续可见，结束后按代号清掉没重新注册的旧条目 */
  epoch: number;
}

const noteMenus = new Map<string, NoteMenuEntry[]>();
const groupMenus = new Map<string, GroupMenuEntry[]>();
const commands = new Map<string, PluginCommand[]>();
const editorToolbars = new Map<string, EditorToolbarEntry[]>();
const aiTools = new Map<string, AiToolEntry[]>();
const aiPrompts = new Map<string, AiPromptBucketEntry[]>();
const aiProviders = new Map<string, AiProviderBucketEntry[]>();
const settingsSections = new Map<string, SettingsSectionBucketEntry[]>();
const hooks = new Map<PluginHook, Map<string, PluginHookHandler>>();
const styles = new Map<string, string>();
/** dirName → manifest.name（插件显示名）；由 host 在激活成功后写入 */
const pluginNames = new Map<string, string>();
/** dirName → manifest.config：插件设置分区字段的类型 / 默认值都从这里继承 */
const pluginSchemas = new Map<string, PluginConfigField[]>();

/* ---------------- 写入端（PluginContext 背后就是这些） ---------------- */

export const registerNoteMenu = (pluginId: string, item: PluginMenuItem): void => {
  const bucket = noteMenus.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else noteMenus.set(pluginId, [{ pluginId, item }]);
};

export const registerCommand = (pluginId: string, item: PluginCommand): void => {
  const bucket = commands.get(pluginId);
  if (bucket) bucket.push(item);
  else commands.set(pluginId, [item]);
};

export const registerGroupMenu = (pluginId: string, item: PluginGroupMenuItem): void => {
  const bucket = groupMenus.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else groupMenus.set(pluginId, [{ pluginId, item }]);
};

export const registerAiTool = (pluginId: string, item: PluginAiTool): void => {
  const bucket = aiTools.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else aiTools.set(pluginId, [{ pluginId, item }]);
};

export const registerAiPrompt = (pluginId: string, item: PluginAiPromptContribution): void => {
  const bucket = aiPrompts.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else aiPrompts.set(pluginId, [{ pluginId, item }]);
  notifyContributionsChanged();
};

export const registerAiProvider = (pluginId: string, item: PluginAiProvider): void => {
  const bucket = aiProviders.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else aiProviders.set(pluginId, [{ pluginId, item }]);
  notifyContributionsChanged();
};

export const registerSettingsSection = (pluginId: string, item: PluginSettingsSection): void => {
  upsertSettingsSection(pluginId, item);
};

/** 设置分区按 id 幂等写入：重激活时用新定义替换旧条目，不会出现重复分区 */
const upsertSettingsSection = (pluginId: string, item: PluginSettingsSection): void => {
  const bucket = settingsSections.get(pluginId) ?? [];
  const entry: SettingsSectionBucketEntry = { pluginId, item, epoch: currentSettingsEpoch(pluginId) };
  const index = bucket.findIndex((e) => e.item.id === item.id);
  if (index >= 0) bucket[index] = entry;
  else bucket.push(entry);
  settingsSections.set(pluginId, bucket);
  notifyContributionsChanged();
};

/**
 * 宿主自动生成配置分区：不校验 settings.section 权限（权限守卫在 host 的 ctx 里，
 * 这条路径由 host 内部直接调用），分区标记 auto 供 UI 区分。
 */
export const registerAutoSettingsSection = (
  pluginId: string,
  item: Omit<PluginSettingsSection, "auto">,
): void => {
  upsertSettingsSection(pluginId, { ...item, auto: true });
};

/* ---------------- 设置分区的重激活代号 ---------------- */

const settingsEpochs = new Map<string, number>();

const currentSettingsEpoch = (pluginId: string): number => settingsEpochs.get(pluginId) ?? 0;

/**
 * 开始一次重激活：代号 +1 并返回。
 * 激活期间旧分区继续留在注册表里（设置导航不闪、输入框不失焦），
 * 激活结束后由 pruneSettingsSections 清理没重新注册的旧条目。
 */
export const beginSettingsSectionRefresh = (pluginId: string): number => {
  const next = currentSettingsEpoch(pluginId) + 1;
  settingsEpochs.set(pluginId, next);
  return next;
};

/** 激活完成：清掉代号早于本次 refresh 的旧分区（本次没再注册的分区视为已移除） */
export const pruneSettingsSections = (pluginId: string, epoch: number): void => {
  const bucket = settingsSections.get(pluginId);
  if (!bucket) return;
  const kept = bucket.filter((entry) => entry.epoch >= epoch);
  if (kept.length === bucket.length) return;
  if (kept.length === 0) settingsSections.delete(pluginId);
  else settingsSections.set(pluginId, kept);
  notifyContributionsChanged();
};

export const subscribeHook = (
  hook: PluginHook,
  pluginId: string,
  handler: PluginHookHandler,
): void => {
  let pluginBucket = hooks.get(hook);
  if (!pluginBucket) {
    pluginBucket = new Map();
    hooks.set(hook, pluginBucket);
  }
  pluginBucket.set(pluginId, handler);
};

export const registerEditorToolbar = (pluginId: string, item: PluginEditorToolbarItem): void => {
  const bucket = editorToolbars.get(pluginId);
  if (bucket) bucket.push({ pluginId, item });
  else editorToolbars.set(pluginId, [{ pluginId, item }]);
  notifyContributionsChanged();
};

export const setPluginStyle = (pluginId: string, css: string): void => {
  styles.set(pluginId, css);
};

/**
 * 记录插件的显示名（manifest.name）。由 host 在 activate 成功后调用，
 * 后续 getNoteMenuGroups / getPluginCommands 会用它做二级菜单分组与命令面板分组。
 */
export const setPluginName = (pluginId: string, name: string): void => {
  pluginNames.set(pluginId, name);
};

/** 写入该插件的配置 schema（激活成功后由 host 调用）；分区渲染时用它补全字段定义 */
export const setPluginSchema = (pluginId: string, config: PluginConfigField[]): void => {
  pluginSchemas.set(pluginId, config);
};

/** 某个插件当前的贡献统计（诊断面板用）：只数不返回细节，避免把注册表结构漏给 UI */
export interface PluginContributionSummary {
  noteMenus: number;
  groupMenus: number;
  commands: number;
  toolbars: number;
  aiTools: number;
  aiPrompts: number;
  aiProviders: number;
  settingsSections: number;
  hooks: number;
}

const countFor = <T>(bucket: Map<string, T[]> | undefined, pluginId: string): number =>
  bucket?.get(pluginId)?.length ?? 0;

export const describePlugin = (pluginId: string): PluginContributionSummary => {
  let hookCount = 0;
  for (const bucket of hooks.values()) {
    if (bucket.has(pluginId)) hookCount += 1;
  }
  return {
    noteMenus: countFor(noteMenus, pluginId),
    groupMenus: countFor(groupMenus, pluginId),
    commands: countFor(commands, pluginId),
    toolbars: countFor(editorToolbars, pluginId),
    aiTools: countFor(aiTools, pluginId),
    aiPrompts: countFor(aiPrompts, pluginId),
    aiProviders: countFor(aiProviders, pluginId),
    settingsSections: countFor(settingsSections, pluginId),
    hooks: hookCount,
  };
};

/* ---------------- 贡献变更订阅 ---------------- */

const contributionListeners = new Set<() => void>();
let contributionsVersion = 0;

/** 订阅贡献变更（useSyncExternalStore 的 subscribe），返回取消订阅函数 */
export const subscribeContributions = (fn: () => void): (() => void) => {
  contributionListeners.add(fn);
  return () => {
    contributionListeners.delete(fn);
  };
};

/** 贡献版本号：只在变更时递增，作为 useSyncExternalStore 的稳定快照 */
export const getContributionsVersion = (): number => contributionsVersion;

const notifyContributionsChanged = (): void => {
  contributionsVersion += 1;
  contributionListeners.forEach((fn) => fn());
};

/* ---------------- 读取端 ---------------- */

/**
 * 笔记菜单单条读取结果：note 已绑定进 onClick（若存在），
 * icon 仍是图标名，由调用方转成 JSX。
 * submenu 也是同样的结构——任意深度嵌套。
 */
export interface PluginNoteMenuEntry {
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  /** 有 submenu 的项可以没有 onClick（hover 展开） */
  onClick?: (ctx: PluginContext) => void | Promise<void>;
  /** 嵌套子菜单，任意深度 */
  submenu?: PluginNoteMenuEntry[];
}

/** 一个插件的整组笔记菜单项，用来在宿主菜单里渲染成二级菜单 */
export interface PluginNoteMenuGroup {
  pluginId: string;
  pluginName: string;
  items: PluginNoteMenuEntry[];
}

/** 命令面板读取结果 */
export interface PluginCommandEntry {
  pluginId: string;
  /** 插件显示名（manifest.name），宿主命令面板里作为 group 标题 */
  group: string;
  id: string;
  label: string;
  icon?: string;
  run: (ctx: PluginContext) => void | Promise<void>;
}

/** 编辑器工具栏读取结果：ctx 已绑定进 onClick，icon 仍是图标名，由调用方转成 JSX */
export interface PluginEditorToolbarEntry {
  pluginId: string;
  id: string;
  title: string;
  icon?: string;
  label?: string;
  onClick: (ctx: PluginContext) => void | Promise<void>;
}

/**
 * 菜单 / 工具栏项的显示条件。
 *   - 函数：inpage 插件用，每次渲染同步求值；
 *   - 对象：**沙箱插件必须用这种**（跨 iframe 不能同步调用函数）——
 *     `{ field: "is_locked", is: "falsy" }`，is 支持 truthy / falsy / equals / notEquals。
 */
export const evaluateWhen = (when: unknown, subject: unknown): boolean => {
  if (!when) return true;
  if (typeof when === "function") {
    try {
      return Boolean((when as (arg: unknown) => boolean)(subject));
    } catch (e) {
      console.error("插件条件（when）求值失败：", e);
      return false;
    }
  }
  if (typeof when === "object") {
    const rule = when as { field?: string; is?: string; value?: unknown };
    const field = String(rule.field ?? "");
    if (!field) return true;
    const actual = (subject as Record<string, unknown> | null | undefined)?.[field];
    switch (rule.is) {
      case "truthy":
        return Boolean(actual);
      case "falsy":
        return !actual;
      case "equals":
        return actual === rule.value;
      case "notEquals":
        return actual !== rule.value;
      default:
        return Boolean(actual);
    }
  }
  return true;
};

/**
 * 递归把 PluginMenuItem 转成 PluginNoteMenuEntry：note 绑定进 onClick，
 * 子项也按各自的 when 过滤；叶子项没有 onClick 时（比如只做分组的子菜单项）onClick 保持 undefined。
 */
const buildNoteMenuEntry = (pluginId: string, item: PluginMenuItem, note: Note): PluginNoteMenuEntry | null => {
  if (!evaluateWhen(item.when, note)) return null;
  let submenu: PluginNoteMenuEntry[] | undefined;
  if (item.submenu && item.submenu.length > 0) {
    const kids = item.submenu
      .map((sub) => buildNoteMenuEntry(pluginId, sub, note))
      .filter((e): e is PluginNoteMenuEntry => e !== null);
    if (kids.length > 0) submenu = kids;
  }
  return {
    pluginId,
    id: item.id,
    label: item.label,
    icon: item.icon,
    danger: item.danger,
    onClick: item.onClick ? (ctx) => item.onClick!(note, ctx) : undefined,
    submenu,
  };
};

/**
 * 当前笔记可用的插件菜单项：按插件分组返回，
 * 每个 group 里的 items 按注册顺序排列；子菜单任意深度嵌套，
 * 声明了 when 的贡献（包括子项）先过滤。没有插件贡献时返回空数组。
 */
export const getNoteMenuGroups = (note: Note): PluginNoteMenuGroup[] => {
  const out: PluginNoteMenuGroup[] = [];
  for (const [pluginId, bucket] of noteMenus) {
    const items: PluginNoteMenuEntry[] = [];
    for (const { item } of bucket) {
      const entry = buildNoteMenuEntry(pluginId, item, note);
      if (entry) items.push(entry);
    }
    if (items.length === 0) continue;
    const pluginName = pluginNames.get(pluginId) ?? pluginId;
    out.push({ pluginId, pluginName, items });
  }
  return out;
};

/** 兼容别名：旧调用可能还在用 getNoteMenuItems 做扁平取项，本仓库已无该路径，保留导出以防外部依赖 */
export const getNoteMenuItems = (note: Note): PluginNoteMenuEntry[] => {
  const groups = getNoteMenuGroups(note);
  const flat: PluginNoteMenuEntry[] = [];
  for (const g of groups) flat.push(...g.items);
  return flat;
};

/** 全部插件命令：按注册顺序返回，group 填插件显示名（manifest.name） */
export const getPluginCommands = (): PluginCommandEntry[] => {
  const out: PluginCommandEntry[] = [];
  for (const [pluginId, bucket] of commands) {
    const group = pluginNames.get(pluginId) ?? pluginId;
    for (const item of bucket) {
      out.push({
        pluginId,
        group,
        id: item.id,
        label: item.label,
        icon: item.icon,
        run: item.run,
      });
    }
  }
  return out;
};

export const getPluginStyle = (pluginId: string): string | undefined => styles.get(pluginId);

/**
 * 当前编辑器可用的插件工具栏项：按注册顺序返回（先按插件、再按插件内注册顺序）。
 * 声明了 when 的贡献先按当前笔记状态过滤，并通过闭包把本次 ctx 绑定进 onClick；
 * 没有插件贡献时返回空数组，工具栏输出与无插件时完全一致。
 */
export const getEditorToolbarItems = (
  ctx: EditorToolbarContext,
): PluginEditorToolbarEntry[] => {
  const out: PluginEditorToolbarEntry[] = [];
  for (const bucket of editorToolbars.values()) {
    for (const { pluginId, item } of bucket) {
      if (!evaluateWhen(item.when, ctx)) continue;
      out.push({
        pluginId,
        id: item.id,
        title: item.title,
        icon: item.icon,
        label: item.label,
        onClick: (plugin) => item.onClick(ctx, plugin),
      });
    }
  }
  return out;
};

/* ---------------- 分组菜单读取 ---------------- */

/** 分组菜单读取结果：ctx 在调用时绑定 */
export interface PluginGroupMenuEntry {
  pluginId: string;
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: (ctx: PluginContext) => void | Promise<void>;
  submenu?: PluginGroupMenuEntry[];
}

/** 一个插件的整组分组菜单项，用来在宿主分组菜单里渲染成二级菜单 */
export interface PluginGroupMenuGroup {
  pluginId: string;
  pluginName: string;
  items: PluginGroupMenuEntry[];
}

const buildGroupMenuEntry = (pluginId: string, item: PluginGroupMenuItem): PluginGroupMenuEntry | null => {
  let submenu: PluginGroupMenuEntry[] | undefined;
  if (item.submenu && item.submenu.length > 0) {
    const kids = item.submenu
      .map((sub) => buildGroupMenuEntry(pluginId, sub))
      .filter((e): e is PluginGroupMenuEntry => e !== null);
    if (kids.length > 0) submenu = kids;
  }
  return {
    pluginId,
    id: item.id,
    label: item.label,
    icon: item.icon,
    danger: item.danger,
    onClick: item.onClick,
    submenu,
  };
};

/**
 * 全部插件分组菜单项：按插件分组返回，没有插件贡献时返回空数组。
 * 分组菜单的 when 以"当前分组 kind / category 状态"为条件；当前版本分组菜单不做上下文
 * （只传 kind 和 handlers），when 在插件侧自己判断。
 */
export const getGroupMenuGroups = (): PluginGroupMenuGroup[] => {
  const out: PluginGroupMenuGroup[] = [];
  for (const [pluginId, bucket] of groupMenus) {
    const items: PluginGroupMenuEntry[] = [];
    for (const { item } of bucket) {
      const entry = buildGroupMenuEntry(pluginId, item);
      if (entry) items.push(entry);
    }
    if (items.length === 0) continue;
    const pluginName = pluginNames.get(pluginId) ?? pluginId;
    out.push({ pluginId, pluginName, items });
  }
  return out;
};

/* ---------------- AI 工具读取 ---------------- */

/** 插件 AI 工具读取结果：AI 对话面板拿来合并到内置工具 */
export interface PluginAiToolEntry {
  pluginId: string;
  id: string;
  desc: string;
  /** 给模型看的完整功能描述（缺省回退 desc） */
  description: string;
  /** UI 显示名（缺省回退 id） */
  label: string;
  args: Record<string, string>;
  handler: (args: Record<string, unknown>, ctx: PluginAiToolContext) => Promise<unknown>;
}

/** 全部插件 AI 工具：按插件分组，合并进 TOOL_DEFS 与 TOOL_EXECUTORS */
export const getAiTools = (): PluginAiToolEntry[] => {
  const out: PluginAiToolEntry[] = [];
  for (const bucket of aiTools.values()) {
    for (const { pluginId, item } of bucket) {
      out.push({
        pluginId,
        id: item.id,
        desc: item.desc,
        description: item.description ?? item.desc,
        label: item.label ?? item.id,
        args: item.args ?? {},
        handler: item.handler,
      });
    }
  }
  return out;
};

/* ---------------- AI 提示词读取 ---------------- */

/** 插件 AI 提示词读取结果：拼装系统提示词时按 position 分两组注入 */
export interface PluginAiPromptEntry {
  pluginId: string;
  id: string;
  text: string;
  position: "append" | "prepend";
}

/** 全部插件 AI 提示词：按注册顺序返回（先按插件、再按插件内注册顺序） */
export const getAiPrompts = (): PluginAiPromptEntry[] => {
  const out: PluginAiPromptEntry[] = [];
  for (const bucket of aiPrompts.values()) {
    for (const { pluginId, item } of bucket) {
      const text = item.text.trim();
      if (!text) continue;
      out.push({ pluginId, id: item.id, text, position: item.position ?? "append" });
    }
  }
  return out;
};

/* ---------------- AI 服务商模板读取 ---------------- */

/** 插件 AI 服务商模板读取结果：pluginName 用于界面上的「插件 · xx」标记 */
export interface PluginAiProviderEntry extends PluginAiProvider {
  pluginId: string;
  pluginName: string;
}

/** 全部插件贡献的 AI 服务商模板：按注册顺序返回；只是模板，不落库 */
export const getAiProviders = (): PluginAiProviderEntry[] => {
  const out: PluginAiProviderEntry[] = [];
  for (const [pluginId, bucket] of aiProviders) {
    const pluginName = pluginNames.get(pluginId) ?? pluginId;
    for (const { item } of bucket) {
      out.push({ ...item, pluginId, pluginName });
    }
  }
  return out;
};

/* ---------------- 设置分区读取 ---------------- */

/** 插件设置分区读取结果：pluginName 用于界面上的分组展示 */
export interface PluginSettingsSectionEntry {
  pluginId: string;
  pluginName: string;
  section: PluginSettingsSection;
  /** 该插件 manifest.config：分区字段缺省值 / 类型的唯一事实源 */
  config: PluginConfigField[];
}

/** 全部插件贡献的设置分区：按注册顺序返回（先按插件、再按插件内注册顺序） */
export const getSettingsSections = (): PluginSettingsSectionEntry[] => {
  const out: PluginSettingsSectionEntry[] = [];
  for (const [pluginId, bucket] of settingsSections) {
    const pluginName = pluginNames.get(pluginId) ?? pluginId;
    const config = pluginSchemas.get(pluginId) ?? [];
    for (const { item } of bucket) {
      out.push({ pluginId, pluginName, section: item, config });
    }
  }
  return out;
};

/* ---------------- 钩子发射 ---------------- */

/**
 * 发射一个生命周期钩子：遍历所有订阅了该 hook 的插件，异步非阻塞执行。
 * 单个 handler 抛错 catch 掉不影响其他 handler，也不阻塞笔记操作流程。
 */
export const emitPluginHook = async (hook: PluginHook, payload: unknown): Promise<void> => {
  const pluginBucket = hooks.get(hook);
  if (!pluginBucket || pluginBucket.size === 0) return;
  for (const handler of pluginBucket.values()) {
    Promise.resolve()
      .then(() => handler(payload))
      .catch((e) => console.error(`[plugin-hook:${hook}] handler failed:`, e));
  }
};

/**
 * 清空某插件的全部贡献（菜单、命令、工具栏、样式、显示名、钩子、AI 工具 / 提示词 / 服务商模板）；
 * 样式标签的移除由 host 负责。
 *
 * keepSettingsSections：重激活时用。保留设置分区与显示名直到新的一次激活结束，
 * 让设置窗口在激活期间仍能渲染原来的分区（导航不闪、输入框不失焦），
 * 之后由 pruneSettingsSections 清掉没重新注册的旧条目。
 */
export const removePlugin = (
  pluginId: string,
  options?: { keepSettingsSections?: boolean },
): void => {
  noteMenus.delete(pluginId);
  groupMenus.delete(pluginId);
  commands.delete(pluginId);
  editorToolbars.delete(pluginId);
  aiTools.delete(pluginId);
  aiPrompts.delete(pluginId);
  aiProviders.delete(pluginId);
  // 清理该插件的所有钩子订阅
  for (const pluginBucket of hooks.values()) {
    pluginBucket.delete(pluginId);
  }
  styles.delete(pluginId);
  if (!options?.keepSettingsSections) {
    settingsSections.delete(pluginId);
    settingsEpochs.delete(pluginId);
    pluginNames.delete(pluginId);
  }
  notifyContributionsChanged();
};
