# MarkdownEditor

可独立发布的 React Markdown 编辑器：自研解析器、分栏 / 编辑 / 阅读三种视图、可配置工具栏与完整主题变量。

- 运行时只依赖 `react` / `react-dom`
- 高亮（highlight.js）、公式（KaTeX）、图表（Mermaid）都是动态 `import`，用到才加载，缺失时自动降级
- 样式自包含（组件内部 `import "./styles.css"`）

```tsx
import { useState } from "react";
import { MarkdownEditor } from "./markdown-editor";

export const Demo = () => {
  const [value, setValue] = useState("# 标题\n\n开始写吧");
  return <MarkdownEditor value={value} onChange={setValue} height={600} />;
};
```

---

## 1. 模式

| 模式 | 说明 |
| -- | -- |
| `split` | 分栏预览：左编辑右预览，滚动按编辑行锚点双向同步，分隔条可拖拽 |
| `code` | 编辑视图，可开行号 |
| `read` | 只读预览，无输入框 |
| `render` | 纯渲染：不画边框 / 底色，高度随内容增长，工具栏、状态栏、查找框、大纲一律不渲染 |

`code` / `read` / `split` 之间切换不丢内容与光标。`render` 不出现在模式切换里，只受 `value` 与配置控制。

---

## 2. Props

| 名称 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `value` | `string` | — | 受控值 |
| `defaultValue` | `string` | `""` | 非受控初始值 |
| `onChange` | `(value, meta) => void` | — | `meta = { source, mode }` |
| `mode` | `MarkdownEditorMode` | — | 受控模式 |
| `defaultMode` | `MarkdownEditorMode` | `config.mode.defaultMode` | 非受控初始模式 |
| `onModeChange` | `(mode) => void` | — | 用户切换模式 |
| `config` | `DeepPartial<MarkdownEditorConfig>` | `{}` | 深合并到默认配置 |
| `readOnly` | `boolean` | `false` | 只读：保留工具栏但禁用改写 |
| `placeholder` | `string` | `config.editor.placeholder` | 编辑区占位 |
| `height` | `number \| string` | `"100%"` | 组件高度 |
| `minHeight` | `number \| string` | `"320px"` | 最小高度 |
| `maxHeight` | `number \| string` | `"none"` | 最大高度 |
| `className` / `style` | — | — | 透传到根节点 |
| `autoFocus` | `boolean` | `false` | 挂载后聚焦编辑区 |
| `onReady` | `(api) => void` | — | 拿到命令式 API（与 `ref` 等价） |
| `onSave` | `(value) => void` | — | `Mod+S` |
| `onImagePaste` | `(file) => Promise<string \| null>` | — | 粘贴 / 拖入图片，返回 URL 后自动插入 `![]()` |
| `onLinkClick` | `(href, event) => boolean \| void` | — | 返回 `false` 阻止默认行为 |
| `onTaskToggle` | `(checked, offset, nextValue) => string \| void` | — | 自定义任务勾选改写，返回新全文 |
| `onOutlineChange` | `(outline) => void` | — | 标题大纲变化 |
| `onStatsChange` | `(stats) => void` | — | 字数 / 光标等统计变化 |
| `onFontSizeChange` | `(fontSize \| null) => void` | — | 用户缩放字号；`null` = 恢复默认（默认值由使用方决定） |
| `onFullscreenChange` | `(fullscreen) => void` | — | 全屏状态变化 |

`meta.source`：`input` / `toolbar` / `api` / `paste` / `undo` / `redo` / `task` / `search` / `format`。

### 只渲染 Markdown：`MarkdownPreview`

`MarkdownPreview` 从 `index.ts` 单独导出，直接接收解析结果渲染，不带工具栏 / 状态栏：

