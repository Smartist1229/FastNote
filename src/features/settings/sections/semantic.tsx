/* 语义搜索：本地模型下载/删除、索引重建/取消与进度。 */

import { SemanticPanel } from "@/components/settings/SemanticPanel";
import type { SettingsSectionContext } from "../context";

export const SemanticSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SemanticPanel
    enabled={ctx.appSettings.general.semanticSearch}
    onEnabledChange={(v) => ctx.setApp("general", "semanticSearch", v)}
    autoIndex={ctx.appSettings.general.semanticAutoIndex}
    onAutoIndexChange={(v) => ctx.setApp("general", "semanticAutoIndex", v)}
    modelId={ctx.appSettings.general.semanticModel}
    onModelChange={(id) => ctx.setApp("general", "semanticModel", id)}
  />
);
