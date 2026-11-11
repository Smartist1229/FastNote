# FastNote 插件 API

> 状态：实验性（安装已开放，接口仍可能调整）。设置 → 插件 可直接安装 / 启用 / 卸载 zip 插件包。插件在应用内运行第三方代码，请仅安装可信来源的插件。

---

## 1. 插件包结构

```
my-plugin/
├── plugin.json      # 必需
├── icon.svg         # 可选，插件图标（见下方「插件图标」）
├── main.js          # 可选，入口脚本，ESM 模块
├── style.css        # 可选，全局样式（宿主用 Constructable Stylesheet 注入，停用即摘）
├── window.html      # 可选，插件自己的窗口页面（ctx.window.open，见 §5.16）
├── locales/         # 可选，插件自己的语言包（.json，见 §5.14）
│   ├── zh.json
│   └── en.json
└── modules/         # 可选，多文件模块（entry 里用相对路径 import，见 §4）
```

> **演示插件**：软件内置一份「插件演示」（`plugin-demo`），把下面所有扩展点都跑了一遍，可以直接拿来改。
> 打包版只在**首次启动**时释放一次，用户卸载后不会再自动出现；设置 → 插件 里的
> **「刷新」** 会安装一份最新的演示插件再重扫目录（存在就覆盖，`config.json` 保留），
> **「安装演示插件」** 则是单独把它装回来。
> 演示插件的**全部 27 个配置项**（功能开关、快捷键、表名、窗口尺寸…）都在设置 → 插件 → 插件演示 里，能直接看到「加了什么、当前是什么值」。

zip 允许两种布局：`plugin.json` 在根目录；或压缩包里只有一个顶层文件夹、`plugin.json` 在该文件夹内。

### 插件图标（可选）

在插件根目录放置以下任意一个文件即可作为插件图标，宿主按顺序取第一个存在的：

| 文件名 | 格式 |
|---|---|
| `icon.png` | PNG |
| `icon.svg` | SVG |
| `icon.webp` | WebP |
| `icon.jpg` | JPEG |

- **只认这四个固定文件名**，`logo.png` 等其他名字不会被识别；文件必须在插件根目录，不支持子目录。
- 单文件上限 4MB。图标随插件目录一起安装 / 卸载 / 升级，不需要在 `plugin.json` 里声明字段。
- 显示尺寸由宿主统一（固定盒子 + `object-fit: contain`），不同分辨率源图的显示大小一致；建议正方形、24×24 或更高分辨率。
- 没有图标时使用内置默认图标。插件管理列表、设置导航都会显示这个图标。

