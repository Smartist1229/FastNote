# MarkdownEditor

一个**可独立抽包**的 React Markdown 编辑器：自研解析器、多种视图模式、可配置工具栏、完整主题变量。

- 目录：`src/markdown-editor/`，组件只依赖 `react`，其余能力（高亮 / 公式 / 图表）按需懒加载
- 演示页：`npm run demo:editor` → `http://localhost:5200/demo/markdown-editor.html`
- 测试：`npm run test:editor`（52 个解析 + 命令用例）

---

## 1. 特性

| 分类 | 能力                                                                                    |
| -- | ------------------------------------------------------------------------------------- |
| 视图 | 分栏预览（双向滚动同步、分隔条可拖拽）、代码模式（可开行号）、阅读模式                                                   |
| 解析 | CommonMark 主体 + GFM（表格、任务列表、删除线、自动链接）+ 扩展（高亮、上下标、Alert、`!!!` 提示块、脚注、TOC、front matter） |
| 渲染 | highlight.js 代码高亮（可换主题）、代码块折叠、KaTeX 公式、Mermaid 图表、表格对齐、脚注区、可折叠 Admonition             |
| 编辑 | 工具栏 33 个工具、快捷键、撤销重做、自动续写列表、括号配对、Tab 缩进、图片粘贴、任务勾选、行号点击选中整行                             |
| 查找 | Ctrl/⌘+F 右上角悬浮查找框（VSCode 风格）：区分大小写、正则、替换 / 全部替换、命中高亮与计数                               |
| 配置 | 深合并 config：模式、排版、间距、全量颜色、圆角、代码配色、工具栏条目、状态栏字段、大纲、查找、快捷键                                |
| 工程 | 受控/非受控、命令式 API、TypeScript 类型全导出、CSS 变量换肤、样式自包含                                        |

---

## 2. 快速开始

### 2.1 在当前项目内使用

```tsx
import { useState } from "react";
import { MarkdownEditor } from "@/markdown-editor";

export const Demo = () => {
  const [value, setValue] = useState("# 标题\n\n开始写吧");
  return (
    <MarkdownEditor
      value={value}
      onChange={setValue}
      height={600}
      config={{ mode: { defaultMode: "split" } }}
    />
  );
};
```

样式由组件内部 `import "./styles.css"` 带入，不需要额外引 CSS。

### 2.2 非受控 + 命令式调用

```tsx
const ref = useRef<MarkdownEditorInstance>(null);

<MarkdownEditor
  ref={ref}
  defaultValue=""
  height="100%"
  config={{ toolbar: { items: TOOLBAR_PRESETS.full } }}
/>

<button onClick={() => ref.current?.insertText("**加粗**")}>插入</button>
```

`onReady(api)` 与 `ref` 等价，按习惯选一个即可。

---

## 3. 模式

```tsx
mode: "split" | "code" | "read" | "render"
```

| 模式       | 说明                                                                            | 适用场景                            |
| -------- | ----------------------------------------------------------------------------- | ------------------------------- |
| `split`  | **分栏预览**：左源码右预览，滚动按源码行锚点双向同步，分隔条可拖拽                                           | 边写边看排版                          |
| `code`   | 纯源码，可开行号                                                                      | 批量改格式、粘贴大段文本                    |
| `read`   | 纯预览，无输入框                                                                      | 阅读、展示                           |
| `render` | **纯渲染**：只输出渲染结果，工具栏 / 状态栏 / 查找框 / 大纲一律不渲染，高度随内容增长；不在模式切换里出现，但仍受 `value` 与配置控制 | 把一段 Markdown 直接显示出来（AI 回复、只读展示） |

细节约定：

- 切模式不会丢失内容与光标位置，草稿始终落在源码里；
- `render` 下组件不画边框、不带自己的底色、高度自适应，嵌进任何容器都像一段普通富文本；
- `split` 的同步策略可选 `anchor`（默认，按行插值）或 `ratio`（按滚动比例）；
- 关闭 `preview.syncScroll` 后两栏各自滚动。

---

## 4. Props

