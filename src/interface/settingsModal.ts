/* 设置窗口的组件层类型：分区枚举、设置行模型与窗口 Props。 */

import type { AiPromptEntry, AiProvider, AiSettings } from "./ai";
import type { AiAccessLevel } from "./aiAccess";
import type { Category, Note } from "./note";
import type { AppSettings, EnumOption } from "./settings";
import type { ThemeSettings } from "./theme";

/** 设置窗口的分区（左侧导航项），写法顺序即导航中的排列顺序 */
export type SettingsSection =
  /** 通用：启动行为、托盘、关闭方式、AI 总开关 */
  | "general"
  /** 编辑器：字号、Ctrl+滚轮缩放 */
  | "editor"
  /** 笔记列表：排序字段与方向 */
  | "view"
  /** 界面布局：启动时的侧边栏 / AI 面板状态 */
  | "layout"
  /** 快捷键：全软件键位一览（只读，跟随设置置灰） */
  | "shortcuts"
  /** 主题：明暗模式、预设主题、自定义取色、保存的主题 */
  | "theme"
  /** 语义搜索：本地模型下载与索引状态 */
  | "semantic"
  /** 工具箱：通用下载工具与下载线程数 */
  | "toolbox"
  /** AI 服务商：增删改、拉取模型 */
  | "provider"
  /** AI 对话行为：轮数、流式、确认、轨迹、输出长度 */
  | "chat"
  /** AI 上下文：预算、保留条数、工具结果长度 */
  | "context"
  /** AI 记忆与提示词 */
  | "memory"
  /** AI 访问权限：总开关 + 逐个分组开关（单篇笔记在「笔记属性」里改） */
  | "access"
  /** 恢复软件设置默认值 */
  | "reset"
  /** 备份与恢复 */
  | "backup"
  /** 关于 */
  | "about";

/** 分区在侧栏的展示信息；group 决定导航里的分组标题 */
export interface SectionMeta {
  key: SettingsSection;
  label: string;
  icon: string;
  group: "软件" | "AI" | "数据" | "其他";
}

/**
 * 设置项的生效时机：
 * live = 改完立刻生效；startup = 只在下次启动 / 初始化阶段读取
 * （如启动清空回收站、开机自启、初始布局）。
 */
export type Scope = "live" | "startup";

/** 所有设置行的公共字段 */
export interface RowBase {
  section: SettingsSection;
  title: string;
  desc: string;
  scope: Scope;
  /**
   * 分区内的小分组：相邻同 group 的行归到同一段，前面加一行小标题。
   * 只有设置项多到需要再切一刀的分区（目前是「编辑器」）才用，其余不传。
   */
  group?: string;
  /** 供搜索命中的额外关键词 */
  keywords?: string;
  /**
   * 危险标记：只是在标题后额外挂一枚「不建议修改」徽标，
   * 用来提示"改了可能出问题"的项（例如关掉单例模式导致多进程同时写库）。
   */
  danger?: boolean;
}

/**
 * 设置项行模型，按 kind 决定渲染的控件与取值类型：
 * toggle = 开关；number = 数值输入（min/max 必填）；
 * segment = 分段按钮组（选项少）；select = 下拉框（选项多，一行放不下时用）；
 * color = 自绘取色器（松手提交）；colorList = 逗号分隔的十六进制色值列表。
 */
export type SettingRow =
  | (RowBase & { kind: "toggle"; value: boolean; onChange: (v: boolean) => void })
  | (RowBase & {
      kind: "number";
      value: number;
      min: number;
      max: number;
      step?: number;
      /** 数值单位后缀（如 px、token） */
      unit?: string;
      onChange: (v: number) => void;
    })
  | (RowBase & {
      kind: "segment";
      value: string;
      /** value 必须是其中一项的 value */
      options: EnumOption[];
      onChange: (v: string) => void;
    })
  | (RowBase & {
      kind: "select";
      value: string;
      options: EnumOption[];
      onChange: (v: string) => void;
    })
  | (RowBase & { kind: "color"; value: string; onChange: (v: string) => void })
  | (RowBase & {
      kind: "colorList";
      value: string;
      placeholder?: string;
      onChange: (v: string) => void;
    });

/** 设置窗口 Props：软件设置与 AI 设置分别由父级持有，这里只做展示与回调 */
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
  /** 恢复软件设置默认值（只删 app.config.* 键，不影响 AI 设置） */
  onResetAppSettings: () => void;
  /** 只恢复编辑器设置，不影响其他软件设置、主题与 AI 设置 */
  onResetEditorSettings: () => void;
  /** 只恢复主题设置，不影响其他软件设置与 AI 设置 */
  onResetThemeSettings: () => void;
  aiSettings: AiSettings;
  /** AI 设置整对象回写（与对话面板的 patch 形式不同） */
  onAiSettingsChange: (next: AiSettings) => void;
  aiProviders: AiProvider[];
  /** 当前选中的服务商 id；0 = 尚未选择 */
  aiSelectedProviderId: number;
  onAiProvidersChange: (list: AiProvider[]) => void;
  onAiSelectedProviderChange: (id: number) => void;
  aiPrompts: AiPromptEntry[];
  onAiPromptsChange: (next: AiPromptEntry[]) => void;
  /** 全部分组与笔记：仅「AI 访问权限」分区用来列开关与统计 */
  categories?: Category[];
  notes?: Note[];
  /** 设置分组的 AI 访问档位（0 禁止 / 1 只读 / 2 完全） */
  onSetCategoryAiAccess?: (category: Category, level: AiAccessLevel) => void | Promise<void>;
  /** 设置单篇笔记的 AI 访问档位 */
  onSetNoteAiAccess?: (note: Note, level: AiAccessLevel) => void | Promise<void>;
  /** 主题设置：模式、预设、自定义令牌与已保存主题 */
  theme: ThemeSettings;
  /** 主题整对象回写：改动立即生效并落库（设置项都是实时的） */
  onThemeChange: (next: ThemeSettings) => void;
}