## 2. plugin.json

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "author": "你的名字",
  "description": "一句话说明这个插件做什么。",
  "entry": "main.js",
  "style": "style.css",
  "defaultEnabled": true,
  "tags": ["示例"],
  "homepage": "https://example.com",
  "license": "MIT",
  "permissions": ["notes.read", "notes.write", "config.read_write", "editor.insert", "ai.tool"],
  "i18n": { "zh": "locales/zh.json", "en": "locales/en.json" },
  "config": [
    { "key": "menuEnabled", "label": "右键菜单项", "kind": "boolean", "default": true }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | `^[a-z0-9][a-z0-9-]{1,63}$` |
| `name` | string | 是 | 显示名称 |
| `version` | string | 是 | 建议语义化版本 |
| `author` | string | 否 | 同 id 时用于判断"是否同一插件" |
| `description` | string | 否 | 设置页展示 |
| `entry` | string | 否 | 入口脚本，相对路径 |
| `style` | string | 否 | 样式文件，相对路径 |
| `defaultEnabled` | boolean | 否 | 默认 `true` |
| `tags` | string[] | 否 | 设置页小圆角标签 |
| `homepage` | string | 否 | 外部浏览器打开 |
| `license` | string | 否 | 仅展示 |
| **`permissions`** | string[] | **否** | **权限声明，见 §3** |
| `i18n` | Record<string, string> | 否 | 插件自己的语言包，语言标识 → 插件目录内的 `.json` 相对路径，见 §5.14 |
| `config` | ConfigField[] | 否 | 配置项 schema，见 §8 |
| `minAppVersion` | string | 否 | 要求的最低软件版本，**安装与激活都会校验**，不满足直接拒绝 |
| `apiVersion` | number | 否 | 插件按哪一版 ctx 契约编写；高于宿主支持版本时安装被拒（当前宿主支持 v1） |
| `netDomains` | string[] | 否 | `ctx.net.fetch` 的主机白名单（主机名或后缀）；空 = 不允许联网 |

`entry` / `style` 必须是相对路径：不能以 `/`、`\` 或盘符开头，不能包含 `..`。

`config` 里的文案同样可以本地化：字段支持 `labelI18n` / `descriptionI18n`，`options` 的元素支持
`labelI18n`（键可写 `"en"` 或 `"en-US"`）。不写就原样显示 `label`——
宿主只能翻译**自己**词典里的词条，插件写的文案必须由插件自己提供译文，否则英文界面下会显示中文。

`i18n` 的每个值额外要求：只能引用 `.json` 文件，不能含反斜杠与 `..`，且文件必须真实存在于插件包内（缺失会在安装时拒绝）。

## 3. 权限声明（permissions）

插件通过 `permissions` 声明需要的能力。未声明的 API 调用会被拒绝并抛错。

### 当前支持的权限

| 权限标识符 | 说明 | 依赖的 API |
|---|---|---|
| `notes.read` | 读取笔记正文（锁定笔记返回空串） | `ctx.notes.getContent` |
| `notes.write` | 创建 / 更新 / 删除笔记（source_plugin 沙箱，见 §6） | `ctx.notes.create` / `update` / `remove` |
| `config.read_write` | 读写插件自身配置 | `ctx.config.values` / `set` |
| `editor.insert` | 编辑器光标处插入文本 | `editor.insertText(text)` |
| `ai.tool` | 注册 AI Agent 工具（只读） | `ctx.ai.tool` |
| `ai.prompt` | 向 AI 注入额外的系统提示词 | `ctx.ai.systemPrompt` |
| `ai.provider` | 注册 AI 服务商预填模板 | `ctx.ai.provider` |
| `ai.settings` | 读写 AI 行为参数（白名单键） | `ctx.ai.getSettings` / `updateSettings` |
| `settings.section` | 在设置窗口添加插件自己的分区 | `ctx.settings.section` |
| `db.read_write` | 创建 / 删除并读写**本插件自己的**数据表 | `ctx.db.*`（表名强制带 `plugin_<目录名>__` 前缀，见 §5.15） |
| `window.open` | 用插件目录里的页面开独立窗口 | `ctx.window.*`（见 §5.16） |
| `shortcut.register` | 注册窗口内快捷键（系统全局热键由宿主独占，见 §5.17） | `ctx.shortcut.*` |
| `fs.read_write` | 读写插件自己的**数据目录**（不是插件目录） | `ctx.fs.*`（见 §5.18） |
| `net.fetch` | 通过宿主代理联网（还要 `netDomains` 白名单） | `ctx.net.fetch`（见 §5.19） |
| `ui.modal` | 宿主统一风格弹窗 | `ctx.ui.modal`（**当前版本无需显式声明，默认开放**） |

### 默认开放（无需声明）

| API | 说明 |
|---|---|
| `ctx.menu.note` | 笔记右键菜单 |
| `ctx.menu.group` | 分组右键菜单 |
| `ctx.command` | 命令面板 |
| `ctx.editor.toolbar` | 编辑器工具栏 |
| `ctx.ui.toast` | Toast |
| `ctx.hooks.*` | 生命周期钩子 |
| `ctx.i18n` | 插件自己的语言包（跟随软件语言，见 §5.14） |
| `ctx.ui.mount` | 往宿主界面的元素里挂 DOM（见 §5.13） |
| `ctx.onDispose` | 清理契约 |

### 安全说明

- 安装时宿主会弹出**权限确认弹窗**，列出插件声明的所有权限，用户确认后才安装。
- 已安装插件可以在设置页「插件管理 → 某插件 → 权限」查看当前生效的权限清单。
- `fastnote-plugin` 协议 handler 只 serve 插件目录内的静态资源（`.js` / `.mjs` / `.html` / `.css` / `.json` / 图片 / 字体）：`..`、绝对路径、反斜杠等路径逃逸尝试一律拒绝；单文件上限 2MB。
- 插件以 ESM 模块运行在应用主窗口 JS 上下文，无沙箱；**仅安装可信来源的插件**。

## 4. 入口脚本与多文件 import

`main.js` 是 ESM 模块，默认导出带 `activate` 的对象：

```js
export default {
  async activate(ctx) {
    // 注册贡献...
  },
};
```

宿主加载流程：后端把插件目录经自定义协议 `fastnote-plugin` serve 成真实 URL
（Windows / Android 为 `http://fastnote-plugin.localhost/<dirName>/<path>`，
macOS / Linux 为 `fastnote-plugin://localhost/<dirName>/<path>`），
前端 `import()` 该 URL → `await default.activate(ctx)`。

### 多文件 import

entry 里可以用相对路径（`./`、`../`）import 插件目录内的其他文件，浏览器原生解析：

```js
// main.js
import { formatBytes } from "./modules/util.js";

export default {
  async activate(ctx) {
    ctx.ui.toast(formatBytes(2048), "info");
  },
};
```

```js
// modules/util.js
export const formatBytes = (n) => `${(n / 1024).toFixed(1)} KB`;
```

规则：

- 只允许 import `.js` / `.mjs` 文件；路径必须落在本插件目录内（`..` 逃出插件目录会被协议 handler 拒绝）。
- 不能 import npm 包或绝对 URL——依赖必须打进插件目录。
- 每次激活 entry URL 会带递增的 `?v=` 参数 bust 缓存，改动 entry 重新激活即生效；子模块在 webview 模块图里按 URL 缓存，改了子模块需重启应用才生效。

`style` 会被注入为 `<style data-plugin-id="<dirName>">`，禁用/卸载时移除。

### 完整 ctx 类型

```ts
interface PluginContext {
  menu: {
    /** 笔记右键菜单（多层 submenu + danger + when） */
    note(item: PluginMenuItem): void;
    /** 分组右键菜单（多层 submenu） */
    group(item: PluginGroupMenuItem): void;
  };
  command(item: PluginCommand): void;
  editor: {
    toolbar(item: PluginEditorToolbarItem): void;
    /** 生成 Markdown 渲染句柄，供 ui.modal({ render }) 用编辑器纯渲染模式展示 */
    render(markdown: string): PluginMarkdownHandle;
  };
  ui: {
    /** Toast 三种类型：success / error / info */
    toast(message: string, type?: ToastType): void;
    /** 宿主统一风格弹窗（模态/非模态/自定义内容/自定义按钮/Markdown 渲染） */
    modal(options: PluginModalOptions): Promise<PluginModalResult>;
    /** 往宿主的某个元素里挂节点；返回移除函数，并自动登记到 onDispose */
    mount(target: string | Element, node: Node): () => void;
  };
  /** 插件私有数据表（需 db.read_write）：表名由宿主加 plugin_<目录名>__ 前缀 */
  db: {
    createTable(table: string, columns: { name: string; kind: "text" | "integer" | "real" }[]): Promise<void>;
    dropTable(table: string): Promise<void>;
    tables(): Promise<string[]>;
    insert(table: string, values: Record<string, unknown>): Promise<number>;
    query(table: string, options?: {
      filter?: Record<string, unknown>; orderBy?: string;
      descending?: boolean; limit?: number; offset?: number;
    }): Promise<Record<string, unknown>[]>;
    update(table: string, filter: Record<string, unknown>, values: Record<string, unknown>): Promise<number>;
    remove(table: string, filter: Record<string, unknown>): Promise<number>;
  };
  /** 插件自己的窗口（需 window.open）：加载插件目录里的 html */
  window: {
    open(relPath: string, options?: { title?: string; width?: number; height?: number }): Promise<string>;
    close(label: string): Promise<void>;
  };
  /** 快捷键（需 shortcut.register）：停用 / 重激活时自动注销；只能注册窗口内快捷键 */
  shortcut: {
    register(
      combo: string,
      handler: () => void,
      options?: { scope?: "app" },
    ): void | (() => void);
    unregister(combo: string): void;
  };
  notes: {
    /** 按笔记 id（UUID 字符串）读正文；锁定的加密笔记返回空串 */
    getContent(id: string): Promise<string>;
    /** 当前编辑器打开的笔记（不含正文）；外部文件 / 临时草稿 / 未选中返回 null */
    getCurrent(): PluginCurrentNote | null;
    /** 创建归属于本插件的笔记（source_plugin = 本插件 dirName），返回新笔记的 UUID */
    create(title: string, content?: string, categoryId?: number | null): Promise<string>;
    /** 更新本插件创建的笔记（只有 source_plugin 匹配允许修改） */
    update(id: string, title?: string, content?: string): Promise<void>;
    /** 软删除本插件创建的笔记（只有 source_plugin 匹配允许删除） */
    remove(id: string): Promise<void>;
  };
  /** 被动订阅笔记生命周期事件；钩子异步非阻塞，handler 抛错只记日志不阻断流程 */
  hooks: {
    onNoteCreate(cb: (payload: { note: Note; isExternal: boolean }) => void | Promise<void>): void;
    onNoteSave(cb: (payload: { noteId: string; content: string; savedAt: string }) => void | Promise<void>): void;
    onNoteDelete(cb: (payload: { noteId: string }) => void | Promise<void>): void;
    onNoteSwitch(cb: (payload: { oldNoteId: string | null; newNoteId: string | null }) => void | Promise<void>): void;
  };
  /** AI 域贡献点：工具 / 系统提示词 / 服务商模板 / 设置读写 */
  ai: {
    /** 注册 AI Agent 工具（只读：只能通过 notes.getContent 读笔记） */
    tool(item: PluginAiTool): void;
    /** 向系统提示词注入一段文本；prepend 在内置提示词之前，append（默认）在最后 */
    systemPrompt(entry: { id: string; text: string; position?: "append" | "prepend" }): void;
    /** 注册服务商预填模板；用户填好 API Key 保存后才落入用户数据库 */
    provider(provider: {
      id: string; name: string; baseUrl: string;
      models?: string[]; apiKeyHint?: string;
    }): void;
    /** 读当前 AI 设置（归一化后的行为参数，不含 API Key / 服务商列表） */
    getSettings(): Promise<Record<string, unknown>>;
    /** 局部更新 AI 设置：只允许白名单键，其余一律拒绝 */
    updateSettings(patch: Record<string, unknown>): Promise<void>;
  };
  /** 在设置窗口添加插件自己的分区（复用 config schema 渲染，值存 config.json） */
  settings: {
    section(section: PluginSettingsSection): void;
  };
  config: {
    /** 激活时已读取好的配置值（schema 默认值 + 用户保存值） */
    values: Record<string, unknown>;
    /** 局部更新配置：写入 config.json 后宿主自动重新激活本插件 */
    set(patch: Record<string, unknown>): Promise<void>;
  };
  /** 插件自己的语言包：跟随软件语言，支持点号嵌套 key 与 {name} 占位插值 */
  i18n: {
    /** 当前软件语言（zh-CN / en-US） */
    locale: string;
    /** 缺 key 或值不是字符串时返回 key 本身 */
    t(key: string, vars?: Record<string, string | number>): string;
    /** key 是否存在且为字符串 */
    has(key: string): boolean;
  };
  /** 禁用/卸载/重激活时 LIFO 执行；登记自己创建的 DOM / 定时器 / 全局变量清理 */
  onDispose(fn: () => void): void;
}

type ToastType = "success" | "error" | "info";
```

## 5. 扩展点 API

### 5.1 笔记右键菜单 `ctx.menu.note`

```js
ctx.menu.note({
  id: "my-plugin.greet",
  label: "打招呼",
  icon: "toast-info",
  danger: false,
  when: (note) => !note.pinned,
  submenu: [
    {
      id: "my-plugin.greet-hello",
      label: "说你好",
      icon: "ai-sparkles",
      onClick: (note, pluginCtx) => {
        pluginCtx.ui.toast(`你好，${note.title || "无标题"}`, "success");
      },
    },
  ],
  onClick: async (note, pluginCtx) => {
    // 有 submenu 的项也可以同时提供 onClick（hover 展开 + click 也执行）
  },
});
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件内唯一，建议 `plugin-id.xxx` 前缀 |
| `label` | string | 是 | 显示文本 |
| `icon` | string | 否 | Icon 组件的图标名（`public/icons/<name>.svg`） |
| `danger` | boolean | 否 | 默认 false；true 时文字红色 |
| `when` | `(note: Note) => boolean` | 否 | 返回 false 时该项不出现在当前笔记的菜单里 |
| `submenu` | PluginMenuItem[] | 否 | 任意深度嵌套；有值时该项 hover 展开 |
| `onClick` | `(note: Note, ctx: PluginContext) => void \| Promise<void>` | 否 | 叶子节点必填；有 submenu 的项可选 |

### 5.2 分组右键菜单 `ctx.menu.group`

与笔记菜单类似，但不绑定 Note 上下文——onClick 只拿到 PluginContext，没有 note 参数。

```js
ctx.menu.group({
  id: "my-plugin.group-root",
  label: "我的插件",
  icon: "ai-sparkles",
  submenu: [
    {
      id: "my-plugin.group-stats",
      label: "显示状态",
      icon: "ai-monitor",
      onClick: (pluginCtx) => {
        pluginCtx.ui.toast("分组菜单被触发", "success");
      },
    },
    {
      id: "my-plugin.group-danger",
      label: "危险项",
      danger: true,
      onClick: (pluginCtx) => {
        pluginCtx.ui.modal({ title: "危险操作", content: "确定吗？", danger: true });
      },
    },
  ],
});
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件内唯一 |
| `label` | string | 是 | 显示文本 |
| `icon` | string | 否 | 图标名 |
| `danger` | boolean | 否 | 默认 false；true 时文字红色 |
| `submenu` | PluginGroupMenuItem[] | 否 | 任意深度嵌套 |
| `onClick` | `(ctx: PluginContext) => void \| Promise<void>` | 是 | 叶子节点必填 |

### 5.3 命令面板 `ctx.command`

```js
ctx.command({
  id: "my-plugin.now",
  label: "报时",
  icon: "toast-info",
  run: (pluginCtx) => pluginCtx.ui.toast(new Date().toLocaleString(), "info"),
});
```

出现在 Ctrl+P 命令面板的「插件演示」分组（分组标题取 manifest.name）。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件内唯一 |
| `label` | string | 是 | 命令显示文本 |
| `icon` | string | 否 | 图标名 |
| `run` | `(ctx: PluginContext) => void \| Promise<void>` | 是 | 执行回调 |

### 5.4 编辑器工具栏 `ctx.editor.toolbar`

```js
ctx.editor.toolbar({
  id: "my-plugin.insert-time",
  title: "插入当前时间",
  icon: "editor-copy",
  when: (editor) => editor.noteId !== null,
  onClick: (editor, ctx) => {
    if (!editor.insertText) {
      ctx.ui.toast("编辑器不支持插入文本", "error");
      return;
    }
    editor.insertText(`\n${new Date().toLocaleString()}\n`);
  },
});
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件内唯一 |
| `title` | string | 是 | 按钮 tooltip |
| `icon` | string | 否 | 图标名；与 `label` 至少填一个 |
| `label` | string | 否 | 纯文字按钮（不填 icon 时显示） |
| `when` | `(ctx: EditorToolbarContext) => boolean` | 否 | 返回 false 时按钮隐藏 |
| `onClick` | `(ctx: EditorToolbarContext, plugin: PluginContext) => void \| Promise<void>` | 是 | 点击回调 |

**EditorToolbarContext 字段**：

| 字段 | 说明 |
|---|---|
| `noteId` | 当前笔记 id（UUID 字符串），无笔记时为 `null` |
| `title` | 当前标题 |
| `content` | 当前正文 |
| `mode` | 当前编辑器模式 |
| `insertText(text)` | 光标处插入文本；只读或未就绪返回 `false` |

### 5.5 Toast `ctx.ui.toast`

```js
ctx.ui.toast("操作完成", "success");   // 绿色 + ✓ 图标
ctx.ui.toast("出错了", "error");       // 红色 + ✕ 图标
ctx.ui.toast("提示", "info");          // 中性（默认）
```

三种 type：`success` / `error` / `info`。默认 3 秒消失，并行堆叠。

### 5.6 Modal `ctx.ui.modal`（宿主统一风格）

**完整参数**（`content` 回调可以返回 React 节点，也可以返回**原生 DOM 节点**——插件自己
`createElement` 拼的弹窗由宿主挂进内容区容器；React 不认把原生节点当 child，宿主替你挂）：

```ts
// 插件自绘弹窗的最小写法：宿主只给空壳（标题 / 宽度 / 按钮），长什么样归插件
await ctx.ui.modal({
  title: "我的弹窗",
  size: "2xl",
  buttons: [{ label: "关闭" }],
  content: () => {
    const root = document.createElement("div");
    root.className = "my-plugin-dialog";   // 样式写在插件的 style.css 里
    root.textContent = "…";
    return root;
  },
});
```


```ts
interface PluginModalOptions {
  title?: string;
  /** 纯文本消息，或接收 PluginModalApi 的自定义 DOM 渲染回调 */
  content?: string | ((api: PluginModalApi) => React.ReactNode);
  /** modal（阻塞，默认）| non-modal（浮层，可点外部关闭） */
  mode?: "modal" | "non-modal";
  /** 确认按钮文案，默认宿主 i18n「确定」 */
  confirmText?: string;
  /** 取消按钮文案，默认宿主 i18n「取消」 */
  cancelText?: string;
  /** 危险操作：确认按钮 / 自定义按钮红色样式 */
  danger?: boolean;
  /** 是否显示遮罩。modal 默认 true，non-modal 默认 false */
  showOverlay?: boolean;
  /** 非模态时点击遮罩 / 弹窗外部是否自动关闭（ok=false）；默认 true */
  closeOnExternalClick?: boolean;
  /** 自定义按钮数组；传了就替代 confirm/cancel 双按钮 */
  buttons?: PluginModalButton[];
  /** 宽度档位 "lg" | "xl" | "2xl"；render 模式默认 "2xl"，其余默认 "lg" */
  size?: "lg" | "xl" | "2xl";
  /** 固定高度（px 或 CSS 长度）；render 模式默认 "min(78vh, 760px)"，内容区变为滚动容器 */
  height?: number | string;
}

interface PluginModalButton {
  label: string;
  danger?: boolean;
  /** 返回 false 阻止关闭，其他值正常结算（ok=true） */
  onClick?: () => boolean | void;
}

interface PluginModalApi {
  /** 确认，resolve({ok: true, value}) */
  ok(value?: unknown): void;
  /** 取消，resolve({ok: false}) */
  cancel(): void;
  /** 传入 ok/value 主动关闭；ok=false 等价于 cancel() */
  close(result?: unknown): void;
}

interface PluginModalResult {
  ok: boolean;
  value?: unknown;
}
```

#### 用法 1：基础确认框（content 字符串）

```js
const result = await ctx.ui.modal({
  title: "删除",
  content: "确定要删除吗？",
  confirmText: "删除",
  cancelText: "取消",
  danger: true,
});
if (result.ok) { /* 用户点了确认 */ }
```

#### 用法 2：非模态浮层（mode: "non-modal"）

```js
ctx.ui.modal({
  title: "临时提示",
  content: "点窗外或关闭按钮都会以 ok=false 结算。",
  mode: "non-modal",
});
```

#### 用法 3：编辑器纯渲染展示 Markdown（嵌套调用）

```js
const note = ctx.notes.getCurrent();
if (!note) {
  ctx.ui.toast("当前没有打开任何笔记");
  return;
}
const content = await ctx.notes.getContent(note.id);
await ctx.ui.modal({
  title: note.title,
  render: ctx.editor.render(content), // 也可直接传 Markdown 字符串
  buttons: [{ label: "关闭" }],
});
```

`render` 走编辑器同一套解析与排版（`MarkdownPreview`），只读、不可编辑，样式跟随当前主题。render 模式默认使用与「历史版本对比」相同的宽弹窗（2xl + 固定高度，正文区滚动），可用 `size` / `height` 覆盖。

#### 用法 4：自定义 DOM + PluginModalApi

```js
ctx.ui.modal({
  title: "输入你的名字",
  content: (api) => {
    const wrap = document.createElement("div");
    wrap.innerHTML = '<input id="myname" placeholder="你的名字" />';
    const input = wrap.querySelector("#myname");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") api.ok(input.value.trim() || "匿名");
      else if (e.key === "Escape") api.cancel();
    });
    return wrap;
  },
});
```

#### 用法 4：自定义按钮（buttons 数组）

```js
ctx.ui.modal({
  title: "选择颜色",
  content: "三个按钮，演示 danger 样式。",
  buttons: [
    { label: "红色（danger）", danger: true, onClick: () => true },
    { label: "黄色", danger: false, onClick: () => true },
    { label: "蓝色", danger: false, onClick: () => true },
  ],
});
```

### 5.7 写笔记 API（source_plugin 沙箱）

必须声明 `notes.write` 权限。插件只能操作自己创建的笔记——宿主自动写入并校验 `source_plugin = 本插件 dirName`。

```js
// 创建：宿主自动把 source_plugin 设为本插件的 dirName
const noteId = await ctx.notes.create("我的笔记", "正文内容", null);

