/* AI 对话行为：轮数、流式、确认、轨迹、输出长度与思考参数。 */

import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

export const buildChatRows = ({ aiSettings, setAi }: SettingsRowsContext): SettingRow[] => [
  {
    section: "chat",
    kind: "number",
    badges: badges("live"),
    title: "深度思考最少字数",
    desc: "低于这个字数会提醒模型重新深入思考（0 表示不限制）。",
    keywords: "思考 thinking 字数",
    value: aiSettings.minThinkingLen,
    min: 0,
    max: 1000,
    step: 10,
    unit: "字",
    onChange: (v) => setAi("minThinkingLen", v),
  },
  {
    section: "chat",
    kind: "number",
    badges: badges("live"),
    title: "最多工具轮数",
    desc: "一次提问里模型最多连续调用几轮工具；0 表示不限制。",
    keywords: "工具 轮数 rounds tool",
    value: aiSettings.maxRounds,
    min: 0,
    max: 200,
    unit: "轮",
    onChange: (v) => setAi("maxRounds", v),
  },
  {
    section: "chat",
    kind: "number",
    badges: badges("live"),
    title: "最大输出长度",
    desc: "单次回复最多生成多少 token；调大能明显减少「长文被截断」。",
    keywords: "输出 token 长度 截断 maxtokens",
    value: aiSettings.maxTokens,
    min: 256,
    max: 32000,
    step: 512,
    unit: "token",
    onChange: (v) => setAi("maxTokens", v),
  },
  {
    section: "chat",
    kind: "toggle",
    badges: badges("live"),
    title: "思考过浅时重来一次",
    desc: "关闭后直接采纳模型的回答，不再要求重写（响应更快）。",
    keywords: "思考 重试 retry",
    value: aiSettings.retryShallowThinking,
    onChange: (v) => setAi("retryShallowThinking", v),
  },
  {
    section: "chat",
    kind: "toggle",
    badges: badges("live"),
    title: "流式输出",
    desc: "边生成边显示；关闭后等整段生成完再一次性显示。",
    keywords: "流式 streaming 输出",
    value: aiSettings.streaming,
    onChange: (v) => setAi("streaming", v),
  },
  {
    section: "chat",
    kind: "toggle",
    badges: badges("live"),
    title: "自动生成会话标题",
    desc: "首轮对话后自动用一句话概括，关闭后标题保持「新对话」。",
    keywords: "标题 title 自动",
    value: aiSettings.autoTitle,
    onChange: (v) => setAi("autoTitle", v),
  },
  {
    section: "chat",
    kind: "toggle",
    badges: badges("live"),
    title: "默认开启操作确认",
    desc: "写操作（创建/修改/删除）执行前先弹确认框，面板里仍可临时切换。标签操作不在此列：AI 打标签、删自己建的标签一律直接执行。",
    keywords: "确认 confirm 操作 标签",
    value: aiSettings.confirmByDefault,
    onChange: (v) => setAi("confirmByDefault", v),
  },
  {
    section: "chat",
    kind: "toggle",
    badges: badges("live"),
    title: "显示工具执行轨迹",
    desc: "在回复上方逐条显示执行过的工具，可展开查看参数与结果。",
    keywords: "工具 轨迹 trace 执行",
    value: aiSettings.showToolTrace,
    onChange: (v) => setAi("showToolTrace", v),
  },
];

export const ChatSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="chat" rows={ctx.rowsOf("chat")} groupRefs={ctx.groupRefs} />
);