| 名称 | 类型 | 说明 |
| -- | -- | -- |
| `doc` | `ParsedDocument` | `parseMarkdown(value)` 的结果 |
| `config` | `MarkdownEditorConfig` | 与编辑器同一份配置（`resolveConfig` 补全） |
| `labels` | `Record<string, string>` | `resolveLabels` 的结果 |
| `readOnly` | `boolean` | 只读展示 |
| `themeVars` | `Record<string, string>` | 主题变量（图片放大浮层 portal 到 `body` 后靠它继承配色） |
| `onLinkClick` / `onTaskToggle` | — | 同编辑器 |
| `onImageClick` | `(src, alt) => boolean \| void` | 接管图片点击；不传则用内置放大浮层 |

---

## 3. 配置（config）

配置是**深合并**：只写要改的字段；数组（`toolbar.items`、`mode.available`）整体替换。

```tsx
<MarkdownEditor
  config={{
    preview: { typography: { fontSize: 16, maxWidth: 900 } },
    theme: { mode: "dark", codeTheme: "github" },
    toolbar: { exclude: ["image", "mermaid"] },
  }}
/>
```

> 组件不内置任何宿主专有的值：凡是可调的都在 `config` 里，默认值集中在 `defaults.ts`，
> 对外类型在 `types.ts`。需要新能力时加**带默认值的配置项**，而不是在组件里写死。

### 3.1 顶层

| 字段 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `locale` | `"zh-CN" \| "en-US"` | `"zh-CN"` | 内置文案语言 |
| `labels` | `Record<string, string>` | `{}` | 覆盖任意文案（键见 3.10） |
| `mode` | `object` | 见 3.2 | 模式 |
| `editor` | `object` | 见 3.3 | 输入区 |
| `preview` | `object` | 见 3.4 | 预览区 |
| `toolbar` | `object` | 见 3.5 | 工具栏 |
| `statusBar` | `object` | 见 3.6 | 状态栏 |
| `outline` | `object` | 见 3.7 | 大纲面板 |
| `split` / `search` | `object` | 见 3.8 | 分栏 / 查找 |
| `theme` | `object` | 见 3.9 | 主题 |
| `shortcuts` | `boolean \| Record<string, string \| false>` | `true` | 快捷键 |

### 3.2 mode

| 字段 | 类型 | 默认 |
| -- | -- | -- |
| `defaultMode` | `MarkdownEditorMode` | `"split"` |
| `available` | `MarkdownEditorMode[]` | `["split","code","read"]` |
| `showSwitch` | `boolean` | `true` |

### 3.3 editor（输入区）

| 字段 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `fontFamily` | `string` | 等宽字体栈 | 编辑字体 |
| `fontSize` | `number` | `14` | px |
| `lineHeight` | `number` | `1.75` | 倍数 |
| `letterSpacing` | `string` | `"0"` | 字间距；同时作用于编辑区与行号测量层 |
| `tabSize` | `number` | `2` | 缩进宽度 |
| `tabKey` | `"indent" \| "spaces" \| "none"` | `"indent"` | Tab 行为 |
| `placeholder` | `string` | `"开始书写 Markdown…"` | |
| `spellCheck` | `boolean` | `false` | |
| `wrap` | `boolean` | `true` | 自动换行 |
| `lineNumbers` | `boolean` | `false` | 行号；换行时按视觉行对齐，续行前不显示数字 |
| `fontLigatures` | `boolean` | `false` | 字体连字 |
| `zoom` | `{ enabled, step, min, max }` | `true / 1 / 10 / 32` | 字号缩放，见下 |
| `autoPair.brackets` | `boolean` | `true` | `()[]{}` 自动配对 |
| `autoPair.quotes` | `boolean` | `false` | `""''` 自动配对 |
| `autoPair.backticks` | `boolean` | `true` | 反引号配对 |
| `continueMarkdownOnEnter` | `boolean` | `true` | 回车续写列表 / 任务 / 引用 |
| `historyLimit` | `number` | `200` | 撤销栈上限 |
| `scrollPaddingBottom` | `number` | `120` | 底部留白 px |
| `gutterClickSelectsLine` | `boolean` | `true` | 点击行号选中整行 |
| `highlightActiveLine` | `boolean` | `true` | 光标行整行高亮 |
| `caretWidth` | `number` | `2` | 自绘光标宽度 px（原生光标恒 1px，高缩放下看不见） |
| `caretHeight` | `number` | `1.25` | 自绘光标高度 = 字号 × 该值；`1` 与字同高，略大则上下各出头；`<=0` 回退默认 |
| `codeHighlight` | `boolean` | `true` | 编辑区代码块增强：围栏语言识别 + 整块浅底（`theme.colors.sourceCodeBg`）+ token 着色（跟 `theme.codeTheme`）；依赖 `preview.highlight` |

