import type {
  AppSettings,
  GeneralSettings,
  EditorSettings,
  LayoutSettings,
  ViewSettings,
} from "@/interface/settings";

/**
 * 软件设置的「默认配置文件」：所有分类的默认值与字号区间。
 *
 * 数据库里查不到的键一律回退到这里；新增或调整设置项只改本文件，无需迁移脚本。
 * 键名与数据库一一对应：app.config.<分类>.<字段>
 *   app.config.general.<字段>  → GeneralSettings
 *   app.config.editor.<字段>   → EditorSettings
 *   app.config.layout.<字段>   → LayoutSettings
 *   app.config.view.<字段>     → ViewSettings
 * 消费方：appSettingsStore 负责读库合并，App 用它初始化 state，SettingsModal 渲染表单项。
 */

/** 编辑器字号可选范围（px）：Ctrl/⌘ + 滚轮缩放与设置面板的滑杆共用这一区间 */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 24;

/**
 * 默认字体栈：不开放给用户配（设置面板没有对应开关），只作为出厂默认值。
 *
 * 消费方是 config/markdownEditor.ts，由它注入自研编辑器的四处字体：编辑输入区、
 * 代码块等宽区、预览正文、工具栏/查找框等界面。App.css 里 `html` 的全局字体与
 * 这里的 APP_UI_FONT_STACK 是同一套，改一处就要同步另一处。
 *
 * 取值基准是自研编辑器组件的 FONT_STACKS（src/markdown-editor/defaults.ts），
 * 只多塞了一个软件内置的 MiSans VF：等宽字体没有中文字形，不补的话编辑区里的中文
 * 会掉到系统默认字体，跟软件界面不是一套。
 */
export const APP_UI_FONT_STACK =
  '"MiSans VF", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
export const APP_MONO_FONT_STACK =
  '"JetBrains Mono", "Cascadia Code", "Fira Code", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, "MiSans VF", monospace';

/* ---------- General ---------- */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  /** 启动时清空回收站（只在软件初始化时执行，永久删除、不可恢复） */
  cleanTrashOnStartup: false,
  /** 是否显示托盘图标 */
  trayEnabled: true,
  /** 关闭窗口按钮行为：minimize 到托盘 | exit 直接退出 */
  closeBehavior: "minimize",
  /** 是否开机自启动 */
  autostart: false,
  /** 开机自启动时是否最小化到托盘 */
  minimizeToTray: false,
  /** 是否开启 AI 能力（关闭后隐藏所有 AI 相关入口和设置，开启后可为软件开启 AI 能力） */
  enableAI: false,
  /** 是否启用单例模式：默认开启，关掉后允许多开（多进程同时写库有风险，故标为不建议修改） */
  singleInstance: true, 
};

