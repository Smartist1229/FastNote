/**
 * 主题预设与默认令牌。
 *
 * 这里是「一套主题长什么样」的唯一来源：默认令牌（minimal 直接复用）、8 套预设、
 * 以及自定义面板里每个取色项的中文名与说明。
 *
 * 预设只写与默认令牌不同的键（`Partial<ThemeTokens>`），渲染时与默认令牌合并，
 * 因此新增一套主题通常只要写 8~12 行。亮/暗必须成对给出，否则某个模式下会退回默认色。
 */
import type { ThemeColorKey, ThemePreset, ThemeSettings, ThemeTokens } from "@/interface/theme";

/* ---------- 默认令牌：极简（浅色 slate + indigo） ---------- */

/** 亮色默认令牌：色值与改造前的 :root 一致；圆角基准统一为 4px（微圆） */
export const DEFAULT_LIGHT_TOKENS: ThemeTokens = {
  appBg: "#f8fafc",
  surface: "#ffffff",
  surfaceAlt: "#f1f5f9",
  surfaceStrong: "#e2e8f0",
  textInk: "#0f172a",
  textBody: "#334155",
  textMuted: "#64748b",
  textFaint: "#94a3b8",
  textFaintSoft: "#cbd5e1",
  borderSoft: "#f1f5f9",
  border: "#e2e8f0",
  borderStrong: "#cbd5e1",
  accent: "#6366f1",
  onAccent: "#ffffff",
  danger: "#ef4444",
  warning: "#f59e0b",
  success: "#10b981",
  info: "#0ea5e9",
  radius: 4,
};

/** 暗色默认令牌：石墨底 + 同一支 indigo；文字亮度分五档，弱化项不会糊成一片 */
export const DEFAULT_DARK_TOKENS: ThemeTokens = {
  appBg: "#0d1016",
  surface: "#151a22",
  surfaceAlt: "#1b212b",
  surfaceStrong: "#252c38",
  textInk: "#f1f5f9",
  textBody: "#c7d2df",
  textMuted: "#8b98ab",
  textFaint: "#6b7789",
  textFaintSoft: "#495364",
  borderSoft: "#1e242e",
  border: "#272f3b",
  borderStrong: "#3a4453",
  accent: "#6366f1",
  onAccent: "#ffffff",
  danger: "#f87171",
  warning: "#fbbf24",
  success: "#34d399",
  info: "#38bdf8",
  radius: 4,
};

/* ---------- 预设 ---------- */

/** 预设声明：只写覆盖项，其余继承默认令牌 */
interface PresetSpec {
  id: string;
  name: string;
  desc: string;
  /** 卡片上的色点预览，直接引用令牌键，避免手写一遍色值 */
  light: Partial<ThemeTokens>;
  dark: Partial<ThemeTokens>;
}