// 读（任何笔记都能读，不受 source_plugin 限制）
const content = await ctx.notes.getContent(noteId);

// 更新：只有 source_plugin 等于自己的笔记允许修改
await ctx.notes.update(noteId, undefined, "新的正文");
await ctx.notes.update(noteId, "新标题", undefined);

// 删除：只有 source_plugin 等于自己的笔记允许删除（软删除，进回收站）
await ctx.notes.remove(noteId);
```

**安全模型**：宿主在每个 RPC 命令里校验 `source_plugin = dirName`，插件无法绕过。

### 5.8 生命周期钩子 `ctx.hooks.*`

被动订阅笔记事件。钩子是异步非阻塞的——单个 handler 抛错 catch 掉不影响其他 handler，也不阻塞笔记操作流程。

```js
// 笔记被创建（手动新建 / 外部导入）
ctx.hooks.onNoteCreate((payload) => {
  console.log(`笔记 "${payload.note.title}" 创建了${payload.isExternal ? "（外部）" : ""}`);
});

// 笔记被保存（宿主节流后触发，不一定每次打字都触发）
ctx.hooks.onNoteSave((payload) => {
  console.log(`笔记 id=${payload.noteId} 已保存，内容长度 ${payload.content.length}`);
});

// 笔记被删除
ctx.hooks.onNoteDelete((payload) => {
  console.log(`笔记 id=${payload.noteId} 被删了`);
});

