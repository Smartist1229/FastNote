/**
 * 主题模型。
 *
 * 三层结构：
 *   主题令牌（ThemeTokens）  —— 唯一可编辑的调色板，全部是十六进制色值 + 一个圆角基准
 *   预设（ThemePreset）     —— 令牌的亮/暗两套成品，用户点一下即整体替换
 *   主题设置（ThemeSettings）—— 当前生效的模式、选中的预设（或自定义）、以及用户保存的主题
 *
 * 令牌只描述"语义"（页面底色、正文色、边框色……），不描述具体元件。
 * 具体类名（bg-app / text-body / border-line）在 tailwind.config.cjs 里映射到这些令牌，
 * 因此换主题不需要改任何组件。
 */

/** 用户可选的外观模式；system 表示跟随操作系统的深浅色 */
export type ThemeMode = "light" | "dark" | "system";

/** 解析后的实际模式：system 已经按系统偏好落成 light 或 dark */
export type ResolvedThemeMode = "light" | "dark";

/**
 * 一套主题令牌。
 *
 * 深浅两套结构完全一致：同一个键在亮色下是浅底深字，在暗色下是深底浅字，
 * 所以切换模式只是换一组值，不需要组件做任何判断。
 */
export interface ThemeTokens {
  /** 页面底色（App 根节点、侧边栏外的留白） */
  appBg: string;
  /** 卡片 / 面板 / 弹层 / 输入框的底色 */
  surface: string;
  /** 次级填充：工具条、分段控件槽、悬停底色、代码内联底色 */
  surfaceAlt: string;
  /** 更强的填充：进度槽、分隔块、按下态 */
  surfaceStrong: string;
  /** 标题与强调文字 */
  textInk: string;
  /** 正文文字 */
  textBody: string;
  /** 次要文字：说明、元信息 */
  textMuted: string;
  /** 弱化文字与默认图标 */
  textFaint: string;
  /** 极弱文字 / 禁用态图标 / 占位符 */
  textFaintSoft: string;
  /** 极浅边框与分隔线 */
  borderSoft: string;
  /** 常规边框 */
  border: string;
  /** 悬停边框、滚动条滑块、输入框描边 */
  borderStrong: string;
  /** 主题强调色：按钮、选中项、链接、焦点环都由它派生色阶 */
  accent: string;
  /** 强调色上的文字/图标；浅强调色（如米色、灰白）需要配深色文字 */
  onAccent: string;
  /** 危险色：删除、错误提示 */
  danger: string;
  /** 警告色：受限、注意事项 */
  warning: string;
  /** 成功色：保存成功、已启用 */
  success: string;
  /** 信息色：中性提示 */
  info: string;
  /** 圆角基准（px）：sm/md/lg/xl/2xl 由它换算，0 即直角风格 */
  radius: number;
}

/** 需要取色的令牌键（排除 radius），用于自定义面板渲染与归一化校验 */
export type ThemeColorKey = Exclude<keyof ThemeTokens, "radius">;

/** 一套完整的预设主题：亮色与暗色各一份令牌 */
export interface ThemePreset {
  id: string;
  /** 展示名（中文） */
  name: string;
  /** 一句话描述，列在预设卡片下方 */
  desc: string;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** 用户保存下来的主题快照：亮暗两套一起存，切换模式不会失真 */
export interface SavedTheme {
  id: string;
  name: string;
  /** ISO 时间，列表里显示保存顺序 */
  createdAt: string;
  /** 保存时的外观模式，应用时一并恢复 */
  mode: ThemeMode;
  light: ThemeTokens;
  dark: ThemeTokens;
}

/** 主题设置总集合，整体以 JSON 存在 app.config.theme.settings 一个键里 */
export interface ThemeSettings {
  /** 外观模式：浅色 / 深色 / 跟随系统 */
  mode: ThemeMode;
  /** 当前预设 id；值为 "custom" 时使用下面的自定义令牌 */
  presetId: string;
  /** 自定义令牌（改过任何颜色就落到这里，亮暗各自独立） */
  custom: {
    light: ThemeTokens;
    dark: ThemeTokens;
  };
  /** 用户保存的主题，最多 MAX_SAVED_THEMES 个 */
  saved: SavedTheme[];
}
