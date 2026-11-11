/**
 * 设置行徽标目录：行模型（RowBase.badges）只引用徽标 id，
 * 文案与配色统一由 settingBadges.json 提供，渲染见 features/settings/controls.tsx 的 RowBadge。
 * 新增徽标先在 JSON 里登记，行上即可引用其 id。
 */
import badgesJson from "./settingBadges.json";

/** 徽标色调：只作为样式区分（primary 主色 / amber 琥珀 / red 红 / purple 紫） */
export type SettingBadgeTone = "primary" | "amber" | "red" | "purple";

/** 徽标展示定义：label 走 translate()（中文 key），hint 是可选的悬停提示 */
export interface SettingBadgeDef {
  label: string;
  hint?: string;
  tone: SettingBadgeTone;
}

/** 徽标 id：目录 JSON 的 key */
export type SettingBadgeId = keyof typeof badgesJson;

/** 徽标目录：id → 展示定义 */
export const SETTING_BADGES = badgesJson as Record<SettingBadgeId, SettingBadgeDef>;

/** 按 id 取徽标定义；未知 id 兜底为把 id 原样当文案，避免渲染层拿到 undefined */
export const getBadge = (id: SettingBadgeId | string): SettingBadgeDef =>
  (SETTING_BADGES as Record<string, SettingBadgeDef | undefined>)[id] ?? { label: id, tone: "primary" };

/** 行声明的快捷写法：badges("live", "danger") —— 参数受目录约束，写错 id 编译期即报错 */
export const badges = (...ids: SettingBadgeId[]): SettingBadgeId[] => ids;
