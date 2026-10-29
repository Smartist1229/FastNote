/**
 * AI 访问权限：全项目唯一的判定口径。
 *
 * 三档权限（0 禁止 / 1 只读 / 2 完全），分组与笔记各存一档，实际生效值取更严格的：
 *   生效 = min(笔记档位, 所属分组档位)，再受总开关压制（关闭即 0）。
 *
 * 这里只提供"判断"，不提供"过滤"：过滤发生在各自的调用点，因为
 * 「是否可见」还要和「是否已删除 / 是否当前打开」一起判断，混成一个布尔值会丢信息。
 *
 * 约定：禁止档一律表现为"没找到"，不向模型暴露受限内容的存在性与标题；
 * 只读档可以读，但写操作要返回明确的"只读"提示，让模型转告用户而不是反复重试。
 */
import type { AiAccessLevel, AiAccessRules } from "@/interface/aiAccess";
import type { Category, Note } from "@/interface/note";

export type { AiAccessLevel, AiAccessRules };

/** 把任意来源的值收敛到合法档位；非法值按"完全"处理（老数据只有 0/1 或布尔） */
export const normalizeLevel = (value: unknown): AiAccessLevel => {
  // 兼容最早那版布尔：true 曾表示"完全开放"，不能简化成 Number(true)=1（那是只读）
  if (typeof value === "boolean") return value ? 2 : 0;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 2;
  if (n <= 0) return 0;
  return n >= 2 ? 2 : 1;
};

/** 从分组列表构建快照；加密分组一律按 0 记，组内笔记不会继承出可读档位 */
export const buildAiAccessRules = (enabled: boolean, categories: Category[]): AiAccessRules => ({
  enabled,
  categoryLevels: new Map(categories.map((c) => [c.id, c.is_encrypted ? 0 : normalizeLevel(c.ai_access)])),
});

/**
 * 加密内容对 AI 恒为「禁止」：密钥可能根本没解锁，AI 连标题都不该看到。
 * 这里不区分临时解锁与否——解密后重新归入普通笔记，权限按 ai_access 正常生效。
 */
const isEncryptedNote = (note: Pick<Note, "enc_mode">) => note.enc_mode !== 0;

/** 分组的生效档位（总开关关闭 / 分组加密 → 0） */
export const categoryAiLevel = (
  rules: AiAccessRules,
  category: Pick<Category, "ai_access" | "is_encrypted">,
): AiAccessLevel =>
  rules.enabled && !category.is_encrypted ? normalizeLevel(category.ai_access) : 0;

/** 笔记的生效档位：笔记档位与所属分组档位取小；未分类只看自己 */
export const noteAiLevel = (
  rules: AiAccessRules,
  note: Pick<Note, "ai_access" | "category_id" | "enc_mode">,
): AiAccessLevel => {
  if (!rules.enabled || isEncryptedNote(note)) return 0;
  const own = normalizeLevel(note.ai_access);
  if (note.category_id === null) return own;
  const inherited = rules.categoryLevels.get(note.category_id) ?? 2;
  return Math.min(own, inherited) as AiAccessLevel;
};

/** 能否读到这篇笔记（只读及以上） */
export const canAiReadNote = (
  rules: AiAccessRules,
  note: Pick<Note, "ai_access" | "category_id" | "enc_mode">,
): boolean => noteAiLevel(rules, note) >= 1;

/** 能否修改这篇笔记（必须"完全"档） */
export const canAiWriteNote = (
  rules: AiAccessRules,
  note: Pick<Note, "ai_access" | "category_id" | "enc_mode">,
): boolean => noteAiLevel(rules, note) >= 2;

/** 能否看到/检索这个分组（只读及以上） */
export const canAiReadCategory = (
  rules: AiAccessRules,
  category: Pick<Category, "ai_access" | "is_encrypted">,
): boolean => categoryAiLevel(rules, category) >= 1;

/** 能否往这个分组写（新建/移动进去、改名、删除）：必须"完全"档 */
export const canAiWriteCategory = (
  rules: AiAccessRules,
  category: Pick<Category, "ai_access" | "is_encrypted">,
): boolean => categoryAiLevel(rules, category) >= 2;

/** 总开关关闭时的统一拒答文案：明确告诉模型"这是用户设置"，不要反复重试 */
export const AI_ACCESS_DISABLED_NOTE =
  "用户已关闭「AI 访问笔记」权限，所有笔记与分组工具都不可用。不要重试，也不要猜测笔记内容；请说明这一点并只做普通对话。";

/** 禁止档的拒答文案 */
export const AI_ACCESS_DENIED_NOTE =
  "该内容未对 AI 开放（用户在属性或设置里禁止了访问），换一条或让用户自己确认。";

/** 只读档的拒答文案：读没问题，写要说清楚 */
export const AI_READ_ONLY_NOTE =
  "该内容对 AI 是只读的：可以读取，但不能修改。请把结果给用户，并说明这篇笔记需要用户自己改（或在属性里把 AI 访问改为「完全」）。";
