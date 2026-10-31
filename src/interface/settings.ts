/**
 * 非 AI 的软件设置模型：通用 / 编辑器 / 布局 / 视图。
 *
 * 持久化在 app_settings 的键值表，键名 app.config.<分类>.<字段>（值为 JSON）；
 * 打开软件时优先读库，缺键或类型不符回退到 config/appDefaults.ts 的默认值，
 * 并把缺的那些键补写回库（首次启动即等于「把默认设置写进数据库」）。
 * 这些类型只描述配置内容，运行时状态另有各 store / useState 持有。
 */
import type { CodeThemePreset, MarkdownEditorMode } from "@/markdown-editor";
import type { AppLanguage } from "@/i18n/locale";

/** 通用设置：启动行为、托盘、关闭方式与 AI 总开关 */
export interface GeneralSettings {
  language: AppLanguage;
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
  /**
   * 是否启用单例模式（只允许一个软件进程）。
   * 只在启动时读取：关掉后可以同时开多个进程，多个进程会同时写同一个库文件。
   */
  singleInstance: boolean;
  /**
   * 侧边栏「搜索笔记」是否按正则匹配。
   * 开启后 `*`、`(` 这类字符会被当成正则元字符；写不出合法正则时本次搜索不报错、直接零结果。
   */
  noteSearchRegex: boolean;
  /**
   * 是否启用语义搜索（本地向量检索）。
   * 成本：首次需下载本地模型（推荐版约 24 MB），并在后台为全部笔记建立索引；
   * 之后按同义/换述描述也能命中，且全程离线。
   */
  semanticSearch: boolean;
  /**
   * 是否自动建立/更新语义索引：模型下载完成即建索引，之后笔记改动自动增量更新。
   * 关闭后只能手动点「重建索引」；默认开启。
   */
  semanticAutoIndex: boolean;
  /**
   * 语义搜索使用的本地模型 id。
   * 可选清单由后端提供；开启自动索引时，切换后后台会按新模型重建向量索引。
   */
  semanticModel: string;
  /**
   * 下载线程数：语义模型下载与工具箱下载共用，1–128，默认 32。
   * 改完在下一次下载任务生效。
   */
  downloadThreads: number;
  /**
   * 每篇笔记保留的**最近**历史版本数（1–100，默认 10）。
   * 超出后删中间的旧版本，但最早的一条始终保留（总计最多 N+1 条）。
   */
  noteHistoryLimit: number;
  /**
   * 自动历史版本的最小间隔（分钟，1–60，默认 5）。
   * 自动保存仍按 500ms 防抖落库，但距上一条历史不满这个间隔时不再记新版本，
   * 避免打字停顿把保留窗口刷满、挤掉最初的版本。
   */
  noteHistoryIntervalMinutes: number;
  /**
   * 运行期间自动检查更新的间隔（分钟，0 = 关闭，默认 10）。
   * 只影响软件运行中的定时检查；启动时的静默检查不受它控制。
   */
  updateCheckIntervalMinutes: number;
  /**
   * 空闲自动锁定（分钟，0 = 关闭，默认 10）。
   * 键盘、鼠标、滚轮都算活动；超过这个时间没有任何操作，就丢掉内存里的解密密钥，
   * 已解锁的加密笔记/分组立即回到锁定态。
   */
  autoLockMinutes: number;
}

/** 笔记编辑器可选的默认视图（render 是给 AI 回复用的纯渲染模式，不作为笔记的默认视图） */
export type NoteEditorMode = Exclude<MarkdownEditorMode, "render">;

/** Tab 键行为：indent 缩进整行 | spaces 插入空格 | none 交给浏览器 */
export type EditorTabKey = "indent" | "spaces" | "none";

/** 分栏同步滚动策略：anchor 按编辑行锚点插值 | ratio 按滚动比例 */
export type EditorSyncScrollMode = "anchor" | "ratio";

/** Mermaid 图表主题 */
export type EditorMermaidTheme = "default" | "dark" | "forest" | "neutral" | "base";

/** 代码块配色预设（与 MarkdownThemeConfig.codeTheme 同源） */
export type EditorCodeTheme = CodeThemePreset;