// 切换当前编辑的笔记
ctx.hooks.onNoteSwitch((payload) => {
  console.log(`切换：${payload.oldNoteId ?? "空"} → ${payload.newNoteId ?? "空"}`);
});
```

**Payload 类型**：

| 钩子 | Payload |
|---|---|
| `onNoteCreate` | `{ note: Note, isExternal: boolean }` |
| `onNoteSave` | `{ noteId: string, content: string, savedAt: string }` |
| `onNoteDelete` | `{ noteId: string }` |
| `onNoteSwitch` | `{ oldNoteId: string \| null, newNoteId: string \| null }` |

### 5.9 AI Tool `ctx.ai.tool`

注册 AI Agent 工具。**只读能力**——handler 里只有 `notes.getContent` 权限，不能写笔记。必须声明 `ai.tool` 权限。

```js
ctx.ai.tool({
  id: "my-plugin.count-chars",
  desc: "统计指定笔记的字数和词数",
  args: { noteId: "笔记 ID（UUID 字符串）" },
  handler: async (args, toolCtx) => {
    const noteId = String(args.noteId ?? "").trim();
    if (!noteId) return { error: "noteId 必须是非空字符串" };
    const content = await toolCtx.notes.getContent(noteId);
    const chars = content.length;
    const words = content.trim() ? content.trim().split(/\s+/).filter(Boolean).length : 0;
    return { noteId, chars, words };
  },
});
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 插件内唯一 |
| `desc` | string | 是 | 给 AI 模型看的一句话说明 |
| `description` | string | 否 | 给模型看的完整功能描述；缺省时用 `desc` |
| `label` | string | 否 | UI 显示名；缺省时用 `id` |
| `args` | `Record<string, string>` | 否 | 入参说明 `{ 参数名: 描述 }`，会注入模型侧工具定义 |
| `handler` | `(args: Record<string, unknown>, toolCtx: PluginAiToolContext) => Promise<unknown>` | 是 | 执行器；toolCtx 只有只读的 notes.getContent |

工具的 `id` / `description` / `args` 会合并进发给模型的工具清单（与内置工具并列），模型按这些文本决定何时调用、传什么参数——写清楚能显著提高命中率。

### 5.10 AI 扩展（提示词 / 服务商 / 设置）

#### 系统提示词 `ctx.ai.systemPrompt`（需 `ai.prompt`）

```js
ctx.ai.systemPrompt({
  id: "my-plugin.style-hint",
  text: "回答时优先使用简体中文，并引用笔记标题。",
  position: "append", // 默认 append；prepend 放在内置提示词之前
});
```

拼装顺序：**prepend 贡献 → 内置系统提示词 → append 贡献**。插件禁用 / 卸载后注入立即消失。

#### 服务商模板 `ctx.ai.provider`（需 `ai.provider`）

```js
ctx.ai.provider({
  id: "demo-openai",
  name: "演示 · OpenAI 兼容",
  baseUrl: "https://api.openai.com/v1",
  models: ["gpt-4o-mini", "gpt-4o"],
  apiKeyHint: "在 https://platform.openai.com/api-keys 创建",
});
```

只作为设置页「新建服务商」的预填模板展示（标记为「插件 · xx」）：**不落库、不做运行时依赖**；用户选中模板、填好 API Key 点保存时才写入用户自己的 `ai_providers` 表，此后与插件无关（插件卸载不影响已保存的服务商）。

#### AI 设置读写 `ctx.ai.getSettings` / `updateSettings`（需 `ai.settings`）

```js
const s = await ctx.ai.getSettings();          // 归一化后的行为参数（不含 API Key / 服务商列表）
await ctx.ai.updateSettings({ maxRounds: 6 }); // 局部更新；与设置页改动走同一条生效路径并落库
```

`updateSettings` 只接受白名单键，其余一律抛错；键与类型都会校验：

`minThinkingLen` / `maxRounds` / `contextBudget` / `keepRecent` / `toolResultChars` / `retryShallowThinking` / `autoTitle` / `streaming` / `confirmByDefault` / `showToolTrace` / `maxTokens` / `composerHeight`

> 刻意排除：API Key、服务商列表（不在 AiSettings 里）与 AI 访问档位（管数据可见性，不放给插件）。

### 5.11 设置分区 `ctx.settings.section`（需 `settings.section`）

> **字段可以只写 `key`**：`kind` / `default` / `options` / `min` / `max` / `step` 由宿主从
> `manifest.config` 继承（唯一事实源），这里只覆盖文案即可。这样就不会出现「分区里写的 kind
> 与清单不一致 → 后端按 schema 过滤后写入被静默丢弃」这种坑。

在设置窗口左侧目录的「插件」分组下添加一个插件自己的分区。**不写 UI 代码**：`groups` / `fields` 与 plugin.json 的 `config` schema 同构（见 §7），宿主通用渲染器复用设置控件（Switch / 数值 / 下拉 / 文本）渲染。

```ts
interface PluginSettingsGroup {
  id: string;          // 分区内唯一
  title: string;
  description?: string;
  fields: PluginConfigField[];
}

interface PluginSettingsSection {
  id: string;          // 插件内唯一
  title: string;       // 侧栏显示名
  icon?: string;       // Icon 图标名，缺省 toolbox
  groups?: PluginSettingsGroup[];   // 可选：字段分类，按顺序渲染
  fields?: PluginConfigField[];     // 不分类的字段（渲染在分组之后）
  auto?: boolean;      // 宿主内部标记，插件不要设置
}
```

组合示例（分类 + 多分区二级导航）：