/* ---------- Editor ---------- */
/**
 * 编辑器默认值：自研编辑器全部可配项的出厂值。
 *
 * 字段与 config/editorSettingSpecs.ts 一一对应（那里还声明了区间与控件类型），
 * 取值必须与那里的 min/max、options 自洽，否则读库时会被夹到边界上。
 * 首次启动会把这里每一项写进数据库（app.config.editor.<字段>），缺键时同样回退到这里。
 */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  /* 视图 */
  /** 打开笔记时的默认视图：编辑（只写 Markdown） */
  defaultMode: "code",
  /** 工具栏显示「分栏 / 编辑 / 阅读」切换 */
  showModeSwitch: true,
  /** 分栏时编辑区占比 */
  splitRatio: 0.5,
  /** 分栏分隔条可拖动 */
  splitResizable: true,
  /** 分栏两栏同步滚动 */
  syncScroll: true,
  /** 同步滚动按编辑行锚点对齐 */
  syncScrollMode: "anchor",

  /* 编辑 */
  /** 编辑器默认正文字号（px）：Ctrl/⌘ + `0` 与工具栏字号按钮都恢复到这个值 */
  fontSize: 14,
  /** Ctrl/⌘ + 滚轮、Ctrl/⌘ + `=` / `-` 是否调整编辑器字号 */
  ctrlScrollZoom: true,
  /** 每次加减字号的步长（px） */
  zoomStep: 1,
  /** 编辑行高（1.9 是"看着不挤"的默认；老版本是 1.75，见 appSettingsStore 的旧默认值升级） */
  sourceLineHeight: 1.9,
  /** 编辑字间距（px）：中英混排贴太紧时加一点空气，0 为不加 */
  letterSpacing: 1,
  /**
   * 字体连字：等宽字体会把 `->`、`==`、`<=` 画成一个符号，
   * 而 Markdown 编辑区里这些是语法记号（`~~删除线~~`、`==高亮==`），默认关更不容易看错。
   */
  fontLigatures: false,
  /** 编辑区行号 */
  lineNumbers: true,
  /** 点击行号选中整行 */
  gutterClickSelectsLine: true,
  /** 编辑自动换行 */
  wrap: true,
  /** Tab 宽度（同时用作列表缩进） */
  tabSize: 2,
  /** Tab 键缩进整行 */
  tabKey: "indent",
  /** 回车自动续写列表 / 引用 / 任务项 */
  continueMarkdownOnEnter: true,
  /** 自动配对括号 */
  autoPairBrackets: true,
  /** 自动配对引号（中文输入法下容易多出半边引号，默认关） */
  autoPairQuotes: false,
  /** 自动配对反引号 */
  autoPairBackticks: true,
  /** 浏览器拼写检查 */
  spellCheck: false,
  /** 撤销栈上限 */
  historyLimit: 200,
  /** 光标所在行整行高亮 */
  highlightActiveLine: true,
  /** 自绘光标宽度（px） */
  caretWidth: 2,
  /** 自绘光标高度（字号倍数）：比字略高一点，但不占满行盒 */
  caretHeight: 1.25,
  /** 编辑区代码块增强：识别语言、整块浅底、token 着色 */
  codeHighlight: true,
  /** 滚到底部时的额外留白（px） */
  scrollPaddingBottom: 120,

  /* 预览 */
  /** 输入到渲染的防抖（ms） */
  previewDebounce: 120,
  /** 代码高亮 */
  highlight: true,
  /** 代码块行号 */
  codeLineNumbers: true,
  /** 代码块语言标签 */
  showCodeLanguage: true,
  /** 代码块可折叠 */
  codeCollapsible: true,
  /** 长代码块初次渲染时不自动收起 */
  codeCollapseDefault: false,
  /** 超过 14 行才出现折叠控件 */
  codeCollapseThreshold: 14,
  /** 折叠后高度 */
  codeCollapseHeight: 260,
  /** 围栏行高亮（```py {1-3}） */
  codeHighlightLines: true,
  /** 代码块复制按钮 */
  codeCopyButton: true,
  /** 代码块换行按钮 */
  codeWrapButton: false,
  /** `???` 折叠提示块可折叠 */
  calloutCollapsible: true,
  /** KaTeX 公式 */
  math: true,
  /** Mermaid 流程图 */
  mermaid: true,
  /** Mermaid 主题 */
  mermaidTheme: "default",
  /** 预览里任务项可勾选 */
  taskInteractive: true,
  /** 单个换行即换行（GFM breaks） */
  breaks: false,
  /** 允许 HTML 标签 */
  allowHtml: true,
  /** 渲染前净化 HTML */
  sanitizeHtml: true,
  /** 显示 front matter 属性卡 */
  showFrontmatter: true,
  /** 显示脚注区 */
  showFootnotes: true,
  /** 表格斑马纹 */
  tableStriped: true,
  /** 表格边框 */
  tableBordered: false,
  /** 表格紧凑 */
  tableCompact: false,
  /** 表格撑满宽度 */
  tableFullWidth: true,
  /** 点击图片放大预览 */
  imagePreview: true,
  /** 放大预览每格滚轮倍率 */
  imageZoomStep: 1.2,
  /** 放大预览最小倍率 */
  imageZoomMin: 0.2,
  /** 放大预览最大倍率 */
  imageZoomMax: 8,

  /* 排版 */
  /** 预览行高 */
  previewLineHeight: 1.8,
  /** 段落间距（em） */
  paragraphSpacing: 0.9,
  /** 标题上方间距（em） */
  headingTopSpacing: 1.4,
  /** 标题下方间距（em） */
  headingBottomSpacing: 0.6,
  /** 正文最大宽度（px） */
  previewMaxWidth: 820,
  /** 正文左对齐 */
  textAlign: "left",
  /** 标题字重 */
  headingWeight: 650,

  /* 工具栏 */
  /** 顶部工具栏 */
  showToolbar: true,
  /** 工具栏不吸顶（编辑器自己就是内部滚动容器） */
  toolbarSticky: false,
  /** 工具栏紧凑（笔记区宽度有限） */
  toolbarCompact: true,
  /** 按钮只显示图标 */
  toolbarLabels: false,
  /** 悬停提示 */
  toolbarTooltip: true,
  /** 悬停展开下拉菜单 */
  toolbarOpenOnHover: true,
  /** 悬停展开延迟（ms） */
  toolbarHoverOpenDelay: 140,
  /** 移出关闭延迟（ms） */
  toolbarHoverCloseDelay: 220,
  /** 滚轮横向滚动工具栏 */
  toolbarScrollWheel: true,
  /** 尾部按钮常驻右缘（视图切换 / 大纲 / 全屏 / 复制） */
  toolbarPinTail: true,

  /* 状态栏 */
  /** 状态栏默认关闭，把空间留给正文 */
  showStatusBar: false,
  /** 字数 */
  statusWords: true,
  /** 字符数 */
  statusChars: false,
  /** 行数 */
  statusLines: true,
  /** 光标位置 */
  statusCursor: false,
  /** 阅读时长 */
  statusReadingTime: false,
  /** 当前视图 */
  statusMode: true,
  /** 阅读速度（字/分钟） */
  statusReadingSpeed: 400,

  /* 大纲 */
  /** 默认不展开大纲 */
  showOutline: false,
  /** 大纲停靠右侧 */
  outlinePosition: "right",
  /** 大纲宽度 */
  outlineWidth: 220,
  /** 大纲列到三级标题 */
  outlineMaxDepth: 3,
  /** 大纲层级缩进 */
  outlineIndent: true,
  /** 点大纲后光标落在行首（`###` 前面，顶格） */
  outlineCaretTarget: "lineStart",
  /** 点大纲后把目标标题高亮一下 */
  outlineFlashTarget: true,

  /* 查找替换 */
  /** 启用查找框 */
  searchEnabled: true,
  /** Ctrl/⌘+F 只打开查找行（Ctrl/⌘+H 才带替换行一起出来） */
  searchShowReplace: false,
  /** 默认不区分大小写 */
  searchCaseSensitive: false,
  /** 默认不用正则 */
  searchRegex: false,
  /** 默认：替换串不按正则展开（需要时在查找框里临时打开） */
  searchRegexReplace: false,
  /** 高亮全部命中 */
  searchHighlightAll: true,
  /** 预览区命中高亮：只在阅读视图铺（分栏视图只铺编辑侧） */
  searchHighlightPreview: true,
  /** 查找循环 */
  searchLoop: true,
  /** 选中文字带入查找框 */
  searchSeedFromSelection: true,
  /** 最大命中数（老默认 2000 在几万字的笔记里查常用字就会截断，见 appSettingsStore 的默认值升级） */
  searchMaxMatches: 20000,
  /** 挡掉浏览器原生查找条：否则 Ctrl+F 会同时弹出编辑器的查找框和 WebView 的查找条 */
  searchBlockHostFind: true,

  /* 主题与其他 */
  /** 代码块配色预设 */
  codeTheme: "github",
  /** 启用快捷键 */
  shortcuts: true,
  /** 编辑器外框圆角（px）：与 config/markdownEditor.ts 的 NOTE_EDITOR_RADIUS 保持一致 */
  radius: 4,
};

/* ---------- Layout ---------- */
export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  /** 启动时分组侧边栏是否折叠（仅决定启动时的布局，不跟随运行时的折叠状态） */
  sidebarCollapsed: false,
  /** 启动时 AI 面板是否打开（仅决定启动时的布局，不跟随运行时的开关状态） */
  aiPanelOpen: false,
};

/* ---------- View ---------- */
export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  /** 排序字段：updated_at（更新时间）| created_at（创建时间）| title（标题），直接作为后端排序参数 */
  sortBy: "created_at",
  /** 排序方向 */
  sortOrder: "asc",
};

/* ---------- 合并后的完整默认值 ---------- */
/** 四个分类的完整默认值：App 初始化 state 与各 store 缺键回退都以它为准 */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: DEFAULT_GENERAL_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  layout: DEFAULT_LAYOUT_SETTINGS,
  view: DEFAULT_VIEW_SETTINGS,
};
