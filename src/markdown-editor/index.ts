/**
 * 组件公共入口。
 *
 * 单独抽包时把 package.json 的 exports 指到这里即可；样式已在组件内部 import，
 * 使用方不需要额外引 CSS（KaTeX 样式会在首次渲染公式时按需加载）。
 */
export { MarkdownEditor } from "./components/MarkdownEditor";
export { MarkdownPreview } from "./render/MarkdownPreview";

/** 默认键位表：软件层的「设置 → 快捷键」直接读它，避免文档与实际键位漂移 */
export { DEFAULT_SHORTCUTS, FORMAT_ACTIONS, SHORTCUTS_BY_ACTION, resolveFormatActions } from "./shortcuts";

export { parseMarkdown } from "./parser/block";
export { parseCodeMeta, parseLineRanges } from "./render/codeMeta";
export { parseInline, inlineToText } from "./parser/inline";
export {
  buildSearchRegExp,
  expandReplacement,
  findMatches,
  nextMatchIndex,
  offsetToLine,
  prevMatchIndex,
  replaceAllMatches,
  replaceMatch,
} from "./editor/search";

export {
  DEFAULT_CONFIG,
  DEFAULT_CONFIG as DEFAULT_MARKDOWN_EDITOR_CONFIG,
  TOOLBAR_PRESETS,
  CODE_THEMES,
  LIGHT_COLORS,
  DARK_COLORS,
  FONT_STACKS,
  LABELS,
  resolveConfig,
  resolveLabels,
  resolveCodeTheme,
  mergeDeep,
} from "./defaults";

export {
  runCommand,
  applyHeading,
  applyCallout,
  applyAdmonition,
  applyInlineColor,
  computeStats,
  detectFormats,
  continueMarkdownOnEnter,
  autoPairOnInput,
} from "./editor/commands";

export type { EditState, CommandOptions, ActiveFormats, InlineColorProp } from "./editor/commands";

export type {
  MarkdownEditorProps,
  MarkdownEditorConfig,
  MarkdownEditorInstance,
  MarkdownEditorMode,
  MarkdownEditorLocale,
  MarkdownEditorInputConfig,
  MarkdownPreviewConfig,
  MarkdownToolbarConfig,
  MarkdownStatusBarConfig,
  MarkdownOutlineConfig,
  MarkdownSplitConfig,
  MarkdownSearchConfig,
  MarkdownThemeConfig,
  MarkdownThemeColors,
  SearchOptions,
  SearchMatch,
  MarkdownThemeMode,
  MarkdownTypography,
  MarkdownChangeMeta,
  MarkdownChangeSource,
  MarkdownStats,
  MarkdownCustomTool,
  ToolbarEntry,
  ToolbarItemName,
  DeepPartial,
  CodeThemeColors,
  CodeThemePreset,
  BlockNode,
  InlineNode,
  OutlineItem,
  ParsedDocument,
} from "./types";
