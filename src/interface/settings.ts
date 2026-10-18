/**
 * 非 AI 的软件设置模型：通用 / 编辑器 / 布局 / 视图。
 *
 * 持久化在 app_settings 的键值表，键名 app.config.<分类>.<字段>（值为 JSON）；
 * 打开软件时优先读库，缺键或类型不符回退到 config/appDefaults.ts 的默认值，
 * 并把缺的那些键补写回库（首次启动即等于「把默认设置写进数据库」）。
 * 这些类型只描述配置内容，运行时状态另有各 store / useState 持有。
 */
import type { CodeThemePreset, MarkdownEditorMode } from "@/markdown-editor";

/** 通用设置：启动行为、托盘、关闭方式与 AI 总开关 */
export interface GeneralSettings {
  /** 启动时清空回收站（永久删除，仅初始化时执行一次） */
  cleanTrashOnStartup: boolean;
  /** 是否显示托盘图标 */
  trayEnabled: boolean;
  /** 关闭窗口按钮行为：minimize = 收进托盘 | exit = 直接退出 */
  closeBehavior: "minimize" | "exit";
  /** 是否开机自启动（快捷方式带 --autostart） */
  autostart: boolean;
  /** 开机自启动时是否最小化到托盘（启动时读库决定，不额外传参） */
  minimizeToTray: boolean;
  /** 是否开启 AI 能力（关闭后隐藏所有 AI 相关入口和设置） */
  enableAI: boolean;
}

/** 笔记编辑器可选的默认视图（render 是给 AI 回复用的纯渲染模式，不作为笔记的默认视图） */
export type NoteEditorMode = Exclude<MarkdownEditorMode, "render">;

/** Tab 键行为：indent 缩进整行 | spaces 插入空格 | none 交给浏览器 */
export type EditorTabKey = "indent" | "spaces" | "none";

/** 分栏同步滚动策略：anchor 按源码行锚点插值 | ratio 按滚动比例 */
export type EditorSyncScrollMode = "anchor" | "ratio";

/** 预览里链接的打开方式（外链最终都交给应用侧用系统浏览器打开） */
export type EditorLinkTarget = "_blank" | "_self";

/** Mermaid 图表主题 */
export type EditorMermaidTheme = "default" | "dark" | "forest" | "neutral" | "base";

/** 代码块配色预设（与 MarkdownThemeConfig.codeTheme 同源） */
export type EditorCodeTheme = CodeThemePreset;

/** 预览正文对齐方式 */
export type EditorTextAlign = "left" | "justify" | "start";

/**
 * 编辑器设置：自研编辑器（src/markdown-editor）全部可配项的扁平镜像。
 *
 * 命名与 MarkdownEditorConfig 的分区不是一一对应，而是压平成一层：
 * 每一项对应库里一个键 app.config.editor.<字段>，读写都不需要嵌套路径。
 * 分组、控件类型、取值范围与联动禁用统一声明在 config/editorSettingSpecs.ts，
 * 设置弹窗按那张表渲染、持久化层按那张表校验，新增一项只改那一个文件 + 这里的类型。
 */
export interface EditorSettings {
  /* ---------- 视图 ---------- */
  /** 打开笔记时的默认视图：分栏 / 源码 / 阅读 */
  defaultMode: NoteEditorMode;
  /** 工具栏是否显示视图切换（分栏 / 源码 / 阅读） */
  showModeSwitch: boolean;
  /** 分栏视图下源码区占比（0-1） */
  splitRatio: number;
  /** 分栏分隔条可拖动 */
  splitResizable: boolean;
  /** 分栏视图下两栏是否同步滚动 */
  syncScroll: boolean;
  /** 同步滚动的对齐策略 */
  syncScrollMode: EditorSyncScrollMode;

  /* ---------- 源码编辑 ---------- */
  /** 编辑器默认正文字号（px）：滚轮可临时缩放，工具栏按钮恢复到该值 */
  fontSize: number;
  /** 是否允许 Ctrl/Cmd + 滚轮缩放字号 */
  ctrlScrollZoom: boolean;
  /** 源码行高（倍数） */
  sourceLineHeight: number;
  /** 源码区是否显示行号（纯源码模式与分栏左栏） */
  lineNumbers: boolean;
  /** 点击行号是否选中整行 */
  gutterClickSelectsLine: boolean;
  /** 源码自动换行（关闭后横向滚动） */
  wrap: boolean;
  /** Tab 宽度，同时用作列表缩进 */
  tabSize: number;
  /** Tab 键行为 */
  tabKey: EditorTabKey;
  /** 回车自动续写列表 / 引用 / 任务项 */
  continueMarkdownOnEnter: boolean;
  /** 自动配对括号 */
  autoPairBrackets: boolean;
  /** 自动配对引号 */
  autoPairQuotes: boolean;
  /** 自动配对反引号 */
  autoPairBackticks: boolean;
  /** 是否开启浏览器拼写检查（中文场景一般关着） */
  spellCheck: boolean;
  /** 撤销栈上限（步） */
  historyLimit: number;