```js
ctx.settings.section({
  id: "main",
  title: "我的插件",
  icon: "toolbox",
  groups: [
    {
      id: "general",
      title: "通用",
      description: "基础开关。",
      fields: [
        { key: "enabled", label: "启用", kind: "boolean", default: true },
        { key: "level", label: "等级", kind: "number", default: 3, min: 1, max: 10 },
      ],
    },
    {
      id: "style",
      title: "样式",
      fields: [{ key: "theme", label: "主题", kind: "select", default: "none",
        options: [{ value: "none", label: "不修改" }] }],
    },
  ],
  fields: [
    { key: "greeting", label: "问候语", kind: "string", default: "你好！" },
  ],
});

// 同一插件再注册第二个分区：设置导航会以插件名为父级形成二级菜单
ctx.settings.section({
  id: "advanced",
  title: "我的插件 · 高级",
  icon: "ai-settings",
  fields: [{ key: "demoBool", label: "演示开关", kind: "boolean", default: true }],
});
```

- **唯一入口**：插件配置唯一的 UI 就是设置分区；插件管理页每行的「配置」按钮直接跳转到对应分区（没有单独的配置弹窗）。
- **导航分组**：同一插件注册多个分区时，设置导航以插件名（manifest.name）为父级、各分区为二级菜单；只有 1 个分区时直接平铺一行，不显示父级。
- **图标回落**：`icon` 填内置图标名（如 `toolbox`）；不填时导航使用插件图标（见 §1「插件图标」），插件也没有图标时使用内置默认图标。
- **非空约束**：分区必须至少包含一个配置项（`groups` 里任一组的 `fields` 非空，或顶层 `fields` 非空），否则注册直接抛错「设置分区必须包含至少一个配置项」。
- **字段去重**：同一分区内相同 `key` 只渲染一次（按出现顺序，先 `groups` 后顶层 `fields`）；空组整组跳过。
- **自动分区**：manifest 声明了 `config` 但插件没有主动贡献分区时，宿主自动生成一个 `id: "config"` 的分区；插件一旦主动调用 `ctx.settings.section`，就不会再自动生成。因此建议插件用自己的分区覆盖全部 config 键，否则未覆盖的配置项只能靠自动分区。
- **持久化**：值存到插件自己的 `config.json`，改一项立即写盘（即时生效，没有保存按钮）。
- **schema 约束**：后端读写 `config.json` 都按 plugin.json 的 `config` schema 过滤，所以分区里每个 field 的 `key` 都必须在 plugin.json 的 `config` 里声明，且 `kind` / `default` / `options` / `min` / `max` / `step` 应与 manifest 完全一致——不一致的值会被过滤丢弃。
- 分区里改配置**不会**触发插件重激活；需要"改完重激活"语义的项用 `ctx.config.set`（写入后宿主自动重新激活本插件）。
- 插件禁用 / 卸载后分区立即从目录消失。

### 5.12 清理契约 `ctx.onDispose`

禁用 / 卸载 / 重激活时宿主按 LIFO 执行登记的清理函数。

```js
// 插件自己创建的 DOM 必须登记清理
const badge = document.createElement("div");
document.body.appendChild(badge);
ctx.onDispose(() => badge.remove());

// 定时器也一样
const timer = setInterval(() => doStuff(), 1000);
ctx.onDispose(() => clearInterval(timer));
```

宿主自动清理菜单、命令、工具栏、样式标签、钩子订阅、AI 工具 / 提示词 / 服务商模板 / 设置分区注册；**只有插件直接操作 DOM / 定时器 / 全局变量才需要用 onDispose 登记**。

### 5.13 直接操作 DOM

插件运行在主页面 JS 上下文，可自由创建 DOM。

推荐用 `ctx.ui.mount` 而不是自己 `appendChild`：它会登记到清理契约，插件停用 / 卸载时自动摘掉。

```js
const badge = document.createElement("span");
badge.className = "my-badge";
badge.textContent = "★";
// 挂到宿主侧栏头部；第二个参数是任何 Node（元素、文本、片段都行）
const remove = ctx.ui.mount(".sidebar-shell", badge);
// remove() 可以提前摘；不调用也会在停用时被宿主摘掉
```

**编辑器失焦配置项**（宿主约定）：`keepFocusOnHostClick` 默认 true，宿主 UI 元素点击时不主动抢焦点；如果插件自造了复杂的交互 UI 并且需要主动让编辑器失焦，可以在设置里关掉。

### 5.14 插件 i18n `ctx.i18n`

插件可以自带语言包，跟随软件的界面语言设置。

**文件结构**：`plugin.json` 的 `i18n` 声明语言标识到 `.json` 相对路径的映射：

完整样例（plugin.json 片段 + main.js 片段 + locales/zh.json 片段）：

```json
// plugin.json
{
  "id": "my-plugin",
  "name": "我的插件",
  "version": "1.0.0",
  "entry": "main.js",
  "permissions": ["config.read_write", "settings.section"],
  "i18n": { "zh": "locales/zh.json", "en": "locales/en.json" },
  "config": [
    { "key": "greeting", "label": "问候语", "kind": "string", "default": "你好！" },
    { "key": "enabled", "label": "启用", "kind": "boolean", "default": true }
  ]
}
```

```js
// main.js：命令 + 设置分区都用 ctx.i18n；分区字段覆盖全部 config 键
export default {
  activate(ctx) {
    const t = (key, vars) => ctx.i18n.t(key, vars);

    ctx.command({
      id: "my-plugin.hello",
      label: t("command.hello"),
      run: (c) => c.ui.toast(t("toast.greeting", { name: "FastNote" }), "success"),
    });

    ctx.settings.section({
      id: "main",
      title: t("settings.sectionTitle"),
      fields: [
        { key: "greeting", label: t("settings.fields.greeting"), kind: "string", default: "你好！" },
        { key: "enabled", label: t("settings.fields.enabled"), kind: "boolean", default: true },
      ],
    });
  },
};
```

```json
// locales/zh.json（支持嵌套对象，用点号取值；en.json 必须有完全一致的 key）
{
  "command": { "hello": "打个招呼" },
  "toast": { "greeting": "你好，{name}！" },
  "settings": {
    "sectionTitle": "我的插件",
    "fields": {
      "greeting": "问候语",
      "enabled": "启用"
    }
  }
}
```

| 成员 | 类型 | 说明 |
|---|---|---|
| `locale` | string | 当前软件语言（`zh-CN` / `en-US`） |
| `t(key, vars?)` | string | 点号嵌套取值并做 `{name}` 占位插值；缺 key 或值不是字符串时返回 key 本身 |
| `has(key)` | boolean | key 是否存在且为字符串 |

**加载与回退**：激活时按「当前语言 → `zh` → `en` → `i18n` 里的第一个」顺序读取，都失败则使用空对象；读取或 JSON 解析失败只记日志，不会让插件激活失败。

**语言切换**：软件语言变化时宿主会**重新激活所有已启用插件**（先执行 `onDispose`、清贡献，再重新 `activate`），插件无需自己监听；连续切换会做 100ms 防抖，只重激活一次。语言包路径只允许 `.json`，且必须真实存在于插件包内。

### 5.15 插件私有表 `ctx.db`（需 `db.read_write`）

插件可以有自己的数据表，但**只能碰自己那一份**：表名由宿主强制加前缀
`plugin_<目录名>__`（目录名里的 `-` 换成 `_`），插件侧只写裸名。

- 宿主的表（`notes` / `tags` / `app_settings` …）没有这个前缀，够不到；
- 其它插件的表前缀不同，也够不到；
- 只提供结构化操作（建表 / 删表 / 增删改查），不接受任意 SQL 字符串；值全部参数绑定，
  表名与列名按 `[A-Za-z_][A-Za-z0-9_]*` 校验后再拼接。

```js
// 建表是幂等的（CREATE TABLE IF NOT EXISTS），可以每次激活都调
await ctx.db.createTable("visits", [
  { name: "note_id", kind: "text" },
  { name: "visits", kind: "integer" },
]);

const id = await ctx.db.insert("visits", { note_id: "…", visits: 1 });
await ctx.db.update("visits", { id }, { visits: 2 });
const rows = await ctx.db.query("visits", { filter: { note_id: "…" }, limit: 5 });
await ctx.db.remove("visits", { id });
await ctx.db.dropTable("visits");
console.log(await ctx.db.tables()); // ["visits"]
```

