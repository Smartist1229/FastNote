/**
 * 编辑器默认键位的**单一事实源**（纯数据，不引 React，可以被软件层安全地静态导入）。
 *
 * 两个消费方：
 * - `components/MarkdownEditor.tsx` 用它建快捷键映射表；
 * - 软件层 `config/shortcuts/index.ts` 用同一张表生成「设置 → 快捷键」的可编辑清单。
 *
 * 分成单独文件的原因：组件入口 `index.ts` 会把整个编辑器（含 React、KaTeX 懒加载）
 * 拖进主包，而设置面板只需要一张表——表放这里，两个包各取所需。
 *
 * ## 键位模型
 * 现在是 **动作 → 键位**（老版本是「键位 → 动作」，改一条要同时删旧键加新键）：
 * - 动作 id 是稳定标识，也是调用方覆盖键位时的键：`config.shortcutBindings = { bold: "mod+alt+b" }`；
 * - 一个动作可以绑多个等价键（默认值里用 `/` 分隔），覆盖时也可以传数组；
 * - 传 `false` 关闭某个动作的键位（工具栏按钮仍然可用）。
 *
 * 键名归一化有两处，必须产出同一种写法，否则「改了键位没反应」：
 * 组件的 `acceleratorOf`（事件 → 字符串）与本文件的 `normalizeEditorCombo`（配置 → 字符串）。
 * `mod` = Windows / Linux 的 Ctrl、macOS 的 ⌘。
 */
import { resolveLocaleLabels } from "./locales";
import type { MarkdownEditorLocale } from "./types";

/** 一个可配置的动作：id 稳定，default 里用 ` / ` 分隔多个等价键 */
export interface EditorShortcutSpec {
  /** 动作 id，同时也是 `config.shortcutBindings` 的键 */
  id: string;
  /** 默认键位（已归一化）：`mod+shift+z / mod+y` */
  default: string;
  /** 分组：软件层生成设置清单时用来归类 */
  group: "format" | "edit" | "search" | "view" | "app";
}

/**
 * 编辑器自己处理的**全部**键位。顺序有讲究：设置面板按这个顺序展示，
 * 格式类在前（最常用），其余按「编辑 → 查找 → 视图」。
 */
export const EDITOR_SHORTCUT_SPECS: readonly EditorShortcutSpec[] = [
  { id: "bold", default: "mod+b", group: "format" },
  { id: "italic", default: "mod+i", group: "format" },
  { id: "strike", default: "mod+shift+x", group: "format" },
  { id: "inlineCode", default: "mod+e", group: "format" },
  { id: "codeBlock", default: "mod+shift+e", group: "format" },
  { id: "link", default: "mod+k", group: "format" },
  { id: "image", default: "mod+shift+k", group: "format" },
  { id: "quote", default: "mod+shift+.", group: "format" },
  { id: "orderedList", default: "mod+shift+7", group: "format" },
  { id: "bulletList", default: "mod+shift+8", group: "format" },
  { id: "taskList", default: "mod+shift+9", group: "format" },
  { id: "math", default: "mod+shift+m", group: "format" },
  { id: "footnote", default: "mod+shift+f", group: "format" },
  { id: "heading1", default: "mod+alt+1", group: "format" },
  { id: "heading2", default: "mod+alt+2", group: "format" },
  { id: "heading3", default: "mod+alt+3", group: "format" },
  { id: "heading4", default: "mod+alt+4", group: "format" },
  { id: "heading5", default: "mod+alt+5", group: "format" },
  { id: "heading6", default: "mod+alt+6", group: "format" },
  { id: "heading0", default: "mod+alt+0", group: "format" },
  { id: "undo", default: "mod+z", group: "edit" },
  { id: "redo", default: "mod+shift+z / mod+y", group: "edit" },
  { id: "save", default: "mod+s", group: "app" },
  { id: "find", default: "mod+f", group: "search" },
  { id: "replace", default: "mod+h", group: "search" },
  { id: "findNext", default: "mod+g / f3", group: "search" },
  { id: "findPrev", default: "mod+shift+g / shift+f3", group: "search" },
  { id: "fullscreen", default: "mod+alt+enter", group: "view" },
  { id: "zoomIn", default: "mod+= / mod+shift+=", group: "view" },
  { id: "zoomOut", default: "mod+- / mod+shift+-", group: "view" },
  { id: "zoomReset", default: "mod+0", group: "view" },
];

/** `mod+shift+z / mod+y` → ["mod+shift+z", "mod+y"] */
function splitCombos(value: string): string[] {
  return String(value ?? "")
    .split("/")
    .map((part) => normalizeEditorCombo(part))
    .filter(Boolean);
}