字号缩放（`zoom`）：`enabled` 关掉后手势完全交还浏览器；`step` 为每次加减的像素数；
`Mod+0` 只回调 `onFontSizeChange(null)`，默认字号由使用方决定。

### 3.4 preview（预览区）

| 字段 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `debounce` | `number` | `120` | 输入到渲染的防抖 ms |
| `syncScroll` | `boolean` | `true` | 分栏同步滚动 |
| `syncScrollMode` | `"anchor" \| "ratio"` | `"anchor"` | 同步策略 |
| `highlight` | `boolean` | `true` | 代码高亮 |
| `showCodeLineNumbers` | `boolean` | `true` | 代码块行号（可用 `lines` / `nolines` 按块覆盖） |
| `showCodeLanguage` | `boolean` | `true` | 语言标签 |
| `codeCollapsible` | `boolean` | `true` | 代码块可折叠 |
| `codeHighlightLines` | `boolean` | `true` | 渲染围栏里的行高亮范围 |
| `codeCollapseDefault` | `boolean` | `false` | 超过阈值时默认收起 |
| `codeCollapseThreshold` | `number` | `14` | 超过多少行出现折叠控件 |
| `codeCollapseHeight` | `number` | `260` | 折叠后最大高度 px |
| `codeActions.copy` | `boolean` | `true` | 复制按钮 |
| `codeActions.wrap` | `boolean` | `false` | 换行开关按钮 |
| `calloutCollapsible` | `boolean` | `true` | `???` 折叠提示块 |
| `math` | `boolean` | `true` | KaTeX 公式 |
| `mermaid` | `boolean` | `true` | Mermaid 图表 |
| `mermaidTheme` | `"default" \| "dark" \| "forest" \| "neutral" \| "base"` | `"default"` | |
| `tables.striped` | `boolean` | `true` | 斑马纹 |
| `tables.bordered` | `boolean` | `false` | 全边框 |
| `tables.compact` | `boolean` | `false` | 紧凑 |
| `tables.fullWidth` | `boolean` | `true` | 撑满宽度 |
| `taskInteractive` | `boolean` | `true` | 勾选框可点 |
| `imagePreview` | `boolean` | `true` | 点击图片放大预览（窗口级浮层，不受编辑器裁剪）；`render` 模式不弹 |
| `imageZoom` | `{ step, min, max }` | `1.2 / 0.2 / 8` | 放大浮层：滚轮倍率与区间、按住拖动平移、双击复位、`Esc` / 点遮罩关闭 |
| `allowHtml` | `boolean` | `true` | 允许 HTML |
| `breaks` | `boolean` | `false` | 单个换行即换行（GFM breaks）；开启时强制停用 Setext |
| `setext` | `boolean` | `true` | Setext 标题（段落下一行 `===` / `---`）；`breaks` 开启时不生效 |
| `sanitizeHtml` | `boolean` | `true` | 基础净化（去 `script` / `on*` / `javascript:`） |
| `linkTarget` | `"_blank" \| "_self"` | `"_blank"` | |
| `emptyText` | `string` | `""` | 空文档文案 |
| `showFrontmatter` | `boolean` | `true` | front matter 卡片 |
| `showFootnotes` | `boolean` | `true` | 脚注区 |
| `typography` | `object` | 见下 | 排版 |

`typography`：