约定与边界：

| 项 | 规则 |
|---|---|
| 建表 | 宿主自动补 `id INTEGER PRIMARY KEY AUTOINCREMENT` 与 `created_at TEXT`；`id` / `created_at` 是保留列名 |
| 列类型 | `text` / `integer` / `real`（大小写不敏感） |
| 过滤 | 只支持等值过滤（AND 连接）；`update` / `remove` **必须带 filter**，不支持无条件整表操作 |
| 查询 | 默认按 `id` 倒序、最多 200 行（上限 1000），可传 `orderBy` / `descending` / `limit` / `offset` |
| 迁移 | `addColumn`（幂等加列）/ `createIndex`（幂等建索引，索引名自动带插件前缀） |
| 统计 | `count(table, filter?)` 直接返回行数，不必把数据拉回前端 |
| 卸载 | 表**不会**随插件卸载自动删除。设置页卸载插件时，宿主会先列出该插件的表并问一句「删除数据表 / 保留」：删除会调 `plugin_db_drop_all` 清空前缀下的所有表，保留则只删插件目录 |

### 5.16 插件自己的窗口 `ctx.window`（需 `window.open`）

用插件目录里的一个页面开独立窗口。窗口是**宿主外壳 + 插件页面**：

```
┌─ 插件窗口（应用源：能调宿主命令） ───────────────┐
│  标题栏（插件给的 title）              [ ✕ 关闭 ] │
├──────────────────────────────────────────────┤
│  iframe：fastnote-plugin://<目录名>/window.html │
│  （插件自己的 HTML / CSS / JS，拿不到 IPC）      │
└──────────────────────────────────────────────┘
```

```js
// 打开 <插件目录>/window.html，返回窗口标签
const label = await ctx.window.open("window.html", {
  title: "我的面板",
  width: 640,
  height: 480,
});
await ctx.window.close(label); // 也可以让用户在标题栏 / 页面里关
```

- 插件页面放在外壳的 iframe 里，同目录的相对路径（`style.css`、`app.js`）直接可用；
- 允许的静态资源：`.js` / `.mjs` / `.html` / `.css` / `.json` / `.svg` / `.png` / `.webp` / `.jpg` / `.gif` / `.woff(2)` / `.ttf`；
- 插件停用 / 卸载时，宿主会把这个插件打开的所有窗口关掉。

演示插件的窗口（`window.html`）是一个「速记」小工具：写文本 → 存进自己的 `drafts` 表 →
列表里回载 / 删除，底部显示当前快捷键与打开次数。整套数据都在插件自己的表里，宿主不参与。

#### 页面里怎么用宿主能力（窗口桥）

插件页面不在应用源，**没有** `ctx`，也没有 `__TAURI_INTERNALS__`。需要在页面里读写自己的表、
关窗口时，用 `postMessage` 找外壳代理：

```js
// 页面侧：发一个请求，等外壳回调
const callHost = (op, payload) =>
  new Promise((resolve, reject) => {
    const id = `c${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
    const onMessage = (event) => {
      const data = event.data;
      if (!data || data.__fastnoteReply !== id) return;
      window.removeEventListener("message", onMessage);
      data.error ? reject(new Error(data.error)) : resolve(data.result);
    };
    window.addEventListener("message", onMessage);
    parent.postMessage({ __fastnoteCall: id, op, payload }, "*");
  });

await callHost("db.query", { table: "prefs", filter: { key: "shortcut" }, limit: 1 });
await callHost("plugin.reactivate");
await callHost("window.close");
```

外壳只代理**本次窗口对应的那个插件**（`dir` 来自宿主，页面改不了），并且会校验
`event.origin` 必须是该插件页面的源。可用 `op`：

| op | 作用 | payload |
|---|---|---|
| `db.tables` / `db.createTable` / `db.dropTable` | 同 `ctx.db` | `{ table, columns }` |
| `db.query` / `db.insert` / `db.update` / `db.remove` | 同 `ctx.db` | 同 `ctx.db` 对应参数 |
| `plugin.reactivate` | 请求宿主重新激活本插件（改完数据让注册类副作用生效） | — |
| `window.close` | 关掉当前插件窗口 | — |

> 桥只做"代理"：真正的权限校验仍按插件的 `permissions`（`db.read_write` 等）在 Rust 侧执行。

### 5.17 快捷键 `ctx.shortcut`（需 `shortcut.register`）

```js
// 窗口内快捷键：软件在前台、窗口有焦点时触发（插件唯一可用的作用域）
ctx.shortcut.register("Ctrl+Alt+P", () => {
  ctx.ui.toast("按下了一次 Ctrl+Alt+P");
});

// 系统全局热键由宿主独占，插件声明它会被直接拒绝：
ctx.shortcut.register("Ctrl+Alt+Q", () => {}, { scope: "global" }); // ← 抛错
```

- 写法 `"Ctrl+Shift+K"`，修饰键支持 `Ctrl` / `Shift` / `Alt` / `Meta`（`Cmd` / `Win` 也认），不分大小写；
- **插件只能注册窗口内快捷键**（`scope` 固定 `"app"`，软件窗口有焦点时才触发，走窗口 keydown 分发）。
  系统全局热键是进程级、系统级资源，由宿主独占（`app.*` 那几个动作）：
  两个插件抢同一个组合键时用户在别处完全看不到"是谁占的"，而且全局键注册成功后再靠宿主及时注销，
  漏一次就是幽灵热键。传 `{"scope":"global"}` 会**直接抛错**，不静默降级——否则插件作者会以为
  注册成功，等软件最小化时才发现按不出来；
- 与宿主键位（按「设置 → 快捷键」里**当前生效值**比较，不是写死的默认值）、其它插件键位
  冲突时**直接抛错**，不静默覆盖；
- 停用 / 卸载 / 重激活时宿主自动注销，不需要手动 remove；`register` 返回的 disposer 也会在
  重激活时统一执行。

**让组合键可改**的推荐做法：键位本身放 `manifest.config`（`kind: "shortcut"`，用户在设置 → 插件里改，
宿主写配置后会自动重新激活，旧键由宿主注销、新键立即生效），再把**生效值**记进插件私有表
（§5.15）备查；要换键的 UI 也可以由插件自己提供（改完写表再调 `plugin.reactivate`）。
演示插件的 `shortcutCombo`（键位）配置项 + `modules/prefs.js` 就是这套：
默认按 `Ctrl+Alt+P` 在软件前台时打开速记窗口，表里能看到当前键位与打开次数。

### 5.18 插件文件存储 `ctx.fs`（需 `fs.read_write`）

数据目录：`<数据目录>/plugin-data/<插件目录名>/`。**不要往插件目录写文件**——升级会整目录覆盖。

```js
await ctx.fs.write("notes/today.md", "# 今天\n…");   // 自动建父目录，返回字节数
const text = await ctx.fs.read("notes/today.md");
const list = await ctx.fs.list("notes");               // [{ name, isDir, size }]
await ctx.fs.remove("notes/today.md");
const dir = await ctx.fs.root();                       // 绝对路径，展示用
```

- 只接受相对路径；`..`、绝对路径、反斜杠一律拒绝，最终路径必须仍在数据目录内；
- 单文件读写上限 4MB；`.exe/.dll/.bat/.ps1/...` 等可执行扩展名不允许写入；
- 目前是**文本**接口（UTF-8），二进制资源请用插件目录里的静态文件。

### 5.19 联网 `ctx.net`（需 `net.fetch`）

前端的 CSP 没放宽 `connect-src`，插件自己也 `fetch` 不到外网；要联网只能走宿主代理，
并在 `plugin.json` 里声明白名单：

```json
{ "permissions": ["net.fetch"], "netDomains": ["api.example.com", "cdn.example.com"] }
```

```js
const { status, body, truncated } = await ctx.net.fetch("https://api.example.com/v1/ping");
await ctx.net.fetch("https://api.example.com/v1/echo", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hello: 1 }),
});
```

- 只支持 `GET` / `POST`，超时 15s，响应体上限 1MB（超出截断并置 `truncated`）；
- 白名单按主机名或后缀匹配（`example.com` 也放行 `api.example.com`），空数组 = 完全禁止；
- 走 Rust 的 reqwest，不经过页面，所以插件里没有 Cookie / CORS 的麻烦事。

### 5.20 插件间消息 `ctx.bus`

```js
const off = ctx.bus.on("myplugin.refresh", (payload, from) => {
  console.log("来自", from, payload);
});
ctx.bus.emit("myplugin.refresh", { reason: "manual" });
```

- 只在插件之间转发，异步派发（`queueMicrotask`），单个 handler 抛错不影响其它订阅者；
- 订阅自动登记到清理契约：停用 / 卸载 / 重激活时宿主退订，插件不用手动 `off()`；
- topic 不做命名空间强制，但**建议加插件前缀**，回调第二个参数是发送方 `dirName`。

### 5.21 沙箱运行时（`"runtime": "sandbox"`）

默认插件跑在主页面里（`inpage`），能力全开但没有安全边界：它能碰宿主 DOM、读宿主 localStorage，
甚至绕开 `ctx` 直接 `invoke`。想让插件「只能通过接口申请能力」，在 `plugin.json` 里声明：

```json
{ "runtime": "sandbox" }
```

宿主会把 `main.js` 放进一个**独立源**的隐藏 iframe
（`fastnote-plugin://<目录名>/__runtime.html`，宿主内置、插件覆盖不了）：

