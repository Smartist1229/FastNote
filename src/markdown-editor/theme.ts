/**
 * 主题变量构建：把配置映射成一组 `--mde-*` CSS 变量。
 *
 * 组件所有颜色都从变量取，因此外部只要改配置（或直接覆盖 CSS 变量）就能整体换肤，
 * 不需要碰组件内部的选择器。代码高亮 token 也走变量，换配色只需换一组值。
 */
import { DARK_COLORS, LIGHT_COLORS, resolveCodeTheme, type CodeThemeDefinition } from "./defaults";
import type { MarkdownEditorConfig, MarkdownThemeColors } from "./types";

const kebab = (value: string): string => value.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);

/**
 * 主题色 → CSS 变量。
 *
 * 空值一律不落变量：这样某些色（例如想沿用别的色板的项）可以在配置里留空，
 * CSS 里的 `var(--mde-x, 回退值)` 依然生效。
 */
const colorVars = (colors: Partial<MarkdownThemeColors>): Record<string, string> =>
  Object.fromEntries(
    Object.entries(colors)
      .filter(([, value]) => typeof value === "string" && value.length > 0)
      .map(([key, value]) => [`--mde-${kebab(key)}`, value as string]),
  );

export interface ThemeResult {
  /** 实际生效的亮/暗（auto 已在外部解析成具体值） */
  resolved: "light" | "dark";
  vars: Record<string, string>;
}

/**
 * 「主题」（follow）代码配色：把当前主题的语义色换算成一套代码高亮，
 * 这样换主题/换预设/自定义取色时，代码块会跟着整体变，而不是永远卡在一套固定配色上。
 *
 * 映射规则按 token 的语义找主题里最接近的那一档：
 * 关键字用强调色（最醒目）、字符串用成功色、注释用最弱的文字色、增删用成功/危险色……
 * 代码块底色取 toolbarBg（比正文暗一档，代码块才像沉进去的一块面板），
 * 头部和边框再各掺一点强调色，与行高亮（codeHighlight）形成同一套色系。
 */
const buildFollowCodeTheme = (colors: MarkdownThemeColors): CodeThemeDefinition => ({
  label: "主题",
  bg: colors.toolbarBg,
  headerBg: `color-mix(in srgb, ${colors.accent} 10%, ${colors.toolbarBg})`,
  text: colors.textBody,
  colors: {
    keyword: colors.accent,
    string: colors.tipColor,
    number: colors.noteColor,
    comment: colors.textFaint,
    function: colors.link,
    variable: colors.inlineCodeText,
    type: colors.noteColor,
    tag: colors.danger,
    attr: colors.link,
    builtin: colors.noteColor,
    literal: colors.link,
    meta: colors.textMuted,
    punctuation: colors.textBody,
    addition: colors.tipColor,
    deletion: colors.danger,
  },
});

/**
 * 「主题」模式下这两个外围色也跟着强调色走：
 * 行高亮用强调色调、边框在预设边框色上掺一层强调色，与代码块的头部形成同一套色系。
 * 只有当调用方**没有**显式指定时才写（先看 overrides），避免盖掉用户自己配的色。
 */
const applyFollowFrameColors = (
  colors: MarkdownThemeColors,
  overrides: Partial<MarkdownThemeColors>,
): MarkdownThemeColors => ({
  ...colors,
  codeHighlight: overrides.codeHighlight ?? `color-mix(in srgb, ${colors.accent} 16%, transparent)`,
  codeBorder: overrides.codeBorder ?? `color-mix(in srgb, ${colors.accent} 28%, ${colors.border})`,
});

export const buildThemeVars = (config: MarkdownEditorConfig, resolved: "light" | "dark"): ThemeResult => {
  const followPreset = config.theme.codeTheme === "follow";
  const base = resolved === "dark" ? DARK_COLORS : LIGHT_COLORS;
  const merged = { ...base, ...config.theme.colors };
  const colors = followPreset ? applyFollowFrameColors(merged, config.theme.colors) : merged;
  const code = followPreset
    ? buildFollowCodeTheme(colors)
    : resolveCodeTheme({ ...config, theme: { ...config.theme, mode: resolved } });
  const typography = config.preview.typography;

  const vars: Record<string, string> = {
    ...colorVars(colors),
    "--mde-radius": `${config.theme.radius}px`,
    "--mde-font-family": config.theme.fontFamily,
    "--mde-mono-family": config.theme.monoFontFamily,
    "--mde-preview-font-family": typography.fontFamily,
    "--mde-preview-font-size": typeof typography.fontSize === "number" ? `${typography.fontSize}px` : typography.fontSize,
    "--mde-preview-line-height": String(typography.lineHeight),
    "--mde-preview-letter-spacing": typography.letterSpacing,
    "--mde-preview-max-width": typeof typography.maxWidth === "number" ? `${typography.maxWidth}px` : typography.maxWidth,
    "--mde-preview-padding": typography.padding,
    "--mde-preview-para": `${typography.paragraphSpacing}em`,
    "--mde-heading-top": `${typography.headingTopSpacing}em`,
    "--mde-heading-bottom": `${typography.headingBottomSpacing}em`,
    "--mde-heading-weight": String(typography.headingWeight),
    "--mde-preview-align": typography.textAlign,
    "--mde-editor-font-size": `${config.editor.fontSize}px`,
    "--mde-editor-line-height": String(config.editor.lineHeight),
    // 连字关 → none + 关掉 liga/calt：等宽字体默认会把 ->、== 画成单个符号
    "--mde-ligatures": config.editor.fontLigatures ? "normal" : "none",
    "--mde-font-features": config.editor.fontLigatures ? '"liga" 1, "calt" 1' : '"liga" 0, "calt" 0',
    "--mde-code-bg": code.bg,
    "--mde-code-header-bg": code.headerBg,
    "--mde-code-text": code.text,
    "--mde-code-collapse-height": `${config.preview.codeCollapseHeight}px`,
    ...Object.fromEntries(Object.entries(code.colors).map(([key, value]) => [`--mde-tok-${key}`, value])),
    ...(config.theme.cssVars ?? {}),
  };

  return { resolved, vars };
};
