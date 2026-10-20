/**
 * 主题引擎：令牌 → CSS 变量 → 整站生效。
 *
 * 数据流：
 *   ThemeSettings → resolveActiveTokens() 选出当前模式的令牌
 *                 → buildThemeVars() 派生色阶并展开成 CSS 变量
 *                 → applyTheme() 写到 <html style> 与 data-theme
 *
 * 为什么色阶在 JS 里算而不是写死在 CSS：
 *   主题色只有一个输入值，但按钮底、浅底、描边、悬停、焦点环需要 9 档深浅；
 *   这些档位必须跟着用户选的颜色走，因此按基色的 HSL 推导，深色模式下再整体反过来
 *   （浅色档在暗色底上要变成深色块，深色档要变成亮色字）。
 *
 * 为什么写内联 style 而不是切换 data-theme 的 CSS 类：
 *   用户自定义的颜色是运行时才知道的，写在 style 上优先级最高，也省掉动态注入 <style>。
 *   预留的 [data-theme="dark"] 规则仍保留在 App.css 里，作为 JS 执行前的默认兜底。
 */
import type {
  ResolvedThemeMode,
  SavedTheme,
  ThemeColorKey,
  ThemeMode,
  ThemeSettings,
  ThemeTokens,
} from "@/interface/theme";
import {
  CUSTOM_PRESET_ID,
  DEFAULT_DARK_TOKENS,
  DEFAULT_LIGHT_TOKENS,
  DEFAULT_THEME_SETTINGS,
  MAX_SAVED_THEMES,
  THEME_PRESETS,
} from "@/config/themes";
import { setActiveThemeTokens } from "@/lib/themeRuntime";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/* ---------- 颜色工具 ---------- */

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** 校验并规范化十六进制色值；非法值返回 null（调用方据此保留原值） */
export const normalizeHex = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  const short = /^#?([0-9a-f]{3})$/i.exec(raw);
  if (short) {
    const [r, g, b] = short[1].split("");
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const long = /^#?([0-9a-f]{6})$/i.exec(raw);
  return long ? `#${long[1].toLowerCase()}` : null;
};

const hexToRgb = (hex: string): { r: number; g: number; b: number } => {
  const safe = normalizeHex(hex) ?? "#000000";
  return {
    r: parseInt(safe.slice(1, 3), 16),
    g: parseInt(safe.slice(3, 5), 16),
    b: parseInt(safe.slice(5, 7), 16),
  };
};

/** 十六进制 → "r g b" 通道串，直接作为 CSS 变量的值，支持 /alpha 写法 */
export const hexToChannels = (hex: string): string => {
  const { r, g, b } = hexToRgb(hex);
  return `${r} ${g} ${b}`;
};

/** 十六进制 → CSS rgb() 字符串，用于生成 prettier 的内联样式 */
export const hexToCss = (hex: string): string => `rgb(${hexToChannels(hex)})`;

/** 十六进制 → rgba()，alpha 用 0~1 */
export const hexToRgba = (hex: string, alpha: number): string =>
  `rgba(${hexToChannels(hex).replace(/ /g, ", ")}, ${alpha})`;

const rgbToHsl = (hex: string): Hsl => {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h: h * 360, s, l };
};

const hslToHex = ({ h, s, l }: Hsl): string => {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = clamp(s, 0, 1);
  const lig = clamp(l, 0, 1);
  if (sat === 0) {
    const v = Math.round(lig * 255);
    return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
  }
  const q = lig < 0.5 ? lig * (1 + sat) : lig + sat - lig * sat;
  const p = 2 * lig - q;
  const channel = (t: number) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, "0");
  return `#${toHex(channel(hue + 1 / 3))}${toHex(channel(hue))}${toHex(channel(hue - 1 / 3))}`;
};

/** 把基色调亮/调暗：amount > 0 变亮，< 0 变暗，按 HSL 明度移动 */
const shiftLightness = (hex: string, amount: number): string => {
  const hsl = rgbToHsl(hex);
  return hslToHex({ ...hsl, l: clamp(hsl.l + amount, 0.04, 0.97) });
};

/* ---------- 色阶派生 ---------- */

/** Tailwind 用到的档位：50~900 覆盖浅底 / 描边 / 主色 / 悬停 / 深字 */
const SCALE_LEVELS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;