const PRESET_SPECS: PresetSpec[] = [
  {
    id: "minimal",
    name: "极简",
    desc: "冷灰底 + indigo，默认观感",
    light: {},
    dark: {},
  },
  {
    id: "graphite",
    name: "石墨",
    desc: "纯中性灰，长时间写作不抢注意力",
    light: {
      appBg: "#f4f4f5",
      surfaceAlt: "#f0f0f1",
      surfaceStrong: "#e4e4e7",
      borderSoft: "#f0f0f1",
      border: "#e4e4e7",
      borderStrong: "#d4d4d8",
      textInk: "#18181b",
      textBody: "#3f3f46",
      textMuted: "#71717a",
      textFaint: "#a1a1aa",
      textFaintSoft: "#d4d4d8",
      accent: "#52525b",
    },
    dark: {
      appBg: "#0a0a0b",
      surface: "#141416",
      surfaceAlt: "#1b1b1e",
      surfaceStrong: "#26262b",
      borderSoft: "#1d1d20",
      border: "#26262b",
      borderStrong: "#3f3f46",
      textInk: "#fafafa",
      textBody: "#d4d4d8",
      textMuted: "#8e8e96",
      textFaint: "#6b6b73",
      textFaintSoft: "#4a4a52",
      accent: "#a1a1aa",
      onAccent: "#141416",
    },
  },
  {
    id: "warm",
    name: "暖砂",
    desc: "米黄纸感 + 陶土橙，偏阅读",
    light: {
      appBg: "#faf6ef",
      surface: "#fffcf6",
      surfaceAlt: "#f4ece0",
      surfaceStrong: "#eadfce",
      borderSoft: "#f4ece0",
      border: "#e8dcca",
      borderStrong: "#d8c7ad",
      textInk: "#2a2320",
      textBody: "#4a3f38",
      textMuted: "#8a7a6d",
      textFaint: "#b0a196",
      textFaintSoft: "#ddd0c0",
      accent: "#b45309",
      onAccent: "#fff7ed",
    },
    dark: {
      appBg: "#14100c",
      surface: "#1c1611",
      surfaceAlt: "#241c16",
      surfaceStrong: "#2f241b",
      borderSoft: "#241c16",
      border: "#2f241b",
      borderStrong: "#46372a",
      textInk: "#f7efe4",
      textBody: "#ddcdba",
      textMuted: "#a2917f",
      textFaint: "#7d6d5d",
      textFaintSoft: "#55483b",
      accent: "#f59e0b",
      onAccent: "#1a1206",
    },
  },
  {
    id: "forest",
    name: "森野",
    desc: "淡绿底 + 森林绿，安静清爽",
    light: {
      appBg: "#f4f8f4",
      surfaceAlt: "#ecf3ec",
      surfaceStrong: "#dcebdd",
      borderSoft: "#ecf3ec",
      border: "#dbe8dd",
      borderStrong: "#c2d8c6",
      textInk: "#10231a",
      textBody: "#2c4638",
      textMuted: "#5f7a6c",
      textFaint: "#8fa89a",
      textFaintSoft: "#c5d8c9",
      accent: "#15803d",
    },
    dark: {
      appBg: "#080f0b",
      surface: "#0f1712",
      surfaceAlt: "#141f19",
      surfaceStrong: "#1c2a21",
      borderSoft: "#16211a",
      border: "#1c2a21",
      borderStrong: "#2c3f33",
      textInk: "#e9f5ec",
      textBody: "#c3d9c9",
      textMuted: "#8aa494",
      textFaint: "#64796d",
      textFaintSoft: "#42544a",
      accent: "#34d399",
      onAccent: "#052e1b",
    },
  },
  {
    id: "ocean",
    name: "深海",
    desc: "冷蓝底 + 天蓝，偏理性",
    light: {
      appBg: "#f2f7fb",
      surfaceAlt: "#e9f2f9",
      surfaceStrong: "#d9e8f4",
      borderSoft: "#e9f2f9",
      border: "#d9e7f2",
      borderStrong: "#bdd6e8",
      textInk: "#0b1b2b",
      textBody: "#26405a",
      textMuted: "#5b7793",
      textFaint: "#8aa4bc",
      textFaintSoft: "#c3d6e6",
      accent: "#0284c7",
    },
    dark: {
      appBg: "#070e15",
      surface: "#0d1620",
      surfaceAlt: "#121d29",
      surfaceStrong: "#1a2836",
      borderSoft: "#131e2a",
      border: "#1a2836",
      borderStrong: "#2b4053",
      textInk: "#e6f2fb",
      textBody: "#bcd4e6",
      textMuted: "#7e9bb3",
      textFaint: "#5d7893",
      textFaintSoft: "#3d5468",
      accent: "#38bdf8",
      onAccent: "#04212f",
    },
  },
  {
    id: "rose",
    name: "玫瑰",
    desc: "暖粉底 + 玫红，柔和有辨识度",
    light: {
      appBg: "#fbf5f6",
      surface: "#fffdfd",
      surfaceAlt: "#f8eced",
      surfaceStrong: "#f2dcdf",
      borderSoft: "#f8eced",
      border: "#f0dbde",
      borderStrong: "#e3c3c8",
      textInk: "#2a1418",
      textBody: "#4d2a31",
      textMuted: "#8c6570",
      textFaint: "#b3929b",
      textFaintSoft: "#e3ccd2",
      accent: "#e11d48",
    },
    dark: {
      appBg: "#120b0e",
      surface: "#1a1114",
      surfaceAlt: "#22161a",
      surfaceStrong: "#2d1e23",
      borderSoft: "#22161a",
      border: "#2d1e23",
      borderStrong: "#45303a",
      textInk: "#fdeef1",
      textBody: "#e5c9d1",
      textMuted: "#a98b95",
      textFaint: "#7f646d",
      textFaintSoft: "#59434b",
      accent: "#fb7185",
      onAccent: "#2a0a11",
    },
  },
  {
    id: "paper",
    name: "纸墨",
    desc: "旧纸底 + 墨灰，最接近纸面",
    light: {
      appBg: "#f6f3ea",
      surface: "#fffdf4",
      surfaceAlt: "#efeadd",
      surfaceStrong: "#e4ddcb",
      borderSoft: "#efeadd",
      border: "#e2dac7",
      borderStrong: "#cfc3a9",
      textInk: "#1c1917",
      textBody: "#44403c",
      textMuted: "#78716c",
      textFaint: "#a8a29e",
      textFaintSoft: "#d9d1c3",
      accent: "#57534e",
      onAccent: "#faf8f2",
    },
    dark: {
      appBg: "#12100d",
      surface: "#1a1714",
      surfaceAlt: "#211d18",
      surfaceStrong: "#2c261f",
      borderSoft: "#211d18",
      border: "#2c261f",
      borderStrong: "#443b2f",
      textInk: "#f5f0e6",
      textBody: "#d6cdbf",
      textMuted: "#a69a8a",
      textFaint: "#7d7264",
      textFaintSoft: "#544b3f",
      accent: "#a8a29e",
      onAccent: "#16130f",
    },
  },
  {
    id: "midnight",
    name: "午夜紫",
    desc: "深紫底 + 薰衣草，暗色下最出彩",
    light: {
      appBg: "#f7f5fb",
      surfaceAlt: "#f1edf8",
      surfaceStrong: "#e6dff4",
      borderSoft: "#f1edf8",
      border: "#e4dcf2",
      borderStrong: "#cfc2e6",
      textInk: "#1a1030",
      textBody: "#382a55",
      textMuted: "#6d5c8c",
      textFaint: "#9d8cb8",
      textFaintSoft: "#d3c7e5",
      accent: "#7c3aed",
    },
    dark: {
      appBg: "#0b0812",
      surface: "#120d1c",
      surfaceAlt: "#181226",
      surfaceStrong: "#211a33",
      borderSoft: "#181226",
      border: "#211a33",
      borderStrong: "#362a50",
      textInk: "#f0e9ff",
      textBody: "#d1c4eb",
      textMuted: "#a392c2",
      textFaint: "#7d6d9b",
      textFaintSoft: "#544870",
      accent: "#a78bfa",
      onAccent: "#150a2e",
    },
  },
];