| 名称                    | 类型                                               | 默认                          | 说明                                   |
| --------------------- | ------------------------------------------------ | --------------------------- | ------------------------------------ |
| `value`               | `string`                                         | —                           | 受控值                                  |
| `defaultValue`        | `string`                                         | `""`                        | 非受控初始值                               |
| `onChange`            | `(value, meta) => void`                          | —                           | `meta = { source, mode }`，source 见下表 |
| `mode`                | `MarkdownEditorMode`                             | —                           | 受控模式                                 |
| `defaultMode`         | `MarkdownEditorMode`                             | `config.mode.defaultMode`   | 非受控初始模式                              |
| `onModeChange`        | `(mode) => void`                                 | —                           | 用户切换模式                               |
| `config`              | `DeepPartial<MarkdownEditorConfig>`              | `{}`                        | 深合并到默认配置                             |
| `readOnly`            | `boolean`                                        | `false`                     | 只读：保留工具栏但禁用改写                        |
| `placeholder`         | `string`                                         | `config.editor.placeholder` | 源码区占位                                |
| `height`              | `number \| string`                               | `"100%"`                    | 组件高度                                 |
| `minHeight`           | `number \| string`                               | `"320px"`                   | 最小高度（父级无高度时兜底）                       |
| `maxHeight`           | `number \| string`                               | `"none"`                    | 最大高度                                 |
| `className` / `style` | —                                                | —                           | 透传到根节点                               |
| `autoFocus`           | `boolean`                                        | `false`                     | 挂载后聚焦源码区                             |
| `onReady`             | `(api) => void`                                  | —                           | 拿到命令式 API                            |
| `onSave`              | `(value) => void`                                | —                           | `Ctrl/⌘+S`                           |
| `onImagePaste`        | `(file) => Promise<string \| null>`              | —                           | 粘贴/拖入图片，返回 URL 后自动插入 `![]()`         |
| `onLinkClick`         | `(href, event) => boolean \| void`               | —                           | 返回 `false` 阻止默认行为                    |
| `onTaskToggle`        | `(checked, offset, nextValue) => string \| void` | —                           | 自定义任务勾选改写，返回新全文                      |
| `onOutlineChange`     | `(outline) => void`                              | —                           | 标题大纲变化                               |
| `onStatsChange`       | `(stats) => void`                                | —                           | 字数/光标等统计变化                           |
| `onFullscreenChange`  | `(fullscreen) => void`                           | —                           | 全屏状态变化                               |

`meta.source` 取值：`input` / `toolbar` / `api` / `paste` / `undo` / `redo` / `task` / `search` / `format`。

---

## 5. 配置（config）

配置是**深合并**：只写要改的字段，数组（`toolbar.items`、`mode.available`）整体替换。

```tsx
<MarkdownEditor
  config={{
    preview: { typography: { fontSize: 16, maxWidth: 900 } },
    theme: { mode: "dark", codeTheme: "github" },
    toolbar: { exclude: ["image", "mermaid"] },
  }}
/>
```

### 5.1 顶层

| 字段          | 类型                                           | 默认        | 说明             |
| ----------- | -------------------------------------------- | --------- | -------------- |
| `locale`    | `"zh-CN" \| "en-US"`                         | `"zh-CN"` | 内置文案语言         |
| `labels`    | `Record<string, string>`                     | `{}`      | 覆盖任意文案（键见 5.9） |
| `mode`      | `object`                                     | 见下        | 模式相关           |
| `editor`    | `object`                                     | 见下        | 输入区            |
| `preview`   | `object`                                     | 见下        | 预览区            |
| `toolbar`   | `object`                                     | 见下        | 工具栏            |
| `statusBar` | `object`                                     | 见下        | 状态栏            |
| `outline`   | `object`                                     | 见下        | 大纲面板           |
| `split`     | `object`                                     | 见下        | 分栏             |
| `theme`     | `object`                                     | 见下        | 主题             |
| `shortcuts` | `boolean \| Record<string, string \| false>` | `true`    | 快捷键            |

### 5.2 mode

| 字段            | 类型                     | 默认                        |
| ------------- | ---------------------- | ------------------------- |
| `defaultMode` | `MarkdownEditorMode`   | `"split"`                 |
| `available`   | `MarkdownEditorMode[]` | `["split","code","read"]` |
| `showSwitch`  | `boolean`              | `true`                    |

