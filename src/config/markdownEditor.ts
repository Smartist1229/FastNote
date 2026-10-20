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
import { APP_MONO_FONT_STACK, APP_UI_FONT_STACK, FONT_SIZE_MAX, FONT_SIZE_MIN } from "@/config/appDefaults";

/** 夹取到 [min, max]：设置里的数值型项在写入前已夹过一次，这里只防脏数据 */
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * 笔记编辑器的**默认**根圆角（px）：4，不跟随主题圆角。
 * 主题圆角服务于卡片与弹窗，编辑器是铺满内容区的面板，跟着它变会出现明显的弧度缺口。
 * 这里只是默认值——用户可在「编辑器 → 主题与其他 → 编辑器圆角」里改（0 = 直角）。
 */
const NOTE_EDITOR_RADIUS = 4;

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
  // codeHighlight / codeBorder 的「跟随主题」变体在 markdown-editor/theme.ts 里按语义色算，
  // 且只在选中 follow 预设时生效——这里保持常规预设的原样。
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
  // 光标所在行：比正文深一点点就够了，重了会盖过选中色
  activeLineBg: hexToRgba(tokens.textInk, 0.05),
  // 大纲跳转后的目标标题：用强调色，和「当前命中」是同一套语义（都是"你刚跳到这儿"）
  jumpFlashBg: hexToRgba(tokens.accent, 0.16),
  // 编辑区代码块的整块底色：按主题强调色掺出一层极浅的底（很淡，只把代码块与正文分开）。
  // 与 preview.codeTheme 无关——这里只管编辑区那层「底色」，token 的文字颜色仍由 codeTheme 决定。
  sourceCodeBg: hexToRgba(tokens.accent, 0.05),
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
    // 编辑区用等宽栈（组件默认是同一套 MONO，这里显式写死为软件的默认值），
    // 字体不放进设置面板，改 config/appDefaults.ts 即全软件生效
    fontFamily: APP_MONO_FONT_STACK,
  },
  preview: {
    // 外链一律由应用侧拦截后用系统浏览器打开（见 NoteEditor 的 onLinkClick），
    // 这里设 _self 是防止 WebView 真的在窗口里跳转，把整个界面顶掉
    linkTarget: "_self",
    typography: {
      // 预览内边距比组件默认（28px 32px）紧一点，笔记区宽度有限
      padding: "22px 26px",
      // 预览正文走软件界面字体，与全局（App.css html）保持一致
      fontFamily: APP_UI_FONT_STACK,
    },
  },
  theme: {
    // 工具栏、查找框、大纲等界面元素
    fontFamily: APP_UI_FONT_STACK,
    // 代码块、内联代码
    monoFontFamily: APP_MONO_FONT_STACK,
    // 笔记区是铺满内容区的面板：默认 4px，不跟随主题里的圆角设置
    // （主题圆角是给卡片/弹窗用的，跟着它变会让编辑器四角出现明显的弧度缺口）。
    // 组件本身的 radius 配置保留，用户仍可在设置里覆盖。
    radius: NOTE_EDITOR_RADIUS,
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
      // 字间距：软件里按 px 存，编辑器收 CSS 长度
      letterSpacing: `${clamp(settings.letterSpacing, 0, 3)}px`,
      tabSize: settings.tabSize,
      tabKey: settings.tabKey,
      fontLigatures: settings.fontLigatures,
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
      highlightActiveLine: settings.highlightActiveLine,
      caretWidth: clamp(settings.caretWidth, 1, 6),
      // 光标高度按字号倍数给（1 = 与字同高，略大于 1 上下各出头一点）
      caretHeight: clamp(settings.caretHeight, 0.6, 2),
      // 编辑区代码块增强（语言识别 + 整块浅底 + token 着色）；
      // 底色由 buildEditorColors 的 sourceCodeBg 按主题色生成，这里只传开关
      codeHighlight: settings.codeHighlight,
      scrollPaddingBottom: clamp(settings.scrollPaddingBottom, 0, 600),
      // 字号缩放交给编辑器自己做（滚轮 + Ctrl/⌘ =/- /0），软件只管开关、步长与范围
      zoom: {
        enabled: settings.ctrlScrollZoom,
        step: clamp(settings.zoomStep, 1, 4),
        min: FONT_SIZE_MIN,
        max: FONT_SIZE_MAX,
      },
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
      breaks: settings.breaks,
      sanitizeHtml: settings.sanitizeHtml,
      showFrontmatter: settings.showFrontmatter,
      showFootnotes: settings.showFootnotes,
      imagePreview: settings.imagePreview,
      // 放大浮层缩放区间：最小值不能高过最大值，否则滚轮一滚就顶到边界
      imageZoom: {
        step: clamp(settings.imageZoomStep, 1.05, 3),
        min: clamp(settings.imageZoomMin, 0.1, 1),
        max: clamp(settings.imageZoomMax, 2, 20),
      },
      tables: {
        striped: settings.tableStriped,
        bordered: settings.tableBordered,
        compact: settings.tableCompact,
        fullWidth: settings.tableFullWidth,
      },
      typography: {
        ...NOTE_EDITOR_CONFIG.preview?.typography,
        // 预览比编辑大 1px：编辑要塞更多字符，预览要更好读
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
      pinTail: settings.toolbarPinTail,
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
      caretTarget: settings.outlineCaretTarget,
      flashTarget: settings.outlineFlashTarget,
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
      regexReplace: settings.searchRegexReplace,
      highlightAll: settings.searchHighlightAll,
      highlightPreview: settings.searchHighlightPreview,
      loop: settings.searchLoop,
      seedFromSelection: settings.searchSeedFromSelection,
      maxMatches: settings.searchMaxMatches,
      blockHostFind: settings.searchBlockHostFind,
    },
    theme: {
      ...NOTE_EDITOR_CONFIG.theme,
      mode: themeMode,
      colors: buildEditorColors(tokens, themeMode),
      codeTheme: settings.codeTheme,
      // 圆角取设置项而不是主题令牌：默认 4px，用户可在「编辑器」里自己调（0 = 直角）
      radius: clamp(settings.radius, 0, 24),
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
      fontFamily: APP_UI_FONT_STACK,
    },
  },
  toolbar: { show: false },
  statusBar: { show: false },
  search: { enabled: false },
  shortcuts: false,
  theme: {
    fontFamily: APP_UI_FONT_STACK,
    monoFontFamily: APP_MONO_FONT_STACK,
    mode: themeMode,
    colors: buildEditorColors(tokens, themeMode),
    codeTheme: "atom",
    radius: tokens.radius,
  },
});
