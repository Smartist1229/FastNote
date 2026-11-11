/* 笔记列表：默认排序字段与方向。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildViewRows = ({ appSettings, setApp }: SettingsRowsContext): SettingRow[] => [
  {
    section: "view",
    kind: "segment",
    badges: badges("live"),
    title: "默认排序字段",
    desc: "笔记列表默认按照哪个字段排序。",
    keywords: "排序 sort 创建 更新 标题",
    value: appSettings.view.sortBy,
    options: [
      { value: "created_at", label: "创建时间" },
      { value: "updated_at", label: "更新时间" },
      { value: "title", label: "标题" },
    ],
    onChange: (v) => setApp("view", "sortBy", v),
  },
  {
    section: "view",
    kind: "segment",
    badges: badges("live"),
    title: "排序方向",
    desc: "升序（由早到晚 / A→Z）或降序。",
    keywords: "排序 方向 升序 降序 asc desc",
    value: appSettings.view.sortOrder,
    options: [
      { value: "asc", label: "升序" },
      { value: "desc", label: "降序" },
    ],
    onChange: (v) => setApp("view", "sortOrder", v as "asc" | "desc"),
  },
];

export const ViewSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="view" rows={ctx.rowsOf("view")} groupRefs={ctx.groupRefs} />
);
