/**
 * 组件对外的全部类型契约。
 *
 * 分层：
 * - `MarkdownEditorProps`：React 组件入参（受控/非受控、模式、事件）；
 * - `MarkdownEditorConfig`：行为与外观配置，统一挂在 `config` 下，支持深合并；
 * - `MarkdownEditorInstance`：通过 `ref` / `onReady` 拿到的命令式 API；
 * - 解析层与渲染层的类型（AST）在 parser/types.ts 中单独定义。
 *
 * 兼容性约定：新增配置项一律给默认值并保持向后兼容；删除/改名必须升主版本。
 */
import type { CSSProperties, ReactNode } from "react";
import type { OutlineItem, ParsedDocument } from "./parser/types";

export type {
  AlertKind,
  BlockNode,
  InlineNode,
  ListItemNode,
  OutlineItem,
  ParsedDocument,
  TableAlign,
  TaskState,
} from "./parser/types";

/** 查找 / 替换的类型也归到公共契约里，外部不必深挖 editor/ 目录 */
export type { SearchMatch, SearchOptions } from "./editor/search";

/**
 * 视图模式。
 * - `split`：左编辑右预览；
 * - `code`：只显示编辑区（可开行号）；
 * - `read`：只显示渲染结果，但保留工具栏 / 状态栏等外壳；
 * - `render`：**纯渲染**——只输出渲染结果，工具栏、状态栏、查找框、大纲一律不渲染，
 *   高度随内容增长。给「只要把一段 Markdown 显示出来」的场景用（如 AI 回复），
 *   它不参与模式切换，因此不在 `mode.available` 里也照样生效。
 */
export type MarkdownEditorMode = "split" | "code" | "read" | "render";

/** 主题模式：auto 跟随系统 prefers-color-scheme */
export type MarkdownThemeMode = "light" | "dark" | "auto";

/** 可被配置隐藏的内置工具名 */
export type ToolbarItemName =
  | "undo"
  | "redo"
  | "heading"
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "mark"
  /** 文字颜色（前景）：色盘选择一个颜色，套一层带 color 的行内 span */
  | "textColor"
  /** 文字底色（背景）：同一个色盘，套一层带 background-color 的行内 span */
  | "bgColor"
  | "sup"
  | "sub"
  | "inlineCode"
  | "codeBlock"
  | "quote"
  | "alert"
  | "callout"
  | "bulletList"
  | "orderedList"
  | "taskList"
  | "indent"
  | "outdent"
  | "link"
  | "image"
  | "table"
  | "hr"
  | "math"
  | "mathBlock"
  | "mermaid"
  | "footnote"
  | "toc"
  | "mode"
  | "outline"
  | "fullscreen"
  | "copy";

/** 工具栏条目：工具名、分隔符 `|` 或分组 */
export type ToolbarEntry = ToolbarItemName | "|" | { group: ToolbarItemName[] };

/** 自定义工具：图标可直接给 ReactNode，也可给 SVG path 字符串 */
export interface MarkdownCustomTool {
  name: string;
  title: string;
  /** 内联 SVG 的 path d 属性，或任意 ReactNode */
  icon: string | ReactNode;
  /** 返回 false 时不显示 */
  visible?: boolean;
  onClick: (api: MarkdownEditorInstance) => void;
}

