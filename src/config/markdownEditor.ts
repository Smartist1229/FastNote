/**
 * 自研 Markdown 编辑器（src/markdown-editor）在 FastNote 里的配置。
 *
 * 两件事放在这里：
 * 1. **行为配置**：工具栏、预览、查找、快捷键等默认值。组件自带一套完整默认值，
 *    这里只写与软件契合的部分（中文文案、分栏、链接用系统浏览器打开等）。
 * 2. **主题桥接**：`buildEditorColors()` 把软件的主题令牌（interface/theme.ts 的
 *    ThemeTokens）换算成编辑器的配色（MarkdownThemeColors）。这样换主题/换预设/
 *    自定义取色，编辑器会跟着变，而不需要改编辑器内部的一行代码。
 *
 * 编辑器本身不知道软件主题的存在——颜色全部从这份配置注入，组件保持可独立抽包。
 */
import type {
  DeepPartial,
  MarkdownEditorConfig,
  MarkdownThemeColors,
} from "@/markdown-editor";
import { hexToRgba } from "@/lib/theme";
import type { ResolvedThemeMode, ThemeTokens } from "@/interface/theme";
import type { EditorSettings } from "@/interface/settings";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "@/config/appDefaults";

/** 夹取到 [min, max]：设置里的数值型项在写入前已夹过一次，这里只防脏数据 */
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 主题令牌 → 编辑器配色。
 *
 * 只映射"语义能对上"的键：底色/文字/边框/强调色直接取令牌，需要透明度的用 hexToRgba 派生。
 * 代码块的配色不在这里映射——它由 `theme.codeTheme` 预设决定（深色底更耐看），
 * 只有折叠头、边框这些外围元素跟着主题走。
 */
export const buildEditorColors = (
  tokens: ThemeTokens,
  _mode: ResolvedThemeMode,
): Partial<MarkdownThemeColors> => ({
  bg: tokens.surface,
  editorBg: tokens.surface,
  previewBg: tokens.surface,
  toolbarBg: tokens.surfaceAlt,
  toolbarHover: tokens.surfaceStrong,
  toolbarActiveBg: hexToRgba(tokens.accent, 0.14),
  toolbarActiveText: tokens.accent,
  border: tokens.border,
  borderStrong: tokens.borderStrong,
  text: tokens.textInk,
  textBody: tokens.textBody,
  textMuted: tokens.textMuted,
  textFaint: tokens.textFaint,
  accent: tokens.accent,
  accentHover: tokens.accent,
  accentSoft: hexToRgba(tokens.accent, 0.12),
  onAccent: tokens.onAccent,
  link: tokens.accent,
  selection: hexToRgba(tokens.accent, 0.22),
  inlineCodeBg: tokens.surfaceAlt,
  inlineCodeText: tokens.textInk,
  codeBorder: tokens.border,
  quoteBorder: hexToRgba(tokens.accent, 0.35),
  quoteBg: tokens.surfaceAlt,
  quoteText: tokens.textMuted,
  tableBorder: tokens.border,
  tableHeaderBg: tokens.surfaceAlt,
  tableStripeBg: tokens.appBg,
  markBg: hexToRgba(tokens.warning, 0.35),
  markText: tokens.textInk,
  noteColor: tokens.info,
  tipColor: tokens.success,
  warningColor: tokens.warning,
  cautionColor: tokens.danger,
  danger: tokens.danger,
  divider: tokens.borderSoft,
  gutterBg: "transparent",
  gutterText: tokens.textFaint,
  gutterActiveText: tokens.accent,
  scrollbarThumb: tokens.borderStrong,
  scrollbarThumbHover: tokens.textFaint,
  statusBg: tokens.surfaceAlt,
  statusText: tokens.textMuted,
  outlineBg: tokens.surface,
  outlineActiveBg: hexToRgba(tokens.accent, 0.12),
  outlineActiveText: tokens.accent,
  menuBg: tokens.surface,
  menuBorder: tokens.border,
  inputBg: tokens.surfaceAlt,
  inputText: tokens.textInk,
  inputBorder: tokens.border,
  searchBg: tokens.surface,
  searchBorder: tokens.border,
  searchMatchBg: hexToRgba(tokens.warning, 0.45),
  searchMatchBorder: hexToRgba(tokens.warning, 0.75),
  searchMatchActiveBg: hexToRgba(tokens.accent, 0.5),
  searchMatchActiveBorder: tokens.accent,
});

