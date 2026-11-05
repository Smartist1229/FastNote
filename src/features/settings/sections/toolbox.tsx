/* 工具箱：通用下载工具，与语义模型下载共用线程数。 */

import { ToolboxPanel } from "@/components/settings/ToolboxPanel";
import type { SettingsSectionContext } from "../context";

export const ToolboxSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <ToolboxPanel
    threads={ctx.appSettings.general.downloadThreads}
    onThreadsChange={(v) => ctx.setApp("general", "downloadThreads", v)}
  />
);
