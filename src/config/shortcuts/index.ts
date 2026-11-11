/**
 * 全软件快捷键的**唯一清单**（纯数据 + 纯函数，不引 React）。
 *
 * 三类消费方都必须从这里取键位，不许各写一份：
 *   1. 运行时分发（`features/shortcuts/runtime.ts`）：窗口捕获阶段按这张表匹配；
 *   2. 设置面板（`components/settings/ShortcutPanel.tsx`）：可编辑清单、冲突提示、恢复默认；
 *   3. 插件宿主（`plugins/host.ts`）：插件注册键位时先来这里查是否被宿主占用。
 *
 * ## 两条硬线
 * - **动作 id 是稳定标识**，也是数据库里 `app.config.shortcuts.<id>` 的键。改文案可以，改 id 等于丢用户配置。
 * - **键位一律存规范写法** `mod+alt+shift+key`（见 `lib/shortcuts/combo.ts`）；字符串值用 `" / "` 分隔多个等价键，
 *   空字符串表示用户关掉了这个动作的键位（功能本身还在，只是没有快捷键）。
 *
 * ## 作用域
 * - `app`：窗口内有焦点时生效（window 捕获阶段）。绝大多数键位都属于这一档。
 * - `global`：系统级热键，窗口最小化 / 藏在托盘里也能按到，交给 Rust 的全局热键注册。
 *   注册系统热键是独占资源（被别的软件占了就注册失败），所以默认只给「唤起窗口」这类真需要的动作用。
 *
 * ## owner
 * - `host`：由软件自己分发（本仓库的 React 侧）。
 * - `editor`：由编辑器组件内部分发。设置里能改、能查冲突，但宿主**不**替它执行，
 *   只把键位通过 `config.shortcuts` 传进编辑器。
 */
import type { AppSettings } from "@/interface/settings/settings";
import { EDITOR_SHORTCUT_SPECS } from "@/markdown-editor/shortcuts";
import { joinCombos, splitCombos } from "@/lib/shortcuts/combo";

/** 生效范围：系统级 / 窗口内 */
export type ShortcutScope = "global" | "app";

/** 分组 id：设置面板按这个顺序分块展示 */
export type ShortcutGroupId = "app" | "editor-format" | "editor-edit" | "editor-search" | "editor-view";

/** 谁负责执行这个动作 */
export type ShortcutOwner = "host" | "editor";

export interface ShortcutActionSpec {
  /** 稳定 id，同时是配置键：`app.jump` / `editor.bold` */
  id: string;
  /** 默认键位（规范写法，`" / "` 分隔多个等价键） */
  default: string;
  scope: ShortcutScope;
  group: ShortcutGroupId;
  /** 中文文案，展示时过一次 `t()` */
  label: string;
  /** 补充说明：生效前提、易混点 */
  note?: string;
  owner: ShortcutOwner;
  /** 缺省表示始终可用；返回 false 时面板置灰并显示 offHint */
  available?: (settings: AppSettings) => boolean;
  offHint?: string;
}

export interface ShortcutGroupSpec {
  id: ShortcutGroupId;
  title: string;
  desc?: string;
}

/** 编辑器快捷键总开关关掉后，编辑器内所有键位都不存在 */
const editorShortcutsOn = (settings: AppSettings) => settings.editor.shortcuts;
const EDITOR_OFF = "编辑器快捷键已关闭";

/**
 * 软件自己的动作。
 *
 * 顺序就是面板里的顺序：先用得最多的（跳转 / 命令面板），再写笔记的动作，
 * 最后是全局热键（单独一组，见下面的分组表）。
 */
