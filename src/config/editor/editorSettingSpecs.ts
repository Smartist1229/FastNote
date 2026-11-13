/**
 * 编辑器设置项的「规格表」：分组、控件类型、取值约束、联动隐藏与文案。
 *
 * 一处声明三处消费，避免同一个开关在默认值 / 校验 / 弹窗三处各写一遍：
 *   1. config/appDefaults.ts    —— 默认值照这里的字段取值（类型在此对齐）；
 *   2. stores/appSettingsStore  —— 读库时按 kind 校验（枚举白名单、数值区间），
 *                                  并把缺失 / 非法的键用默认值补写回数据库；
 *   3. SettingsModal            —— 按 kind 渲染开关 / 数字 / 分段控件，group 即小标题。
 *
 * 字段全部是 EditorSettings 的顶层键：库里一个键一个值，没有嵌套路径。
 * 新增一项只改本文件 + interface/settings.ts 的类型 + appDefaults 的默认值。
 */
import type { EditorSettings, EnumOption } from "@/interface/settings/settings";

/** 设置弹窗里的分组小标题；顺序即弹窗里的排列顺序 */
export type EditorSettingGroup =
  | "视图"
  | "编辑"
  | "预览"
  | "排版"
  | "工具栏"
  | "状态栏"
  | "大纲"
  | "查找替换"
  | "主题与其他";

interface SpecBase {
  /** EditorSettings 的字段名，同时是数据库键 app.config.editor.<field> */
  field: keyof EditorSettings;
  group: EditorSettingGroup;
  title: string;
  desc: string;
  /** 供设置搜索命中的额外关键词 */
  keywords?: string;
  /** 依赖的开关没打开时整行隐藏；打开后自动出现 */
  hiddenWhen?: (s: EditorSettings) => boolean;
}

/** 四种控件：开关 / 数字 / 分段（枚举） / 下拉（枚举，选项多） */
export type EditorSettingSpec =
  | (SpecBase & { kind: "toggle" })
  | (SpecBase & {
      kind: "number";
      min: number;
      max: number;
      /** 默认 1；小于 1 时输入框保留对应小数位 */
      step?: number;
      /** 数值单位后缀（px、ms、em…） */
      unit?: string;
    })
  | (SpecBase & { kind: "segment"; options: EnumOption[] })
  /** 选项多（6 个以上）时用下拉而不是分段按钮，避免一行排不下 */
  | (SpecBase & { kind: "select"; options: EnumOption[] })
  /** 单个十六进制颜色：用自绘取色器，松手才提交 */
  | (SpecBase & { kind: "color" })
  /** 逗号分隔的十六进制颜色列表 */
  | (SpecBase & { kind: "colorList"; placeholder?: string });

/**
 * 全部编辑器设置项。
 *
 * 默认值不写在这里，统一在 config/appDefaults.ts（那里是唯一默认值来源）；
 * 但取值区间必须和默认值自洽，否则读库时会被夹到边界上。
 */
import { VIEW_SPECS } from "./specs/view";
import { EDIT_SPECS } from "./specs/edit";
import { PREVIEW_SPECS } from "./specs/preview";
import { TYPOGRAPHY_SPECS } from "./specs/typography";
import { TOOLBAR_SPECS } from "./specs/toolbar";
import { STATUS_BAR_SPECS } from "./specs/statusbar";
import { OUTLINE_SPECS } from "./specs/outline";
import { FIND_REPLACE_SPECS } from "./specs/findReplace";
import { THEME_SPECS } from "./specs/theme";

/** 全部编辑器设置项：按分组展开，顺序即设置弹窗里的排列顺序 */
export const EDITOR_SETTING_SPECS: EditorSettingSpec[] = [
  ...VIEW_SPECS,
  ...EDIT_SPECS,
  ...PREVIEW_SPECS,
  ...TYPOGRAPHY_SPECS,
  ...TOOLBAR_SPECS,
  ...STATUS_BAR_SPECS,
  ...OUTLINE_SPECS,
  ...FIND_REPLACE_SPECS,
  ...THEME_SPECS,
];

/** field → 规格，读库校验时按字段取约束 */
export const EDITOR_SPEC_BY_FIELD: Partial<
  Record<keyof EditorSettings, EditorSettingSpec>
> = Object.fromEntries(EDITOR_SETTING_SPECS.map((s) => [s.field, s]));