/** 旧 API：键位 → 动作（由动作表派生，保持既有引用可用） */
export const DEFAULT_SHORTCUTS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const spec of EDITOR_SHORTCUT_SPECS) {
    for (const combo of splitCombos(spec.default)) out[combo] = spec.id;
  }
  return out;
})();

/** 默认键位表（动作 → 键位数组），调用方拿它做「恢复默认」与文档 */
export const EDITOR_DEFAULT_BINDINGS: Record<string, string[]> = (() => {
  const out: Record<string, string[]> = {};
  for (const spec of EDITOR_SHORTCUT_SPECS) out[spec.id] = splitCombos(spec.default);
  return out;
})();

/** 动作 id 集合：用来判断覆盖项的键是动作 id 还是老式的键位 */
const ACTION_IDS = new Set(EDITOR_SHORTCUT_SPECS.map((spec) => spec.id));

/**
 * 配置里的键位 → 组件内部写法。
 * 与 `acceleratorOf` 对齐：修饰键固定 `mod, alt, shift` 顺序、主键小写；
 * 另外把界面捕获框产出的 `Ctrl+Alt+P` / `Space` / `+` 这些写法折算过来。
 */
export function normalizeEditorCombo(raw: string): string {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  const trailingPlus = text.endsWith("+");
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  // 结尾是空的说明主键本身是 "+"（Ctrl++）：补回来
  if (trailingPlus) parts.push("+");
  let mod = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (["ctrl", "control", "mod", "meta", "cmd", "command", "win", "super"].includes(lower)) {
      mod = true;
    } else if (["alt", "option"].includes(lower)) {
      alt = true;
    } else if (lower === "shift") {
      shift = true;
    } else {
      key = lower;
    }
  }
  if (!key) return "";
  // 物理键归一：+ / = 都是「放大」，_ / - 都是「缩小」，空格统一成 " "
  if (key === "+" || key === "=" || key === "numpadadd") key = "=";
  else if (key === "_" || key === "-" || key === "numpadsubtract") key = "-";
  else if (key === "space") key = " ";
  // 放大 / 缩小不区分 Shift（Ctrl+Shift+= 和 Ctrl+= 是同一个动作）
  if (key === "=" || key === "-") shift = false;
  return [mod ? "mod" : "", alt ? "alt" : "", shift ? "shift" : "", key]
    .filter(Boolean)
    .join("+");
}

/**
 * 计算最终生效的「键位 → 动作」映射。
 *
 * @param overrides 动作 id → 键位（字符串或数组）或 false；同时兼容老写法（键位 → 动作 / false）
 */
export function resolveEditorShortcutMap(
  overrides?: Record<string, string | string[] | false> | null,
): Record<string, string> {
  const map = { ...DEFAULT_SHORTCUTS };
  if (!overrides) return map;
  for (const [key, value] of Object.entries(overrides)) {
    if (ACTION_IDS.has(key)) {
      // 新写法：先摘掉这个动作的全部默认键，再挂上覆盖值
      for (const [combo, action] of Object.entries(map)) {
        if (action === key) delete map[combo];
      }
      if (value === false) continue;
      const combos = Array.isArray(value) ? value.flatMap((item) => splitCombos(item)) : splitCombos(value);
      for (const combo of combos) map[combo] = key;
      continue;
    }
    // 老写法：键就是键位，值是动作 id 或 false
    const combo = normalizeEditorCombo(key);
    if (!combo) continue;
    if (value === false) delete map[combo];
    else if (typeof value === "string") map[combo] = value;
  }
  return map;
}

/**
 * 格式类动作的展示顺序与中文名。
 * 顺序就是快捷键说明表里的顺序（先常用行内格式，再块级，最后标题级别），
 * 文案与工具栏保持一致，避免同一动作在两处叫不同名字。
 */
const FORMAT_ACTION_NAMES = [
  "bold", "italic", "strike", "inlineCode", "codeBlock", "link", "image", "quote",
  "orderedList", "bulletList", "taskList", "math", "footnote",
  "heading1", "heading2", "heading3", "heading4", "heading5", "heading6", "heading0",
];

/** 静态元数据保留原 API；动态展示可按编辑器相同的 locale/labels 解析。 */
export const resolveFormatActions = (
  locale: MarkdownEditorLocale = "en-US",
  overrides: Record<string, string> = {},
): ReadonlyArray<{ action: string; label: string }> => {
  const labels = resolveLocaleLabels(locale, overrides);
  return FORMAT_ACTION_NAMES.map((action) => ({
    action,
    label: action === "link" || action === "image" ? labels[`shortcut.${action}`] : labels[action],
  }));
};

export const FORMAT_ACTIONS = resolveFormatActions();

/** 动作 → 键位（默认值；个别动作绑多个键，如「重做」的 shift+z 与 y） */
export const SHORTCUTS_BY_ACTION: Record<string, string[]> = EDITOR_DEFAULT_BINDINGS;
