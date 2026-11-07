/**
 * 快捷键的运行时（模块级单例，不依赖 React）——**唯一的按键分发入口**。
 *
 * 为什么不用 React Context：
 * - `plugins/host.ts` 要在注册插件快捷键时同步查「这个键宿主自己占没占」，它不在组件树里；
 * - 处理函数来自各域（palette / 编辑器 / 设置 / 插件），用 Context 会把整棵树的依赖搅在一起。
 *
 * ## 分发顺序（决定了「谁抢到键」）
 * 1. **系统全局热键**：Rust 注册，按下时发 `fastnote://global-shortcut`，与窗口焦点无关；
 * 2. **窗口捕获阶段**（本文件在 window 上 capture=true）：先宿主动作，再插件 `app` 作用域动作；
 * 3. 编辑器内部的 `onKeyDown`（编辑器包自己处理 `editor.*`）。
 *
 * 第 2 步只对**有处理函数**的动作 `preventDefault`：编辑器动作在宿主侧没有 handler，
 * 事件会原样传给编辑器 —— 这正是「宿主拦一层又不干扰编辑器」的关键。
 *
 * ## 两个作用域
 * - `app`：窗口有焦点才生效（本文件的 keydown 监听）；
 * - `global`：系统级热键（Rust），窗口隐藏 / 托盘里也能按到。
 *   系统热键是独占资源，注册失败（别的软件占了）会记在 `failures` 里给界面提示。
 */
import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { syncGlobalShortcuts } from "@/api/system/shortcuts";
import {
  buildComboIndex,
  resolveShortcutBindings,
  SHORTCUT_ACTION_BY_ID,
  type ShortcutActionSpec,
  type ShortcutScope,
} from "@/config/shortcuts";
import { comboFromEvent, normalizeCombo, splitCombos, toGlobalAccelerator } from "@/lib/shortcuts/combo";
import { translate } from "@/i18n";

type ActionHandler = (payload?: unknown) => void;

/** 全局热键注册失败的记录（系统里已被别的软件占用 / 非法组合） */
export interface GlobalShortcutFailure {
  /** 宿主动作 id 或 `plugin:<dirName>:<combo>` */
  id: string;
  combo: string;
  reason: string;
}

/** 插件注册的一条键位 */
interface PluginShortcutEntry {
  dirName: string;
  scope: ShortcutScope;
  handler: ActionHandler;
}

/**
 * 初始就是**默认键位**，不是空表。
 *
 * 插件激活早于设置读回（App 的两个 effect 顺序 + 异步读库），空表会让插件在
 * 这几十毫秒里「以为宿主没有任何键位」，把 Ctrl+P 这类默认键抢走。
 */
const initialBindings = resolveShortcutBindings();

const state = {
  /** 数据库里的覆盖值（`app.config.shortcuts.*`） */
  overrides: {} as Record<string, string>,
  /** 动作 id → 生效键位数组 */
  bindings: initialBindings,
  /** 键位 → 动作 id */
  index: buildComboIndex(initialBindings),
  /** 宿主动作的处理函数（可多个订阅者） */
  handlers: new Map<string, Set<ActionHandler>>(),
  /** 插件键位：规范键位 → 条目（app / global 共用一张表，冲突判定才不会漏） */
  pluginShortcuts: new Map<string, PluginShortcutEntry>(),
  /** 键盘监听是否已挂上 */
  keyListenerAttached: false,
  /** 全局热键事件监听是否已挂上（listen 会累积，只能挂一次） */
  globalEventAttached: false,
  failures: [] as GlobalShortcutFailure[],
  /** 全局热键注册结果变化（设置面板显示「被系统占用」用） */
  listeners: new Set<() => void>(),
  /** 设置面板正处在「捕获新键位」状态：此时按什么键都不该触发动作 */
  captureActive: false,
};

const notify = () => {
  for (const listener of state.listeners) listener();
};

/**
 * 捕获态开关。
 * 没有它的话，用户在设置里改 Ctrl+F 时，按下 Ctrl+F 会先把原来的查找动作跑一遍
 * （window 捕获阶段早于面板的 onKeyDown），体验上是「改键顺便触发了一次功能」。
 */