### 5.3 editor（输入区）

| 字段                        | 类型                               | 默认                 | 说明                                |
| ------------------------- | -------------------------------- | ------------------ | --------------------------------- |
| `fontFamily`              | `string`                         | 等宽字体栈              | 源码字体                              |
| `fontSize`                | `number`                         | `14`               | px                                |
| `lineHeight`              | `number`                         | `1.75`             | 倍数                                |
| `tabSize`                 | `number`                         | `2`                | 缩进宽度                              |
| `tabKey`                  | `"indent" \| "spaces" \| "none"` | `"indent"`         | Tab 行为                            |
| `placeholder`             | `string`                         | `"开始书写 Markdown…"` |                                   |
| `spellCheck`              | `boolean`                        | `false`            |                                   |
| `wrap`                    | `boolean`                        | `true`             | 自动换行                              |
| `lineNumbers`             | `boolean`                        | `false`            | 源码行号（换行开启时可能错位，建议配合 `wrap:false`） |
| `autoPair.brackets`       | `boolean`                        | `true`             | `()[]{}` 自动配对                     |
| `autoPair.quotes`         | `boolean`                        | `false`            | `""''` 自动配对                       |
| `autoPair.backticks`      | `boolean`                        | `true`             | 反引号配对                             |
| `continueMarkdownOnEnter` | `boolean`                        | `true`             | 回车续写列表/任务/引用                      |
| `historyLimit`            | `number`                         | `200`              | 撤销栈上限                             |
| `scrollPaddingBottom`     | `number`                         | `120`              | 底部留白 px                           |
| `gutterClickSelectsLine`  | `boolean`                        | `true`             | 点击行号选中整行                          |

### 5.4 preview（预览区）

| 字段                      | 类型                                                       | 默认          | 说明                                 |
| ----------------------- | -------------------------------------------------------- | ----------- | ---------------------------------- |
| `debounce`              | `number`                                                 | `120`       | 输入到渲染的防抖 ms                        |
| `syncScroll`            | `boolean`                                                | `true`      | 分栏同步滚动                             |
| `syncScrollMode`        | `"anchor" \| "ratio"`                                    | `"anchor"`  | 同步策略                               |
| `highlight`             | `boolean`                                                | `true`      | 代码高亮                               |
| `showCodeLineNumbers`   | `boolean`                                                | `true`      | 代码块行号（可用 `lines` / `nolines` 按块覆盖） |
| `showCodeLanguage`      | `boolean`                                                | `true`      | 语言标签                               |
| `codeCollapsible`       | `boolean`                                                | `true`      | 代码块可折叠                             |
| `codeHighlightLines`    | `boolean`                                                | `true`      | 渲染围栏里的行高亮范围                        |
| `codeCollapseDefault`   | `boolean`                                                | `false`     | 超过阈值时默认收起                          |
| `codeCollapseThreshold` | `number`                                                 | `14`        | 超过多少行出现折叠控件                        |
| `codeCollapseHeight`    | `number`                                                 | `260`       | 折叠后的最大高度 px                        |
| `codeActions.copy`      | `boolean`                                                | `true`      | 复制按钮                               |
| `codeActions.wrap`      | `boolean`                                                | `false`     | 换行开关按钮                             |
| `calloutCollapsible`    | `boolean`                                                | `true`      | `???` 折叠提示块；`false` 时一律渲染成常驻提示块    |
| `math`                  | `boolean`                                                | `true`      | KaTeX 公式                           |
| `mermaid`               | `boolean`                                                | `true`      | Mermaid 图表                         |
| `mermaidTheme`          | `"default" \| "dark" \| "forest" \| "neutral" \| "base"` | `"default"` |                                    |
| `tables.striped`        | `boolean`                                                | `true`      | 斑马纹                                |
| `tables.bordered`       | `boolean`                                                | `false`     | 全边框                                |
| `tables.compact`        | `boolean`                                                | `false`     | 紧凑                                 |
| `tables.fullWidth`      | `boolean`                                                | `true`      | 撑满宽度                               |
| `taskInteractive`       | `boolean`                                                | `true`      | 勾选框可点                              |
| `allowHtml`             | `boolean`                                                | `true`      | 允许 HTML                            |
| `sanitizeHtml`          | `boolean`                                                | `true`      | 基础净化（去 script / on* / javascript:） |
| `linkTarget`            | `"_blank" \| "_self"`                                    | `"_blank"`  |                                    |
| `emptyText`             | `string`                                                 | `""`        | 空文档文案                              |
| `showFrontmatter`       | `boolean`                                                | `true`      | front matter 卡片                    |
| `showFootnotes`         | `boolean`                                                | `true`      | 脚注区                                |
| `typography`            | `object`                                                 | 见下          | 排版                                 |

