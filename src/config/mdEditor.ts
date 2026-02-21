export const mdEditorConfig = {
  // ==================== 视图配置 ====================
  
  view: {
    menu: true, // 是否显示顶部工具栏菜单
    md: true, // 是否显示 Markdown 编辑区
    html: true, // 是否显示 HTML 预览区
    // fullScreen: false, // 是否全屏模式
  },

  // ==================== 可显示的视图 ====================
  
  canView: {
    menu: true, // 是否允许显示/隐藏菜单
    md: true, // 是否允许显示/隐藏编辑区
    html: true, // 是否允许显示/隐藏预览区
    fullScreen: true, // 是否允许全屏模式
    hideMenu: true, // 是否允许隐藏菜单
    // both: true, // 是否允许双栏模式
  },

  // ==================== 同步滚动 ====================
  
  syncScrollMode: [
    'rightFollowLeft', // 预览区跟随编辑区滚动
    'leftFollowRight', // 编辑区跟随预览区滚动
  ],
  // syncScrollDelay: 0, // 同步滚动延迟（毫秒）

  // ==================== 样式类名 ====================
  
  htmlClass: '', // HTML 预览区的自定义类名
  markdownClass: '', // Markdown 编辑区的自定义类名
  // config: {
  //   view: {
  //     htmlClass: '',
  //     markdownClass: '',
  //   },
  // },

  // ==================== 图片上传 ====================
  
  imageUrl: '', // 图片上传的接口地址（字符串或返回 Promise 的函数）
  imageAccept: '', // 允许上传的图片类型，例如 'image/jpeg,image/jpg,image/png,image/svg+xml,image/gif'
  // imageCallback: undefined, // 图片上传回调函数
  // imageUploadCallback: undefined, // 图片上传回调函数，返回 Promise<string>

  // ==================== 链接插入 ====================
  
  linkUrl: '', // 链接插入的默认地址前缀
  // linkCallback: undefined, // 链接插入回调函数

  // ==================== 快捷键 ====================
  
  shortcuts: true, // 是否启用快捷键
  // shortcuts: {
  //   insertUnorderedList: 'Ctrl+Shift+L',
  //   insertOrderedList: 'Ctrl+Shift+O',
  //   insertCodeblock: 'Ctrl+Shift+C',
  //   insertQuote: 'Ctrl+Shift+Q',
  //   insertLink: 'Ctrl+Shift+L',
  //   insertImage: 'Ctrl+Shift+I',
  //   toggleFullScreen: 'F11',
  //   toggleMenu: 'Ctrl+Shift+M',
  //   toggleView: 'Ctrl+Shift+V',
  // },

  // ==================== 编辑器模式 ====================
  
  mode: 'live', // 编辑器模式：'live' 实时预览，'edit' 仅编辑，'preview' 仅预览

  // ==================== 占位符文本 ====================
  
  placeholder: '开始输入 Markdown 内容...', // 编辑区的占位符文本

  // ==================== 语言设置 ====================
  
  // language: 'zh-CN', // 界面语言：'zh-CN' 中文，'en-US' 英文，'ja-JP' 日文，'ko-KR' 韩文，'es-ES' 西班牙文等

  // ==================== 表格默认列数 ====================
  
  table: {
    maxRow: 6, // 插入表格时的最大行数
    maxCol: 6, // 插入表格时的最大列数
    // row: 3, // 默认行数
    // col: 3, // 默认列数
  },

  // ==================== 标题默认级别 ====================
  
  // headings: 'h1', // 标题默认级别：'h1', 'h2', 'h3', 'h4', 'h5', 'h6'

  // ==================== 工具栏配置 ====================
  
  // toolbar: [
  //   'bold', // 粗体
  //   'italic', // 斜体
  //   'heading', // 标题
  //   '|', // 分隔符
  //   'quote', // 引用
  //   'unordered-list', // 无序列表
  //   'ordered-list', // 有序列表
  //   '|',
  //   'link', // 链接
  //   'image', // 图片
  //   'code', // 行内代码
  //   'code-block', // 代码块
  //   '|',
  //   'table', // 表格
  //   '|',
  //   'split', // 分屏
  //   'fullscreen', // 全屏
  //   '|',
  //   'preview', // 预览
  //   'edit', // 编辑
  //   '|',
  //   'help', // 帮助
  //   'info', // 信息
  //   '|',
  //   'undo', // 撤销
  //   'redo', // 重做
  //   '|',
  //   'clear', // 清空
  //   '|',
  //   'save', // 保存
  // ],

  // ==================== 自定义工具栏按钮 ====================
  
  // customRender: {
  //   // 自定义渲染函数
  //   // 示例：
  //   // bold: true,
  //   // italic: true,
  //   // heading: true,
  // },

  // ==================== 自定义菜单项 ====================
  
  // customMenu: [
  //   // 自定义菜单项
  //   // {
  //   //   name: 'custom',
  //   //   title: '自定义',
  //   //   icon: '<svg>...</svg>',
  //   //   action: (editor) => {},
  //   // },
  // ],

  // ==================== 编辑器高度 ====================
  
  // height: '500px', // 编辑器高度
  // minHeight: '300px', // 最小高度
  // maxHeight: '800px', // 最大高度

  // ==================== 编辑器宽度 ====================
  
  // width: '100%', // 编辑器宽度
  // minWidth: '300px', // 最小宽度
  // maxWidth: '1200px', // 最大宽度

  // ==================== 编辑器边框 ====================
  
  // border: true, // 是否显示边框
  // borderColor: '#e0e0e0', // 边框颜色

  // ==================== 编辑器背景 ====================
  
  // background: '#ffffff', // 背景颜色
  // mdBackground: '#ffffff', // 编辑区背景颜色
  // htmlBackground: '#fafafa', // 预览区背景颜色

  // ==================== 编辑器字体 ====================
  
  // fontFamily: 'Arial, sans-serif', // 字体
  // fontSize: '14px', // 字体大小
  // lineHeight: '1.6', // 行高

  // ==================== 编辑器配色 ====================
  
  // theme: 'light', // 主题：'light', 'dark', 'auto'

  // ==================== 代码高亮 ====================
  
  // highlight: true, // 是否启用代码高亮
  // hljs: undefined, // highlight.js 实例

  // ==================== 预览配置 ====================
  
  // previewConfig: {
  //   markdownIt: undefined, // markdown-it 实例
  //   markdownItPlugins: [], // markdown-it 插件
  //   transformLink: (link) => link, // 链接转换函数
  //   transformImageUri: (uri) => uri, // 图片 URI 转换函数
  //   allowDangerousHtml: false, // 是否允许危险的 HTML
  //   htmlSanitize: undefined, // HTML 净化函数
  // },

  // ==================== 渲染配置 ====================
  
  // renderConfig: {
  //   html: true, // 是否渲染 HTML
  //   linkify: true, // 是否自动链接
  //   typographer: true, // 是否启用排版增强
  //   xhtmlOut: false, // 是否输出 XHTML
  //   breaks: false, // 是否换行
  //   langPrefix: 'language-', // 语言前缀
  //   quotes: '“”‘’', // 引号
  // },

  // ==================== 事件回调 ====================
  
  // onChange: (text, event) => {}, // 内容变化时的回调
  // onFocus: (event) => {}, // 获得焦点时的回调
  // onBlur: (event) => {}, // 失去焦点时的回调
  // onPaste: (event) => {}, // 粘贴时的回调
  // onDrop: (event) => {}, // 拖拽时的回调
  // onImageUpload: (file) => {}, // 图片上传时的回调
  // onLinkClick: (event) => {}, // 链接点击时的回调
  // onSave: (text) => {}, // 保存时的回调

  // ==================== 其他配置 ====================
  
  // readOnly: false, // 是否只读模式
  // disabled: false, // 是否禁用
  // spellCheck: false, // 是否启用拼写检查
  // autoFocus: false, // 是否自动聚焦
  // allowPasteImage: true, // 是否允许粘贴图片
  // allowDropImage: true, // 是否允许拖拽图片
  // tabSize: 4, // Tab 大小
  // insertSpaces: true, // 是否用空格代替 Tab
  // lineWrapping: true, // 是否自动换行
  // lineNumbers: true, // 是否显示行号
  // wordWrap: true, // 是否自动换行
  // indentUnit: 4, // 缩进单位
  // indentWithTabs: false, // 是否用 Tab 缩进
  // electricChars: true, // 是否启用电子字符
  // specialChars: /[\u0000-\u001F\u007F-\u009F]/g, // 特殊字符
  // specialCharPlaceholder: (ch) => '.', // 特殊字符占位符
  // direction: 'ltr', // 文本方向：'ltr', 'rtl'
  // rtlMoveVisually: true, // 是否视觉移动 RTL
  // tabIndex: undefined, // Tab 索引
  // autofocus: false, // 是否自动聚焦
  // cover: false, // 是否覆盖模式
  // placeholder: '', // 占位符
  // inputStyle: 'textarea', // 输入样式：'textarea', 'contenteditable'
  // dragDrop: true, // 是否启用拖放
  // allowDropFileTypes: ['text/plain'], // 允许拖放的文件类型
  // pasteLinesPerSelection: true, // 是否每行粘贴一个选择
  // selectionsMayTouch: false, // 选择是否可以接触
  // flattenSpans: true, // 是否扁平化 span
  // addModeClass: false, // 是否添加模式类
  // maxHighlightLength: 10000, // 最大高亮长度
  // viewportMargin: 10, // 视口边距
  // lint: false, // 是否启用 lint
  // gutters: [], // 边距
  // fixedGutter: true, // 固定边距
  // scrollbarStyle: 'native', // 滚动条样式：'native', 'null'
  // coverGutterNextToScrollbar: false, // 是否覆盖滚动条旁边的边距
  // inputStyle: 'textarea', // 输入样式
  // theme: 'default', // 主题
  // keyMap: 'default', // 键映射
  // extraKeys: null, // 额外键
  // lineSeparator: null, // 行分隔符
  // scrollPastEnd: false, // 是否滚动到末尾之后
  // scrollMargin: [0, 0, 0, 0], // 滚动边距
  // cursorBlinkRate: 530, // 光标闪烁率
  // cursorScrollMargin: 0, // 光标滚动边距
  // cursorHeight: 1, // 光标高度
  // singleCursorHeightPerLine: true, // 每行单个光标高度
  // workTime: 200, // 工作时间
  // workDelay: 300, // 工作延迟
  // pollInterval: 100, // 轮询间隔
  // lineWiseCopyCut: true, // 行方式复制/剪切
  // undoDepth: 200, // 撤销深度
  // historyEventDelay: 1250, // 历史事件延迟
  // tabindex: undefined, // Tab 索引
  // autofocus: false, // 是否自动聚焦
  // showCursorWhenSelecting: false, // 选择时是否显示光标
  // lineNumbers: true, // 是否显示行号
  // lineNumberFormatter: undefined, // 行号格式化函数
  // firstLineNumber: 1, // 第一行号
  // fixedGutter: true, // 固定边距
  // showTrailingSpace: false, // 是否显示尾随空格
  // indentUnit: 2, // 缩进单位
  // smartIndent: true, // 智能缩进
  // tabSize: 4, // Tab 大小
  // indentWithTabs: false, // 是否用 Tab 缩进
  // electricChars: true, // 电子字符
  // specialChars: /[\u0000-\u001F\u007F-\u009F]/, // 特殊字符
  // specialCharPlaceholder: (ch) => '.', // 特殊字符占位符
  // direction: 'ltr', // 方向
  // rtlMoveVisually: true, // RTL 视觉移动
  // dragDrop: true, // 拖放
  // allowDropFileTypes: undefined, // 允许拖放的文件类型
  // cursorBlinkRate: 530, // 光标闪烁率
  // cursorScrollMargin: 0, // 光标滚动边距
  // cursorHeight: 1, // 光标高度
  // singleCursorHeightPerLine: true, // 每行单个光标高度
  // coverGutterNextToScrollbar: false, // 覆盖滚动条旁边的边距
  // fixedGutter: true, // 固定边距
  // scrollPastEnd: false, // 滚动到末尾之后
  // scrollMargin: [0, 0, 0, 0], // 滚动边距
  // coverGutterNextToScrollbar: false, // 覆盖滚动条旁边的边距
  // dragDrop: true, // 拖放
  // onDragEvent: undefined, // 拖放事件
  // allowDropFileTypes: undefined, // 允许拖放的文件类型
  // lineWiseCopyCut: true, // 行方式复制/剪切
  // pasteLinesPerSelection: true, // 每行粘贴一个选择
  // selectionsMayTouch: false, // 选择是否可以接触
  // flattenSpans: true, // 扁平化 span
  // addModeClass: false, // 添加模式类
  // maxHighlightLength: 10000, // 最大高亮长度
  // viewportMargin: 10, // 视口边距
  // lint: false, // lint
  // gutters: [], // 边距
  // fixedGutter: true, // 固定边距
  // scrollbarStyle: 'native', // 滚动条样式
  // coverGutterNextToScrollbar: false, // 覆盖滚动条旁边的边距
  // lineNumbers: true, // 行号
  // lineNumberFormatter: undefined, // 行号格式化函数
  // firstLineNumber: 1, // 第一行号
  // showTrailingSpace: false, // 显示尾随空格
  // indentUnit: 2, // 缩进单位
  // smartIndent: true, // 智能缩进
  // tabSize: 4, // Tab 大小
  // indentWithTabs: false, // 用 Tab 缩进
  // electricChars: true, // 电子字符
  // specialChars: /[\u0000-\u001F\u007F-\u009F]/, // 特殊字符
  // specialCharPlaceholder: (ch) => '.', // 特殊字符占位符
  // direction: 'ltr', // 方向
  // rtlMoveVisually: true, // RTL 视觉移动
  // onDragEvent: undefined, // 拖放事件
  // pasteLinesPerSelection: true, // 每行粘贴一个选择
  // selectionsMayTouch: false, // 选择是否可以接触
  // flattenSpans: true, // 扁平化 span
  // addModeClass: false, // 添加模式类
  // maxHighlightLength: 10000, // 最大高亮长度
  // viewportMargin: 10, // 视口边距
  // lint: false, // lint
  // gutters: [], // 边距
  // scrollbarStyle: 'native', // 滚动条样式
  // workTime: 200, // 工作时间
  // workDelay: 300, // 工作延迟
  // pollInterval: 100, // 轮询间隔
  // keyMap: 'default', // 键映射
  // extraKeys: null, // 额外键
  // lineSeparator: null, // 行分隔符
  // theme: 'default', // 主题
  // inputStyle: 'textarea', // 输入样式
  // showCursorWhenSelecting: false, // 选择时显示光标
  // undoDepth: 200, // 撤销深度
  // historyEventDelay: 1250, // 历史事件延迟
  // tabindex: undefined, // Tab 索引
  // autofocus: false, // 自动聚焦
};
