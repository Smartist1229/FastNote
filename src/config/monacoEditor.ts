export const monacoEditorConfig = {
  // ==================== 基本显示 ====================
  
  minimap: {
    enabled: false, // 是否启用右侧缩略图（小地图），禁用可以让界面更简洁
    // maxColumn: 120, // 小地图中显示的最大列数
    // renderCharacters: true, // 是否在小地图中渲染字符
    // side: 'right', // 小地图位置：'right' 右侧，'left' 左侧
    // scale: 1, // 小地图缩放比例
  },
  wordWrap: 'on', // 自动换行：'on' 开启，'off' 关闭，'wordWrapColumn' 按列换行，'bounded' 限制在视口内
  // wordWrapColumn: 80, // 按列换行时的列数（wordWrap: 'wordWrapColumn' 或 'bounded' 时生效）
  // wrappingIndent: 'none', // 换行后的缩进：'none' 无，'same' 相同，'indent' 缩进，'deepIndent' 深缩进
  // wrappingStrategy: 'simple', // 换行策略：'simple' 简单，'advanced' 高级
  lineNumbers: 'on', // 行号显示：'on' 显示，'off' 隐藏，'relative' 相对行号，'interval' 间隔显示
  // lineNumbersMinChars: 5, // 行号最小字符数
  fontSize: 14, // 字体大小（像素）
  // fontFamily: 'Consolas, "Courier New", monospace', // 字体
  // fontWeight: 'normal', // 字体粗细
  // letterSpacing: 0, // 字符间距
  // lineHeight: 0, // 行高（0 表示自动）
  automaticLayout: true, // 是否自动适应容器大小变化，推荐开启
  theme: 'vs', // 主题：'vs' 浅色，'vs-dark' 深色，'hc-black' 高对比度黑色
  // readOnly: false, // 是否只读模式
  // domReadOnly: false, // DOM 只读模式
  // renderValidationDecorations: 'editable', // 验证装饰渲染时机：'always' 始终，'editable' 可编辑时，'on' 开启
  
  // ==================== 滚动和行高亮 ====================
  
  scrollBeyondLastLine: true, // 是否允许滚动到最后一行之后
  // scrollBeyondLastColumn: 5, // 是否允许滚动到最后一列之后的列数
  renderLineHighlight: 'line', // 当前行高亮样式：'none' 无，'gutter' 仅行号区，'line' 整行，'all' 两者都有
  // renderLineHighlightOnlyWhenFocus: false, // 是否仅在聚焦时高亮当前行
  selectOnLineNumbers: true, // 点击行号时是否选中整行
  roundedSelection: true, // 选区是否使用圆角
  // overviewRulerBorder: true, // 是否显示概览标尺边框
  // overviewRulerLanes: 3, // 概览标尺的车道数
  // hideCursorInOverviewRuler: false, // 是否在概览标尺中隐藏光标
  // overviewRulerPosition: 'left', // 概览标尺位置：'left' 左侧，'right' 右侧
  
  // ==================== 滚动条 ====================
  
  scrollbar: {
    useShadows: false, // 滚动条是否使用阴影
    verticalScrollbarSize: 5, // 垂直滚动条宽度（像素）
    horizontalScrollbarSize: 10, // 水平滚动条高度（像素）
    // arrowSize: 11, // 箭头大小（像素）
    // handleMouseWheel: true, // 是否处理鼠标滚轮
    // handleMouseWheelZoom: false, // 是否处理鼠标滚轮缩放（需要 mouseWheelZoom 配置）
    // onlyScrollIfFocused: false, // 是否仅在聚焦时滚动
    // alwaysConsumeMouseWheel: false, // 是否始终消费鼠标滚轮事件
  },
  
  // ==================== 代码折叠 ====================
  
  folding: true, // 是否启用代码折叠（Markdown 也可以折叠标题等）
  // foldingHighlight: true, // 是否高亮折叠区域
  // foldingStrategy: 'auto', // 折叠策略：'auto' 自动，'indentation' 基于缩进
  showFoldingControls: 'always', // 折叠控制按钮显示时机：'always' 始终显示，'mouseover' 鼠标悬停时显示
  // foldingMaximumRegions: 5000, // 最大折叠区域数
  // fastScrollSensitivity: 5, // 快速滚动灵敏度
  // scrollPredominantAxis: true, // 是否沿主要轴滚动
  
  // ==================== 括号匹配 ====================
  
  matchBrackets: 'always', // 括号高亮匹配：'never' 从不，'near' 接近光标时，'always' 始终
  
  // ==================== 空白字符显示 ====================
  
  renderWhitespace: 'selection', // 空白字符显示：'none' 不显示，'boundary' 边界，'selection' 选中时，'trailing' 行尾，'all' 全部
  renderControlCharacters: false, // 是否显示控制字符
  
  // ==================== 自动建议 ====================
  
  wordBasedSuggestions: true, // 是否基于文档中的词提供建议
  // wordBasedSuggestionsOnlySameLanguage: true, // 是否仅在同语言中提供基于词的建议
  quickSuggestions: {
    other: true, // 其他内容是否显示快速建议
    comments: false, // 注释中是否显示快速建议
    strings: false, // 字符串中是否显示快速建议
  },
  // quickSuggestionsDelay: 10, // 快速建议延迟（毫秒）
  acceptSuggestionOnEnter: 'on', // 按 Enter 接受建议：'on' 开启，'off' 关闭，'smart' 智能判断
  suggestOnTriggerCharacters: true, // 是否在触发字符时显示建议
  tabCompletion: 'on', // Tab 补全：'on' 开启，'off' 关闭，'onlySnippets' 仅代码片段
  wordSeparators: '`~!@#$%^&*()-=+[{]}\\|;:\'",.<>/?', // 词分隔符（用于建议等功能）
  // snippetSuggestions: 'inline', // 代码片段建议位置：'top' 顶部，'bottom' 底部，'inline' 内联，'none' 不显示
  // suggestSelection: 'first', // 建议选择：'first' 第一个，'recentlyUsed' 最近使用，'recentlyUsedByPrefix' 按前缀最近使用
  // suggestFontSize: 0, // 建议字体大小（0 表示与编辑器一致）
  // suggestLineHeight: 0, // 建议行高（0 表示与编辑器一致）
  
  // ==================== 建议面板 ====================
  
  suggest: {
    showIcons: true, // 是否在建议列表中显示图标
    showStatusBar: true, // 是否在建议面板底部显示状态栏
    // filterGraceful: true, // 是否启用宽松过滤
    // snippetsPreventQuickSuggestions: true, // 代码片段是否阻止快速建议
    // localityBonus: true, // 是否对附近的词给予额外权重
    // shareSuggestSelections: false, // 是否共享建议选择
    // showInlineDetails: false, // 是否显示内联详情
    // maxVisibleSuggestions: 12, // 最大可见建议数
  },
  
  // ==================== 参数提示 ====================
  
  parameterHints: {
    enabled: true, // 是否启用参数提示
    cycle: true, // 是否循环切换多个重载
  },
  
  // ==================== 代码操作 ====================
  
  lightbulb: {
    enabled: true, // 是否显示灯泡图标（代码操作提示）
  },
  codeActionsOnSave: {}, // 保存时自动执行的代码操作
  // codeActionsOnSaveTimeout: 750, // 保存时代码操作超时时间（毫秒）
  
  // ==================== 格式化 ====================
  
  formatOnPaste: true, // 粘贴时是否自动格式化
  formatOnType: false, // 输入时是否自动格式化
  autoIndent: 'advanced', // 自动缩进：'none' 无，'keep' 保持，'brackets' 括号，'advanced' 高级
  trimAutoWhitespace: true, // 是否自动修剪行尾空白
  // formatOnSave: false, // 保存时是否自动格式化
  // defaultFormatter: '', // 默认格式化器
  // trimTrailingWhitespace: false, // 是否修剪尾随空白
  // insertFinalNewline: false, // 是否在文件末尾插入新行
  // useTabStops: true, // 是否使用 Tab 停止位
  
  // ==================== 缩进设置 ====================
  
  insertSpaces: true, // 是否用空格代替 Tab
  tabSize: 4, // Tab 大小（空格数）
  detectIndentation: true, // 是否自动检测文件的缩进设置
  // indentSize: 4, // 缩进大小（空格数）
  
  // ==================== 括号颜色 ====================
  
  bracketPairColorization: {
    enabled: true, // 是否启用括号配对颜色（彩虹括号）
    // independentColorPoolPerBracketType: false, // 是否为每种括号类型使用独立颜色池
  },
  
  // ==================== 辅助线 ====================
  
  guides: {
    bracketPairs: true, // 是否显示括号配对辅助线
    bracketPairsHorizontal: true, // 是否显示水平括号配对辅助线
    highlightActiveIndentation: true, // 是否高亮当前缩进级别
    indentation: true, // 是否显示缩进辅助线
  },
  
  // ==================== 嵌入式提示 ====================
  
  inlayHints: {
    enabled: 'off', // 嵌入式提示：'on' 开启，'off' 关闭，'offUnlessPressed' 按键时显示
    // fontFamily: '', // 嵌入式提示字体
    // fontSize: 0, // 嵌入式提示字体大小
    // padding: false, // 是否添加内边距
  },
  
  // ==================== 粘性滚动 ====================
  
  stickyScroll: {
    enabled: false, // 是否启用粘性滚动（顶部固定显示函数/类名）
    // maxLineCount: 5, // 最大显示行数
    // scrollWithEditor: true, // 是否与编辑器一起滚动
  },
  
  // ==================== 高亮 ====================
  
  occurrencesHighlight: true, // 是否高亮当前词的所有出现
  selectionHighlight: true, // 是否高亮选区匹配的内容
  colorDecorators: true, // 是否在颜色代码旁显示颜色预览
  
  // ==================== Unicode 高亮 ====================
  
  unicodeHighlight: {
    ambiguousCharacters: true, // 是否高亮有歧义的 Unicode 字符
    invisibleCharacters: true, // 是否高亮不可见字符
    // excludeNonASCIIFromAmbiguous: false, // 是否从歧义字符中排除非 ASCII 字符
  },
  
  // ==================== 光标设置 ====================
  
  cursorBlinking: 'smooth', // 光标闪烁：'blink' 闪烁，'smooth' 平滑，'phase' 相位，'expand' 扩展，'solid' 实心
  cursorSmoothCaretAnimation: 'on', // 光标平滑动画：'on' 开启，'off' 关闭
  cursorStyle: 'line', // 光标样式：'line' 竖线，'block' 块，'underline' 下划线，'line-thin' 细线，'block-outline' 块轮廓，'underline-thin' 细下划线
  cursorWidth: 2, // 光标宽度（仅 line 样式有效，像素）
  // cursorSurroundingLines: 0, // 光标周围保持可见的行数
  // cursorSurroundingLinesStyle: 'default', // 光标周围行样式：'default' 默认，'all' 全部
  // multiCursorLimit: 1000, // 多光标限制数
  
  // ==================== 鼠标设置 ====================
  
  mouseWheelZoom: true, // 是否允许 Ctrl+滚轮缩放字体
  smoothScrolling: true, // 是否启用平滑滚动
  // mouseWheelScrollSensitivity: 1, // 鼠标滚轮滚动灵敏度
  // fastScrollSensitivity: 5, // 快速滚动灵敏度
  // selectOnMouseMove: true, // 鼠标移动时是否选中
  // columnSelection: false, // 是否启用列选择模式
  // multiCursorModifier: 'alt', // 多光标修饰键：'ctrlCmd' Ctrl/Cmd，'alt' Alt
  // multiCursorMergeOverlapping: true, // 是否合并重叠的多光标
  
  // ==================== 多光标 ====================
  
  multiCursorMergeOverlapping: true, // 是否合并重叠的多光标
  multiCursorModifier: 'alt', // 多光标修饰键：'ctrlCmd' Ctrl/Cmd，'alt' Alt
  multiCursorPaste: 'spread', // 多光标粘贴：'spread' 分散，'full' 每个都粘贴全部
  
  // ==================== 无障碍 ====================
  
  accessibilitySupport: 'auto', // 无障碍支持：'auto' 自动，'on' 开启，'off' 关闭
  // accessibilityPageSize: 10, // 无障碍页面大小
  // screenReaderAnnounceInlineSuggestion: true, // 屏幕阅读器是否公告内联建议
  
  // ==================== 查找和替换 ====================
  
  // find: {
  //   addExtraSpaceOnTop: true, // 是否在顶部添加额外空间
  //   autoFindInSelection: 'never', // 自动在选区内查找：'always' 始终，'never' 从不，'multiline' 多行
  //   seedSearchStringFromSelection: 'always', // 从选区中获取搜索字符串：'always' 始终，'never' 从不，'singleline' 单行
  //   caseSensitive: false, // 是否区分大小写
  //   wholeWord: false, // 是否整词匹配
  //   regex: false, // 是否使用正则表达式
  // },
  
  // ==================== 内联建议 ====================
  
  // inlineSuggest: {
  //   enabled: true, // 是否启用内联建议
  //   showToolbar: 'always', // 显示工具栏时机：'always' 始终，'onHover' 悬停时
  //   hideOnHover: false, // 悬停时是否隐藏
  // },
  
  // ==================== 语义高亮 ====================
  
  // semanticHighlighting: {
  //   enabled: true, // 是否启用语义高亮
  // },
  
  // ==================== 性能 ====================
  
  // maxTokenizationLineLength: 20000, // 最大词法分析行长度
  // tokenization: {
  //   semanticColorProvider: true, // 是否提供语义颜色
  // },
  
  // ==================== 其他配置 ====================
  
  // dragAndDrop: true, // 是否启用拖放
  // copyWithSyntaxHighlighting: true, // 复制时是否带语法高亮
  // emptySelectionClipboard: true, // 空选区时是否复制整行
  // padding: {
  //   top: 0, // 顶部内边距
  //   bottom: 0, // 底部内边距
  // },
  // fixedOverflowWidgets: false, // 是否固定溢出小部件
  // stopRenderingLineAfter: 10000, // 停止渲染行的字符数限制
  // renderFinalNewline: 'on', // 渲染最后一个新行：'on' 开启，'off' 关闭
  // peekWidgetDefaultFocus: 'tree', // 预览小部件默认焦点：'tree' 树，'editor' 编辑器
  // definitionLinkOpensInPeek: true, // 定义链接是否在预览中打开
  // showUnused: true, // 是否显示未使用的代码
  // showDeprecated: true, // 是否显示已弃用的代码
  // links: false, // 是否启用链接检测
  // hover: {
  //   enabled: true, // 是否启用悬停提示
  //   sticky: true, // 是否粘性悬停提示
  //   delay: 300, // 悬停延迟（毫秒）
  // },
  // gotoLocation: {
  //   multiple: 'peek', // 多个位置时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  //   multipleDefinitions: 'peek', // 多个定义时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  //   multipleTypeDefinitions: 'peek', // 多个类型定义时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  //   multipleDeclarations: 'peek', // 多个声明时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  //   multipleImplementations: 'peek', // 多个实现时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  //   multipleReferences: 'peek', // 多个引用时的处理：'peek' 预览，'gotoAndPeek' 跳转并预览，'goto' 跳转
  // },
  // codeLens: true, // 是否启用代码镜头
  // codeLensFontFamily: '', // 代码镜头字体
  // codeLensFontSize: 0, // 代码镜头字体大小
  // selectionClipboard: true, // 是否启用选择剪贴板
  // renderIndentGuides: true, // 是否渲染缩进辅助线
  // highlightActiveIndentGuide: true, // 是否高亮当前缩进辅助线
  // glyphMargin: false, // 是否显示字形边距
  // lineDecorationsWidth: 10, // 行装饰宽度
  // revealHorizontalRightPadding: 30, // 水平显示右内边距
  // automaticLayout: true, // 是否自动布局
};
