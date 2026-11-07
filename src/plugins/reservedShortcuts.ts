/**
 * 宿主自己占用的键位（归一化签名 → 功能名）。
 *
 * 两处消费，别各写一份：
 *   1. `plugins/host.ts` 的 `ctx.shortcut.register`：插件注册这些键直接抛错；
 *   2. 插件配置里的「组合键捕获框」（`settings/controls.tsx` 的 ShortcutInput）：
 *      当场拦下，不把注定注册失败的键位写进配置——否则插件每次激活都要抛错或回退，
 *      用户看到的只是「快捷键不好使」。
 *
 * 编辑器自己的键位（Ctrl+K 之类）不在这里：那些由编辑器管，插件系统不碰。
 */
export const RESERVED_SHORTCUTS: Record<string, string> = {
  "ctrl+p": "跳转笔记",
  "ctrl+shift+p": "命令面板",
  "ctrl+f": "查找",
  "ctrl+g": "跳到行",
  "ctrl+h": "替换",
  "ctrl+s": "保存笔记",
  "ctrl+n": "新建笔记",
};

/**
 * "Ctrl+Shift+P" → "ctrl+shift+p"。
 * 口径与 host.ts 的 `parseShortcut` 一致：修饰键顺序无关、大小写无关、主键取最后一段。
 */
export const shortcutSignature = (combo: string): string => {
  const parts = String(combo ?? "")
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const main = parts.pop() ?? "";
  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "ctrl" || lower === "control") ctrl = true;
    else if (lower === "shift") shift = true;
    else if (lower === "alt" || lower === "option") alt = true;
    else if (["meta", "cmd", "command", "win", "super"].includes(lower)) meta = true;
  }
  return `${ctrl ? "ctrl+" : ""}${shift ? "shift+" : ""}${alt ? "alt+" : ""}${
    meta ? "meta+" : ""
  }${main.toLowerCase()}`;
};

/** 命中的宿主功能名；没被占用时返回 undefined */
export const reservedShortcutName = (combo: string): string | undefined =>
  RESERVED_SHORTCUTS[shortcutSignature(combo)];