| 字段 | 默认 | 说明 |
| -- | -- | -- |
| `fontFamily` | 系统无衬线栈 | 预览字体 |
| `fontSize` | `15` | 正文 px |
| `lineHeight` | `1.8` | |
| `letterSpacing` | `"0.01em"` | |
| `paragraphSpacing` | `0.9` | 段间距（em） |
| `headingTopSpacing` | `1.4` | 标题上间距 |
| `headingBottomSpacing` | `0.6` | 标题下间距 |
| `maxWidth` | `820` | 内容宽度 |
| `padding` | `"28px 32px"` | 内边距 |
| `headingWeight` | `650` | 标题字重 |
| `textAlign` | `"left"` | `left \| justify \| start` |

### 3.5 toolbar

| 字段 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `show` | `boolean` | `true` | |
| `sticky` | `boolean` | `false` | 吸顶 |
| `items` | `ToolbarEntry[]` | `TOOLBAR_PRESETS.default` | 顺序与分组 |
| `exclude` | `ToolbarItemName[]` | `[]` | 一键隐藏（优先级最高） |
| `labels` | `boolean` | `false` | 按钮显示文字 |
| `compact` | `boolean` | `false` | 紧凑 |
| `tooltip` | `boolean` | `true` | 悬停提示 |
| `scrollable` | `boolean` | `true` | 溢出横向滚动 |
| `scrollWheel` | `boolean` | `true` | 滚轮纵向滚动转为横向 |
| `pinTail` | `boolean` | `true` | 尾部组（视图切换 / 大纲 / 全屏 / 复制）钉在右缘 |
| `colorSwatches` | `string[]` | 16 个预设色 | 文字颜色 / 底色菜单里的色块，数组整体替换 |
| `textColorFallback` | `string` | `"#e03131"` | 文字颜色取色器的起始色（`#rrggbb`） |
| `backgroundColorFallback` | `string` | `"#ffe066"` | 底色取色器的起始色（`#rrggbb`） |
| `openOnHover` | `boolean` | `true` | 悬停即展开下拉菜单 |
| `hoverOpenDelay` | `number` | `140` | 悬停展开延迟 ms |
| `hoverCloseDelay` | `number` | `220` | 移出后关闭延迟 ms |
| `customItems` | `MarkdownCustomTool[]` | `[]` | 自定义工具 |

`ToolbarEntry` 三种写法：

```ts
type ToolbarEntry = ToolbarItemName | "|" | { group: ToolbarItemName[] };
```

内置工具名：

```
undo redo | heading bold italic strike textColor bgColor underline mark sup sub inlineCode codeBlock
| quote alert callout bulletList orderedList taskList indent outdent
| link image table hr math mathBlock mermaid footnote toc
| mode outline fullscreen copy
```

预设：`TOOLBAR_PRESETS.full`（35 项）、`.default`（34 项）、`.minimal`（6 项）。

其中 `textColor` / `bgColor` 是**带色盘的下拉**（`toolbar.colorSwatches` 给出的预设色块 + 自绘 HSV 取色器 + 清除），
给选区套一层 `<font style="color:…">` / `<font style="background-color:…">`——
Markdown 没有颜色语法，只能落到行内 HTML，因此这两项依赖 `preview.allowHtml`。

改色是**接管而不是叠加**：选区落在已有颜色标签内部、跨过标签边界，或连续拖动取色器改色，
都只会在选区覆盖到的字符上生成一层新标签，不会出现同属性标签互相嵌套。
选区外原有的标签按原样恢复，其他样式属性（如同时存在的文字色与底色）保留。
命令执行后选区仍只圈住原来的文字，新插入的开、闭标签不进入选区，连续改色不会把闭合标签当成选中内容。
`清除` 会从选区覆盖到的所有颜色标签里摘掉对应属性，属性删空时连标签一起删除。
取色器的起始色由 `toolbar.textColorFallback` / `toolbar.backgroundColorFallback` 决定。