```
┌─ 主页面（应用源，能 invoke） ─────────────────────┐
│  ctx / registry / 权限守卫                        │
│        ▲ postMessage(origin + source 校验)       │
│        │                                          │
│  ┌─ 隐藏 iframe（插件源）──────────────┐          │
│  │  插件的 main.js：没有 IPC、        │          │
│  │  没有父页面 DOM、没有宿主存储      │          │
│  └────────────────────────────────────┘          │
└───────────────────────────────────────────────────┘
```

**第一步已开放**（都走 RPC，返回 Promise）：

| 能力 | 说明 |
|---|---|
| `ctx.config.values` / `set` | 配置读写（写盘后宿主照常重激活） |
| `ctx.db.*` | 私有表全套（含 count / addColumn / createIndex） |
| `ctx.fs.*` | 插件数据目录 |
| `ctx.net.fetch` | 宿主代理 + `netDomains` 白名单 |
| `ctx.notes.*` | 笔记读写（`source_plugin` 沙箱规则不变） |
| `ctx.editor.insertText` | 光标处插入 |
| `ctx.ui.toast` | 提示 |
| `ctx.shortcut.*` | 快捷键（宿主触发后回推事件给沙箱） |
| `ctx.window.*` | 插件窗口（窗口仍是「外壳 + iframe」） |
| `ctx.i18n` / `ctx.onDispose` | 语言包与清理（在沙箱内本地实现） |

**UI 贡献也已开放**（第二步完成），机制是「函数换成 id、宿主反向调用」：

| 贡献点 | 沙箱里的写法 | 宿主侧怎么调 |
|---|---|---|
| `ctx.menu.note` / `.group` | 照旧传 spec，`onClick`/`when` 由运行时处理 | `onClick(note)` 回推，`when` 只认声明式 |
| `ctx.command` | `run: (c) => …` | 点命令时回推，`c` 是插件自己的 ctx |
| `ctx.editor.toolbar` | `onClick: (editor, c) => …` | 第一个参数是编辑器上下文（content/title），`c` 是 ctx |
| `ctx.hooks.*` | `ctx.hooks.onNoteSave(fn)` | 事件发生时回推 payload |
| `ctx.ai.tool` / `.provider` / `.systemPrompt` / `getSettings` | 照旧 | `execute(args)` 回推，可 await |
| `ctx.settings.section` | 照旧（纯数据） | 直接注册 |
| `ctx.ui.modal` | `content`/`html` 传**HTML 字符串** | 宿主消毒后插入；按钮由宿主收尾 |
| `ctx.ui.mount` | `mount("body", nodeOrHtml)` | 宿主消毒后代插，返回移除函数 |
| `ctx.ui.setBodyClass` / `setHtmlClass` | `setBodyClass("my-theme", true)` | 宿主代改 `<body>` / `<html>` 的 class，停用自动移除 |
| `ctx.bus` | `on` / `emit` | 宿主转发，回调带 `from` |

两条硬约束：

- **`when` 不能用函数**（跨 iframe 无法同步求值），改成声明式：
  `when: { field: "is_locked", is: "falsy" }`，`is` 支持 `truthy` / `falsy` / `equals` / `notEquals`；
- 插件传的 HTML 会被**消毒**（标签/属性白名单、禁 `on*` 与 `javascript:`），复杂结构请用 `div/span/table`。

演示插件（`plugin-demo`）已经切到 `runtime: "sandbox"`，可以作为迁移参照。

配套：

- **`plugin-template/plugin-api.d.ts`**：`FastNoteContext` 全量类型（含 `PluginNoteSummary`、
  声明式 `PluginWhen`、沙箱里所有返回 Promise 的注册方法）。**真源在模板里**，随模板整目录分发；
  仓库根目录的同名文件只是 `export *` 转发，方便老链接。补全不是「有文件就自动有」——还需要
  同目录的 `jsconfig.json`（`checkJs` + `**/*.js`）与 `main.js` 里那行
  `@param {import("./plugin-api").FastNoteContext} ctx`，三者缺一个 ctx 就退化成 `any`；
- **`plugin-template/`**：最小可跑模板——`runtime: "sandbox"`、双语语言包、私有表、右键菜单、
  快捷键（含撞键报错的 try/catch）、生命周期钩子 + 数据目录写入、`ui.mount` 角标、HTML 弹窗。
  整个目录拷进 `plugin/` 就能用，也是「沙箱插件该怎么写」的参照实现：
  注册类调用全都 `await`（沙箱是异步 RPC，不 await 只会得到一条 unhandled rejection）。

**沙箱里改不了宿主页面的 `document`**：主题、隐藏统计这类效果用 `ctx.ui.setBodyClass` /
`setHtmlClass`；要插节点用 `ctx.ui.mount`（宿主代插 + 消毒）。这是隔离的代价，也是唯一正确的姿势。


沙箱插件的生命周期：`activate` 在 iframe 里执行完会回一个 ready；停用 / 重激活 / 卸载时宿主直接
销毁 iframe（定时器、监听、DOM 一起没），宿主侧注册的快捷键 / 窗口 / 样式照旧走 disposers。

**最小可跑示例**（两文件，放进 `plugin/` 下任意目录即可）：

```json
// plugin.json
{
  "id": "sandbox-sample",
  "name": "沙箱示例",
  "version": "1.0.0",
  "entry": "main.js",
  "runtime": "sandbox",
  "permissions": ["db.read_write"],
  "config": [{ "key": "greeting", "label": "问候语", "kind": "string", "default": "hi" }]
}
```

```js
// main.js
export default {
  async activate(ctx) {
    await ctx.db.createTable("runs", [{ name: "at", kind: "text" }]);
    await ctx.db.insert("runs", { at: new Date().toISOString() });
    const count = await ctx.db.count("runs");
    ctx.ui.toast(`${ctx.config.values.greeting} · 第 ${count} 次运行（沙箱）`);
  },
};
```

它会证明三件事：`ctx` 能用、能力全走 RPC、插件里 `window.__TAURI_INTERNALS__ === undefined`。

## 6. 生命周期

| 事件 | 说明 |
|---|---|
| 启动 | 扫描 `plugin/`，加载所有已启用插件 |
| 安装 | 设置页点「安装插件（zip）」→ 弹权限确认 → 落盘 → 激活 |
| 刷新 | 手动拷入文件夹后点「刷新」重新扫描 |
| 启用/禁用 | 即时生效：停用先执行 disposers（LIFO）+ 清贡献 + 移除样式；启用读配置 + 激活 |
| 卸载 | 删除 `plugin/<dirName>/` 整个目录 |
| 重激活 | `ctx.config.set(patch)` 写盘后自动触发（只重激活自己，不影响其他插件）；软件语言变化时自动重激活全部已启用插件 |