const HOST_ACTIONS: ShortcutActionSpec[] = [
  { id: "app.jump", default: "mod+p", scope: "app", group: "app", label: "快速跳转", note: "按标题与正文搜索笔记", owner: "host" },
  { id: "app.command", default: "mod+shift+p", scope: "app", group: "app", label: "命令面板", note: "新建、排序、主题、设置…", owner: "host" },
  { id: "app.newNote", default: "mod+n", scope: "app", group: "app", label: "新建笔记", note: "在当前分组里新建一篇空笔记", owner: "host" },
  { id: "app.save", default: "mod+s", scope: "app", group: "app", label: "保存 / 导出当前笔记", note: "编辑电脑上的文件时直接写回原文件", owner: "host" },
  { id: "app.settings", default: "mod+,", scope: "app", group: "app", label: "打开设置", owner: "host" },
  { id: "app.toggleSidebar", default: "mod+\\", scope: "app", group: "app", label: "折叠 / 展开侧栏", owner: "host" },
  { id: "app.toggleAi", default: "mod+shift+a", scope: "app", group: "app", label: "显示 / 隐藏 AI 面板", note: "需要先在设置里开启 AI", owner: "host", available: (s) => s.general.enableAI, offHint: "AI 已关闭" },
  { id: "app.toggleWindow", default: "mod+shift+space", scope: "global", group: "app", label: "全局唤起窗口", note: "任何程序在前台时都能把窗口叫出来 / 收回托盘", owner: "host" },
  { id: "app.quickNote", default: "mod+shift+n", scope: "global", group: "app", label: "全局速记", note: "唤起窗口并直接新建一篇笔记", owner: "host" },
];

/**
 * 编辑器自带的动作：默认键位与分组直接读 `markdown-editor/shortcuts.ts`，
 * 面板文案用这里的（编辑器语言包只覆盖格式类，撤销 / 查找这些没有对应词条）。
 */
const EDITOR_LABELS: Record<string, string> = {
  undo: "撤销",
  redo: "重做",
  save: "保存（编辑器内）",
  find: "打开查找",
  replace: "打开查找并展开替换",
  findNext: "下一个命中",
  findPrev: "上一个命中",
  fullscreen: "全屏 / 退出全屏",
  zoomIn: "放大字号",
  zoomOut: "缩小字号",
  zoomReset: "恢复默认字号",
};

const EDITOR_GROUP: Record<string, ShortcutGroupId> = {
  format: "editor-format",
  edit: "editor-edit",
  search: "editor-search",
  view: "editor-view",
  app: "app",
};

const EDITOR_AVAILABILITY: Record<string, (settings: AppSettings) => boolean> = {
  find: (s) => s.editor.searchEnabled,
  replace: (s) => s.editor.searchEnabled,
  findNext: (s) => s.editor.searchEnabled,
  findPrev: (s) => s.editor.searchEnabled,
  zoomIn: (s) => s.editor.ctrlScrollZoom,
  zoomOut: (s) => s.editor.ctrlScrollZoom,
  zoomReset: (s) => s.editor.ctrlScrollZoom,
};

/** 这些编辑器动作的可用性跟的是别的开关，因此不挂在「编辑器快捷键」总开关上 */
const EDITOR_INDEPENDENT = new Set(["find", "replace", "findNext", "findPrev", "zoomIn", "zoomOut", "zoomReset"]);

/**
 * 编辑器动作里的 `save` **不进清单**：宿主已有 `app.save`（同一个 mod+s），
 * 两行同键会让冲突检测天天报警；编辑器内部那条 save 在本软件里没有回调（见 NoteEditor），
 * 真正干活的是宿主的 `app.save`。
 */
const EDITOR_SKIP = new Set(["save"]);

const EDITOR_ACTIONS: ShortcutActionSpec[] = EDITOR_SHORTCUT_SPECS.filter(
  (spec) => !EDITOR_SKIP.has(spec.id),
).map((spec) => ({
  id: `editor.${spec.id}`,
  // 编辑器表里的 `default` 已用 ` / ` 分隔多个等价键
  default: joinCombos(splitCombos(spec.default)),
  scope: "app",
  group: EDITOR_GROUP[spec.group] ?? "editor-format",
  label: EDITOR_LABELS[spec.id] ?? spec.id,
  owner: "editor",
  available: EDITOR_INDEPENDENT.has(spec.id)
    ? EDITOR_AVAILABILITY[spec.id]
    : editorShortcutsOn,
  offHint: EDITOR_INDEPENDENT.has(spec.id)
    ? spec.id.startsWith("zoom")
      ? "字号缩放已关闭"
      : "查找已关闭"
    : EDITOR_OFF,
}));

