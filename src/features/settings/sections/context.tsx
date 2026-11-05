/* AI 上下文：预算、保留条数与工具结果注入上限。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildContextRows = ({ aiSettings, setAi }: SettingsRowsContext): SettingRow[] => [
  {
    section: "context",
    kind: "number",
    badges: badges("live"),
    title: "上下文预算",
    desc: "历史超过这个规模就把更早的对话压成摘要，避免上下文过长。",
    keywords: "上下文 context token 预算",
    value: aiSettings.contextBudget,
    min: 2000,
    max: 200000,
    step: 1000,
    unit: "token",
    onChange: (v) => setAi("contextBudget", v),
  },
  {
    section: "context",
    kind: "number",
    badges: badges("live"),
    title: "始终保留最近消息",
    desc: "无论上下文多长，最近这么多条消息都完整保留。",
    keywords: "上下文 保留 keep 消息",
    value: aiSettings.keepRecent,
    min: 2,
    max: 50,
    unit: "条",
    onChange: (v) => setAi("keepRecent", v),
  },
  {
    section: "context",
    kind: "number",
    badges: badges("live"),
    title: "工具结果注入上限",
    desc: "单个工具结果最多带多少字进上下文，超出只保留开头。",
    keywords: "工具 结果 上限 toolresult",
    value: aiSettings.toolResultChars,
    min: 200,
    max: 20000,
    step: 100,
    unit: "字",
    onChange: (v) => setAi("toolResultChars", v),
  },
];

export const ContextSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="context" rows={ctx.rowsOf("context")} groupRefs={ctx.groupRefs} />
);
