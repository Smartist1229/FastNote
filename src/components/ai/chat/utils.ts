import { t as translate } from "@/i18n";
import { TOOL_LABELS, toolDetail } from "@/lib/ai/tools";
import type { ToolTrace } from "@/interface/ai/aiOutput";
import type { UiNotice } from "./types";

/** 用户点了"取消"时写进工具结果的固定文案 */
export const CONFIRM_CANCELLED = "用户已取消";

/** 工具轨迹的中文一句话摘要：写进正文，让用户/模型都能看清做了什么 */
const describeTools = (tools: ToolTrace[] | undefined, t: typeof translate): string[] =>
  (tools || []).map(tool => {
    const label = TOOL_LABELS[tool.name] ? t(TOOL_LABELS[tool.name]) : tool.name;
    const detail = tool.result === CONFIRM_CANCELLED ? t("用户已取消") : toolDetail(tool.name, tool.args ?? {}, tool.result, t);
    return `${label}${detail ? ` · ${detail}` : ""}`;
  });

export const renderUiNotice = (notice: UiNotice, tools: ToolTrace[] | undefined, t: typeof translate): string => {
  if (notice.kind === "reply") {
    const body = [notice.prefix, notice.source ? t(notice.source) : ""].filter(Boolean).join("\n\n");
    return body + (notice.unverified?.length ? `\n\n> ${t("提示：本次回答里并没有实际执行「{actions}」，上面的相关表述未经工具结果确认，请以左侧笔记列表的实际状态为准。", { actions: notice.unverified.map(label => t(label)).join(" / ") })}` : "");
  }
  if (notice.kind === "stopped") return [notice.prefix, t("已停止")].filter(Boolean).join("\n\n");
  if (notice.kind === "empty") return t("（模型没有返回有效内容，请重试，或把需求说得更具体一些。）");
  const actions = describeTools(tools, t).map(detail => `- ${detail}`).join("\n");
  if (notice.kind === "failure") {
    return t("本轮请求失败了：{error}\n\n可以检查一下：服务商配置/模型是否可用、网络是否正常，然后重发或点「继续」。", { error: notice.error ?? t("未知错误") })
      + (actions ? `\n\n${t("失败前已完成的操作：\n{actions}", { actions })}` : "");
  }
  return notice.kind === "no-progress"
    ? t("（模型连续两轮重复请求同样的数据、没有新进展，已先停下。已完成的操作为：\n{actions}\n\n还需要继续的话，回一句「继续」并说明下一步要做什么。）", { actions })
    : t("（本次操作步骤已达上限，先停在这里。已完成的操作为：\n{actions}\n\n还需要继续的话，回一句「继续」就行。）", { actions });
};
