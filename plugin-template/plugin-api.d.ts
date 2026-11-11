/**
 * FastNote 插件 API 类型声明（v1）
 *
 * 用法：把本文件放到你的插件目录（或 `/// <reference path="./plugin-api.d.ts" />`），
 * 然后写 `export default { activate(ctx: FastNoteContext) { … } }` 就能拿到补全。
 *
 * 两种运行方式的能力完全一致，区别只在隔离：
 *   - `runtime: "inpage"`（默认）：和宿主同上下文，能直接摸 DOM，但没有安全边界；
 *   - `runtime: "sandbox"`：跑在独立源的 iframe 里，只能走下面的接口。
 * 沙箱模式下 `when` 必须用声明式条件（函数无法跨 iframe 同步求值）。
 */

/** 沙箱模式下的声明式显示条件（`is` 省略时等价于 truthy） */
export interface PluginWhen {
  field: string;
  is?: "truthy" | "falsy" | "equals" | "notEquals";
  value?: unknown;
}

/** 宿主传给插件的笔记摘要（右键菜单的 note、钩子的 payload 都是它） */
export interface PluginNoteSummary {
  id: string;
  title?: string;
  category_id?: string | null;
  is_locked?: boolean;
  updated_at?: string;
}

export interface PluginMenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  /** inpage 用函数；sandbox 必须用对象 */
  when?: ((subject: unknown) => boolean) | PluginWhen;
  submenu?: PluginMenuItem[];
  onClick?: (subject: PluginNoteSummary, ctx: FastNoteContext) => unknown;
}

export interface PluginCommand {
  id: string;
  label: string;
  icon?: string;
  hint?: string;
  keywords?: string[];
  run: (ctx: FastNoteContext) => unknown;
}

export interface PluginToolbarItem {
  id: string;
  title: string;
  icon?: string;
  label?: string;
  when?: ((ctx: unknown) => boolean) | PluginWhen;
  onClick: (editor: { content?: string; title?: string }, ctx: FastNoteContext) => unknown;
}

export interface PluginConfigField {
  key: string;
  label: string;
  /**
   * 各语言下的 label，键可写 `"en"` 或 `"en-US"`。
   * 不填时英文界面会直接显示 label 原文（中文）——宿主词典里没有插件的词条。
   */
  labelI18n?: Record<string, string>;
  kind: "boolean" | "string" | "number" | "select" | "shortcut";
  default?: unknown;
  description?: string;
  /** 各语言下的 description，规则同 labelI18n */
  descriptionI18n?: Record<string, string>;
  options?: { value: string; label: string; labelI18n?: Record<string, string> }[];
  min?: number;
  max?: number;
  step?: number;
}

export interface PluginModalButton {
  label: string;
  danger?: boolean;
  onClick?: () => boolean | void;
}

/** 弹窗的收尾句柄：inpage 的 content 回调会拿到；沙箱里由运行时转成 RPC */
export interface PluginModalApi {
  close(value?: unknown): void;
  ok(value?: unknown): void;
  cancel(): void;
}

export interface PluginModalOptions {
  title?: string;
  /**
   * 弹窗内容：
   *   - 字符串：当纯文本渲染（简单确认框）；
   *   - 回调：`(api) => React 节点 / DOM 节点 / HTML 字符串`，可用 api 主动收尾；
   *   - **沙箱里只能用字符串**（运行时把回调结果转成 HTML 发给宿主）。
   */
  content?: string | ((api: PluginModalApi) => unknown);
  /** 直接给一段 HTML（沙箱插件推荐）：宿主消毒后插入，class 可走插件自己的 style.css */
  html?: string;
  buttons?: PluginModalButton[];
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  size?: "sm" | "md" | "lg" | "xl" | "2xl";
  height?: string;
}

export interface PluginModalResult {
  ok: boolean;
  value?: unknown;
}

export interface PluginDbColumn {
  name: string;
  kind: "text" | "integer" | "real";
}

export interface PluginFsEntry {
  name: string;
  isDir: boolean;
  size: number;
}

export interface PluginNetResponse {
  status: number;
  body: string;
  truncated: boolean;
}

