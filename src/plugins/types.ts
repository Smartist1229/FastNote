/**
 * 插件系统的组件层类型：插件可贡献的扩展点（笔记菜单、命令面板、编辑器工具栏、toast、笔记读取）。
 *
 * 插件通过 activate(ctx) 拿到 PluginContext，把贡献注册进 registry；
 * icon 统一用图标名（public/icons/<name>.svg），由调用方转成 JSX。
 */

import type { Note } from "@/interface/note/note";
import type { PluginAiPromptContribution, PluginAiProvider, PluginAiTool, PluginSettingsSection } from "./registry";
import type {
  PluginMarkdownHandle,
  PluginModalOptions,
  PluginModalResult,
  ToastType,
} from "@/interface/app/ui";
import type {
  PluginDbColumn,
  PluginDbQueryOptions,
  PluginFsEntry,
  PluginNetResponse,
} from "@/api/system/plugins";

/** ctx.notes.getCurrent() 的返回：当前编辑器打开的笔记（不含正文） */
export interface PluginCurrentNote {
  id: string;
  title: string;
  isLocked: boolean;
}

/** 笔记右键菜单贡献：when 不传则始终可见 */
export interface PluginMenuItem {
  id: string;
  label: string;
  /** 图标名（Icon 组件的 name），不是 JSX */
  icon?: string;
  danger?: boolean;
  /** 返回 false 时该项不出现在当前笔记的菜单里 */
  when?: (note: Note) => boolean;
  /** 叶子节点的点击回调；有 submenu 的项可以不提供（hover 展开），也可以同时提供（hover 展开 + click 也执行） */
  onClick?: (note: Note, ctx: PluginContext) => void | Promise<void>;
  /** 子菜单，支持任意深度嵌套；有值时该项 hover 展开 */
  submenu?: PluginMenuItem[];
}

/** 分组右键菜单贡献：不绑定 Note，按插件自行判断可见性 */
export interface PluginGroupMenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  onClick: (ctx: PluginContext) => void | Promise<void>;
  submenu?: PluginGroupMenuItem[];
}

/** 生命周期钩子名称：插件能被动订阅的笔记事件 */
export type PluginHook = "note-create" | "note-save" | "note-delete" | "note-switch";

/** 命令面板贡献 */
export interface PluginCommand {
  id: string;
  label: string;
  icon?: string;
  run: (ctx: PluginContext) => void | Promise<void>;
}

/** 编辑器工具栏按钮的上下文：当前笔记与编辑器状态 */
export interface EditorToolbarContext {
  noteId: string | null;
  title: string;
  content: string;
  mode: string;
  /** 在正文光标处插入文本；编辑器未就绪或只读时返回 false */
  insertText?: (text: string) => boolean;
}

/** 编辑器工具栏贡献 */
export interface PluginEditorToolbarItem {
  id: string;
  /** 按钮 tooltip（必填，按钮本身只显示图标） */
  title: string;
  /** 图标名，复用 @/components/common/Icon 的 name */
  icon?: string;
  /** 纯文字按钮（不填 icon 时显示 label，二者至少一个） */
  label?: string;
  /** 返回 false 时本按钮在此笔记下隐藏 */
  when?: (ctx: EditorToolbarContext) => boolean;
  onClick: (ctx: EditorToolbarContext, plugin: PluginContext) => void | Promise<void>;
}

/**
 * 插件运行上下文：activate 与每次贡献回调执行时都会拿到一份。
 * menu / command / editor 的注册会归属到对应插件名下（插件被禁用/卸载时整体清除）。
 * onDispose 登记的回调在该插件停用、卸载或重新激活时执行（LIFO），用于撤销插件自己
 * 创建的 DOM、定时器、全局变量等 registry 覆盖不到的副作用。
 */