export const setShortcutCapture = (active: boolean): void => {
  state.captureActive = active;
};

/* ---------------- 绑定与查询 ---------------- */

/**
 * 写入生效键位（App 在设置变化时调用）。
 * 同时刷新反查表并把全局热键重新同步给 Rust —— 后者是「替换式」注册，
 * 重复调用安全，且能顺手把改掉的旧键位注销。
 */
export function applyShortcutOverrides(overrides: Record<string, string> | null | undefined): void {
  state.overrides = { ...(overrides ?? {}) };
  state.bindings = resolveShortcutBindings(state.overrides);
  state.index = buildComboIndex(state.bindings);
  void syncGlobalHotkeys();
}

/** 当前生效的键位（动作 id → 键位数组） */
export const currentShortcutBindings = (): Record<string, string[]> => state.bindings;

/** 动作规格（文案 / 作用域），供设置面板与插件冲突提示使用 */
export const shortcutActionSpec = (id: string): ShortcutActionSpec | undefined =>
  SHORTCUT_ACTION_BY_ID[id];

/**
 * 这组键当前被谁占着：宿主动作 id / `plugin:<dir>:<combo>`。
 * 插件注册键位、面板改键都走它，保证「只有一份判定」。
 */
export function shortcutOwners(combo: string, exceptId?: string): string[] {
  const owners: string[] = [];
  for (const normalized of splitCombos(combo)) {
    const action = state.index[normalized];
    if (action && action !== exceptId) owners.push(action);
    const plugin = state.pluginShortcuts.get(normalized);
    if (plugin) {
      const pluginId = pluginShortcutId(plugin.dirName, normalized);
      if (pluginId !== exceptId) owners.push(pluginId);
    }
  }
  return [...new Set(owners)];
}

/** 占用者的可读名字（报错 / 提示文案用） */
export function shortcutOwnerLabel(id: string): string {
  if (id.startsWith("plugin:")) return `插件 ${id.split(":")[1] ?? ""}`;
  return SHORTCUT_ACTION_BY_ID[id]?.label ?? id;
}

/* ---------------- 宿主动作处理函数 ---------------- */

/** 注册一个宿主动作的处理函数，返回注销函数（组件卸载时调用） */
export function registerShortcutHandler(actionId: string, handler: ActionHandler): () => void {
  const set = state.handlers.get(actionId) ?? new Set<ActionHandler>();
  set.add(handler);
  state.handlers.set(actionId, set);
  attachKeyListener();
  return () => {
    const current = state.handlers.get(actionId);
    if (!current) return;
    current.delete(handler);
    if (current.size === 0) state.handlers.delete(actionId);
    detachIfIdle();
  };
}

/** 直接触发一个动作（全局热键事件、命令面板里点「快捷键」都可以复用） */
export function dispatchShortcutAction(actionId: string, payload?: unknown): boolean {
  const handlers = state.handlers.get(actionId);
  if (!handlers || handlers.size === 0) return false;
  for (const handler of [...handlers]) {
    try {
      handler(payload);
    } catch (error) {
      console.error(`快捷键动作 ${actionId} 执行失败：`, error);
    }
  }
  return true;
}

/* ---------------- 插件键位 ---------------- */

const pluginShortcutId = (dirName: string, combo: string) => `plugin:${dirName}:${combo}`;

/**
 * 插件注册一条键位。
 *
 * 冲突一律抛错（不回退、不静默覆盖）：插件注册失败时自己会 toast，
 * 用户能立刻知道「这个键被谁占了」，比悄无声息地不生效好排查。
 *
 * @returns 注销函数
 */