/** 主题色板：每一项都会落成 `--mde-*` CSS 变量 */
export interface MarkdownThemeColors {
  /** 组件底色 */
  bg: string;
  /** 编辑区底色 */
  editorBg: string;
  /** 预览区底色 */
  previewBg: string;
  /** 工具栏底色 */
  toolbarBg: string;
  /** 工具按钮悬停底色 */
  toolbarHover: string;
  /** 工具按钮激活底色 */
  toolbarActiveBg: string;
  /** 工具按钮激活前景 */
  toolbarActiveText: string;
  /** 常规边框 */
  border: string;
  /** 强边框（hover / 分隔） */
  borderStrong: string;
  /** 主文字 */
  text: string;
  /** 正文文字 */
  textBody: string;
  /** 次要文字 */
  textMuted: string;
  /** 弱化文字 */
  textFaint: string;
  /** 强调色 */
  accent: string;
  /** 强调色 hover */
  accentHover: string;
  /** 强调色浅底 */
  accentSoft: string;
  /** 强调色底上的文字 */
  onAccent: string;
  /** 链接色 */
  link: string;
  /** 选中文本底色 */
  selection: string;
  /** 行内代码底色 */
  inlineCodeBg: string;
  /** 行内代码文字 */
  inlineCodeText: string;
  /** 代码块底色 */
  codeBg: string;
  /** 代码块文字 */
  codeText: string;
  /** 代码块头部底色 */
  codeHeaderBg: string;
  /** 代码块边框 */
  codeBorder: string;
  /** 围栏行高亮底色（```lang {1-3}） */
  codeHighlight: string;
  /** 代码块右上角按钮悬停底色 */
  codeToolHover: string;
  /** 引用左边线 */
  quoteBorder: string;
  /** 引用底色 */
  quoteBg: string;
  /** 引用文字 */
  quoteText: string;
  /** 表格边框 */
  tableBorder: string;
  /** 表头底色 */
  tableHeaderBg: string;
  /** 表格斑马纹底色 */
  tableStripeBg: string;
  /** 高亮标记底色 */
  markBg: string;
  /** 高亮标记文字 */
  markText: string;
  /** 提示块：note */
  noteColor: string;
  /** 提示块：tip */
  tipColor: string;
  /** 提示块：warning */
  warningColor: string;
  /** 提示块：caution */
  cautionColor: string;
  /** 错误 / 危险 */
  danger: string;
  /** 阴影 */
  shadow: string;
  /** 分段控件（模式切换激活块）阴影 */
  chipShadow: string;
  /** 遮罩层 */
  overlay: string;
  /** 分栏分隔条 */
  divider: string;
  /** 行号槽底色 */
  gutterBg: string;
  /** 行号文字 */
  gutterText: string;
  /** 行号悬停 / 当前行文字 */
  gutterActiveText: string;
  /** 滚动条滑块 */
  scrollbarThumb: string;
  /** 滚动条滑块悬停 */
  scrollbarThumbHover: string;
  /** 状态栏底色 */
  statusBg: string;
  /** 状态栏文字 */
  statusText: string;
  /** 大纲面板底色 */
  outlineBg: string;
  /** 大纲当前项底色 */
  outlineActiveBg: string;
  /** 大纲当前项文字 */
  outlineActiveText: string;
  /** 下拉菜单底色 */
  menuBg: string;
  /** 下拉菜单边框 */
  menuBorder: string;
  /** 输入框（查找 / 替换）底色 */
  inputBg: string;
  /** 输入框文字 */
  inputText: string;
  /** 输入框边框 */
  inputBorder: string;
  /** 查找框底色 */
  searchBg: string;
  /** 查找框边框 */
  searchBorder: string;
  /** 查找框阴影 */
  searchShadow: string;
  /** 命中底色 */
  searchMatchBg: string;
  /** 命中描边 */
  searchMatchBorder: string;
  /** 当前命中底色 */
  searchMatchActiveBg: string;
  /** 当前命中描边 */
  searchMatchActiveBorder: string;
  /** 光标所在行的底色（editor.highlightActiveLine） */
  activeLineBg: string;
  /** 大纲跳转后目标标题的高亮底色（outline.flashTarget） */
  jumpFlashBg: string;
  /**
   * 编辑区里围栏代码块整块的底色（`editor.codeHighlight`）。
   *
   * 只是「很浅的一层」，用来把代码块和正文分开；语法 token 的颜色不在这里，
   * 它跟 `theme.codeTheme` / `theme.codeColors` 走（见 theme.ts 的 buildSyntaxRules）。
   */
  sourceCodeBg: string;
  /** 图片放大预览浮层的遮罩底色（preview.imagePreview） */
  imageViewerBg: string;
}

