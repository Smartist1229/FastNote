/* 快捷键：全软件键位一览，按当前设置置灰不可用的项。 */

import { ShortcutPanel } from "@/components/settings/ShortcutPanel";
import type { SettingsSectionContext } from "../context";

export const ShortcutsSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <ShortcutPanel settings={ctx.appSettings} />
);