export function registerPluginShortcut(
  dirName: string,
  rawCombo: string,
  scope: ShortcutScope,
  handler: ActionHandler,
): () => void {
  const combo = normalizeCombo(rawCombo);
  if (!combo) throw new Error(translate("快捷键不能为空：{combo}", { combo: rawCombo }));
  const owners = shortcutOwners(combo, pluginShortcutId(dirName, combo));
  if (owners.length > 0) {
    throw new Error(
      translate("快捷键 {combo} 已被「{name}」占用", {
        combo: rawCombo,
        name: owners.map((id) => translate(shortcutOwnerLabel(id))).join(translate("、")),
      }),
    );
  }
  state.pluginShortcuts.set(combo, { dirName, scope, handler });
  if (scope === "app") attachKeyListener();
  else void syncGlobalHotkeys();
  return () => unregisterPluginShortcut(dirName, combo);
}

/** 注销某条插件键位 */
export function unregisterPluginShortcut(dirName: string, rawCombo: string): void {
  const combo = normalizeCombo(rawCombo);
  const entry = state.pluginShortcuts.get(combo);
  if (!entry || entry.dirName !== dirName) return;
  state.pluginShortcuts.delete(combo);
  if (entry.scope === "global") void syncGlobalHotkeys();
  detachIfIdle();
}

/** 插件停用 / 重激活时一次清空（比逐条注销可靠：漏一条就是幽灵快捷键） */
export function clearPluginShortcuts(dirName: string): void {
  let removedGlobal = false;
  for (const [combo, entry] of [...state.pluginShortcuts]) {
    if (entry.dirName !== dirName) continue;
    state.pluginShortcuts.delete(combo);
    if (entry.scope === "global") removedGlobal = true;
  }
  if (removedGlobal) void syncGlobalHotkeys();
  detachIfIdle();
}

/** 某个插件当前注册的键位（诊断面板用） */
export const pluginShortcutCombos = (dirName: string): string[] =>
  [...state.pluginShortcuts.entries()]
    .filter(([, entry]) => entry.dirName === dirName)
    .map(([combo]) => combo);

/* ---------------- 键盘监听 ---------------- */

/**
 * 窗口捕获阶段的按键分发。
 *
 * - `isComposing` 直接放行：输入法正在组词时按的键属于输入法；
 * - 宿主动作优先，插件 `app` 作用域动作其次（注册时已保证两者不撞键）；
 * - 编辑器动作在这里没有 handler，事件原样落到编辑器自己手里；
 * - **不** stopPropagation：掐断会打死编辑器与其它组件在 window 上的监听。
 */
function handleKeyDown(event: KeyboardEvent) {
  /*
   * 不按 `event.defaultPrevented` 提前退出：`main.tsx` 会在同一个阶段的更早时机
   * 对 Ctrl+P / F / G / H 统一 preventDefault（挡 WebView2 的原生打印与查找条），
   * 一旦这里尊重它，绑在这几个键上的宿主动作就永远收不到事件。
   * 冲突已经由注册时的判定排除了，这里按精确组合匹配即可。
   */
  if (state.captureActive || event.isComposing) return;
  const combo = comboFromEvent(event);
  if (!combo) return;

  const actionId = state.index[combo];
  if (actionId) {
    const spec = SHORTCUT_ACTION_BY_ID[actionId];
    /*
     * `global` 动作默认交给系统热键：注册成功后这组键已被系统截走，
     * 这里再执行一次就是「按一下、跑两遍」（切换窗口这类动作会立刻变回原样）。
     *
     * 例外：系统注册失败（键位被别的软件占用）或不在 Tauri 环境时，系统那条路不存在，
     * 退回窗口内分发 —— 否则改成一个被占用的全局键后，在窗口里也彻底按不动。
     */
    const handledBySystem = spec?.owner === "host" && spec.scope === "global" && systemHandlesGlobal(combo);
    if (spec?.owner === "host" && !handledBySystem && state.handlers.has(actionId)) {
      if (dispatchShortcutAction(actionId, event)) event.preventDefault();
      return;
    }
  }

  const plugin = state.pluginShortcuts.get(combo);
  if (!plugin) return;
  // 全局插件键同理：系统注册成功才由 Rust 派发，失败时退回窗口内触发一次
  if (plugin.scope === "global" && systemHandlesGlobal(combo)) return;
  event.preventDefault();
  try {
    plugin.handler(event);
  } catch (error) {
    console.error(`插件 ${plugin.dirName} 的快捷键回调失败：`, error);
  }
}