/** 预览正文对齐方式 */
export type EditorTextAlign = "left" | "justify" | "start";

/** 点击大纲后光标的落点：行首（`###` 前面）| 标题文字前（跳过 `### `） */
export type EditorOutlineCaret = "lineStart" | "textStart";

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
  /** 打开笔记时的默认视图：分栏 / 编辑 / 阅读 */
  defaultMode: NoteEditorMode;
  /** 工具栏是否显示视图切换（分栏 / 编辑 / 阅读） */
  showModeSwitch: boolean;
  /** 分栏视图下编辑区占比（0-1） */
  splitRatio: number;
  /** 分栏分隔条可拖动 */
  splitResizable: boolean;
  /** 分栏视图下两栏是否同步滚动 */
  syncScroll: boolean;
  /** 同步滚动的对齐策略 */
  syncScrollMode: EditorSyncScrollMode;

  /* ---------- 编辑 ---------- */
  /** 编辑器默认正文字号（px）：Ctrl/⌘ + `0` 与工具栏字号按钮恢复到该值 */
  fontSize: number;
  /** 字号缩放（Ctrl/⌘ + 滚轮、Ctrl/⌘ + `=` / `-` / `0`）是否启用 */
  ctrlScrollZoom: boolean;
  /** 每次加减字号的步长（px） */
  zoomStep: number;
  /** 编辑行高（倍数） */
  sourceLineHeight: number;
  /**
   * 编辑字间距（px）。
   * 中英混排时字与字贴得太紧会显得糊成一团，加一点间距整块正文会松快不少；
   * 0 表示不加，按字号缩放时会跟着排版一起重算。
   */
  letterSpacing: number;
  /**
   * 字体连字：开启后等宽字体会把 `->`、`==`、`<=` 画成单个符号。
   * 写 Markdown 时这些是语法记号，连成一坨会误读，默认关。
   */
  fontLigatures: boolean;
  /** 编辑区是否显示行号（编辑模式与分栏左栏） */
  lineNumbers: boolean;
  /** 点击行号是否选中整行 */
  gutterClickSelectsLine: boolean;
  /** 编辑自动换行（关闭后横向滚动） */
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
  /** 光标所在行整行高亮（行号槽里同一格也跟着点亮） */
  highlightActiveLine: boolean;
  /** 自绘光标的宽度（px）：原生那根恒为 1px，高缩放下细得几乎看不见 */
  caretWidth: number;
  /** 自绘光标的高度（字号倍数）：1 = 与字同高，略大于 1 时上下各出头一点 */
  caretHeight: number;
  /**
   * 编辑区代码块增强：识别围栏语言，给整块铺一层浅底并给 token 着色。
   *
   * 底色不是单独存的——它由主题强调色派生（见 config/markdownEditor.ts 的 sourceCodeBg），
   * 这里只控制开与关。关闭后编辑区退化成纯文本的样子。
   */
  codeHighlight: boolean;
  /** 滚到底部时额外留出的空白（px），方便继续往下写 */
  scrollPaddingBottom: number;

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
  /** 单个换行即换行（GFM breaks）：每行的 \n 都渲染成换行，不用行尾补两个空格；开启后 Setext 标题停用 */
  breaks: boolean;
  /** Setext 标题：文字下一行写 === / --- 变成一级 / 二级标题；仅在关闭「单换行即换行」时生效 */
  setext: boolean;
  /** 允许 HTML 标签（关闭后原样显示为文本） */
  allowHtml: boolean;
  /** 对 HTML 做基础净化（去 script / on* / javascript:） */
  sanitizeHtml: boolean;
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
  /** 点击图片放大预览（窗口级浮层，滚轮缩放、拖动平移） */
  imagePreview: boolean;
  /** 放大预览每格滚轮的倍率（>1，缩小取倒数） */
  imageZoomStep: number;
  /** 放大预览的最小倍率 */
  imageZoomMin: number;
  /** 放大预览的最大倍率 */
  imageZoomMax: number;

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
  /** 尾部按钮（视图切换 / 大纲 / 全屏 / 复制）窄窗时钉在右缘 */
  toolbarPinTail: boolean;
  /** 文字颜色 / 底色菜单里的预设色块：逗号分隔的十六进制颜色 */
  toolbarColorSwatches: string;
  /** 文字颜色取色器的起始色（没有选中已上色文本时） */
  toolbarTextColorFallback: string;
  /** 底色取色器的起始色（没有选中已上色文本时） */
  toolbarBackgroundColorFallback: string;

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
  /** 点击大纲后光标落在标题行的哪里 */
  outlineCaretTarget: EditorOutlineCaret;
  /** 点击大纲后把目标标题高亮一下（光标移到别处自动撤掉） */
  outlineFlashTarget: boolean;

  /* ---------- 查找 / 替换 ---------- */
  /** 启用查找框与 Ctrl/⌘+F */
  searchEnabled: boolean;
  /** 打开查找框时是否展开替换行 */
  searchShowReplace: boolean;
  /** 初始：区分大小写 */
  searchCaseSensitive: boolean;
  /** 初始：正则表达式 */
  searchRegex: boolean;
  /** 初始：替换串也按正则展开（替换串里原样写下的查找正则 = 整个命中） */
  searchRegexReplace: boolean;
  /** 编辑区高亮全部命中 */
  searchHighlightAll: boolean;
  /** 预览 / 阅读视图同样铺命中高亮（分栏时左右各铺各的） */
  searchHighlightPreview: boolean;
  /** 跳到末尾后再按下一个时回到开头 */
  searchLoop: boolean;
  /** 打开时把当前选区文本填进查找框 */
  searchSeedFromSelection: boolean;
  /** 最多统计 / 高亮多少个命中 */
  searchMaxMatches: number;
  /** 焦点在编辑器内时挡掉浏览器的原生查找条 / 快捷键（F3、Ctrl+F 等） */
  searchBlockHostFind: boolean;

  /* ---------- 主题与其他 ---------- */
  /** 代码块配色预设 */
  codeTheme: EditorCodeTheme;
  /** 启用编辑器快捷键 */
  shortcuts: boolean;
  /**
   * 编辑器外框圆角（px）。0 = 直角。
   * 笔记区默认 4px（见 config/markdownEditor.ts 的 NOTE_EDITOR_RADIUS，不跟随主题圆角）；
   * 这里放开是为了让需要直角/大圆角的用户自己调，改它就等于覆盖默认值。
   */
  radius: number;
}