用 `<font>` 而不是 `<span>` 是踩出来的：行首出现短语级标签时，块解析器原本会把整行判成 HTML 块，
`<span…># 标题</span>` 于是连标题都不是了。现在这类标签（`span`/`font`/`u`/`mark`/`a`…）在行首一律放行
（见 `parser/block.ts` 的 `INLINE_HTML_TAGS`），而且上色时行首块标记（`# `、`> `、`- [ ] `、`1. `）会被
留在标签外面 —— 整行标题上完色仍然是标题。

取色器是自己画的（SV 面板 + 色相滑杆 + 十六进制输入），**不**用原生 `<input type="color">`：
它在 WebView2 里弹的是系统对话框，而且拖动过程中会连续发 change，外层一接到就套色、菜单一关，
表现就是「碰一下就定了、滑杆拖不动」。自绘版按下时抢占指针（拖到面板外也不掉），
拖动只更新面板预览，**松手才落到文档**——一次拖动 = 一次编辑，不是几百次。
十六进制输入框可以直接编辑（`#66dbff` 或 `66dbff`，聚焦时自动全选），回车或失焦时提交，
Esc 放弃本次输入，非法值回退到面板当前色。

自定义工具：

```tsx
config={{
  toolbar: {
    customItems: [
      {
        name: "timestamp",
        title: "插入时间",
        icon: "M12 8v5l3 2", // SVG path，或直接给 ReactNode
        onClick: (api) => api.insertText(`\n> ${new Date().toLocaleString()}\n`),
      },
    ],
  },
}}
```

### 3.6 statusBar

| 字段 | 默认 |
| -- | -- |
| `show` | `true` |
| `words` / `chars` / `lines` | `true` |
| `cursor` | `false` |
| `readingTime` | `true` |
| `mode` | `true` |
| `readingSpeed` | `400`（字/分钟） |

### 3.7 outline

| 字段 | 默认 | 说明 |
| -- | -- | -- |
| `show` | `false` | 初始展开 |
| `position` | `"left"` | `left \| right` |
| `width` | `220` | px |
| `title` | `"大纲"` | |
| `maxDepth` | `3` | 只显示到几级标题 |
| `indent` | `true` | 按层级缩进 |
| `caretTarget` | `"lineStart"` | 点击后光标落点：`lineStart` 行首、`textStart` 标题文字前 |
| `flashTarget` | `true` | 跳转后高亮目标标题 |

### 3.8 split / search

| 字段 | 默认 | 说明 |
| -- | -- | -- |
| `split.ratio` | `0.5` | 编辑区占比 |
| `split.resizable` | `true` | 可拖拽 |
| `split.dividerWidth` | `1` | 分隔条 px |
| `search.enabled` | `true` | 查找框与 `Mod+F` |
| `search.showReplace` | `true` | 程序化打开时是否展开替换行；`Mod+F` 恒不展开、`Mod+H` 恒展开 |
| `search.caseSensitive` | `false` | 初始：区分大小写 |
| `search.regex` | `false` | 初始：正则（`^` `$` 按行首行尾） |
| `search.regexReplace` | `false` | 初始：替换串也按正则展开（`$1` / `$&` / `$<name>` / `$$`） |
| `search.highlightAll` | `true` | 编辑区高亮全部命中 |
| `search.highlightPreview` | `true` | 预览 / 阅读视图同样铺命中高亮 |
| `search.loop` | `true` | 跳到末尾后回绕 |
| `search.maxMatches` | `20000` | 最多统计 / 高亮的命中数，到顶时显示 `N+` |
| `search.seedFromSelection` | `true` | 打开时把选区文本填进查找框 |
| `search.blockHostFind` | `true` | 焦点在编辑器内时挡掉宿主 / 浏览器的原生 `Mod+F/G/H`、`F3` |

### 3.9 theme

