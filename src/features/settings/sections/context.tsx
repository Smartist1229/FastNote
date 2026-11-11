/* AI 上下文：预算、保留条数、工具结果注入上限与辅助模型。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildContextRows = ({ aiSettings, aiProviders, setAi }: SettingsRowsContext): SettingRow[] => {
  /** 当前选中的辅助服务商；id 为 0 表示跟随当前对话，此时没有可选模型 */
  const helperProvider = aiProviders.find((provider) => provider.id === aiSettings.helperProviderId);
  const helperModels = helperProvider?.enabled_models ?? [];
  // 库里存的模型可能已经不在勾选列表里（服务商那侧改了勾选）：补一个同名选项，
  // 否则下拉的 value 找不到对应项，界面会显示成空值，看起来像"设置丢了"。
  const staleHelperModel = aiSettings.helperModel && !helperModels.includes(aiSettings.helperModel)
    ? [{ value: aiSettings.helperModel, label: aiSettings.helperModel }]
    : [];

  return [
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
      desc: "单个工具结果最多带多少字进上下文；超出部分会做结构化裁剪，保留键名并标注省略。",
      keywords: "工具 结果 上限 toolresult",
      value: aiSettings.toolResultChars,
      min: 200,
      max: 20000,
      step: 100,
      unit: "字",
      onChange: (v) => setAi("toolResultChars", v),
    },
    {
      section: "context",
      kind: "toggle",
      badges: badges("live"),
      title: "自动召回相关笔记",
      desc: "每次提问前用本地语义检索找出可能相关的旧笔记，第一轮就带给模型，省掉它先跑一轮搜索的往返。需要先在「语义搜索」分区下载模型并建好索引，否则会自动跳过。",
      keywords: "召回 rag 语义 检索 recall 相关笔记 vector",
      value: aiSettings.semanticRecall,
      onChange: (v) => setAi("semanticRecall", v),
    },
    {
      section: "context",
      kind: "select",
      badges: badges("live"),
      title: "辅助任务服务商",
      desc: "上下文摘要和会话标题用哪个服务商。这类任务不需要强模型，指一个便宜的服务商能明显省成本。",
      keywords: "辅助 模型 helper 摘要 标题 成本 summary title",
      value: String(aiSettings.helperProviderId),
      options: [
        { value: "0", label: "跟随当前对话的服务商" },
        ...aiProviders.map((provider) => ({ value: String(provider.id), label: provider.name })),
      ],
      onChange: (v) => setAi("helperProviderId", Number(v) || 0),
    },
    {
      section: "context",
      kind: "select",
      title: "辅助任务模型",
      desc: "该服务商下用于摘要/标题的模型。只有服务商设置里勾选过的模型会出现在这里；留空表示跟随该服务商当前选中的模型。",
      keywords: "辅助 模型 helper 摘要 标题 model",
      value: aiSettings.helperModel,
      options: [
        { value: "", label: "跟随该服务商的当前模型" },
        ...helperModels.map((model) => ({ value: model, label: model })),
        ...staleHelperModel,
      ],
      onChange: (v) => setAi("helperModel", v),
    },
  ];
};

export const ContextSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="context" rows={ctx.rowsOf("context")} groupRefs={ctx.groupRefs} />
);