/**
 * 亮色下的档位：(明度, 饱和度系数)。50~400 是固定的浅色阶梯，
 * 600~900 以基色明度为锚点往下压——这样深色主题色（如墨灰）也不会出现 600 比 500 还亮。
 */
const LIGHT_TINTS: { l: number; s: number }[] = [
  { l: 0.958, s: 0.75 },
  { l: 0.915, s: 0.8 },
  { l: 0.85, s: 0.85 },
  { l: 0.75, s: 0.9 },
  { l: 0.66, s: 0.95 },
];

/** 暗色下反过来：50~400 变成深色块，600~900 变成亮色字 */
const DARK_TINTS: { l: number; s: number }[] = [
  { l: 0.18, s: 0.6 },
  { l: 0.23, s: 0.65 },
  { l: 0.31, s: 0.72 },
  { l: 0.42, s: 0.82 },
  { l: 0.55, s: 0.9 },
];

/**
 * 由基色派生完整色阶。
 * 500 始终等于用户选的基色（所见即所得），其余档位按模式推导。
 */
export const buildScale = (base: string, mode: ResolvedThemeMode): Record<number, string> => {
  const hsl = rgbToHsl(base);
  const tints = mode === "dark" ? DARK_TINTS : LIGHT_TINTS;
  const out: Record<number, string> = { 500: base };

  for (let i = 0; i < tints.length; i++) {
    out[SCALE_LEVELS[i]] = hslToHex({
      h: hsl.h,
      s: clamp(hsl.s * tints[i].s, 0, 1),
      l: tints[i].l,
    });
  }

  const dir = mode === "dark" ? 1 : -1;
  [0.07, 0.14, 0.2, 0.26].forEach((step, i) => {
    // 从 600 开始：SCALE_LEVELS 的前 5 个是浅色档，第 6 个（下标 5）就是 500 本身
    const level = SCALE_LEVELS[6 + i];
    out[level] = shiftLightness(base, dir * step);
  });

  return out;
};

/* ---------- 令牌 → CSS 变量 ---------- */

/** 语义色只用得上 5 档：soft(50) / line(200) / 本体(500) / strong(600) / 深阶(700) */
const SEMANTIC_KEYS = ["danger", "warning", "success", "info"] as const;

/**
 * 生成完整的 CSS 变量表（不含单位换算之外的处理）。
 * 键名与 App.css 的 :root 声明、tailwind.config.cjs 的语义色映射一一对应，
 * 任何一处改名都要三处同步。
 */
export const buildThemeVars = (
  tokens: ThemeTokens,
  mode: ResolvedThemeMode,
): Record<string, string> => {
  const vars: Record<string, string> = {};

  const neutral: [string, string][] = [
    ["app", tokens.appBg],
    ["surface", tokens.surface],
    ["surface-alt", tokens.surfaceAlt],
    ["surface-strong", tokens.surfaceStrong],
    ["ink", tokens.textInk],
    ["body", tokens.textBody],
    ["muted", tokens.textMuted],
    ["faint", tokens.textFaint],
    ["faint-soft", tokens.textFaintSoft],
    ["line-soft", tokens.borderSoft],
    ["line", tokens.border],
    ["line-strong", tokens.borderStrong],
    ["on-accent", tokens.onAccent],
  ];
  for (const [name, hex] of neutral) vars[`--c-${name}`] = hexToChannels(hex);

  // 主题色与四个语义色都展开成同一套档位，组件只引用档位，不引用基色
  const ramps: [string, string][] = [
    ["primary", tokens.accent],
    ...SEMANTIC_KEYS.map((key) => [key, tokens[key]] as [string, string]),
  ];
  for (const [name, base] of ramps) {
    const scale = buildScale(base, mode);
    for (const level of SCALE_LEVELS) vars[`--c-${name}-${level}`] = hexToChannels(scale[level]);
  }

  // 浮层气泡：亮色下是深色，暗色下比卡片再亮一档，保证"浮起来"的层次
  vars["--c-tooltip"] = hexToChannels(
    mode === "dark" ? shiftLightness(tokens.surfaceStrong, 0.06) : shiftLightness(tokens.textInk, -0.04),
  );

  // 遮罩与选中色只需要通道 + 独立的透明度变量（两者在深浅模式下浓度不同）
  vars["--c-overlay"] = hexToChannels(mode === "dark" ? "#000000" : tokens.textInk);
  vars["--c-overlay-alpha"] = mode === "dark" ? "0.55" : "0.22";
  vars["--c-selection-alpha"] = mode === "dark" ? "0.34" : "0.25";

  // 圆角：一个基准推导整套阶梯。用比例而不是固定的 +4/+6/+8 加法，
  // 这样基准调到 0 时整档都是 0（真正的直角风），加法会让 lg 以上仍有 4~12px 的圆角。
  // 基准 8 时展开为 6/8/12/14/16/20，与改造前的默认值完全一致。
  const r = clamp(Math.round(tokens.radius), 0, 20);
  vars["--radius-sm"] = `${Math.round(r * 0.75)}px`;
  vars["--radius-md"] = `${r}px`;
  vars["--radius-lg"] = `${Math.round(r * 1.5)}px`;
  vars["--radius-xl"] = `${Math.round(r * 1.75)}px`;
  vars["--radius-2xl"] = `${Math.round(r * 2)}px`;
  vars["--radius-3xl"] = `${Math.round(r * 2.5)}px`;

  return vars;
};