### 目录规则与安装决策

插件装在 `<软件安装目录>/plugin/`，一个插件一个子文件夹。

- `id`（来自 plugin.json）可以重复；`dirName`（磁盘目录名）在安装目录内唯一。
- 启用/卸载/读资源全部以 `dirName` 为准。

| 情况 | 结果 |
|---|---|
| 无同 id | 目录名 = `id` |
| 同 id 且同 author | 覆盖原目录（升级/降级） |
| 同 id 但 author 不同 | 目录名 = `<id>-<6位随机字符>` |

不比较版本号大小，装什么版本就生效什么版本。

## 7. 插件配置（`config`）

### schema 字段

```json
{
  "config": [
    { "key": "greeting", "label": "问候语", "kind": "string", "default": "你好！" },
    { "key": "theme", "label": "主题", "kind": "select", "default": "none",
      "options": [ { "value": "none", "label": "不修改" }, { "value": "accent", "label": "强调色" } ] },
    { "key": "delay", "label": "延迟（毫秒）", "kind": "number", "default": 300, "min": 0, "max": 2000, "step": 100 },
    { "key": "combo", "label": "快捷键", "kind": "shortcut", "default": "Ctrl+Alt+P" }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `key` | `[a-zA-Z0-9_.-]`，同一插件内不重复，最长 64 |
| `label` | 显示名称 |
| `kind` | `boolean` / `string` / `number` / `select` / `shortcut` |
| `default` | 默认值 |
| `description` | 可选，控件下方说明 |
| `options` | `select` 必填，`{ value, label }` 数组 |
| `min` / `max` / `step` | 仅 `number` |

`kind: "shortcut"` 的值与 `string` 同构（就是 `"Ctrl+Alt+P"` 这样的组合键字符串），但宿主在设置里
渲染成**捕获框**：点一下，按下要用的组合键就写进去，不需要手写格式；捕获框会拒绝没有修饰键的组合。
配合 §5.17 的 `ctx.shortcut.register` 正好一套：改键位 → 配置落库 → 宿主重激活 → 旧键注销、新键生效。

规则：最多 32 项；schema 非法则安装被拒；`config.json` 只存声明过的 key；文件上限 256KB；升级时保留用户值并按新 schema 过滤；卸载后重装丢失。

### ctx.config API

读取：`ctx.config.values`（schema 默认值 + 用户保存值的合并结果）。

运行时写入（写盘后宿主自动重新激活本插件）：

```js
await ctx.config.set({ effectEnabled: !ctx.config.values.effectEnabled });
```

配置的唯一 UI 是设置分区（见 §5.11），插件无需自己写配置界面。manifest 有 `config` 但未贡献分区时宿主自动生成 `id: "config"` 的分区；插件主动贡献分区会抑制自动生成。插件管理页的「配置」按钮只负责跳转到对应分区。

## 8. 能力清单

| 能力 | 状态 |
|---|---|
| 笔记右键菜单项（多层 submenu + danger + when） | **已实现** |
| 分组右键菜单项（多层 submenu + danger） | **已实现** |
| 命令面板命令（按插件名分组） | **已实现** |
| 编辑器工具栏按钮（含光标插入文本） | **已实现** |
| 全局样式注入（`style` 字段 + body class） | **已实现** |
| Toast（success / error / info 三种 type） | **已实现** |
| Modal（模态 / 非模态 / 自定义内容 / 自定义按钮 / PluginModalApi） | **已实现** |
| 读取笔记正文 | **已实现**（锁定笔记返回空串） |
| 写笔记（create / update / remove） | **已实现**（source_plugin 沙箱） |
| 生命周期钩子（onNoteCreate / onNoteSave / onNoteDelete / onNoteSwitch） | **已实现** |
| AI tool（只读 handler + ai.tool 权限守卫） | **已实现** |
| AI 系统提示词注入（prepend / append） | **已实现** |
| AI 服务商模板（预填不落库，填 key 保存后才落库） | **已实现** |
| AI 设置读写（白名单行为参数） | **已实现** |
| 设置分区（config schema 渲染 + 字段分组 + 多分区二级导航 + 即时生效 + 存 config.json） | **已实现** |
| 插件配置（`config.json` + 运行时 `set` 触发重激活 + 设置分区唯一入口 / 自动分区兜底） | **已实现** |
| 插件 i18n（`manifest.i18n` + `ctx.i18n.t/has` + 语言切换自动重激活） | **已实现** |
| 权限声明（permissions 白名单 + 安装确认弹窗） | **已实现** |
| 清理契约（`ctx.onDispose` LIFO） | **已实现** |
| 插件自绘弹窗（`ui.modal` 的 `content` 返回 DOM + 插件自带样式） | **已实现** |
| 往宿主界面挂节点（`ctx.ui.mount`，停用自动摘除） | **已实现** |
| 插件私有数据表（`ctx.db`，表名前缀隔离，可建表 / 删表 / 增删改查） | **已实现** |
| 插件自己的窗口（`ctx.window.open`，加载插件目录里的 html） | **已实现** |
| 快捷键（`ctx.shortcut.register`，仅窗口内、停用自动注销、撞键报错） | **已实现** |
| 多文件 ESM import（相对路径，`.js` / `.mjs`；含 `locales/*.json` 语言包） | **支持**（`fastnote-plugin://` 协议） |
| 编辑器源码菜单扩展点 | 暂不开放 |
| 外部网络请求 | 被 CSP 阻止 |

## 9. 安全等级

插件以 ESM 模块运行在应用主窗口 JS 上下文，无沙箱；安全等级：**实验性**，仅安装可信来源插件。

## 10. 还没对插件开放的模块

「万物皆插件」的目标是软件只留基础功能，其余都由插件补。当前已经开放的扩展点见 §8；
下面这些**还没**开放，按「补起来收益 / 成本」大致排序，方便后续排期：

| 模块 | 现状 | 开放需要补的扩展点 |
|---|---|---|
| 编辑器源码区右键菜单 | 不开放 | `ctx.editor.sourceMenu`（与笔记菜单同形状的贡献点） |
| 编辑器状态栏 / 底部信息条 | 不开放 | `ctx.editor.statusItem`（可更新的文本 / 图标小格） |
| 行内装饰、语法规则、块渲染替换 | 不开放 | 编辑器渲染管线的注册点（改动大，要注意百万字性能红线） |
| 侧栏自定义视图 / 新页面 | 不开放 | 路由 + 侧栏项注册（`ctx.view.register`），宿主要提供容器 |
| 笔记列表项装饰（徽标 / 角标） | 不开放 | `ctx.notes.decorate`（按笔记返回小节点，随列表渲染） |
| 主题预设（整份 tokens） | 只能改 CSS 变量 | `ctx.theme.register(preset)`，让插件贡献主题给「设置 → 外观」 |
| 托盘菜单项 | 不开放 | `ctx.tray.menu`（宿主已有托盘，只差贡献点） |
| 导出格式 / 备份钩子 | 只有内置格式 | `ctx.export.format` + 备份前 / 后钩子 |
| 全局搜索来源（provider） | 不开放 | `ctx.search.provider`（返回异步结果，与大搜索框合并展示） |
| 系统通知 | 不开放 | `ctx.ui.notify`（要接系统通知权限） |
| 保存前 / 渲染前的内容变换 | 只有 `onNoteSave` 观察 | `ctx.hooks.transformNote`（能改内容，必须连 AI 写权限一起校验） |
| 自定义设置控件类型 | 只有 4 种内置控件 | `ctx.settings.control(kind)`（插件提供渲染函数） |
| AI 对话界面扩展（输入区按钮 / 消息操作） | 部分（选中文本工具条是内置的） | `ctx.chat.action` |
| 沙箱运行时的 UI 贡献 | 第一步只开了数据类能力 | 菜单/命令/工具栏/钩子/AI/设置分区/modal/mount/bus 改成声明式 RPC（见 §5.21） |

补齐这些之后，「关掉插件就恢复原样」的契约不变：新扩展点同样要在宿主侧登记、
在 `deactivate` 里整批撤销（参考 §5.12 与 `host.ts` 里 `registry` / `disposers` 的分工）。
