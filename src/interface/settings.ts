/* 非 AI 的软件设置模型：通用 / 编辑器 / 布局 / 视图及其总集合。 */

/*
 * 非 AI 的软件设置。统一持久化在 app_settings 表（键名 app.config.<分类>.<字段>），
 * 打开软件优先读库，读不到的键回退到 config/appDefaults.ts 里的默认值。
 */

/** 通用 / 启动行为 */
export interface GeneralSettings {
  /** 启动时清空回收站（永久删除，仅初始化时执行一次） */
  cleanTrashOnStartup: boolean;
  /** 是否显示托盘图标 */
  trayEnabled: boolean;
  /** 关闭窗口按钮行为：minimize 到托盘 | exit 直接退出 */
  closeBehavior: "minimize" | "exit";
  /** 是否开机自启动 */
  autostart: boolean;
  /** 开机自启动时是否最小化到托盘 */
  minimizeToTray: boolean;
}

/** 编辑器外观与交互 */
export interface EditorSettings {
  /** 编辑器默认正文字号（px）：滚轮可临时缩放，工具栏按钮恢复到该值 */
  fontSize: number;
  /** 是否允许 Ctrl/Cmd + 滚轮缩放字号 */
  ctrlScrollZoom: boolean;
}

/** 界面布局状态（仅决定启动时的布局，不跟随运行时的折叠/开关状态） */
export interface LayoutSettings {
  /** 启动时分组侧边栏是否折叠 */
  sidebarCollapsed: boolean;
  /** 启动时 AI 对话面板是否展开 */
  aiPanelOpen: boolean;
}

/** 笔记列表视图 */
export interface ViewSettings {
  /** 排序字段：updated_at / created_at / title */
  sortBy: string;
  /** 排序方向 */
  sortOrder: "asc" | "desc";
}

/** 软件设置总集合 */
export interface AppSettings {
  general: GeneralSettings;
  editor: EditorSettings;
  layout: LayoutSettings;
  view: ViewSettings;
}
