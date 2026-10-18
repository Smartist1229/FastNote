/**
 * 主题变量构建：把配置映射成一组 `--mde-*` CSS 变量。
 *
 * 组件所有颜色都从变量取，因此外部只要改配置（或直接覆盖 CSS 变量）就能整体换肤，
 * 不需要碰组件内部的选择器。代码高亮 token 也走变量，换配色只需换一组值。
 */
import { DARK_COLORS, LIGHT_COLORS, resolveCodeTheme } from "./defaults";
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

export const buildThemeVars = (config: MarkdownEditorConfig, resolved: "light" | "dark"): ThemeResult => {
  const base = resolved === "dark" ? DARK_COLORS : LIGHT_COLORS;
  const colors = { ...base, ...config.theme.colors };
  const code = resolveCodeTheme({ ...config, theme: { ...config.theme, mode: resolved } });
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
    "--mde-code-bg": code.bg,
    "--mde-code-header-bg": code.headerBg,
    "--mde-code-text": code.text,
    "--mde-code-collapse-height": `${config.preview.codeCollapseHeight}px`,
    ...Object.fromEntries(Object.entries(code.colors).map(([key, value]) => [`--mde-tok-${key}`, value])),
    ...(config.theme.cssVars ?? {}),
  };

  return { resolved, vars };
};