`typography`：

| 字段                     | 默认            | 说明                         |
| ---------------------- | ------------- | -------------------------- |
| `fontFamily`           | 系统无衬线栈        | 预览字体                       |
| `fontSize`             | `15`          | 正文 px                      |
| `lineHeight`           | `1.8`         |                            |
| `letterSpacing`        | `"0.01em"`    |                            |
| `paragraphSpacing`     | `0.9`         | 段间距（em）                    |
| `headingTopSpacing`    | `1.4`         | 标题上间距                      |
| `headingBottomSpacing` | `0.6`         | 标题下间距                      |
| `maxWidth`             | `820`         | 内容宽度                       |
| `padding`              | `"28px 32px"` | 内边距                        |
| `headingWeight`        | `650`         | 标题字重                       |
| `textAlign`            | `"left"`      | `left \| justify \| start` |

### 5.5 toolbar

| 字段                | 类型                     | 默认                        | 说明                          |
| ----------------- | ---------------------- | ------------------------- | --------------------------- |
| `show`            | `boolean`              | `true`                    |                             |
| `sticky`          | `boolean`              | `false`                   | 吸顶                          |
| `items`           | `ToolbarEntry[]`       | `TOOLBAR_PRESETS.default` | 顺序                          |
| `exclude`         | `ToolbarItemName[]`    | `[]`                      | 一键隐藏                        |
| `labels`          | `boolean`              | `false`                   | 按钮显示文字                      |
| `compact`         | `boolean`              | `false`                   | 紧凑                          |
| `tooltip`         | `boolean`              | `true`                    | 悬停提示（原生 title）              |
| `scrollable`      | `boolean`              | `true`                    | 溢出横向滚动（窄窗口），下拉菜单不受裁剪影响      |
| `scrollWheel`     | `boolean`              | `true`                    | 滚轮纵向滚动转为横向滚动                |
| `openOnHover`     | `boolean`              | `true`                    | 悬停即展开下拉菜单（标题 / 提示块 / 警告提示块） |
| `hoverOpenDelay`  | `number`               | `140`                     | 悬停展开延迟 ms                   |
| `hoverCloseDelay` | `number`               | `220`                     | 移出后关闭延迟 ms                  |
| `customItems`     | `MarkdownCustomTool[]` | `[]`                      | 自定义工具                       |

`ToolbarEntry` 三种写法：

```ts
type ToolbarEntry = ToolbarItemName | "|" | { group: ToolbarItemName[] };
```

### 5.6 statusBar

| 字段                          | 默认          |
| --------------------------- | ----------- |
| `show`                      | `true`      |
| `words` / `chars` / `lines` | `true`      |
| `cursor`                    | `false`     |
| `readingTime`               | `true`      |
| `mode`                      | `true`      |
| `readingSpeed`              | `400`（字/分钟） |

### 5.7 outline

| 字段         | 默认       | 说明              |
| ---------- | -------- | --------------- |
| `show`     | `false`  | 初始展开            |
| `position` | `"left"` | `left \| right` |
| `width`    | `220`    | px              |
| `title`    | `"大纲"`   |                 |
| `maxDepth` | `3`      | 只显示到几级标题        |
| `indent`   | `true`   | 按层级缩进           |

### 5.8 split / search

