/* 设置窗口的分区、设置项行模型与窗口 Props。 */

import type { AiPromptEntry, AiProvider, AiSettings } from "./ai";
import type { AppSettings } from "./settings";

export type SettingsSection =
  | "general"
  | "editor"
  | "view"
  | "layout"
  | "provider"
  | "chat"
  | "context"
  | "memory"
  | "reset"
  | "backup"
  | "about";

export interface SectionMeta {
  key: SettingsSection;
  label: string;
  icon: string;
  group: "软件" | "AI" | "数据" | "其他";
}

/** live = 改完立刻生效；startup = 只影响软件初始化阶段 */
export type Scope = "live" | "startup";

export interface RowBase {
  section: SettingsSection;
  title: string;
  desc: string;
  scope: Scope;
  /** 供搜索命中的额外关键词 */
  keywords?: string;
  /** 依赖未满足时置灰：控件保留在原位，但不可交互（例如未开启托盘时的关闭行为） */
  disabled?: boolean;
}

/** 设置项行模型：开关 / 数值 / 分段按钮组 */
export type SettingRow =
  | (RowBase & { kind: "toggle"; value: boolean; onChange: (v: boolean) => void })
  | (RowBase & {
      kind: "number";
      value: number;
      min: number;
      max: number;
      step?: number;
      unit?: string;
      onChange: (v: number) => void;
    })
  | (RowBase & {
      kind: "segment";
      value: string;
      options: { value: string; label: string }[];
      onChange: (v: string) => void;
    });

export interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 打开时定位到的分区；不传则定位到第一个分区 */
  defaultSection?: SettingsSection;
  appSettings: AppSettings;
  /** 软件设置变更：实时持久化 + 实时生效，由 App 统一处理 */
  onAppSettingChange: (
    category: keyof AppSettings,
    field: string,
    value: boolean | number | string,
  ) => void;
  /** 恢复软件设置默认值 */
  onResetAppSettings: () => void;
  aiSettings: AiSettings;
  onAiSettingsChange: (next: AiSettings) => void;
  aiProviders: AiProvider[];
  aiSelectedProviderId: number;
  onAiProvidersChange: (list: AiProvider[]) => void;
  onAiSelectedProviderChange: (id: number) => void;
  aiPrompts: AiPromptEntry[];
  onAiPromptsChange: (next: AiPromptEntry[]) => void;
}
