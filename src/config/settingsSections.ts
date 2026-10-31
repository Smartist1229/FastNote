import type { SectionMeta } from "@/interface/settingsModal";

/**
 * 分区元数据：key 与 SettingsSection 一一对应，group 决定左侧目录归到哪一栏。
 *
 * 单独放在 config 里而不是跟着 SettingsModal：命令面板也要用它生成
 * 「打开设置：xxx」，放在组件里会让懒加载的设置窗口被静态引回主包。
 */
export const SETTINGS_SECTIONS: readonly SectionMeta[] = [
  { key: "general", label: "通用", icon: "ai-bolt", group: "软件" },
  { key: "editor", label: "编辑器", icon: "ai-edit", group: "软件" },
  { key: "view", label: "笔记列表", icon: "sidebar-list", group: "软件" },
  { key: "layout", label: "界面布局", icon: "sidebar-edit-square", group: "软件" },
  { key: "shortcuts", label: "快捷键", icon: "settings-shortcuts", group: "软件" },
  { key: "theme", label: "主题", icon: "settings-theme", group: "软件" },
  { key: "semantic", label: "语义搜索", icon: "ai-bolt", group: "软件" },
  { key: "toolbox", label: "工具箱", icon: "toolbox", group: "软件" },
  { key: "provider", label: "AI 服务商", icon: "settings-provider", group: "AI" },
  { key: "chat", label: "对话行为", icon: "settings-chat", group: "AI" },
  { key: "context", label: "上下文", icon: "settings-context", group: "AI" },
  { key: "memory", label: "记忆与提示词", icon: "settings-memory", group: "AI" },
  { key: "access", label: "AI 访问权限", icon: "ai-shield-check", group: "AI" },
  { key: "reset", label: "恢复默认", icon: "app-restore", group: "数据" },
  { key: "backup", label: "备份与恢复", icon: "app-backup", group: "数据" },
  { key: "about", label: "关于", icon: "toast-info", group: "其他" },
];