/** 预览区排版参数 */
export interface MarkdownTypography {
  fontFamily: string;
  fontSize: number | string;
  lineHeight: number | string;
  letterSpacing: string;
  /** 段落间距（em） */
  paragraphSpacing: number;
  /** 标题与上文间距（em） */
  headingTopSpacing: number;
  /** 标题与下文间距（em） */
  headingBottomSpacing: number;
  /** 内容最大宽度，超出后居中留白 */
  maxWidth: number | string;
  /** 左右内边距 */
  padding: string;
  /** 标题字重 */
  headingWeight: number | string;
  /** 正文对齐 */
  textAlign: "left" | "justify" | "start";
}

/** 代码块配色预设名 */
export type CodeThemePreset = "github" | "atom" | "nord" | "solarized" | "monokai" | "plain" | "follow";

/** 代码高亮 token → 颜色；未给出的沿用预设 */
export interface CodeThemeColors {
  keyword: string;
  string: string;
  number: string;
  comment: string;
  function: string;
  variable: string;
  type: string;
  tag: string;
  attr: string;
  builtin: string;
  literal: string;
  meta: string;
  punctuation: string;
  addition: string;
  deletion: string;
}

/** 输入区配置 */
export interface MarkdownEditorInputConfig {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  /**
   * 字间距（任意 CSS 长度，`"0"` 表示不加）。
   * 中英混排、纯中文长文里给字与字之间留一点空气，整块正文会松快不少；
   * 会同时作用到编辑区与折行测量层，两处必须一致（否则同一行折出来的行数不同）。
   */
  letterSpacing: string;
  /** Tab 宽度（同时用于列表缩进） */
  tabSize: number;
  /** Tab 键行为：indent = 缩进整行，spaces = 插入空格，none = 交给浏览器 */
  tabKey: "indent" | "spaces" | "none";
  placeholder: string;
  spellCheck: boolean;
  /**
   * 字体连字：等宽字体默认会把 `->`、`==`、`<=` 画成一个符号。
   * Markdown 编辑区里这些是语法标记，连起来会影响判读，所以默认关。
   */
  fontLigatures: boolean;
  /** 自动换行（关闭后横向滚动） */
  wrap: boolean;
  /** 代码模式行号槽 */
  lineNumbers: boolean;
  /** 输入时自动配对括号、引号、反引号 */
  autoPair: {
    brackets: boolean;
    quotes: boolean;
    backticks: boolean;
  };
  /** 回车自动续写列表/引用/任务项 */
  continueMarkdownOnEnter: boolean;
  /** 撤销栈上限 */
  historyLimit: number;
  /**
   * 字号缩放（Ctrl/⌘ + 滚轮、Ctrl/⌘ + `=` / `-` / `0`）。
   *
   * 组件只负责把「目标字号」算出来交给 `onFontSizeChange`，
   * 默认字号（`0` 复原到哪）由宿主自己决定——它才是设置项的主人。
   */
  zoom: {
    /** 是否允许改字号；关掉后这四个按键/手势都还给宿主 */
    enabled: boolean;
    /** 每次加减的步长（px） */
    step: number;
    /** 缩放范围（px） */
    min: number;
    max: number;
  };
  /** 滚到底部时额外留白（px），方便继续写 */
  scrollPaddingBottom: number;
  /** 点击行号选中整行 */
  gutterClickSelectsLine: boolean;
  /**
   * 光标所在行整行高亮。
   *
   * 按行虚拟化之后「哪一行是当前行」只是给那一个 `.mde-line` 加个类的事，
   * 行号槽里对应的那一格也跟着点亮。失焦时撤掉（否则两个编辑器并排会各亮一行）。
   */
  highlightActiveLine: boolean;
  /**
   * 自绘光标的宽度（px）。
   *
   * 原生光标恒为 1px（Chromium 没有 caret-width），125%/150% 缩放下细成一根毛发，
   * 所以组件自己画一根；这里决定它多宽，0 / 负数回退到默认的 2px。
   */
  caretWidth: number;
  /**
   * 编辑区的代码块增强：识别围栏里的语言，给整块铺一层浅底色，并给 token 着色。
   *
   * 关掉之后编辑区就是纯文本的样子（围栏仍按普通文字显示，样式和以前一致）。
   * 着色依赖 `preview.highlight`（同一个 highlight.js 开关），预览关掉高亮时这里也不再着色。
   */
  codeHighlight: boolean;
  /**
   * 自绘光标的高度（相对字号的倍数）。
   *
   * 1 = 与字同高；略大于 1 时上下各出头一点，像原生光标那样把字符"括"住。
   * 不会超过行盒高度（行高 1.75 时 1.25 倍字号正好居中、上下留白）。
   * 0 / 负数回退到默认的 1.25。
   */
  caretHeight: number;
}