| 字段 | 类型 | 默认 | 说明 |
| -- | -- | -- | -- |
| `mode` | `"light" \| "dark" \| "auto"` | `"light"` | auto 跟随系统 |
| `colors` | `Partial<MarkdownThemeColors>` | `{}` | 覆盖任意颜色 |
| `codeTheme` | `"github" \| "atom" \| "nord" \| "solarized" \| "monokai" \| "plain" \| "follow"` | `"atom"` | 代码块配色 |
| `codeColors` | `Partial<CodeThemeColors>` | `{}` | 覆盖单个 token 色 |
| `radius` | `number` | `4` | 根圆角 px（`0` = 直角） |
| `fontFamily` | `string` | 系统栈 | UI 字体 |
| `monoFontFamily` | `string` | 等宽栈 | 代码字体 |
| `className` | `string` | — | 附加类名 |
| `cssVars` | `Record<string, string>` | `{}` | 任意 CSS 变量直写根节点 |

`codeTheme: "follow"` 时，代码块配色从当前主题语义色推算（底色取 `toolbarBg`、关键字取 `accent`、
字符串取 `tipColor`、数字取 `noteColor`、注释取 `textFaint` 等），换主题时自动同步；
显式传了 `theme.colors.codeHighlight` / `codeBorder` 则以传入值为准。

`MarkdownThemeColors` 可覆盖的键（全部落成 `--mde-*` 变量）：

```
// 面板与文字
bg editorBg previewBg toolbarBg toolbarHover toolbarActiveBg toolbarActiveText
border borderStrong text textBody textMuted textFaint
// 强调
accent accentHover accentSoft onAccent link selection
// 代码
codeBg codeText codeHeaderBg codeBorder codeHighlight codeToolHover
inlineCodeBg inlineCodeText
// 引用 / 表格 / 标记 / 提示块
quoteBorder quoteBg quoteText tableBorder tableHeaderBg tableStripeBg
markBg markText noteColor tipColor warningColor cautionColor danger
// 结构性颜色
shadow chipShadow overlay divider
// 行号槽
gutterBg gutterText gutterActiveText
// 滚动条
scrollbarThumb scrollbarThumbHover
// 状态栏 / 大纲 / 菜单 / 输入框 / 查找框
statusBg statusText outlineBg outlineActiveBg outlineActiveText
menuBg menuBorder inputBg inputText inputBorder
searchBg searchBorder searchShadow
searchMatchBg searchMatchBorder searchMatchActiveBg searchMatchActiveBorder
// 当前行 / 跳转高亮 / 编辑区代码块整块浅底 / 图片放大浮层遮罩
activeLineBg jumpFlashBg sourceCodeBg imageViewerBg
```

多数颜色通过 `--mde-*` 变量生效，但查找命中与大纲跳转的高亮走 `::highlight()`，
该伪元素不认自定义属性，因此 `searchMatchBg` / `searchMatchActiveBg` / `jumpFlashBg`
会由组件拼成字面量规则注入；要改这三种颜色请改配置，覆盖 CSS 变量无效。

### 3.10 文案键（labels）

工具名同名键（`bold`、`italic`、`quote`…）、`mode.split/code/read`、`heading1..6`、`paragraph`、
`alertNote/Tip/Important/Warning/Caution`、`words/chars/lines/cursor/readingTime`、`empty`、`editing`、
`outlineEmpty`、`copySuccess`、`tocTitle`、`frontmatter`、`footnotes`、`placeholderLink`、`placeholderImage`、
`placeholderText`、`code`、`expandCode`、`collapseCode`、`expandCodeLines`、`searchPlaceholder`、
`replacePlaceholder`、`searchToggleReplace`、`searchCaseSensitive`、`searchRegex`、`searchPrev`、`searchNext`、
`searchClose`、`searchReplace`、`searchReplaceAll`、`searchNoResult`、
色盘的 `colorCustom`、`colorClear`。

```tsx
config={{ labels: { bold: "Bold", empty: "Type something…" } }}
```

---

## 4. 实例 API