/**
 * 笔记编辑器的「固定部分」：与软件强绑定、不打算开放给用户配的那几项。
 *
 * 其余全部由 EditorSettings 决定（见 buildNoteEditorConfig）。
 */
export const NOTE_EDITOR_CONFIG: DeepPartial<MarkdownEditorConfig> = {
  locale: "zh-CN",
  mode: {
    available: ["split", "code", "read"],
  },
  editor: {
    placeholder: "开始书写 Markdown…",
  },
  preview: {
    typography: {
      // 预览内边距比组件默认（28px 32px）紧一点，笔记区宽度有限
      padding: "22px 26px",
    },
  },
  toolbar: {
    // 窄窗下工具栏溢出时可横向滚动
    scrollable: true,
  },
};

/**
 * 组装笔记编辑器的完整配置：固定部分 + 软件设置 + 当前主题。
 *
 * 设置项与 MarkdownEditorConfig 的对应关系（扁平字段 → 嵌套配置）都写在这里，
 * 编辑器本身不知道软件设置的存在。
 *
 * @param settings 软件设置里的「编辑器」分区（app.config.editor.*）
 * @param tokens   当前主题令牌，换算成编辑器配色
 * @param themeMode 解析后的明暗模式
 * @param fontSize 实际字号：设置里的默认字号，或滚轮临时缩放后的值
 */