| 字段                         | 默认      | 说明                       |
| -------------------------- | ------- | ------------------------ |
| `split.ratio`              | `0.5`   | 编辑区占比                    |
| `split.resizable`          | `true`  | 可拖拽                      |
| `split.dividerWidth`       | `1`     | 分隔条 px                   |
| `search.enabled`           | `true`  | 查找框与 `Mod+F`；关闭后快捷键也不拦截  |
| `search.showReplace`       | `true`  | 打开时是否展开替换行（`Mod+H` 始终展开） |
| `search.caseSensitive`     | `false` | 初始：区分大小写                 |
| `search.regex`             | `false` | 初始：正则表达式                 |
| `search.highlightAll`      | `true`  | 源码区高亮全部命中（关闭只高亮当前命中）     |
| `search.loop`              | `true`  | 跳到末尾后回绕到开头               |
| `search.maxMatches`        | `2000`  | 最多统计/高亮的命中数（大文档保护）       |
| `search.seedFromSelection` | `true`  | 打开时把选区文本填进查找框            |

```tsx
config={{
  search: { regex: true, maxMatches: 500 },
}}
```

### 5.10 theme

| 字段               | 类型                                                                    | 默认        | 说明             |
| ---------------- | --------------------------------------------------------------------- | --------- | -------------- |
| `mode`           | `"light" \| "dark" \| "auto"`                                         | `"light"` | auto 跟随系统      |
| `colors`         | `Partial<MarkdownThemeColors>`                                        | `{}`      | 覆盖任意颜色         |
| `codeTheme`      | `"github" \| "atom" \| "nord" \| "solarized" \| "monokai" \| "plain"` | `"atom"`  | 代码块配色          |
| `codeColors`     | `Partial<CodeThemeColors>`                                            | `{}`      | 覆盖单个 token 色   |
| `radius`         | `number`                                                              | `10`      | 根圆角            |
| `fontFamily`     | `string`                                                              | 系统栈       | UI 字体          |
| `monoFontFamily` | `string`                                                              | 等宽栈       | 代码字体           |
| `className`      | `string`                                                              | —         | 附加类名           |
| `cssVars`        | `Record<string, string>`                                              | `{}`      | 任意 CSS 变量直写根节点 |

`MarkdownThemeColors` 可覆盖的键（全部会落成 `--mde-*` 变量，留空字符串则沿用回退值）：


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
```

### 5.11 文案键（labels）

工具名同名键（`bold`、`italic`、`quote`…）、`mode.split/code/read`、`heading1..6`、`paragraph`、  
`alertNote/Tip/Important/Warning/Caution`、`words/chars/lines/cursor/readingTime`、`empty`、`editing`、  
`outlineEmpty`、`copySuccess`、`tocTitle`、`frontmatter`、`footnotes`、`placeholderLink`、`placeholderImage`、`placeholderText`、`code`、  
`expandCode`、`collapseCode`、`expandCodeLines`、`searchPlaceholder`、`replacePlaceholder`、`searchToggleReplace`、`searchCaseSensitive`、`searchRegex`、`searchPrev`、`searchNext`、`searchClose`、`searchReplace`、`searchReplaceAll`、`searchNoResult`。

```tsx
config={{ labels: { bold: "Bold", empty: "Type something…" } }}
```

---

## 6. 工具栏

### 6.1 内置工具名

```
undo redo | heading bold italic strike underline mark sup sub inlineCode codeBlock
| quote alert callout bulletList orderedList taskList indent outdent
| link image table hr math mathBlock mermaid footnote toc
| mode outline fullscreen copy
```

窄窗口下工具栏自动横向滚动（可关闭 `toolbar.scrollable`），滚轮纵向滚动会转为横向滚动（`toolbar.scrollWheel`），  
模式切换控件会吸附在工具栏右缘始终可点。下拉菜单支持悬停展开（`toolbar.openOnHover`，带开合延迟避免扫过时乱闪），  
点击仍可切换；菜单渲染在 `body` 上（portal + fixed），不会被工具栏的横向滚动裁剪。

### 6.2 三种隐藏方式

```tsx
// 1) 换预设
config={{ toolbar: { items: TOOLBAR_PRESETS.minimal } }}

// 2) 自定义顺序与分组
config={{ toolbar: { items: ["bold", "italic", "|", { group: ["link", "image"] }] } }}

