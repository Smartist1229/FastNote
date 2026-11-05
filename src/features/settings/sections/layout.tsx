/* 界面布局：启动时的侧边栏折叠与 AI 面板状态。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildLayoutRows = ({ appSettings, setApp }: SettingsRowsContext): SettingRow[] => [
  {
    section: "layout",
    kind: "toggle",
    badges: badges("startup"),
    title: "启动时折叠分组侧边栏",
    desc: "只是启动时的布局状态，不跟随运行时的折叠操作；下次打开软件才会生效。",
    keywords: "侧边栏 折叠 sidebar 布局 启动",
    value: appSettings.layout.sidebarCollapsed,
    onChange: (v) => setApp("layout", "sidebarCollapsed", v),
  },
  // 依赖 enableAI：关闭 AI 能力时不出现这个「启动时打开面板」的开关
  ...(appSettings.general.enableAI
    ? [
        {
          section: "layout" as const,
          kind: "toggle" as const,
          badges: badges("startup"),
          title: "启动时打开 AI 对话面板",
          desc: "只是启动时的布局状态，不跟随运行时的开关操作；下次打开软件才会生效。",
          keywords: "ai 面板 对话 布局 panel 启动",
          value: appSettings.layout.aiPanelOpen,
          onChange: (v: boolean) => setApp("layout", "aiPanelOpen", v),
        },
      ]
    : []),
];

export const LayoutSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="layout" rows={ctx.rowsOf("layout")} groupRefs={ctx.groupRefs} />
);