/** 预览区配置 */
export interface MarkdownPreviewConfig {
  /** 输入到渲染的防抖（ms），0 = 同步 */
  debounce: number;
  /** 分栏模式是否同步滚动 */
  syncScroll: boolean;
  /** 同步策略：anchor 按编辑行锚点插值，ratio 按滚动比例 */
  syncScrollMode: "anchor" | "ratio";
  /** 代码高亮 */
  highlight: boolean;
  /** 代码块行号 */
  showCodeLineNumbers: boolean;
  /** 代码块语言标签 */
  showCodeLanguage: boolean;
  /** 代码块可折叠 */
  codeCollapsible: boolean;
  /** 渲染围栏里的行高亮范围（```py {1-3,5}） */
  codeHighlightLines: boolean;
  /** 超过折叠阈值时默认收起 */
  codeCollapseDefault: boolean;
  /** 超过多少行才出现折叠控件 */
  codeCollapseThreshold: number;
  /** 折叠后的最大高度（px） */
  codeCollapseHeight: number;
  /** 代码块右上角操作 */
  codeActions: {
    copy: boolean;
    wrap: boolean;
  };
  /** `???` 折叠提示块是否真的可折叠（关闭后一律渲染成常驻提示块） */
  calloutCollapsible: boolean;
  /** MathJax 风格公式（KaTeX 渲染） */
  math: boolean;
  /** Mermaid 图表 */
  mermaid: boolean;
  /** Mermaid 主题 */
  mermaidTheme: "default" | "dark" | "forest" | "neutral" | "base";
  /** 表格样式 */
  tables: {
    striped: boolean;
    bordered: boolean;
    compact: boolean;
    /** 撑满内容宽度（否则按内容自适应） */
    fullWidth: boolean;
  };
  /** 任务列表勾选框可点击 */
  taskInteractive: boolean;
  /**
   * 点击图片放大预览（分栏预览区 / 阅读视图）。
   *
   * 放大后在浮层里用滚轮继续缩放、按住拖动平移，Esc / 点空白关闭。
   * 关掉后图片就是普通静态图，点击不弹浮层（宿主可以用 `onImageClick` 接管）。
   */
  imagePreview: boolean;
  /** 放大预览浮层的缩放参数（`imagePreview` 为 true 时生效） */
  imageZoom: {
    /** 每格滚轮的倍率（>1；缩小取倒数） */
    step: number;
    /** 最小倍率 */
    min: number;
    /** 最大倍率 */
    max: number;
  };
  /** 单个换行即换行（GFM breaks）：开启后每行的 `\n` 都渲染成换行，不用行尾补两个空格；同时停用 Setext 标题 */
  breaks: boolean;
  /**
   * Setext 标题：段落下一行写 `===` / `---`，把这段文字变成一级 / 二级标题。
   * 仅在 `breaks` 关闭时生效——开启单换行即换行后，`文字\n---` 应渲染成段落 + 分割线。
   */
  setext: boolean;
  /** 允许 HTML 标签（关闭后原样显示为文本） */
  allowHtml: boolean;
  /** 对 HTML 做基础净化（去 script / on* / javascript:） */
  sanitizeHtml: boolean;
  /** 链接打开方式 */
  linkTarget: "_blank" | "_self";
  /** 空文档占位文案 */
  emptyText: string;
  /** 显示 front matter 元信息卡 */
  showFrontmatter: boolean;
  /** 显示脚注区 */
  showFootnotes: boolean;
  /** 排版 */
  typography: MarkdownTypography;
}