export interface PluginContext {
  menu: {
    note(item: PluginMenuItem): void;
    group(item: PluginGroupMenuItem): void;
  };
  command(item: PluginCommand): void;
  editor: {
    toolbar(item: PluginEditorToolbarItem): void;
    /**
     * 生成 Markdown 渲染句柄，供 ui.modal({ render }) 以编辑器纯渲染模式展示。
     * 只做本地解析，不读写笔记数据；也可直接给 ui.modal 传原始 Markdown 字符串。
     */
    render(markdown: string): PluginMarkdownHandle;
  };
  ui: {
    toast(message: string, type?: ToastType): void;
    modal(options: PluginModalOptions): Promise<PluginModalResult>;
    /**
     * 给宿主 <body> / <html> 加 / 去一个 class。
     * 沙箱插件改不到宿主页面（document 是 iframe 的），主题、隐藏统计这类效果走这里；
     * 停用 / 卸载时宿主自动移除。
     */
    setBodyClass(name: string, on: boolean): void | Promise<void>;
    setHtmlClass(name: string, on: boolean): void | Promise<void>;
    /**
     * 往宿主界面的某个元素里挂一个节点（装饰、状态块、工具条都靠它）。
     * target 传选择器或元素；返回移除函数，并自动登记到 onDispose——
     * 插件停用 / 卸载时宿主会摘掉，界面恢复原样。
     */
    mount(target: string | Element, node: Node): () => void;
  };
  /**
   * 插件私有数据表。表名由宿主强制加 `plugin_<目录名>__` 前缀（插件只写裸名），
   * 所以插件的表与宿主表、其它插件的表天然隔离。
   * 需要声明 db.read_write 权限。
   */
  db: {
    /** 建表（幂等）。columns 里的 kind 只认 "text" / "integer" / "real" */
    createTable(table: string, columns: PluginDbColumn[]): Promise<void>;
    /** 删表：只删得掉自己的表 */
    dropTable(table: string): Promise<void>;
    /** 本插件的表清单（裸名） */
    tables(): Promise<string[]>;
    /** 插入一行，返回新行 id */
    insert(table: string, values: Record<string, unknown>): Promise<number>;
    /** 查询：等值过滤 + 排序 + 分页（默认按 id 倒序、200 行） */
    query(table: string, options?: PluginDbQueryOptions): Promise<Record<string, unknown>[]>;
    /** 更新：filter 必须非空，返回影响行数 */
    update(
      table: string,
      filter: Record<string, unknown>,
      values: Record<string, unknown>,
    ): Promise<number>;
    /** 删除：filter 必须非空，返回影响行数 */
    remove(table: string, filter: Record<string, unknown>): Promise<number>;
    /** 统计行数（不把数据拉回前端） */
    count(table: string, filter?: Record<string, unknown>): Promise<number>;
    /** 加一列（迁移用，幂等）：true = 这次真的加了 */
    addColumn(table: string, column: PluginDbColumn): Promise<boolean>;
    /** 建索引（幂等，索引名自动带插件前缀） */
    createIndex(table: string, name: string, columns: string[], unique?: boolean): Promise<void>;
  };
  /**
   * 插件文件存储（需 fs.read_write）：只能碰自己的数据目录
   * `<数据目录>/plugin-data/<插件目录名>/`——插件目录会被升级覆盖，不适合放数据。
   * 单文件上限 4MB；`.exe/.dll/.bat/...` 这类可执行扩展名不允许写入。
   */
  fs: {
    /** 数据目录的绝对路径 */
    root(): Promise<string>;
    /** 列目录（默认根目录） */
    list(relDir?: string): Promise<PluginFsEntry[]>;
    /** 读文本文件（UTF-8） */
    read(relPath: string): Promise<string>;
    /** 写文本文件（自动建父目录），返回字节数 */
    write(relPath: string, content: string): Promise<number>;
    /** 删文件或空目录 */
    remove(relPath: string): Promise<void>;
  };
  /**
   * 联网（需 net.fetch）：由宿主代发，只允许 plugin.json 的 `netDomains` 里声明的主机。
   * 前端 CSP 不放宽 connect-src，所以插件的 fetch 不能直连外网，必须走这里。
   */
  net: {
    fetch(
      url: string,
      options?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
    ): Promise<PluginNetResponse>;
  };
  /**
   * 插件之间的消息总线（无需权限）：同一实例内广播，宿主自动在所有插件之间转发。
   * topic 建议加插件前缀（`myplugin.refresh`），避免和别的插件撞。
   */
  bus: {
    /** 订阅；返回取消函数，并自动登记到 onDispose */
    on(topic: string, handler: (payload: unknown, from: string) => void): () => void;
    /** 广播（异步派发，单个 handler 抛错不影响别人） */
    emit(topic: string, payload?: unknown): void;
  };
  /**
   * 插件自己的窗口：加载插件目录里的页面（宿主外壳 + iframe，页面里用 postMessage 桥拿
   * `db.*` / `plugin.reactivate` / `window.close`），页面 / 样式 / 脚本全归插件。
   * 需要声明 window.open 权限。插件停用 / 卸载时宿主会把该插件开的窗口全部关掉。
   */
  window: {
    /** 打开插件目录里的文件（通常是 .html），返回窗口标签 */
    open(
      relPath: string,
      options?: { title?: string; width?: number; height?: number },
    ): Promise<string>;
    /** 关掉某个插件窗口 */
    close(label: string): Promise<void>;
  };
  /**
   * 快捷键：注册即生效，插件停用 / 卸载 / 重激活时自动注销。
   * 与宿主键位（Ctrl+P / Ctrl+F …）或其它插件撞键会抛错，不静默覆盖。
   * 监听的是软件窗口的 keydown（窗口有焦点时才触发），不是系统级全局热键。
   * 需要声明 shortcut.register 权限。
   */
  shortcut: {
    register(combo: string, handler: () => void): void;
    unregister(combo: string): void;
  };
  notes: {
    /** 按笔记 id 读正文；锁定的加密笔记返回空串 */
    getContent(id: string): Promise<string>;
    /**
     * 当前编辑器里打开的笔记（外部文件 / 未选中时为 null）。
     * 需要 manifest 声明 notes.read。
     */
    getCurrent(): PluginCurrentNote | null;
    /**
     * 创建一篇归属于本插件的笔记（source_plugin = 本插件 dirName）。
     * 必须在 manifest.permissions 里声明 notes.write，否则调用会被拒绝。
     * 返回新建笔记的完整 Note（含 id）。
     */
    create(
      title: string,
      content?: string,
      categoryId?: string | null,
    ): Promise<string>;
    /**
     * 更新本插件创建的笔记。只能改 title / content，category_id 不动（避免插件误把自己的笔记移到加密分组）。
     * 只有 source_plugin 等于本插件的笔记允许修改。
     */
    update(id: string, title?: string, content?: string): Promise<void>;
    /**
     * 把本插件创建的笔记移入回收站（软删除）。只有 source_plugin 等于本插件的笔记允许删除。
     */
    remove(id: string): Promise<void>;
  };
  /** 被动订阅笔记生命周期事件；钩子是异步非阻塞的，handler 抛错只记日志不阻断流程 */
  hooks: {
    onNoteCreate(cb: (payload: { note: Note; isExternal: boolean }) => void | Promise<void>): void;
    onNoteSave(cb: (payload: { noteId: string; content: string; savedAt: string }) => void | Promise<void>): void;
    onNoteDelete(cb: (payload: { noteId: string }) => void | Promise<void>): void;
    onNoteSwitch(cb: (payload: { oldNoteId: string | null; newNoteId: string | null }) => void | Promise<void>): void;
  };
  /** AI 域贡献点：工具 / 系统提示词 / 服务商模板 / 设置读写。各自需要声明对应权限：
   * ai.tool / ai.prompt / ai.provider / ai.settings，未声明时调用会被拒绝（抛中文错误）。 */
  ai: {
    /** 注册 AI Agent 工具（只读：只能通过内置 notes.getContent 读笔记，不能写）。
     * 必须在 manifest.permissions 里声明 ai.tool，否则调用会被拒绝。 */
    tool(item: PluginAiTool): void;
    /**
     * 向 AI 的系统提示词注入一段文本：position="prepend" 放在内置提示词之前，
     * "append"（默认）放在最后；插件禁用 / 卸载后立即消失。
     * 必须在 manifest.permissions 里声明 ai.prompt。
     */
    systemPrompt(entry: PluginAiPromptContribution): void;
    /**
     * 注册一个 AI 服务商模板：在服务商设置列表里展示为「插件 · xx」条目，
     * 用户选中后预填 baseUrl / models，填好 API Key 保存时才落入用户自己的数据库；
     * 插件卸载不影响已保存的配置。必须在 manifest.permissions 里声明 ai.provider。
     */
    provider(provider: PluginAiProvider): void;
    /**
     * 读当前 AI 设置（归一化后的行为参数，不含 API Key / 服务商列表）。
     * 必须在 manifest.permissions 里声明 ai.settings。
     */
    getSettings(): Promise<Record<string, unknown>>;
    /**
     * 局部更新 AI 设置：只允许白名单内的行为参数（如 maxTokens / streaming /
     * minThinkingLen / maxRounds / contextBudget / keepRecent / toolResultChars /
     * retryShallowThinking / autoTitle / confirmByDefault / showToolTrace / composerHeight），
     * 其余键一律拒绝。写入后与设置页改动走同一条生效路径。
     * 必须在 manifest.permissions 里声明 ai.settings。
     */
    updateSettings(patch: Record<string, unknown>): Promise<void>;
  };
  /** 设置域贡献点：在设置弹窗里加插件自己的分区（复用 config schema 渲染，值存 config.json）。
   * 必须在 manifest.permissions 里声明 settings.section，否则调用会被拒绝（抛中文错误）。 */
  settings: {
    section(section: PluginSettingsSection): void;
  };
  config: {
    /** 激活时已读取好的配置值（schema 默认值 + 用户保存值） */
    values: Record<string, unknown>;
    /** 局部更新配置：写入 config.json 后宿主会自动重新激活本插件（用于插件内切换功能） */
    set(patch: Record<string, unknown>): Promise<void>;
  };
  /** 插件自带语言包：跟随软件界面语言，支持点号嵌套 key；缺 key 时返回 key 本身 */
  i18n: {
    /** 当前软件语言（zh-CN / en-US） */
    locale: string;
    /** 取当前语言文案并做 {name} 占位插值；key 不存在或不是字符串时返回 key */
    t(key: string, vars?: Record<string, string | number>): string;
    /** key 是否存在且为字符串 */
    has(key: string): boolean;
  };
  onDispose(fn: () => void): void;
}