export const buildNoteEditorConfig = (
  settings: EditorSettings,
  tokens: ThemeTokens,
  themeMode: ResolvedThemeMode,
  fontSize?: number,
): DeepPartial<MarkdownEditorConfig> => {
  const bodyFontSize = clamp(fontSize ?? settings.fontSize, FONT_SIZE_MIN, FONT_SIZE_MAX);

  return {
    ...NOTE_EDITOR_CONFIG,
    mode: {
      ...NOTE_EDITOR_CONFIG.mode,
      defaultMode: settings.defaultMode,
      showSwitch: settings.showModeSwitch,
    },
    editor: {
      ...NOTE_EDITOR_CONFIG.editor,
      fontSize: bodyFontSize,
      lineHeight: settings.sourceLineHeight,
      tabSize: settings.tabSize,
      tabKey: settings.tabKey,
      wrap: settings.wrap,
      spellCheck: settings.spellCheck,
      lineNumbers: settings.lineNumbers,
      gutterClickSelectsLine: settings.gutterClickSelectsLine,
      continueMarkdownOnEnter: settings.continueMarkdownOnEnter,
      autoPair: {
        brackets: settings.autoPairBrackets,
        quotes: settings.autoPairQuotes,
        backticks: settings.autoPairBackticks,
      },
      historyLimit: settings.historyLimit,
    },
    preview: {
      ...NOTE_EDITOR_CONFIG.preview,
      debounce: settings.previewDebounce,
      syncScroll: settings.syncScroll,
      syncScrollMode: settings.syncScrollMode,
      highlight: settings.highlight,
      showCodeLineNumbers: settings.codeLineNumbers,
      showCodeLanguage: settings.showCodeLanguage,
      codeCollapsible: settings.codeCollapsible,
      codeCollapseDefault: settings.codeCollapseDefault,
      codeCollapseThreshold: settings.codeCollapseThreshold,
      codeCollapseHeight: settings.codeCollapseHeight,
      codeHighlightLines: settings.codeHighlightLines,
      codeActions: {
        copy: settings.codeCopyButton,
        wrap: settings.codeWrapButton,
      },
      calloutCollapsible: settings.calloutCollapsible,
      math: settings.math,
      mermaid: settings.mermaid,
      mermaidTheme: settings.mermaidTheme,
      taskInteractive: settings.taskInteractive,
      allowHtml: settings.allowHtml,
      sanitizeHtml: settings.sanitizeHtml,
      linkTarget: settings.linkTarget,
      showFrontmatter: settings.showFrontmatter,
      showFootnotes: settings.showFootnotes,
      tables: {
        striped: settings.tableStriped,
        bordered: settings.tableBordered,
        compact: settings.tableCompact,
        fullWidth: settings.tableFullWidth,
      },
      typography: {
        ...NOTE_EDITOR_CONFIG.preview?.typography,
        // 预览比源码大 1px：源码要塞更多字符，预览要更好读
        fontSize: bodyFontSize + 1,
        lineHeight: settings.previewLineHeight,
        paragraphSpacing: settings.paragraphSpacing,
        headingTopSpacing: settings.headingTopSpacing,
        headingBottomSpacing: settings.headingBottomSpacing,
        maxWidth: settings.previewMaxWidth,
        headingWeight: settings.headingWeight,
        textAlign: settings.textAlign,
      },
    },
    toolbar: {
      ...NOTE_EDITOR_CONFIG.toolbar,
      show: settings.showToolbar,
      sticky: settings.toolbarSticky,
      compact: settings.toolbarCompact,
      labels: settings.toolbarLabels,
      tooltip: settings.toolbarTooltip,
      scrollWheel: settings.toolbarScrollWheel,
      openOnHover: settings.toolbarOpenOnHover,
      hoverOpenDelay: settings.toolbarHoverOpenDelay,
      hoverCloseDelay: settings.toolbarHoverCloseDelay,
    },
    statusBar: {
      show: settings.showStatusBar,
      words: settings.statusWords,
      chars: settings.statusChars,
      lines: settings.statusLines,
      cursor: settings.statusCursor,
      readingTime: settings.statusReadingTime,
      mode: settings.statusMode,
      readingSpeed: settings.statusReadingSpeed,
    },
    outline: {
      show: settings.showOutline,
      position: settings.outlinePosition,
      width: settings.outlineWidth,
      maxDepth: settings.outlineMaxDepth,
      indent: settings.outlineIndent,
    },
    split: {
      ratio: settings.splitRatio,
      resizable: settings.splitResizable,
    },
    search: {
      enabled: settings.searchEnabled,
      showReplace: settings.searchShowReplace,
      caseSensitive: settings.searchCaseSensitive,
      regex: settings.searchRegex,
      highlightAll: settings.searchHighlightAll,
      loop: settings.searchLoop,
      seedFromSelection: settings.searchSeedFromSelection,
      maxMatches: settings.searchMaxMatches,
    },
    theme: {
      mode: themeMode,
      colors: buildEditorColors(tokens, themeMode),
      codeTheme: settings.codeTheme,
      radius: tokens.radius,
    },
    shortcuts: settings.shortcuts,
  };
};

/**
 * AI 回复的纯渲染配置。
 *
 * 用 `render` 模式：没有工具栏 / 状态栏 / 查找框，高度随内容增长。
 * 排版对齐聊天面板（13px、行距 1.75、无内边距、不限宽），代码高亮与公式照常支持。
 */
export const buildAiRenderConfig = (
  tokens: ThemeTokens,
  themeMode: ResolvedThemeMode,
): DeepPartial<MarkdownEditorConfig> => ({
  locale: "zh-CN",
  mode: { defaultMode: "render", available: [], showSwitch: false },
  preview: {
    debounce: 0,
    highlight: true,
    showCodeLineNumbers: false,
    codeCollapsible: true,
    math: true,
    mermaid: true,
    taskInteractive: false,
    linkTarget: "_self",
    typography: {
      fontSize: 13,
      lineHeight: 1.75,
      maxWidth: "none",
      padding: "0",
      paragraphSpacing: 0.75,
    },
  },
  toolbar: { show: false },
  statusBar: { show: false },
  search: { enabled: false },
  shortcuts: false,
  theme: {
    mode: themeMode,
    colors: buildEditorColors(tokens, themeMode),
    codeTheme: "atom",
    radius: tokens.radius,
  },
});
