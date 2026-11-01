/**
 * AI 访问权限的类型契约（规则与判定逻辑在 lib/aiAccess.ts）。
 *
 * 三档权限，分组与笔记共用同一套取值；两层取"更严格"的那一档：
 *   0 禁止  —— AI 完全看不到（不列出、不检索、不读、不改）
 *   1 只读  —— 可以搜到、读到，但所有写操作都被拒绝
 *   2 完全  —— 读写、增删、移动都允许
 *
 * 实际生效值 = min(笔记档位, 所属分组档位)；未分类笔记没有分组可继承，只看自己。
 * 总开关关闭时一律按 0 处理。
 */

/** 访问档位：0 禁止 / 1 只读 / 2 完全 */
export type AiAccessLevel = 0 | 1 | 2;

/** 一次请求内使用的规则快照：发送前重建，改动在下一轮立即生效 */
export interface AiAccessRules {
  /** 总开关；false 时所有笔记工具都不可用，对话退化为普通聊天 */
  enabled: boolean;
  /** 分组档位上限：组内笔记的生效档位不会超过它 */
  categoryLevels: Map<number, AiAccessLevel>;
}

/** 档位的中文名：界面与提示词统一引用，避免各处文案不一致 */
export const AI_ACCESS_LABELS: Record<AiAccessLevel, string> = {
  0: "禁止",
  1: "只读",
  2: "完全",
};