/** 插件运行上下文：`activate(ctx)` 拿到的那份 */
export interface FastNoteContext {
  /** 插件目录名（实例键） */
  dirName: string;
  config: {
    values: Record<string, unknown>;
    set(patch: Record<string, unknown>): Promise<void>;
  };
  /** 插件私有表：表名自动加 `plugin_<目录名>__` 前缀，碰不到宿主与其它插件 */
  db: {
    createTable(table: string, columns: PluginDbColumn[]): Promise<void>;
    dropTable(table: string): Promise<void>;
    tables(): Promise<string[]>;
    insert(table: string, values: Record<string, unknown>): Promise<number>;
    query(
      table: string,
      options?: {
        filter?: Record<string, unknown>;
        orderBy?: string;
        descending?: boolean;
        limit?: number;
        offset?: number;
      },
    ): Promise<Record<string, unknown>[]>;
    update(
      table: string,
      filter: Record<string, unknown>,
      values: Record<string, unknown>,
    ): Promise<number>;
    remove(table: string, filter: Record<string, unknown>): Promise<number>;
    count(table: string, filter?: Record<string, unknown>): Promise<number>;
    addColumn(table: string, column: PluginDbColumn): Promise<boolean>;
    createIndex(table: string, name: string, columns: string[], unique?: boolean): Promise<void>;
  };
  /** 插件数据目录（<数据目录>/plugin-data/<目录名>/），单文件 4MB */
  fs: {
    root(): Promise<string>;
    list(relDir?: string): Promise<PluginFsEntry[]>;
    read(relPath: string): Promise<string>;
    write(relPath: string, content: string): Promise<number>;
    remove(relPath: string): Promise<void>;
  };
  /** 联网：只允许 plugin.json 的 netDomains 白名单 */
  net: {
    fetch(
      url: string,
      options?: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: string },
    ): Promise<PluginNetResponse>;
  };
  notes: {
    getContent(id: string): Promise<string>;
    create(input: { title?: string; content?: string; categoryId?: string | null }): Promise<{ id: string }>;
    update(id: string, patch: { title?: string; content?: string }): Promise<void>;
    remove(id: string): Promise<void>;
  };
  editor: {
    insertText(text: string): boolean | Promise<boolean>;
    /** 编辑器工具栏按钮；沙箱里是异步 RPC，建议 await */
    toolbar(item: PluginToolbarItem): void | Promise<void>;
  };
  menu: {
    /** 右键菜单；沙箱里是异步 RPC，建议 await（否则注册失败只是 unhandled rejection） */
    note(item: PluginMenuItem): void | Promise<void>;
    group(item: PluginMenuItem): void | Promise<void>;
  };
  command(item: PluginCommand): void | Promise<void>;
  hooks: {
    onNoteCreate(fn: (note: PluginNoteSummary) => unknown): void | Promise<void>;
    onNoteSave(fn: (note: PluginNoteSummary) => unknown): void | Promise<void>;
    onNoteDelete(fn: (note: PluginNoteSummary) => unknown): void | Promise<void>;
    onNoteSwitch(fn: (note: PluginNoteSummary) => unknown): void | Promise<void>;
  };
  ai: {
    tool(tool: {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      execute: (args: Record<string, unknown>) => unknown;
    }): void | Promise<void>;
    systemPrompt(text: string): void | Promise<void>;
    provider(provider: unknown): void | Promise<void>;
    getSettings(): Promise<Record<string, unknown>>;
    updateSettings(patch: Record<string, unknown>): void | Promise<void>;
  };
  settings: {
    section(section: {
      id: string;
      title: string;
      icon?: string;
      groups?: {
        id: string;
        title: string;
        description?: string;
        fields: ({ key: string } & Partial<PluginConfigField>)[];
      }[];
      fields?: PluginConfigField[];
    }): void | Promise<void>;
  };
  window: {
    open(
      relPath: string,
      options?: { title?: string; width?: number; height?: number },
    ): Promise<string>;
    close(label: string): Promise<void>;
  };
  shortcut: {
    /**
     * 注册一条快捷键，返回注销函数（停用 / 卸载时宿主也会自动注销）。
     *
     * 冲突（宿主当前生效的键位、其它插件、系统里已被占用的热键）会抛错，不静默覆盖。
     * 插件只能注册**窗口内**快捷键：软件窗口有焦点时才触发。
     * 系统全局热键由宿主独占，传 `scope: "global"` 会直接抛错（不会静默降级）。
     * 沙箱运行时里返回 Promise，需要 `await`。
     */
    register(
      combo: string,
      handler: () => void,
      options?: { scope?: "app" },
    ): void | (() => void) | Promise<void>;
    unregister(combo: string): void | Promise<void>;
  };
  ui: {
    toast(message: string, type?: "success" | "error" | "info"): void | Promise<void>;
    modal(options: PluginModalOptions): Promise<PluginModalResult>;
    /** 宿主 body / html 的 class（沙箱里唯一能改到宿主界面的样式手段） */
    setBodyClass(name: string, on: boolean): void | Promise<void>;
    setHtmlClass(name: string, on: boolean): void | Promise<void>;
    /** 往宿主元素里插一段 HTML（沙箱：宿主消毒后代插），返回移除函数 */
    mount(target: string, node: string | Node): (() => void) | Promise<() => void>;
  };
  bus: {
    /** 订阅；返回取消函数（沙箱里返回 Promise，await 后拿到取消函数） */
    on(
      topic: string,
      handler: (payload: unknown, from: string) => void,
    ): (() => void) | Promise<() => void>;
    emit(topic: string, payload?: unknown): void | Promise<void>;
  };
  i18n: {
    locale: string;
    t(key: string, vars?: Record<string, string | number>): string;
    has(key: string): boolean;
  };
  /** 清理回调：插件停用 / 卸载 / 重激活时按 LIFO 执行 */
  onDispose(fn: () => void): void;
}

export interface FastNotePlugin {
  activate(ctx: FastNoteContext): void | Promise<void>;
}