/** 全部可配置动作：宿主在前，编辑器在后 */
export const SHORTCUT_ACTIONS: readonly ShortcutActionSpec[] = [...HOST_ACTIONS, ...EDITOR_ACTIONS];

/** id → 规格，冲突提示、面板渲染都要按 id 反查文案 */
export const SHORTCUT_ACTION_BY_ID: Record<string, ShortcutActionSpec> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((spec) => [spec.id, spec]),
);

/** 出厂默认键位表：同时是 `AppSettings.shortcuts` 的默认值（每条都是字符串） */
export const DEFAULT_SHORTCUT_SETTINGS: Record<string, string> = Object.fromEntries(
  SHORTCUT_ACTIONS.map((spec) => [spec.id, spec.default]),
);

export const SHORTCUT_GROUPS: readonly ShortcutGroupSpec[] = [
  { id: "app", title: "软件", desc: "窗口有焦点时生效；标「全局」的键在最小化 / 托盘里也生效" },
  { id: "editor-format", title: "编辑器 · 格式", desc: "焦点在正文里时生效" },
  { id: "editor-edit", title: "编辑器 · 编辑" },
  { id: "editor-search", title: "编辑器 · 查找替换" },
  { id: "editor-view", title: "编辑器 · 视图与缩放" },
];

/**
 * 覆盖值 → 每个动作实际生效的键位（数组，空数组 = 用户关掉了）。
 *
 * 只有 `overrides` 里**存在**的 id 才采用覆盖值：缺键回退默认，
 * 这样新增动作不用写迁移，老数据库里没有的键自动拿到默认键位。
 */
export function resolveShortcutBindings(
  overrides?: Record<string, string> | null,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const spec of SHORTCUT_ACTIONS) {
    const raw = overrides?.[spec.id];
    out[spec.id] = splitCombos(raw === undefined || raw === null ? spec.default : raw);
  }
  return out;
}

/**
 * 某个动作当前生效的**展示用**键位串（`" / "` 分隔多组键，没绑定就是空串）。
 * 命令面板等只读展示统一走这里，避免在 UI 里另写一份 "Ctrl+S" 常量——
 * 用户改键后提示会跟着变。
 */
export function shortcutKeyText(
  bindings: Record<string, string[]>,
  actionId: string,
): string {
  return joinCombos(bindings[actionId] ?? []);
}

/** 键位反查表：`mod+p` → `app.jump`（同一键位被两个动作占用时取先出现的，冲突由面板提示） */
export function buildComboIndex(bindings: Record<string, string[]>): Record<string, string> {
  const index: Record<string, string> = {};
  for (const [id, combos] of Object.entries(bindings)) {
    for (const combo of combos) if (!index[combo]) index[combo] = id;
  }
  return index;
}

/**
 * 编辑器配置里的 `shortcuts` 字段：动作 id → 键位数组 / `false`。
 *
 * 关掉的动作用 `false`（而不是空数组）表达，因为编辑器包的语义是「false 明确禁用」，
 * 而缺键表示「用包内默认」——两者不能混。
 */
export function resolveEditorShortcutOverrides(
  bindings: Record<string, string[]>,
): Record<string, string | string[] | false> {
  const out: Record<string, string | string[] | false> = {};
  for (const [id, combos] of Object.entries(bindings)) {
    if (!id.startsWith("editor.")) continue;
    const action = id.slice("editor.".length);
    out[action] = combos.length === 0 ? false : combos;
  }
  return out;
}