/** 工具栏配置 */
export interface MarkdownToolbarConfig {
  show: boolean;
  /** 吸顶（在内部滚动容器里生效） */
  sticky: boolean;
  /** 条目顺序；传空数组得到空工具栏 */
  items: ToolbarEntry[];
  /** 一键隐藏某些工具，优先于 items */
  exclude: ToolbarItemName[];
  /** 按钮显示文字而非只有图标 */
  labels: boolean;
  /** 紧凑模式：按钮更小、间距更窄 */
  compact: boolean;
  /** 悬停提示 */
  tooltip: boolean;
  /** 工具栏溢出时横向滚动 */
  scrollable: boolean;
  /** 滚轮纵向滚动转换为工具栏横向滚动 */
  scrollWheel: boolean;
  /**
   * 尾部吸附：把「视图切换 / 大纲 / 全屏 / 复制」这一组钉在工具栏右缘，
   * 窗口变窄、前面的按钮被滚走时它们始终点得到。关掉就整排一起滚。
   */
  pinTail: boolean;
  /** 文字颜色 / 底色菜单里的预设色块（CSS 颜色值），数组顺序即显示顺序 */
  colorSwatches: string[];
  /** 没有选中已上色文本时，文字颜色取色器的起始色（`#rrggbb`） */
  textColorFallback: string;
  /** 没有选中已上色文本时，底色取色器的起始色（`#rrggbb`） */
  backgroundColorFallback: string;
  /** 鼠标悬停即展开下拉菜单（标题 / 提示块 / 警告提示块） */
  openOnHover: boolean;
  /** 悬停展开的延迟（ms），避免扫过工具栏时菜单乱闪 */
  hoverOpenDelay: number;
  /** 移出后关闭菜单的延迟（ms），给指针进入菜单留时间 */
  hoverCloseDelay: number;
  /** 自定义工具，追加在末尾 */
  customItems: MarkdownCustomTool[];
}

/** 状态栏配置 */
export interface MarkdownStatusBarConfig {
  show: boolean;
  words: boolean;
  chars: boolean;
  lines: boolean;
  cursor: boolean;
  readingTime: boolean;
  mode: boolean;
  /** 每秒汉字数（阅读时长估算） */
  readingSpeed: number;
}

/** 大纲面板配置 */
export interface MarkdownOutlineConfig {
  show: boolean;
  position: "left" | "right";
  width: number;
  title: string;
  /** 只显示到第几级标题 */
  maxDepth: number;
  /** 大纲项前缀是否显示层级缩进 */
  indent: boolean;
  /**
   * 点击大纲后光标落在哪里：
   * - `lineStart`：行首（`###` 前面，顶格）—— 要改标题级别时最顺手；
   * - `textStart`：标题文字前（跳过 `### `）—— 要改标题内容时最顺手。
   */
  caretTarget: "lineStart" | "textStart";
  /**
   * 点击大纲后把目标标题高亮一下：编辑区整行（含 `###`）、预览区整个标题块。
   * 高亮在光标移到别处（点别的地方 / 打字）时自动撤掉。
   */
  flashTarget: boolean;
}

