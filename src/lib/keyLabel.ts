/**
 * 快捷键的展示用格式化（纯展示，不解析事件）。
 *
 * 键位字符串沿用编辑器的归一化写法：`mod+shift+p`。
 * 展示时分平台：Windows / Linux 显示 `Ctrl` `Shift`，macOS 显示 `⌘` `⇧` `⌥`。
 * 设置里的快捷键清单与命令面板右侧的键位角标共用这里，避免两处各写一套映射。
 */

/** 运行平台：Tauri 只跑在桌面端，UA 判断足够 */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

const MODIFIER_LABELS: Record<string, string> = IS_MAC
  ? { mod: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
  : { mod: "Ctrl", ctrl: "Ctrl", alt: "Alt", shift: "Shift" };

const KEY_LABELS: Record<string, string> = {
  enter: "Enter",
  escape: "Esc",
  esc: "Esc",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Delete",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  "`": "`",
  ".": ".",
  "/": "/",
  "-": "-",
  "=": "=",
};

/** 单段键名 → 展示文案（`p` → `P`，`f3` → `F3`，`enter` → `Enter`） */
export const keyLabel = (part: string): string => {
  const lower = part.toLowerCase();
  if (MODIFIER_LABELS[lower]) return MODIFIER_LABELS[lower];
  if (KEY_LABELS[lower]) return KEY_LABELS[lower];
  if (/^f\d{1,2}$/.test(lower)) return lower.toUpperCase();
  return part.length === 1 ? part.toUpperCase() : part;
};

/**
 * 键位字符串 → 按键组（每组一次按下的键，组之间是「或」的关系）。
 * `mod+g / mod+shift+g` → `[["Ctrl","G"], ["Ctrl","Shift","G"]]`（macOS 下 Ctrl 换成 ⌘）。
 */
export const parseKeys = (accelerator: string): string[][] =>
  accelerator
    .split("/")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) => group.split("+").map((part) => keyLabel(part.trim())));

/** 只要一行文字时用它（设置里做纯文本说明、aria-label） */
export const keyText = (accelerator: string): string =>
  parseKeys(accelerator)
    .map((keys) => keys.join(" + "))
    .join(" / ");
