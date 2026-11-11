/* 主题：明暗模式 + 预设 + 自定义取色 + 已保存主题。 */

import { ThemePanel } from "@/components/settings/ThemePanel";
import type { SettingsSectionContext } from "../context";

export const ThemeSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <ThemePanel theme={ctx.theme} onChange={ctx.onThemeChange} />
);