/** 查找 / 替换配置（Ctrl+F 悬浮框，交互对齐 VSCode） */
export interface MarkdownSearchConfig {
  /** 是否启用查找框与 Ctrl/⌘+F */
  enabled: boolean;
  /** Ctrl/⌘+F 打开时是否直接展开替换行；替换行始终可以手动展开，Ctrl/⌘+H 总是带着它打开 */
  showReplace: boolean;
  /** 初始：区分大小写 */
  caseSensitive: boolean;
  /** 初始：正则表达式 */
  regex: boolean;
  /**
   * 初始：替换串也按正则展开（替换串里原样写下的查找正则 = 整个命中）。
   * 只在 `regex` 打开时有意义。
   */
  regexReplace: boolean;
  /** 编辑区高亮全部命中（关闭则只高亮当前命中） */
  highlightAll: boolean;
  /**
   * 预览 / 阅读视图里也铺命中高亮。
   *
   * 分栏时左右各铺各的：编辑侧按编辑区偏移铺，预览侧按渲染后的文本节点扫。
   * 两边计数不保证一一对应（编辑区里的 `**` 在预览里不显示），计数与替换始终以编辑区为准。
   */
  highlightPreview: boolean;
  /** 跳转到末尾后再按下一个时回到开头 */
  loop: boolean;
  /** 最多统计 / 高亮多少个命中，避免大文档卡顿 */
  maxMatches: number;
  /** 打开时把当前选区文本填进查找框 */
  seedFromSelection: boolean;
  /**
   * 焦点在编辑器内时，替宿主挡掉查找相关的原生快捷键（Ctrl/⌘+F / G / H）。
   *
   * 浏览器标签页、WebView2、Electron 都会抢这几个键弹自己的查找条 / 替换条，
   * 结果就是"编辑器查找框 + 原生查找条"一起出来。这里在 **window 捕获阶段**
   * 对落在编辑器内部的按键 preventDefault，把原生那层挡掉；
   * 宿主仍然收得到事件（不 stopPropagation），也不需要自己再写一遍拦截。
   */
  blockHostFind: boolean;
}

/** 分栏配置 */
export interface MarkdownSplitConfig {
  /** 0-1，编辑区占比 */
  ratio: number;
  resizable: boolean;
  /** 分隔条宽度（px） */
  dividerWidth: number;
}

/** 主题配置 */
export interface MarkdownThemeConfig {
  mode: MarkdownThemeMode;
  colors: Partial<MarkdownThemeColors>;
  /** 代码配色预设 */
  codeTheme: CodeThemePreset;
  /** 在预设之上覆盖单个 token 颜色 */
  codeColors: Partial<CodeThemeColors>;
  radius: number;
  fontFamily: string;
  monoFontFamily: string;
  /** 额外类名，便于外部用 CSS 覆盖 */
  className?: string;
  /** 任意 CSS 变量，直接写到根节点上 */
  cssVars?: Record<string, string>;
}

/** 内置界面语言；不影响文档内容。 */
export type MarkdownEditorLocale = "zh-CN" | "en-US";

/** 完整配置 */
export interface MarkdownEditorConfig {
  /** 默认 en-US；更新 config 即时切换界面，不重置文稿、选区或历史。 */
  locale: MarkdownEditorLocale;
  /** 覆盖内置文案（键名见 locales.ts），包括空字符串；不随 locale 被覆盖。 */
  labels: Record<string, string>;
  mode: {
    defaultMode: MarkdownEditorMode;
    /** 允许切换到的模式，顺序即工具栏中的顺序 */
    available: MarkdownEditorMode[];
    /** 工具栏是否显示模式切换 */
    showSwitch: boolean;
  };
  editor: MarkdownEditorInputConfig;
  preview: MarkdownPreviewConfig;
  toolbar: MarkdownToolbarConfig;
  statusBar: MarkdownStatusBarConfig;
  outline: MarkdownOutlineConfig;
  split: MarkdownSplitConfig;
  search: MarkdownSearchConfig;
  theme: MarkdownThemeConfig;
  /** 快捷键：false 关闭全部；对象可按动作覆盖，值 false 关闭单个 */
  shortcuts: boolean | Record<string, string | false>;
}

/** 深可选：允许只写要改的字段 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends (...args: never[]) => unknown
    ? T[K]
    : T[K] extends readonly unknown[]
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K];
};

/** 变更来源，便于外部区分是用户输入还是 API 写入 */
export type MarkdownChangeSource =
  | "input"
  | "toolbar"
  | "api"
  | "paste"
  | "undo"
  | "redo"
  | "task"
  | "search"
  | "format";