```tsx
const api = ref.current!;

api.focus(); api.blur();
api.getValue();
api.setValue("新内容", { emitChange: false });
api.insertText("文本", { wrap: ["**", "**"], selectInserted: false });
api.getSelection();          // { start, end, text }
api.setSelection(3, 8);
api.getMode();  api.setMode("read");
api.getStats();              // 字数 / 字符 / 行 / 段落 / 阅读时长 / 光标
api.getOutline();            // OutlineItem[]
api.getDocument();           // 完整 AST
api.runCommand("bold");
api.undo(); api.redo();
api.scrollToLine(42);
api.toggleFullscreen(true);
api.toggleOutline(true);
api.openSearch("关键词", true);   // 第二个参数 = 展开替换行
api.closeSearch();
```

---

## 5. 快捷键

| 快捷键 | 动作 |
| -- | -- |
| `Mod+B` / `Mod+I` | 加粗 / 斜体 |
| `Mod+Shift+X` | 删除线 |
| `Mod+E` / `Mod+Shift+E` | 行内代码 / 代码块 |
| `Mod+K` / `Mod+Shift+K` | 链接 / 图片 |
| `Mod+Shift+.` | 引用 |
| `Mod+Shift+7/8/9` | 有序 / 无序 / 任务列表 |
| `Mod+Shift+M` / `Mod+Shift+F` | 行内公式 / 脚注 |
| `Mod+Alt+1..6` / `Mod+Alt+0` | 一~六级标题 / 正文 |
| `Mod+Z` / `Mod+Shift+Z`、`Mod+Y` | 撤销 / 重做 |
| `Mod+S` | `onSave` |
| `Mod+Alt+Enter` | 全屏 |
| `Mod+F` / `Mod+H` | 打开查找框 / 打开并展开替换行 |
| `Mod+G` / `Mod+Shift+G`、`F3` / `Shift+F3` | 下一个 / 上一个命中（`Mod+G` 仅在查找框已打开时生效） |
| 查找框内 `Enter` / `Shift+Enter` | 下一个 / 上一个命中（焦点留在查找框） |
| 查找框内 `Ctrl+Alt+Enter` | 全部替换 |
| `Tab` / `Shift+Tab` | 缩进 / 反缩进 |
| `Mod` + 滚轮 / `Mod+=` / `Mod+-` / `Mod+0` | 放大 / 缩小 / 恢复字号 |
| `Esc` | 关闭查找框 / 退出全屏 / 结束块编辑 |

`Mod` = Windows / Linux 的 `Ctrl`、macOS 的 `⌘`。

```tsx
config={{ shortcuts: false }}                 // 全关
config={{ shortcuts: { "mod+b": "italic" } }} // 改键
config={{ shortcuts: { "mod+b": false } }}    // 关单个
```

键名规则：`mod`、`alt`、`shift` + `KeyboardEvent.code` 归一化后的键（字母小写、数字不带 `Digit`、符号直接用）。

---

## 6. 主题与 CSS 变量

优先级从高到低：

1. `config.theme.cssVars` → 直接写根节点 CSS 变量
2. `config.theme.colors` / `codeColors` → 转成变量
3. `config.theme.mode` 的亮 / 暗内置色板
4. `styles.css` 里的默认值

```tsx
config={{
  theme: {
    mode: "dark",
    colors: { accent: "#0ea5e9", accentSoft: "#0b2b3a", previewBg: "#0b1220" },
    codeTheme: "github",
    codeColors: { keyword: "#f472b6" },
    radius: 14,
  },
}}
```

需要复杂选择器时用 `theme.className` 或外层 `className`：

```css
.my-editor .mde-preview-content h1 { font-family: Georgia, serif; }
```

常用变量：`--mde-accent`、`--mde-border`、`--mde-bg`、`--mde-preview-font-size`、
`--mde-preview-max-width`、`--mde-code-bg`、`--mde-tok-keyword`、`--mde-radius`、
`--mde-font-family`、`--mde-mono-family`、`--mde-caret-width`、`--mde-source-code-bg`。