/* ---------- 模式解析与令牌选取 ---------- */

/** 系统深浅色查询（WebView2 支持 matchMedia 的 prefers-color-scheme） */
const darkQuery = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** 把 system 落成具体的 light / dark */
export const resolveMode = (mode: ThemeMode): ResolvedThemeMode => {
  if (mode !== "system") return mode;
  return darkQuery()?.matches ? "dark" : "light";
};

/** 当前预设；presetId 指向不存在的预设时回退到「极简」，避免删预设后整个面板空转 */
export const getPreset = (presetId: string) =>
  THEME_PRESETS.find((p) => p.id === presetId) ?? THEME_PRESETS[0];

/** 取某个模式下生效的令牌：预设 → 预设值，custom → 自定义值 */
export const getTokensForMode = (
  settings: ThemeSettings,
  mode: ResolvedThemeMode,
): ThemeTokens =>
  settings.presetId === CUSTOM_PRESET_ID
    ? settings.custom[mode]
    : getPreset(settings.presetId)[mode];

/** 亮暗两套一起取：保存主题时要两份都存下来 */
export const getTokenPair = (settings: ThemeSettings): { light: ThemeTokens; dark: ThemeTokens } =>
  settings.presetId === CUSTOM_PRESET_ID
    ? { light: settings.custom.light, dark: settings.custom.dark }
    : { light: getPreset(settings.presetId).light, dark: getPreset(settings.presetId).dark };

/* ---------- 应用到文档 ---------- */

const STYLE_ATTR = "data-theme";

/** 上一次应用过的设置：系统深浅色变化时要用它重新着色 */
let appliedSettings: ThemeSettings | null = null;
let systemListenerBound = false;

/**
 * 原生窗口底色（不是网页背景）。
 *
 * 窗口里那层底色只在"网页还没画出第一帧"时可见：启动、改窗口大小、从托盘恢复……
 * 系统会先拿它填一帧。让它等于主题的 appBg，这些瞬间就不会闪出白底或黑底。
 * 同一个颜色只下发一次，避免拖色盘时每帧一次 IPC。
 */
let syncedWindowBg = "";
const syncWindowBackground = (appBg: string): void => {
  if (appBg === syncedWindowBg) return;
  syncedWindowBg = appBg;
  if (!isTauri()) return;
  void getCurrentWindow().setBackgroundColor(appBg).catch(() => undefined);
};

/** 真正写 DOM：变量逐条 setProperty，同时更新 data-theme 与 color-scheme */
const writeVars = (settings: ThemeSettings): ResolvedThemeMode => {
  const resolved = resolveMode(settings.mode);
  const tokens = getTokensForMode(settings, resolved);
  const root = document.documentElement;
  const vars = buildThemeVars(tokens, resolved);
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value);
  }
  root.setAttribute(STYLE_ATTR, resolved);
  // 让原生控件（滚动条、日期选择器、输入框自动填充）跟着变深，避免白底突兀
  root.style.colorScheme = resolved;
  // 令牌对外留一份可读副本：Markdown 编辑器要拿它换算自己的配色（CSS 变量读不出来）
  setActiveThemeTokens(tokens);
  syncWindowBackground(tokens.appBg);
  return resolved;
};