// 3) 一键隐藏（优先级最高）
config={{ toolbar: { exclude: ["mermaid", "footnote", "toc"] } }}
```

预设：`TOOLBAR_PRESETS.full`（33 项）、`.default`（21 项）、`.minimal`（6 项）。

### 6.3 自定义工具

```tsx
<MarkdownEditor
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
/>
```

---

## 7. 快捷键

| 快捷键                             | 动作                   |
| ------------------------------- | -------------------- |
| `Mod+B` / `Mod+I`               | 加粗 / 斜体              |
| `Mod+Shift+X`                   | 删除线                  |
| `Mod+E` / `Mod+Shift+E`         | 行内代码 / 代码块           |
| `Mod+K` / `Mod+Shift+K`         | 链接 / 图片              |
| `Mod+Shift+.`                   | 引用                   |
| `Mod+Shift+7/8/9`               | 有序 / 无序 / 任务列表       |
| `Mod+Shift+M` / `Mod+Shift+F`   | 行内公式 / 脚注            |
| `Mod+Alt+1..6` / `Mod+Alt+0`    | 一~六级标题 / 正文          |
| `Mod+Z` / `Mod+Shift+Z`、`Mod+Y` | 撤销 / 重做              |
| `Mod+S`                         | `onSave`             |
| `Mod+Alt+Enter`                 | 全屏                   |
| `Mod+F` / `Mod+H`               | 打开查找框 / 打开并展开替换行     |
| `F3` / `Shift+F3`               | 下一个 / 上一个命中          |
| 在查找框内：`Enter` / `Shift+Enter`   | 下一个 / 上一个命中          |
| 在查找框内：`Ctrl+Alt+Enter`          | 全部替换                 |
| `Tab` / `Shift+Tab`             | 缩进 / 反缩进             |
| `Esc`                           | 关闭查找框 / 退出全屏 / 结束块编辑 |

`Mod` = Windows/Linux 的 `Ctrl`、macOS 的 `⌘`。

自定义 / 关闭：

```tsx
config={{ shortcuts: false }}                       // 全关
config={{ shortcuts: { "mod+b": "italic" } }}        // 改键
config={{ shortcuts: { "mod+b": false } }}           // 关单个
```

键名规则：`mod`、`alt`、`shift` + `KeyboardEvent.code` 归一化后的键（字母小写、数字不带 `Digit` 前缀、`.` `` ` `` `/` 直接用符号）。

---

## 8. 实例 API

```tsx
const api = ref.current!;

api.focus();
api.blur();
api.getValue();
api.setValue("新内容", { emitChange: false });
api.insertText("文本", { wrap: ["**", "**"], selectInserted: false });
api.getSelection();          // { start, end, text }
api.setSelection(3, 8);
api.getMode();
api.setMode("read");
api.getStats();              // 字数/字符/行/段落/阅读时长/光标
api.getOutline();            // OutlineItem[]
api.getDocument();           // 完整 AST
api.runCommand("bold");
api.undo(); api.redo();
api.scrollToLine(42);
api.toggleFullscreen(true);
api.toggleOutline(true);
api.openSearch("关键词");        // 打开查找框（可选传查询词，withReplace 展开替换行）
api.closeSearch();
```

---

## 9. 支持的语法

