/* 设置分区注册表：分区渲染器、分区搜索条目与数据行聚合。 */

import type { ReactNode } from "react";
import type { SettingRow, SettingsSection } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "./context";

import { GeneralSection, buildGeneralRows } from "./sections/general";
import { EditorSection, buildEditorRows } from "./sections/editor";
import { ViewSection, buildViewRows } from "./sections/view";
import { LayoutSection, buildLayoutRows } from "./sections/layout";
import { ShortcutsSection } from "./sections/shortcuts";
import { ThemeSection } from "./sections/theme";
import { SemanticSection } from "./sections/semantic";
import { ToolboxSection } from "./sections/toolbox";
import { CleaningSection } from "./sections/cleaning";
import { ProviderSection } from "./sections/provider";
import { ChatSection, buildChatRows } from "./sections/chat";
import { ContextSection, buildContextRows } from "./sections/context";
import { MemorySection } from "./sections/memory";
import { AccessSection, buildAccessRows } from "./sections/access";
import { ResetSection } from "./sections/reset";
import { BackupSection } from "./sections/backup";
import { PluginsSection } from "./sections/plugins";
import { AboutSection } from "./sections/about";

/** 分区 → 渲染器：弹窗只渲染当前选中的那个分区 */
export const SECTION_RENDERERS: Record<
  SettingsSection,
  (ctx: SettingsSectionContext) => ReactNode
> = {
  general: (ctx) => <GeneralSection ctx={ctx} />,
  editor: (ctx) => <EditorSection ctx={ctx} />,
  view: (ctx) => <ViewSection ctx={ctx} />,
  layout: (ctx) => <LayoutSection ctx={ctx} />,
  shortcuts: (ctx) => <ShortcutsSection ctx={ctx} />,
  theme: (ctx) => <ThemeSection ctx={ctx} />,
  semantic: (ctx) => <SemanticSection ctx={ctx} />,
  toolbox: (ctx) => <ToolboxSection ctx={ctx} />,
  cleaning: (ctx) => <CleaningSection ctx={ctx} />,
  provider: (ctx) => <ProviderSection ctx={ctx} />,
  chat: (ctx) => <ChatSection ctx={ctx} />,
  context: (ctx) => <ContextSection ctx={ctx} />,
  memory: (ctx) => <MemorySection ctx={ctx} />,
  access: (ctx) => <AccessSection ctx={ctx} />,
  reset: (ctx) => <ResetSection ctx={ctx} />,
  backup: (ctx) => <BackupSection ctx={ctx} />,
  plugins: (ctx) => <PluginsSection onOpenPluginSection={ctx.onOpenPluginSection} />,
  about: (ctx) => <AboutSection ctx={ctx} />,
};

/**
 * 数据驱动分区的全部设置行（按分区顺序聚合）。
 * 「编辑器」的行由规格表生成，其余分区的行在各自文件里声明。
 */
export const buildSettingRows = (ctx: SettingsRowsContext): SettingRow[] => [
  ...buildGeneralRows(ctx),
  ...buildEditorRows(ctx),
  ...buildViewRows(ctx),
  ...buildLayoutRows(ctx),
  ...buildChatRows(ctx),
  ...buildContextRows(ctx),
  ...buildAccessRows(ctx),
];

/**
 * 自定义面板的可搜索文案：这些分区的内容不是 SettingRow，取不到行级关键词，
 * 因此按分区手写词表。数据驱动分区留空，由行自身的 title/desc/keywords 命中。
 */
export const SECTION_SEARCH_ENTRIES: Record<SettingsSection, readonly string[]> = {
  general: [],
  editor: [],
  view: [],
  layout: [],
  shortcuts: [
    "快捷键 键位 按键 组合键 键盘 ctrl cmd shift alt 跳转 命令面板 shortcut shortcuts keymap hotkey keyboard ctrl+p ctrl+shift+p",
  ],
  theme: [
    "主题 配色 颜色 取色 色盘 暗黑 暗色 深色 浅色 夜间 预设 自定义 圆角 外观 theme color palette dark light appearance radius preset",
  ],
  semantic: [
    "语义搜索 语义 向量 embedding 向量检索 模型 本地模型 推荐 多语言 bge minilm 下载 索引 重建 自动 自动索引 增量 启用 开关 index semantic vector model onnx 离线 相似 近似",
  ],
  toolbox: [
    "工具箱 下载 下载器 链接 url http https 线程 并发 分段 文件 目录 download downloader threads",
  ],
  cleaning: [
    "清理 缓存 临时 残留 索引 向量 占用 空间 存储 图片 回收 删除 cache temp index storage cleanup gc",
  ],
  provider: [
    "服务商 模型 api key 密钥 openai google claude 接口 base url http",
  ],
  chat: [],
  context: [],
  memory: ["记忆 提示词 prompt 长期记忆 前置 要求 memory"],
  access: [
    "访问 权限 分组 笔记 ai 隐私 限制 禁止 只读 完全 三档 access permission privacy readonly category note",
  ],
  reset: ["恢复默认 重置 出厂值 reset default"],
  backup: [
    "备份 恢复 导出 导入 数据 json sqlite db 数据库 快照 迁移 加密 口令 fnbak 加密备份 webdav 云同步 云端 网盘 nextcloud 群晖 坚果云 alist 自动备份 服务器 账号 密码 文件夹 backup restore cloud sync encrypted passphrase",
  ],
  plugins: [
    "插件 插件管理 plugin plugins 安装 卸载 实验 实验性 zip 导入 内置 安装包 install uninstall experimental extension 扩展",
  ],
  about: [
    "关于 版本 作者 应用名 图标 开源项目 开源 about version author name iconfont opensource",
  ],
};

/** 某个分区的完整搜索文案；服务商名称随数据变化，单独拼进来 */
export const sectionSearchText = (
  key: SettingsSection,
  providerNames: readonly string[] = [],
): string => {
  const entries = SECTION_SEARCH_ENTRIES[key].join(" ");
  if (key !== "provider") return entries;
  return `${entries} ${providerNames.join(" ")}`;
};