编辑区光标是自绘的：宽度取 `editor.caretWidth`、高度取 `editor.caretHeight` × 字号，颜色跟随
`--mde-accent`；横向对齐「前后两字之间的空隙中线」；失焦、有选区、输入法组合中自动收起。

---

## 7. 语法支持

CommonMark 主体 + GFM（表格、任务列表、删除线、自动链接）+ 扩展（`==高亮==`、上下标、Alert、
`!!!` / `???` 提示块、脚注、`[TOC]`、front matter、KaTeX 公式、Mermaid 图表、围栏代码块的
`lines` / `nolines` / `collapse` / `{1-2,5}` 等 info 标记）。

解析器是自研的（`parser/`），没有第三方 Markdown 依赖；块级节点带编辑区偏移，
滚动同步与任务勾选都依赖它。

front matter 只在文档开头识别：首行必须是 `---`，并且在头部元数据区域内找到
`---` 或 `...` 闭合线。头部区域允许空行、`key: value`、列表项和缩进续行；闭合线
之前一旦出现正文（标题、引用、普通段落等），整段就按普通 Markdown 渲染——未闭合
时不会把后面的正文一起吞掉。

Setext 标题由 `preview.setext` 控制：开启时段落下一行的 `===` / `---` 会把整段变成
一级 / 二级标题；关闭后这行 `---` 是分割线，`===` 则并入段落正文。它与
`preview.breaks` 互斥——开启单换行即换行后 Setext 强制停用，`文字\n---` 始终渲染成
段落 + 分割线。

由于是自研解析器，以下边界与 CommonMark 不完全一致：极端嵌套强调、表格不支持跨行合并、
HTML 净化是正则级（渲染不可信内容建议 `allowHtml: false`）、大纲只取顶层标题、
`!!!` 提示块不支持同语法嵌套。

---

## 8. 目录结构

```
markdown-editor/
├── index.ts              # 公共出口（组件 / 解析 / 配置 / 类型）
├── types.ts              # 全部对外类型
├── defaults.ts           # 默认配置 / 工具栏预设 / 色板 / 文案
├── theme.ts              # config → CSS 变量 + 语法高亮规则
├── styles.css            # 组件样式（自包含）
├── icons.tsx             # 内联图标
├── parser/               # 自研解析器（无依赖）
│   ├── types.ts
│   ├── inline.ts
│   └── block.ts
├── render/               # AST → React
│   ├── MarkdownPreview.tsx
│   ├── CodeBlock.tsx
│   ├── codeMeta.ts       # 围栏 info：折叠 / 行号 / 行高亮范围
│   ├── MathNode.tsx
│   ├── highlight.ts      # 三方能力懒加载
│   ├── sanitize.ts
│   └── context.ts
├── editor/               # 纯逻辑：命令 / 查找 / 行偏移 / 滚动同步 / 高亮
│   ├── commands.ts
│   ├── search.ts
│   ├── highlights.ts     # CSS Custom Highlight 注册表
│   ├── syntax.ts         # 围栏扫描 + 行内 token 切分
│   ├── lines.ts
│   ├── lineRows.ts
│   ├── scrollSync.ts
│   └── hooks/
│       ├── useHistory.ts
│       ├── useVisibleRange.ts
│       └── useVisualLineRows.ts
└── components/           # UI
    ├── MarkdownEditor.tsx
    ├── Toolbar.tsx
    ├── StatusBar.tsx
    ├── Outline.tsx
    ├── SourceEditor.tsx
    ├── Gutter.tsx
    └── overlays/
        ├── SearchBox.tsx
        └── ImageViewer.tsx   # 图片放大浮层（portal 到 body，窗口级）
```

组件目录无 `@/` 别名、无项目内其他依赖、图标全部内联、样式自包含，可整体复制为独立包；
`index.ts` 已是公共出口，`package.json` 的 `exports` 指过去即可。

`peerDependencies` 需要 `react` / `react-dom`（>=18），`highlight.js` / `katex` / `mermaid` 按需引入。