| 语法           | 写法                                                                                    | 备注                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标题           | `# H1` … `###### H6`、`===`/`---` 下划线                                                  | 自动生成去重锚点                                                                                                                                                          |
| 强调           | `**粗**`、`*斜*`、`***粗斜***`、`_斜_`                                                        | 支持下划线词边界（不误伤 snake_case）                                                                                                                                          |
| 删除线          | `~~文本~~`                                                                              |                                                                                                                                                                   |
| 高亮           | `==文本==`                                                                              | 扩展                                                                                                                                                                |
| 上下标          | `x^2^`、`H~2~O`                                                                        | 扩展                                                                                                                                                                |
| 行内代码         | `` `code` ``、多反引号                                                                     | 内容里的 `*` `_` 原样保留                                                                                                                                                 |
| 链接           | `[t](url "title")`、`[t][id]`、`<url>`、裸链接                                              | 引用式定义可放文末                                                                                                                                                         |
| 图片           | `![alt](src)`、`![alt][id]`                                                            |                                                                                                                                                                   |
| 引用           | `> 引用`，可嵌套                                                                            |                                                                                                                                                                   |
| Alert        | `> [!NOTE]`、TIP / IMPORTANT / WARNING / CAUTION                                       | GFM 扩展                                                                                                                                                            |
| 提示块          | `!!!` / `!!! warning` / `!!! note "标题"` … 内容 … `!!!`；`???` 可折叠（默认收起）、`???+` 可折叠（默认展开） | 默认 warning；类型别名覆盖 MkDocs Material 全集（abstract/success/question/bug/failure/cite… 均映射到 note/tip/important/warning/caution 五种观感）；`preview.calloutCollapsible` 可关闭折叠 |
| 列表           | `-` `*` `+`、`1.` `1)`、缩进嵌套、紧/松列表                                                      |                                                                                                                                                                   |
| 任务           | `- [ ]` / `- [x]`                                                                     | 可点击改写源码                                                                                                                                                           |
| 表格           | 管道表 + `:---:` 对齐                                                                      | 单元格内支持行内语法与转义 `\|`                                                                                                                                                |
| 代码块          | ` ```lang ` / `~~~`、缩进 4 空格                                                           | 高亮 + 行号 + 复制 + 折叠                                                                                                                                                 |
| 代码折叠         | ` ```js collapse `、` ```js expand `、` ```js nocollapse `                              | 也可写 `{collapse}`；超过阈值自动出现控件                                                                                                                                       |
| 行号           | ` ```js lines `、` ```js nolines `                                                     | 块级覆盖 `preview.showCodeLineNumbers`                                                                                                                                |
| 行高亮          | ` ```python {1-2,5} `                                                                 | 高亮第 1、2、5 行；行号显隐跟随 `preview.showCodeLineNumbers`，与是否高亮无关                                                                                                          |
| 公式           | `$x$`、`$$…$$`                                                                         | KaTeX                                                                                                                                                             |
| 图表           | ` ```mermaid `                                                                        | 渲染失败自动回退源码                                                                                                                                                        |
| 分割线          | `---`、`***`、`___`                                                                     |                                                                                                                                                                   |
| 脚注           | `正文[^1]` + `[^1]: 内容`                                                                 | 支持多行定义                                                                                                                                                            |
| TOC          | `[TOC]` / `[[toc]]`                                                                   | 按标题生成                                                                                                                                                             |
| front matter | `---` 包裹的 YAML                                                                        | 渲染成属性卡片                                                                                                                                                           |
| HTML         | 行内与块级                                                                                 | 受 `allowHtml` / `sanitizeHtml` 控制                                                                                                                                 |
| 硬换行          | 行尾两个空格或 `\`                                                                           | 软换行渲染成空格                                                                                                                                                          |

解析器是自研的（`parser/`），没有第三方 Markdown 依赖；块级节点带源码偏移，滚动同步与任务勾选都依赖它。

---

## 10. 主题与样式覆盖

优先级从高到低：

1. `config.theme.cssVars` → 直接写根节点 CSS 变量；
2. `config.theme.colors` / `codeColors` → 转成变量；
3. `config.theme.mode` 的亮/暗内置色板；
4. `styles.css` 里的默认值。

```tsx
<MarkdownEditor
  config={{
    theme: {
      mode: "dark",
      colors: { accent: "#0ea5e9", accentSoft: "#0b2b3a", previewBg: "#0b1220" },
      codeTheme: "github",
      codeColors: { keyword: "#f472b6" },
      radius: 14,
    },
  }}
/>
```

需要写复杂选择器时，用 `theme.className` 或外层 `className`：

```css
.my-editor .mde-preview-content h1 { font-family: Georgia, serif; }
.my-editor .mde-code { border-radius: 14px; }
```

常用变量：`--mde-accent`、`--mde-border`、`--mde-bg`、`--mde-preview-font-size`、`--mde-preview-max-width`、  
`--mde-code-bg`、`--mde-tok-keyword`、`--mde-radius`、`--mde-font-family`、`--mde-mono-family`。

---

## 11. 可选依赖与降级

| 能力   | 依赖             | 缺失时         |
| ---- | -------------- | ----------- |
| 代码高亮 | `highlight.js` | 代码显示为纯文本    |
| 公式   | `katex`（含 CSS） | 显示 `$…$` 原文 |
| 图表   | `mermaid`      | 图表块回退为代码块   |

三者都是**动态 import**：不写公式/图表就不会加载对应体积；任一依赖加载失败只降级、不抛错。  
首次渲染代码块时才会加载 highlight.js（约 900KB，覆盖全部语言）。

---

## 12. 与当前项目（FastNote）集成

现有 `NoteEditor` 用的是 `md-editor-rt`。若要换成这个组件，改动集中在三处：

```tsx
// 1) 引入
import { MarkdownEditor } from "@/markdown-editor";

