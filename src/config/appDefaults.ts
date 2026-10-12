import type {
  AppSettings,
  GeneralSettings,
  EditorSettings,
  LayoutSettings,
  ViewSettings,
} from "@/types";

/**
 * 软件设置的「默认配置文件」。
 *
 * 数据库里查不到的键一律回退到这里；新增/调整设置项只改本文件，无需迁移脚本。
 * 键名与数据库一一对应：app.config.<分类>.<字段>
 *   app.config.general.<字段>  → GeneralSettings
 *   app.config.editor.<字段>   → EditorSettings
 *   app.config.layout.<字段>   → LayoutSettings
 *   app.config.view.<字段>     → ViewSettings
 */

/** 编辑器字号可选范围（px） */
export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 24;

/* ---------- General ---------- */
export const DEFAULT_GENERAL_SETTINGS: GeneralSettings = {
  /** 启动时清空回收站（只在软件初始化时执行，永久删除、不可恢复） */
  cleanTrashOnStartup: false,
};

/* ---------- Editor ---------- */
export const DEFAULT_EDITOR_SETTINGS: EditorSettings = {
  /** 编辑器默认正文字号（px）：Ctrl/⌘ + 滚轮可在 12–24 之间临时缩放，工具栏字号按钮恢复到这个值 */
  fontSize: 14,
  /** Ctrl/Cmd + 滚轮是否调整编辑器字号 */
  ctrlScrollZoom: true,
};

/* ---------- Layout ---------- */
export const DEFAULT_LAYOUT_SETTINGS: LayoutSettings = {
  /** 启动时分组侧边栏是否折叠（仅决定启动时的布局，不跟随运行时的折叠状态） */
  sidebarCollapsed: false,
  /** 启动时 AI 面板是否打开（仅决定启动时的布局，不跟随运行时的开关状态） */
  aiPanelOpen: false,
};

/* ---------- View ---------- */
export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  /** 排序字段 */
  sortBy: "created_at",
  /** 排序方向 */
  sortOrder: "asc",
};

/* ---------- 合并后的完整默认值 ---------- */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  general: DEFAULT_GENERAL_SETTINGS,
  editor: DEFAULT_EDITOR_SETTINGS,
  layout: DEFAULT_LAYOUT_SETTINGS,
  view: DEFAULT_VIEW_SETTINGS,
};