/** 系统主题变化时重新应用；只在首次调用时绑定一次 */
const bindSystemListener = () => {
  if (systemListenerBound) return;
  const query = darkQuery();
  if (!query) return;
  query.addEventListener("change", () => {
    if (appliedSettings && appliedSettings.mode === "system") writeVars(appliedSettings);
  });
  systemListenerBound = true;
};

/**
 * 应用主题：幂等，可反复调用。
 * 返回实际生效的模式，供需要分支的组件（如 Markdown 编辑器）使用。
 */
export const applyTheme = (settings: ThemeSettings): ResolvedThemeMode => {
  appliedSettings = settings;
  bindSystemListener();
  return writeVars(settings);
};

/** 预览单个令牌的改动而不落地：自定义面板拖色时用它即时看效果 */
export const previewTheme = (settings: ThemeSettings): ResolvedThemeMode => applyTheme(settings);

/* ---------- 本地缓存（首帧防闪） ---------- */

const CACHE_KEY = "fastnote.theme";

/**
 * 把主题写进 localStorage。
 * 数据库是唯一事实来源，这里只是一份"首帧快照"：下次启动时同步读出来先刷一遍颜色，
 * 避免深色主题用户看到一瞬白屏（读库是异步的，赶不上第一帧）。
 */
export const cacheTheme = (settings: ThemeSettings): void => {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(settings));
  } catch {
    // 隐私模式 / 存储被禁用：忽略即可，只是少了一次防闪
  }
};

/** 读首帧快照；缺失或损坏返回 null，由调用方继续等异步设置 */
export const readCachedTheme = (): ThemeSettings | null => {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    return normalizeThemeSettings(JSON.parse(raw));
  } catch {
    return null;
  }
};

/* ---------- 归一化 ---------- */

const normalizeTokens = (raw: unknown, fallback: ThemeTokens): ThemeTokens => {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const src = raw as Record<string, unknown>;
  const out = { ...fallback };
  for (const key of Object.keys(fallback) as (keyof ThemeTokens)[]) {
    if (key === "radius") {
      const n = Number(src.radius);
      if (Number.isFinite(n)) out.radius = clamp(Math.round(n), 0, 20);
      continue;
    }
    const hex = normalizeHex(src[key]);
    if (hex) out[key as ThemeColorKey] = hex;
  }
  return out;
};

const normalizeMode = (raw: unknown): ThemeMode =>
  raw === "light" || raw === "dark" || raw === "system" ? raw : DEFAULT_THEME_SETTINGS.mode;

/** 用户保存的主题：逐条校验，坏数据直接丢弃（宁可少一条，不要渲染出错） */
const normalizeSaved = (raw: unknown): SavedTheme[] => {
  if (!Array.isArray(raw)) return [];
  const out: SavedTheme[] = [];
  for (const item of raw) {
    const src = item as Record<string, unknown> | null;
    if (!src || typeof src !== "object") continue;
    const name = typeof src.name === "string" ? src.name.trim().slice(0, 24) : "";
    if (!name) continue;
    out.push({
      id: typeof src.id === "string" && src.id ? src.id : `t${out.length}-${Date.now().toString(36)}`,
      name,
      createdAt: typeof src.createdAt === "string" ? src.createdAt : new Date().toISOString(),
      mode: normalizeMode(src.mode),
      light: normalizeTokens(src.light, DEFAULT_LIGHT_TOKENS),
      dark: normalizeTokens(src.dark, DEFAULT_DARK_TOKENS),
    });
    if (out.length >= MAX_SAVED_THEMES) break;
  }
  return out;
};

/**
 * 把库里读出的任意结构收敛成合法的 ThemeSettings。
 * 缺字段走默认值，非法色值逐项回退——任何脏数据都不该让整站配色崩掉。
 */
export const normalizeThemeSettings = (raw: unknown): ThemeSettings => {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const custom = (src.custom && typeof src.custom === "object" ? src.custom : {}) as Record<string, unknown>;
  const presetId =
    typeof src.presetId === "string" &&
    (src.presetId === CUSTOM_PRESET_ID || THEME_PRESETS.some((p) => p.id === src.presetId))
      ? src.presetId
      : DEFAULT_THEME_SETTINGS.presetId;

  return {
    mode: normalizeMode(src.mode),
    presetId,
    custom: {
      light: normalizeTokens(custom.light, DEFAULT_LIGHT_TOKENS),
      dark: normalizeTokens(custom.dark, DEFAULT_DARK_TOKENS),
    },
    saved: normalizeSaved(src.saved),
  };
};