// 2) 替换 MdEditor
<MarkdownEditor
  value={content}
  onChange={setContent}
  height="100%"
  config={{
    mode: { defaultMode: "split" },
    preview: { linkTarget: "_self" },
    theme: { fontFamily: "MiSans VF, sans-serif" },
  }}
  onLinkClick={(href) => {
    void openUrl(href);
    return false;
  }}
  onSave={() => saveNow()}
/>

// 3) 之前依赖 MdEditor 的 ref 能力（插入文本、光标偏移）改用实例 API：
//    api.insertText(text) / api.getSelection() / api.scrollToLine(line)
```

注意：`md-editor-rt` 的图片裁剪、全屏、prettier 格式化不在本组件内；需要时可用  
`toolbar.customItems` 挂到工具栏。

---

## 13. 提取为独立 npm 包

组件目录已经按「可拔插」组织：无 `@/` 别名、无项目内其他依赖、图标全部内联、样式自包含。

```
src/markdown-editor/
├── index.ts              # 公共出口
├── types.ts              # 全部对外类型
├── defaults.ts           # 默认配置 / 预设 / 文案
├── theme.ts              # 配置 → CSS 变量
├── styles.css            # 组件样式
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
├── editor/               # 命令 / 历史 / 滚动同步（纯逻辑）
│   ├── commands.ts
│   ├── useHistory.ts
│   └── scrollSync.ts
└── components/           # UI
    ├── MarkdownEditor.tsx
    ├── Toolbar.tsx
    ├── StatusBar.tsx
    ├── Outline.tsx
    ├── SourceEditor.tsx
    └── SearchBox.tsx
```

步骤：

1. 复制整个 `markdown-editor/` 到新包 `src/`；
2. `package.json`：

```json
{
  "name": "your-markdown-editor",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./style.css": "./dist/style.css"
  },
  "sideEffects": ["**/*.css"],
  "peerDependencies": { "react": ">=18", "react-dom": ">=18" },
  "dependencies": {
    "highlight.js": "^11",
    "katex": "^0.16",
    "mermaid": "^11"
  }
}
```

1. 用 tsup / vite lib mode 打包，`external: ["react", "react-dom"]`，并把 CSS 抽成 `style.css`；
2. 使用时 `import "your-markdown-editor/style.css"`，或让构建器自动注入（当前组件是自动 import 的）。

---

## 14. 已知限制

- **强调解析**不是完整 CommonMark 定界符栈，极端嵌套（如 `**a*b**c*`）结果可能与规范不同；
- 表格必须有表头行，且不支持跨行合并；
- HTML 净化是正则级：能挡住 `script`、事件属性、`javascript:`，不等同于浏览器级 sanitizer。渲染不可信内容时建议 `allowHtml: false`；
- 分栏同步在「自动换行 + 超长行」时是近似值，按源码行插值；
- 源码行号按逻辑行渲染，开启自动换行且单行折行时数字不会跟着折行；
- 大纲只取顶层标题，引用/列表里的标题不进大纲；
- 实时模式下未进入任何块编辑时点工具栏命令，会自动落在全局光标所在的块（兜底：最近编辑过的块 / 文末新块）；
- 行高亮范围单块最多解析 5000 行，超出部分截断；
- `!!!` 提示块不支持同语法嵌套（内层同样写 `!!!` 会被当作结束行），需要嵌套时用 `>` 引用型 Alert；`???` 同理。
- 没有内置图片上传、拼写检查、打印/导出 PDF。

---

## 15. 开发命令

```bash
npm run test:editor     # 解析器 + 编辑命令回归（72 例）
npm run demo:editor     # 演示页 http://localhost:5200/demo/markdown-editor.html
npx tsc --noEmit -p tsconfig.json
```
