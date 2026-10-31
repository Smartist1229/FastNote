/**
 * 主题变量构建：把配置映射成一组 `--mde-*` CSS 变量。
 *
 * 组件所有颜色都从变量取，因此外部只要改配置（或直接覆盖 CSS 变量）就能整体换肤，
 * 不需要碰组件内部的选择器。代码高亮 token 也走变量，换配色只需换一组值。
 */
import { DARK_COLORS, LIGHT_COLORS, resolveCodeTheme, type CodeThemeDefinition } from "./defaults";
import { LABELS } from "./locales";
import { SYNTAX_TOKENS, syntaxHighlightName } from "./editor/syntax";
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
  label: LABELS["en-US"]["codeTheme.follow"],
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

/**
 * 解析出「最终生效」的主题配色与代码配色。
 *
 * 编辑区代码 token 的着色规则（`buildSyntaxRules`）要用同一份代码配色，
 * 所以这一步单独拎出来，两条路各取所需、不会算出两套色。
 */
const resolvePalette = (
  config: MarkdownEditorConfig,
  resolved: "light" | "dark",
): { colors: MarkdownThemeColors; code: CodeThemeDefinition } => {
  const followPreset = config.theme.codeTheme === "follow";
  const base = resolved === "dark" ? DARK_COLORS : LIGHT_COLORS;
  const merged = { ...base, ...config.theme.colors };
  const colors = followPreset ? applyFollowFrameColors(merged, config.theme.colors) : merged;
  const code = followPreset
    ? buildFollowCodeTheme(colors)
    : resolveCodeTheme({ ...config, theme: { ...config.theme, mode: resolved } });
  return { colors, code };
};

/**
 * 编辑区代码 token 的 `::highlight()` 规则文本。
 *
 * `::highlight()` 里**自定义属性不保证可用**（取不到就退化成透明，等于没着色），
 * 所以颜色只能用字面量——这里把当前代码配色（预设或「跟随主题」算出来的那套）
 * 的十六进制值直接写进规则里，随主题一起变。半透明色（`color-mix` / `rgba`）
 * 求不出字面色，跳过它，那一类 token 就沿用正文颜色。
 */
export const buildSyntaxRules = (config: MarkdownEditorConfig, resolved: "light" | "dark"): string => {
  const { code } = resolvePalette(config, resolved);
  return SYNTAX_TOKENS.map((token) => {
    const color = code.colors[token];
    if (!color || !/#[0-9a-f]{3,8}/i.test(color)) return "";
    return `::highlight(${syntaxHighlightName(token)}) { color: ${color.trim()}; }`;
  })
    .filter(Boolean)
    .join("\n");
};

/**
 * 查找命中 / 大纲跳转高亮的规则文本。
 *
 * 这类高亮走 `::highlight()`，只认字面量属性值（自定义属性不保证可用），
 * 所以和代码 token 一样把当前配色拼进规则。颜色取自 `theme.colors`，
 * 外部改配置即可换色；拼之前过一遍白名单，避免配置值提前闭合规则块。
 */
export const buildHighlightRules = (config: MarkdownEditorConfig, resolved: "light" | "dark"): string => {
  const { colors } = resolvePalette(config, resolved);
  const base = resolved === "dark" ? DARK_COLORS : LIGHT_COLORS;
  const safe = (value: string, fallback: string): string =>
    /^[#a-zA-Z0-9(),.%\s/+-]+$/.test(value) ? value : fallback;
  return (
    [
      ["mde-find-hit", "searchMatchBg"],
      ["mde-find-current", "searchMatchActiveBg"],
      ["mde-flash", "jumpFlashBg"],
    ] as const
  )
    .map(
      ([name, key]) =>
        `::highlight(${name}) { background-color: ${safe(colors[key], base[key])}; }`,
    )
    .join("\n");
};

export const buildThemeVars = (config: MarkdownEditorConfig, resolved: "light" | "dark"): ThemeResult => {
  const { colors, code } = resolvePalette(config, resolved);
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
    // 自绘光标宽度：非法值（0 / 负 / NaN）回退到 2px
    "--mde-caret-width": `${config.editor.caretWidth > 0 ? config.editor.caretWidth : 2}px`,
    // 自绘光标高度：字号 × 倍数（非法值回退 1.25），比字略高、不占满行盒
    "--mde-caret-height": `${
      config.editor.fontSize * (config.editor.caretHeight > 0 ? config.editor.caretHeight : 1.25)
    }px`,
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