/**
 * 枚举型设置项的一个选项，供分段按钮 / 下拉共用。
 *
 * swatch 是「按外观挑」的场景用的色卡：[底色, ...token 色]——第一项作底，其余画成小色点。
 * 底色允许写渐变，token 色允许写 rgb(var(--c-*))，这样就有一个能跟着主题变色的选项
 * （代码块配色的「主题」项就是这么表示的）。
 */
export interface EnumOption {
  value: string;
  label: string;
  swatch?: string[];
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

/** 自动备份目标：仅本地 / 仅云端 / 云端 + 本地 */
export type AutoBackupTarget = "local" | "cloud" | "both";

/**
 * WebDAV 云同步设置。
 *
 * 密码不在这里：后端用主密钥加密后单独存 `webdav.password`，
 * 避免明文密码落进 app.config.* 或随普通备份导出。
 */
export interface WebdavSettings {
  /** WebDAV 根地址，例如 https://dav.example.com/remote.php/dav/files/user/ */
  server: string;
  /** 账号（Basic Auth 用户名） */
  username: string;
  /** 在 WebDAV 上创建/使用的文件夹名，默认 FastNote */
  folder: string;
  /** 是否开启自动备份 */
  autoBackup: boolean;
  /** 自动备份间隔（小时，默认 1） */
  autoIntervalHours: number;
  /** 自动备份目标 */
  autoTarget: AutoBackupTarget;
  /** 本地自动备份最多保留份数（云端不限） */
  autoMaxLocal: number;
}

/** 软件设置总集合；分类名即 app.config.<分类> 中的一段 */
export interface AppSettings {
  general: GeneralSettings;
  editor: EditorSettings;
  layout: LayoutSettings;
  view: ViewSettings;
  webdav: WebdavSettings;
}