/** 展开后的预设：默认令牌 + 覆盖项 */
export const THEME_PRESETS: ThemePreset[] = PRESET_SPECS.map((spec) => ({
  id: spec.id,
  name: spec.name,
  desc: spec.desc,
  light: { ...DEFAULT_LIGHT_TOKENS, ...spec.light },
  dark: { ...DEFAULT_DARK_TOKENS, ...spec.dark },
}));

/** 自定义主题的标识：不等于任何预设 id */
export const CUSTOM_PRESET_ID = "custom";

/** 自定义主题的默认值：从「极简」起步 */
export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  mode: "light",
  presetId: "minimal",
  custom: {
    light: { ...DEFAULT_LIGHT_TOKENS },
    dark: { ...DEFAULT_DARK_TOKENS },
  },
  saved: [],
};

/** 最多保存多少套自定义主题：超出时最旧的一条被删掉 */
export const MAX_SAVED_THEMES = 12;

/**
 * 圆角预设：五档，点一下直接落到对应基准值。
 * value 与 ThemeTokens.radius 同义（px，0~20），label 是面板里显示的档位名。
 */
export const RADIUS_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: "直角" },
  { value: 4, label: "微圆" },
  { value: 8, label: "适中" },
  { value: 12, label: "圆润" },
  { value: 16, label: "大圆角" },
];

/* ---------- 自定义面板的分组与取色项 ---------- */

/**
 * 取色项的中文名与说明。
 * 顺序即面板里的展示顺序，`group` 决定归到哪一栏（见 COLOR_GROUPS）。
 */
export const COLOR_FIELD_META: Record<ThemeColorKey, { label: string; hint: string }> = {
  appBg: { label: "页面背景", hint: "最外层底色，侧边栏之外的留白" },
  surface: { label: "卡片 / 面板", hint: "笔记卡片、设置窗口、弹层、输入框" },
  surfaceAlt: { label: "次级填充", hint: "工具条、分段控件槽、悬停底色" },
  surfaceStrong: { label: "强调填充", hint: "进度槽、分隔块、按下态" },
  textInk: { label: "标题文字", hint: "笔记标题、分区标题" },
  textBody: { label: "正文文字", hint: "设置项名称、正文段落" },
  textMuted: { label: "次要文字", hint: "说明文字、元信息" },
  textFaint: { label: "弱化文字", hint: "默认图标、占位符、时间戳" },
  textFaintSoft: { label: "极弱文字", hint: "禁用态、列表里的次要图标" },
  borderSoft: { label: "浅边框", hint: "分区之间的分隔线" },
  border: { label: "常规边框", hint: "卡片、输入框、按钮描边" },
  borderStrong: { label: "强边框", hint: "悬停描边、滚动条滑块" },
  accent: { label: "主题色", hint: "按钮、选中项、焦点环；自动派生深浅色阶" },
  onAccent: { label: "主题色上的文字", hint: "主题色按钮里的字；浅色主题色要配深字" },
  danger: { label: "危险色", hint: "删除、错误、不可恢复操作" },
  warning: { label: "警告色", hint: "权限受限、注意事项" },
  success: { label: "成功色", hint: "已保存、已启用" },
  info: { label: "信息色", hint: "中性提示、说明标签" },
};

/** 取色面板的分栏：底 → 字 → 线 → 主题 → 语义色 */
export const COLOR_GROUPS: { title: string; keys: ThemeColorKey[] }[] = [
  { title: "背景与表面", keys: ["appBg", "surface", "surfaceAlt", "surfaceStrong"] },
  { title: "文字", keys: ["textInk", "textBody", "textMuted", "textFaint", "textFaintSoft"] },
  { title: "边框与分隔", keys: ["borderSoft", "border", "borderStrong"] },
  { title: "主题色", keys: ["accent", "onAccent"] },
  { title: "语义色", keys: ["danger", "warning", "success", "info"] },
];
