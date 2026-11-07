/* 快捷键：全软件键位一览，可改键、可恢复默认，按当前设置置灰不可用的项。 */

import { ShortcutPanel } from "@/components/settings/ShortcutPanel";
import type { SettingsSectionContext } from "../context";

export const ShortcutsSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <ShortcutPanel
    settings={ctx.appSettings}
    // 键位是 `app.config.shortcuts.<动作 id>`，字段名就是动作 id
    onChange={(actionId, combo) => ctx.setApp("shortcuts", actionId, combo)}
  />
);
