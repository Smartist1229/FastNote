/**
 * 快捷键键位的统一写法（纯函数，不依赖 React / Tauri）。
 *
 * 全软件只有一种规范形式：`mod+alt+shift+key`，修饰键固定这个顺序、主键小写。
 * 三个消费方必须产出同一种字符串，否则「设置里改过、按下去没反应」：
 *   - 事件 → `comboFromEvent`（窗口捕获阶段与设置里的捕获框都用它）；
 *   - 配置 → `normalizeCombo`（用户手改数据库、插件写的 "Ctrl+Alt+P" 都折算过来）；
 *   - 系统全局热键 → `toGlobalAccelerator`（Rust 侧的 "CommandOrControl+Shift+P"）。
 *
 * `mod` 表示「平台主修饰键」：Windows / Linux 是 Ctrl，macOS 是 ⌘。
 * 之所以不区分 ctrl / meta：同一份默认配置要在三平台通用，写死 Ctrl 在 macOS 上就是不顺手。
 */

/** 解析结果：三个修饰键 + 主键 */
export interface ParsedCombo {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  /** 已归一的主键：`p` / `1` / `f3` / `space` / `=` */
  key: string;
}

/** 修饰键别名 → 规范位（大小写无关） */
const MODIFIER_ALIASES: Record<string, "mod" | "alt" | "shift"> = {
  ctrl: "mod",
  control: "mod",
  mod: "mod",
  meta: "mod",
  cmd: "mod",
  command: "mod",
  win: "mod",
  super: "mod",
  alt: "alt",
  option: "alt",
  opt: "alt",
  shift: "shift",
};

/**
 * 事件 code / key → 规范主键名。
 * 优先用 `code`：中文输入法或非英文布局下 `key` 会变成别的字符（俄语布局的 К 之类），
 * 而 `code` 始终是物理键位。
 */
const CODE_TO_KEY: Record<string, string> = {
  Space: "space",
  Enter: "enter",
  NumpadEnter: "enter",
  Escape: "escape",
  Tab: "tab",
  Backspace: "backspace",
  Delete: "delete",
  Insert: "insert",
  Home: "home",
  End: "end",
  PageUp: "pageup",
  PageDown: "pagedown",
  ArrowUp: "arrowup",
  ArrowDown: "arrowdown",
  ArrowLeft: "arrowleft",
  ArrowRight: "arrowright",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  NumpadAdd: "=",
  NumpadSubtract: "-",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  /**
   * 斜杠键统一写 `slash`，**不能**写 "/"：
   * 多键位配置用 " / " 分隔，主键本身是 "/" 时会在 `splitCombos` 里被切开
   * （Ctrl+/ → ["mod+", ""] → 变成 Ctrl+=），既存不住也匹配不上。
   */
  Slash: "slash",
};

/** 主键别名 → 规范名（配置文件里手写的 "Space"、"Esc" 都能认） */
const KEY_ALIASES: Record<string, string> = {
  space: "space",
  spacebar: "space",
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  del: "delete",
  delete: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  pageup: "pageup",
  pagedown: "pagedown",
  up: "arrowup",
  down: "arrowdown",
  left: "arrowleft",
  right: "arrowright",
  arrowup: "arrowup",
  arrowdown: "arrowdown",
  arrowleft: "arrowleft",
  arrowright: "arrowright",
  plus: "=",
  numpadadd: "=",
  numpadsubtract: "-",
  // 手写配置可能直接写 "/"，也统一折算成无歧义的 slash
  slash: "slash",
  forwordslash: "slash",
};

/** 主键归一：`Plus` / `NumpadAdd` / `Equal` 都是「＝」那一格 */
export function normalizeKeyName(raw: string): string {
  const lower = String(raw ?? "").trim().toLowerCase();
  if (!lower) return "";
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if (lower === "+" || lower === "add") return "=";
  if (lower === "_") return "-";
  return lower;
}

/**
 * 配置 / 捕获框写出的字符串 → 解析结果。
 * 接受 `Ctrl+Shift+P`、`mod+shift+p`、`⌘⇧P` 之外的任意大小写与修饰键顺序；
 * 只有修饰键、没有主键时返回 null（还在等主键）。
 */
