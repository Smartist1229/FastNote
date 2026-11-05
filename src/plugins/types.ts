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