function attachKeyListener() {
  if (typeof window === "undefined" || state.keyListenerAttached) return;
  state.keyListenerAttached = true;
  window.addEventListener("keydown", handleKeyDown, true);
}

/** 没有任何键位要用窗口监听时摘掉（避免空转） */
function detachIfIdle() {
  if (!state.keyListenerAttached) return;
  const hasPluginApp = [...state.pluginShortcuts.values()].some((entry) => entry.scope === "app");
  if (state.handlers.size > 0 || hasPluginApp) return;
  state.keyListenerAttached = false;
  window.removeEventListener("keydown", handleKeyDown, true);
}

/* ---------------- 系统全局热键 ---------------- */

/**
 * 把「宿主全局动作 + 插件全局键位」合并后一次性同步给 Rust。
 *
 * 替换式而不是增量：一次 invoke 就能处理增删改，不会出现「旧键位忘了注销，
 * 改完之后两套键都能按」的幽灵状态。Rust 侧失败项按 id 返回，记在 `failures` 里。
 */
export async function syncGlobalHotkeys(): Promise<GlobalShortcutFailure[]> {
  if (!isTauri()) return [];
  attachGlobalEvent();
  const items: { id: string; accelerator: string }[] = [];
  for (const [id, combos] of Object.entries(state.bindings)) {
    if (SHORTCUT_ACTION_BY_ID[id]?.scope !== "global") continue;
    for (const combo of combos) items.push({ id, accelerator: toGlobalAccelerator(combo) });
  }
  for (const [combo, entry] of state.pluginShortcuts) {
    if (entry.scope !== "global") continue;
    items.push({
      id: pluginShortcutId(entry.dirName, combo),
      accelerator: toGlobalAccelerator(combo),
    });
  }
  try {
    const failures = await syncGlobalShortcuts(items);
    state.failures = failures.map((item) => ({
      id: item.id,
      combo: item.accelerator,
      reason: item.reason,
    }));
    notify();
    return state.failures;
  } catch (error) {
    console.error("同步全局热键失败：", error);
    return state.failures;
  }
}

/** 全局热键注册失败项（面板与插件诊断用） */
export const globalShortcutFailures = (): GlobalShortcutFailure[] => state.failures;

/** 订阅注册结果变化 */
export function subscribeGlobalShortcuts(listener: () => void): () => void {
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * 全局热键按下：Rust 只回传 id，这里再找处理函数。
 * `plugin:<dir>:<combo>` 的 id 直接解析出键位，回到插件表里取 handler。
 */
function attachGlobalEvent() {
  if (state.globalEventAttached || !isTauri()) return;
  state.globalEventAttached = true;
  void listen<string>("fastnote://global-shortcut", (event) => {
    const id = typeof event.payload === "string" ? event.payload : "";
    if (!id) return;
    if (id.startsWith("plugin:")) {
      // `plugin:` 之后的第一个冒号是分界，组合键里可能有 `mod+...`（没有冒号）
      const rest = id.slice("plugin:".length);
      const split = rest.indexOf(":");
      if (split < 0) return;
      const entry = state.pluginShortcuts.get(rest.slice(split + 1));
      if (entry && entry.scope === "global") {
        try {
          entry.handler();
        } catch (error) {
          console.error(`插件 ${entry.dirName} 的全局热键回调失败：`, error);
        }
      }
      return;
    }
    dispatchShortcutAction(id);
  }).catch((error) => {
    state.globalEventAttached = false;
    console.error("监听全局热键事件失败：", error);
  });
}

/** 设置面板用：这组键的系统注册失败原因（没有失败返回空串） */
export function globalFailureOf(combo: string): string {
  const accelerator = toGlobalAccelerator(combo);
  return state.failures.find((item) => item.combo === accelerator)?.reason ?? "";
}

/**
 * 这组键是否真的由操作系统接管了。
 * 只有「在 Tauri 里 + 注册成功」才算数；注册失败或浏览器预览时走窗口内分发。
 */
function systemHandlesGlobal(combo: string): boolean {
  return isTauri() && globalFailureOf(combo) === "";
}