export function parseCombo(raw: string): ParsedCombo | null {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  // 主键本身就是 "+"（Ctrl 和 + 一起按）：split 后尾部会留一个空段
  const trailingPlus = text.endsWith("+");
  const parts = text
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  if (trailingPlus) parts.push("+");

  let mod = false;
  let alt = false;
  let shift = false;
  let key = "";
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (modifier === "mod") mod = true;
    else if (modifier === "alt") alt = true;
    else if (modifier === "shift") shift = true;
    else key = normalizeKeyName(part);
  }
  if (!key) return null;
  // 放大 / 缩小不区分 Shift：Ctrl+Shift+= 与 Ctrl+= 是同一个动作
  if (key === "=" || key === "-") shift = false;
  return { mod, alt, shift, key };
}

/** 解析结果 → 规范字符串；解析不出来时返回 "" */
export function formatCombo(parsed: ParsedCombo | null): string {
  if (!parsed) return "";
  return [
    parsed.mod ? "mod" : "",
    parsed.alt ? "alt" : "",
    parsed.shift ? "shift" : "",
    parsed.key,
  ]
    .filter(Boolean)
    .join("+");
}

/** 任意写法 → 规范字符串；解析不出来时返回 "" */
export const normalizeCombo = (raw: string): string => formatCombo(parseCombo(raw));

/** `"mod+shift+z / mod+y"` → `["mod+shift+z","mod+y"]`，已归一、去重、丢空 */
export function splitCombos(raw: string | string[] | undefined | null): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split("/");
  const out: string[] = [];
  for (const item of list) {
    const combo = normalizeCombo(item);
    if (combo && !out.includes(combo)) out.push(combo);
  }
  return out;
}

/** 键位数组 → 存储 / 展示用的单字符串 */
export const joinCombos = (combos: string[]): string => splitCombos(combos.join("/")).join(" / ");

/**
 * 键盘事件 → 规范字符串。
 * 只按了修饰键时返回 ""（调用方继续等主键）。
 */
export function comboFromEvent(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "key">): string {
  const code = event.code ?? "";
  let key: string;
  if (code.startsWith("Key") && code.length === 4) key = code.slice(3).toLowerCase();
  else if (code.startsWith("Digit") && code.length === 6) key = code.slice(5);
  else if (code.startsWith("Numpad") && /^Numpad\d$/.test(code)) key = code.slice(6);
  else if (/^F\d{1,2}$/.test(code)) key = code.toLowerCase();
  else if (CODE_TO_KEY[code]) key = CODE_TO_KEY[code];
  else if (MODIFIER_ALIASES[String(event.key ?? "").toLowerCase()]) return "";
  else key = normalizeKeyName(event.key ?? "");
  if (!key) return "";
  return formatCombo({
    mod: Boolean(event.ctrlKey || event.metaKey),
    alt: Boolean(event.altKey),
    shift: Boolean(event.shiftKey),
    key,
  });
}

/**
 * 「能不能当快捷键」的判定：必须带 mod 或 alt。
 *
 * 只有 Shift 的组合等于把正常大写字母全吃掉；裸字母更糟（打字就触发）。
 * F1–F24 例外，它们本来就不是输入键。
 */
export function comboIsUsable(combo: string): boolean {
  const parsed = parseCombo(combo);
  if (!parsed) return false;
  if (parsed.mod || parsed.alt) return true;
  return /^f\d{1,2}$/.test(parsed.key);
}

/** 规范字符串 → Tauri 全局热键写法：`mod+shift+p` → `CommandOrControl+Shift+P` */
export function toGlobalAccelerator(combo: string): string {
  const parsed = parseCombo(combo);
  if (!parsed) return "";
  const keyNames: Record<string, string> = {
    space: "Space",
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    insert: "Insert",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right",
    "`": "Backquote",
    "-": "Minus",
    "=": "Equal",
    "[": "BracketLeft",
    "]": "BracketRight",
    "\\": "Backslash",
    ";": "Semicolon",
    "'": "Quote",
    ",": "Comma",
    ".": "Period",
    slash: "Slash",
  };
  const main = keyNames[parsed.key] ?? parsed.key.toUpperCase();
  return [
    parsed.mod ? "CommandOrControl" : "",
    parsed.alt ? "Alt" : "",
    parsed.shift ? "Shift" : "",
    main,
  ]
    .filter(Boolean)
    .join("+");
}
