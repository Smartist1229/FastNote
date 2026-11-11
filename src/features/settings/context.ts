/* 设置分区上下文：各分区渲染所需的值与回调，字段从 SettingsModalProps 派生。 */

import type { RefObject } from "react";
import type { AiProvider, AiSettings } from "@/interface/ai/ai";
import type { Category, Note } from "@/interface/note/note";
import type {
  SettingRow,
  SettingsModalProps,
  SettingsSection,
} from "@/interface/settings/settingsModal";
import type { AppSettings } from "@/interface/settings/settings";

/** 写软件设置：category + field 由 AppSettings 约束，值统一按原始类型上抛 */
export type SetAppField = <K extends keyof AppSettings>(
  category: K,
  field: keyof AppSettings[K],
  value: boolean | number | string,
) => void;

/** 写 AI 设置：整个对象上抛，App 侧 diff 后落库 */
export type SetAiField = <K extends keyof AiSettings>(field: K, value: AiSettings[K]) => void;

/** 数据驱动分区的行构建只需要设置值、写回函数与可选项来源 */
export interface SettingsRowsContext {
  appSettings: AppSettings;
  aiSettings: AiSettings;
  /** 已配置的 AI 服务商：辅助模型这类"需要选服务商"的行要用 */
  aiProviders: AiProvider[];
  setApp: SetAppField;
  setAi: SetAiField;
}

/** 分区渲染要用到的 Props 子集（不改 SettingsModalProps 本身） */
export type SettingsSectionProps = Pick<
  SettingsModalProps,
  | "isOpen"
  | "onClose"
  | "onAppSettingChange"
  | "onResetAppSettings"
  | "onResetEditorSettings"
  | "onResetThemeSettings"
  | "aiProviders"
  | "aiSelectedProviderId"
  | "onAiProvidersChange"
  | "onAiSelectedProviderChange"
  | "aiPrompts"
  | "onAiPromptsChange"
  | "categories"
  | "notes"
  | "onSetCategoryAiAccess"
  | "onSetNoteAiAccess"
  | "theme"
  | "onThemeChange"
  | "onAiSettingsChange"
  | "onRequestRootPasswordChange"
>;

/** 分区组件的统一入参：Props 子集 + 行构建上下文 + 弹窗运行时能力 */
export interface SettingsSectionContext
  extends Omit<SettingsSectionProps, "categories" | "notes">, SettingsRowsContext {
  /** 全部分组与笔记：仅「AI 访问权限」分区用来列开关与统计 */
  categories: Category[];
  notes: Note[];
  /** 当前搜索过滤后的行；无关键词时返回该分区全部行 */
  rowsOf: (section: SettingsSection) => SettingRow[];
  /** 分区内各分组段的节点注册表，二级目录跳转与高亮反查靠它 */
  groupRefs: RefObject<Record<string, HTMLElement | null>>;
  /** 改动写入后闪一下「已保存」 */
  flashSaved: () => void;
  /** 跳到某个插件设置分区（key 形如 `plugin:<dirName>:<sectionId>`）；插件管理分区用它实现「配置」按钮 */
  onOpenPluginSection?: (key: string) => void;
}
