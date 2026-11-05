# FastNote 插件 API

> 状态：实验性（安装已开放，接口仍可能调整）。设置 → 插件 可直接安装 / 启用 / 卸载 zip 插件包。插件在应用内运行第三方代码，请仅安装可信来源的插件。

---

## 1. 插件包结构

```
my-plugin/
├── plugin.json      # 必需
├── icon.svg         # 可选，插件图标（见下方「插件图标」）
├── main.js          # 可选，入口脚本，ESM 模块
├── style.css        # 可选，全局样式
├── locales/         # 可选，插件自己的语言包（.json，见 §5.14）
│   ├── zh.json
│   └── en.json
└── modules/         # 可选，多文件模块（entry 里用相对路径 import，见 §4）
```

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
| `minAppVersion` | string | 否 | 预留，当前不校验 |

`entry` / `style` 必须是相对路径：不能以 `/`、`\` 或盘符开头，不能包含 `..`。

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
| `ctx.onDispose` | 清理契约 |

### 安全说明

- 安装时宿主会弹出**权限确认弹窗**，列出插件声明的所有权限，用户确认后才安装。
- 已安装插件可以在设置页「插件管理 → 某插件 → 权限」查看当前生效的权限清单。
- `fastnote-plugin` 协议 handler 只 serve 插件目录内的 `.js` / `.mjs`：`..`、绝对路径、反斜杠等路径逃逸尝试一律拒绝。
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

**完整参数**：

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
    { "key": "delay", "label": "延迟（毫秒）", "kind": "number", "default": 300, "min": 0, "max": 2000, "step": 100 }
  ]
}
```

| 字段 | 说明 |
|---|---|
| `key` | `[a-zA-Z0-9_.-]`，同一插件内不重复，最长 64 |
| `label` | 显示名称 |
| `kind` | `boolean` / `string` / `number` / `select` |
| `default` | 默认值 |
| `description` | 可选，控件下方说明 |
| `options` | `select` 必填，`{ value, label }` 数组 |
| `min` / `max` / `step` | 仅 `number` |

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
| 多文件 ESM import（相对路径，`.js` / `.mjs`；含 `locales/*.json` 语言包） | **支持**（`fastnote-plugin://` 协议） |
| 编辑器源码菜单扩展点 | 暂不开放 |
| 外部网络请求 | 被 CSP 阻止 |

## 9. 安全等级

插件以 ESM 模块运行在应用主窗口 JS 上下文，无沙箱；安全等级：**实验性**，仅安装可信来源插件。