  /* ---------- 预览渲染 ---------- */
  /** 输入到渲染的防抖（ms），0 = 同步 */
  previewDebounce: number;
  /** 代码高亮 */
  highlight: boolean;
  /** 代码块是否显示行号 */
  codeLineNumbers: boolean;
  /** 代码块右上角是否显示语言标签 */
  showCodeLanguage: boolean;
  /** 代码块可折叠 */
  codeCollapsible: boolean;
  /** 超过折叠阈值时默认收起 */
  codeCollapseDefault: boolean;
  /** 超过多少行才出现折叠控件 */
  codeCollapseThreshold: number;
  /** 折叠后的最大高度（px） */
  codeCollapseHeight: number;
  /** 渲染围栏里的行高亮（```py {1-3}） */
  codeHighlightLines: boolean;
  /** 代码块右上角「复制」按钮 */
  codeCopyButton: boolean;
  /** 代码块右上角「自动换行」按钮 */
  codeWrapButton: boolean;
  /** `???` 折叠提示块是否真的可折叠 */
  calloutCollapsible: boolean;
  /** 渲染 KaTeX 公式 */
  math: boolean;
  /** 渲染 Mermaid 图表 */
  mermaid: boolean;
  /** Mermaid 图表主题 */
  mermaidTheme: EditorMermaidTheme;
  /** 任务列表勾选框可点击 */
  taskInteractive: boolean;
  /** 允许 HTML 标签（关闭后原样显示为文本） */
  allowHtml: boolean;
  /** 对 HTML 做基础净化（去 script / on* / javascript:） */
  sanitizeHtml: boolean;
  /** 链接打开方式 */
  linkTarget: EditorLinkTarget;
  /** 显示 front matter 元信息卡 */
  showFrontmatter: boolean;
  /** 显示脚注区 */
  showFootnotes: boolean;
  /** 表格斑马纹 */
  tableStriped: boolean;
  /** 表格边框 */
  tableBordered: boolean;
  /** 表格紧凑（缩小单元格内边距） */
  tableCompact: boolean;
  /** 表格撑满内容宽度 */
  tableFullWidth: boolean;

  /* ---------- 预览排版 ---------- */
  /** 预览行高（倍数） */
  previewLineHeight: number;
  /** 段落间距（em） */
  paragraphSpacing: number;
  /** 标题与上文间距（em） */
  headingTopSpacing: number;
  /** 标题与下文间距（em） */
  headingBottomSpacing: number;
  /** 内容最大宽度（px） */
  previewMaxWidth: number;
  /** 正文对齐 */
  textAlign: EditorTextAlign;
  /** 标题字重 */
  headingWeight: number;

  /* ---------- 工具栏 ---------- */
  /** 是否显示顶部工具栏 */
  showToolbar: boolean;
  /** 工具栏吸顶 */
  toolbarSticky: boolean;
  /** 紧凑模式：按钮更小、间距更窄 */
  toolbarCompact: boolean;
  /** 按钮显示文字而非只有图标 */
  toolbarLabels: boolean;
  /** 悬停提示 */
  toolbarTooltip: boolean;
  /** 鼠标悬停即展开下拉菜单（标题 / 提示块 / 警告提示块） */
  toolbarOpenOnHover: boolean;
  /** 悬停展开的延迟（ms） */
  toolbarHoverOpenDelay: number;
  /** 移出后关闭菜单的延迟（ms） */
  toolbarHoverCloseDelay: number;
  /** 滚轮纵向滚动转换为工具栏横向滚动 */
  toolbarScrollWheel: boolean;

  /* ---------- 状态栏 ---------- */
  /** 是否显示底部状态栏 */
  showStatusBar: boolean;
  /** 状态栏：字数 */
  statusWords: boolean;
  /** 状态栏：字符数 */
  statusChars: boolean;
  /** 状态栏：行数 */
  statusLines: boolean;
  /** 状态栏：光标位置 */
  statusCursor: boolean;
  /** 状态栏：预计阅读时长 */
  statusReadingTime: boolean;
  /** 状态栏：当前视图 */
  statusMode: boolean;
  /** 阅读时长估算：每秒汉字数 */
  statusReadingSpeed: number;

  /* ---------- 大纲 ---------- */
  /** 打开笔记时是否默认展开大纲面板 */
  showOutline: boolean;
  /** 大纲停靠在编辑区哪一侧 */
  outlinePosition: "left" | "right";
  /** 大纲面板宽度（px） */
  outlineWidth: number;
  /** 大纲只显示到第几级标题 */
  outlineMaxDepth: number;
  /** 大纲项按层级缩进 */
  outlineIndent: boolean;

  /* ---------- 查找 / 替换 ---------- */
  /** 启用查找框与 Ctrl/⌘+F */
  searchEnabled: boolean;
  /** 打开查找框时是否展开替换行 */
  searchShowReplace: boolean;
  /** 初始：区分大小写 */
  searchCaseSensitive: boolean;
  /** 初始：正则表达式 */
  searchRegex: boolean;
  /** 源码区高亮全部命中 */
  searchHighlightAll: boolean;
  /** 跳到末尾后再按下一个时回到开头 */
  searchLoop: boolean;
  /** 打开时把当前选区文本填进查找框 */
  searchSeedFromSelection: boolean;
  /** 最多统计 / 高亮多少个命中 */
  searchMaxMatches: number;

  /* ---------- 主题与其他 ---------- */
  /** 代码块配色预设 */
  codeTheme: EditorCodeTheme;
  /** 启用编辑器快捷键 */
  shortcuts: boolean;
}

/** 界面布局：只决定启动时的初始布局，不跟随运行时的折叠/开关状态 */
export interface LayoutSettings {
  /** 启动时分组侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 启动时 AI 对话面板是否展开 */
  aiPanelOpen: boolean;
}

/** 笔记列表视图：排序字段与方向（透传给 get_notes） */
export interface ViewSettings {
  /** 排序字段：updated_at / created_at / title（未收窄成联合类型，容错交由调用方） */
  sortBy: string;
  /** 排序方向 */
  sortOrder: "asc" | "desc";
}

/** 软件设置总集合；分类名即 app.config.<分类> 中的一段 */
export interface AppSettings {
  general: GeneralSettings;
  editor: EditorSettings;
  layout: LayoutSettings;
  view: ViewSettings;
}