export interface MarkdownChangeMeta {
  source: MarkdownChangeSource;
  mode: MarkdownEditorMode;
}

/** 文档统计 */
export interface MarkdownStats {
  /** 词数：英文按单词、中日韩按字计 */
  words: number;
  chars: number;
  charsNoSpace: number;
  lines: number;
  paragraphs: number;
  /** 预计阅读时长（分钟，向上取整到 0.1） */
  readingMinutes: number;
  cursor: { line: number; column: number; selection: number };
}

/** 命令式 API */
export interface MarkdownEditorInstance {
  focus(): void;
  blur(): void;
  getValue(): string;
  setValue(value: string, options?: { emitChange?: boolean }): void;
  /** 在当前光标处插入文本；wrap 时把选中内容包起来 */
  insertText(text: string, options?: { wrap?: [string, string]; selectInserted?: boolean }): void;
  getSelection(): { start: number; end: number; text: string };
  setSelection(start: number, end?: number): void;
  getMode(): MarkdownEditorMode;
  setMode(mode: MarkdownEditorMode): void;
  getStats(): MarkdownStats;
  getOutline(): OutlineItem[];
  getDocument(): ParsedDocument;
  /** 执行内置工具命令（等价于点击工具栏按钮） */
  runCommand(name: ToolbarItemName): void;
  undo(): void;
  redo(): void;
  scrollToLine(line: number): void;
  toggleFullscreen(force?: boolean): void;
  toggleOutline(force?: boolean): void;
  /** 打开查找框；传 query 直接填入查找词，withReplace 展开替换行 */
  openSearch(query?: string, withReplace?: boolean): void;
  /** 关闭查找框 */
  closeSearch(): void;
}

/** 组件 Props */
export interface MarkdownEditorProps {
  /** 受控值 */
  value?: string;
  /** 非受控初始值 */
  defaultValue?: string;
  onChange?: (value: string, meta: MarkdownChangeMeta) => void;
  /** 受控模式 */
  mode?: MarkdownEditorMode;
  /** 非受控初始模式，优先于 config.mode.defaultMode */
  defaultMode?: MarkdownEditorMode;
  onModeChange?: (mode: MarkdownEditorMode) => void;
  config?: DeepPartial<MarkdownEditorConfig>;
  /** 只读：保留工具栏但禁用改写类工具 */
  readOnly?: boolean;
  /** 覆盖 config.editor.placeholder */
  placeholder?: string;
  height?: number | string;
  minHeight?: number | string;
  maxHeight?: number | string;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
  /** 挂载完成回传命令式 API */
  onReady?: (api: MarkdownEditorInstance) => void;
  /** Ctrl/⌘+S */
  onSave?: (value: string) => void;
  /** 粘贴/拖入图片：返回可访问的 URL；返回 null 表示不处理 */
  onImagePaste?: (file: File) => Promise<string | null> | string | null;
  /** 点击链接：返回 false 阻止默认行为 */
  onLinkClick?: (href: string, event: React.MouseEvent) => boolean | void;
  /** 勾选任务：返回新的全文（不返回则使用内置改写） */
  onTaskToggle?: (checked: boolean, taskOffset: number, value: string) => string | void;
  /** 大纲变化 */
  onOutlineChange?: (outline: OutlineItem[]) => void;
  /** 统计变化 */
  onStatsChange?: (stats: MarkdownStats) => void;
  /**
   * 用户改了字号（Ctrl/⌘ + 滚轮、Ctrl/⌘ + `=` / `-` / `0`）。
   *
   * 传 `null` 表示「恢复到默认字号」——默认值归宿主管（通常就是设置里的默认字号），
   * 组件自己不存它。不传这个回调时组件退化成内部临时缩放，单独用也能缩。
   */
  onFontSizeChange?: (fontSize: number | null) => void;
  /** 全屏状态变化 */
  onFullscreenChange?: (fullscreen: boolean) => void;
}
