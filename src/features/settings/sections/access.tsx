/* AI 访问权限：总开关 + 默认档位，以及按分组 / 单篇笔记的档位设置。 */

import { useMemo, useState } from "react";
import { Icon } from "@/components/common/Icon";
import { AiAccessLevelSelect } from "@/components/common/AiAccessLevelSelect";
import type { AiAccessLevel } from "@/interface/ai/aiAccess";
import { AI_ACCESS_LABELS } from "@/interface/ai/aiAccess";
import { badges } from "@/config/app/settingBadges";
import type { SettingRow } from "@/interface/settings/settingsModal";
import type { EnumOption } from "@/interface/settings/settings";
import { useI18n } from "@/i18n";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

/** 「AI 访问权限」里"未分类"这一组的伪 key（真实分组 id 是随机字符串，不会与它撞） */
const UNCATEGORIZED_KEY = "__uncategorized__";

/**
 * AI 访问三档的分段选项：与「单篇笔记 / 分组」用的是同一套文案（AI_ACCESS_LABELS），
 * 数值在 onChange 里转回 number，档位类型只认 0/1/2。
 */
const ACCESS_LEVEL_OPTIONS: EnumOption[] = ([0, 1, 2] as AiAccessLevel[]).map((level) => ({
  value: String(level),
  label: AI_ACCESS_LABELS[level],
}));

export const buildAccessRows = ({ aiSettings, setAi }: SettingsRowsContext): SettingRow[] => [
  {
    section: "access",
    kind: "toggle",
    badges: badges("live"),
    title: "允许 AI 访问笔记",
    desc: "总开关。关闭后 AI 完全看不到笔记内容：不发送当前笔记、所有笔记工具直接被拒，对话仍可正常进行。",
    keywords: "ai 访问 权限 隐私 限制 开关 access privacy permission",
    value: aiSettings.aiAccessEnabled,
    onChange: (v) => setAi("aiAccessEnabled", v),
  },
  // AI 无法访问笔记时，「新建默认权限」无处生效，两行一并隐藏
  ...(aiSettings.aiAccessEnabled
    ? [
        {
          section: "access" as const,
          kind: "segment" as const,
          badges: badges("live"),
          title: "新建笔记默认权限",
          desc:
            "之后新建的笔记（含 AI 创建、导入）以此档位开局；已有笔记不受影响。",
          keywords: "默认 新建 笔记 权限 档位 note default",
          value: String(aiSettings.defaultNoteAiAccess),
          options: ACCESS_LEVEL_OPTIONS,
          onChange: (v: string) => setAi("defaultNoteAiAccess", Number(v) as AiAccessLevel),
        },
        {
          section: "access" as const,
          kind: "segment" as const,
          badges: badges("live"),
          title: "新建分组默认权限",
          desc:
            "之后新建的分组以此档位开局；分组档位是组内笔记的访问上限。",
          keywords: "默认 新建 分组 权限 档位 category default",
          value: String(aiSettings.defaultCategoryAiAccess),
          options: ACCESS_LEVEL_OPTIONS,
          onChange: (v: string) => setAi("defaultCategoryAiAccess", Number(v) as AiAccessLevel),
        },
      ]
    : []),
];

export const AccessSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => {
  const { t } = useI18n();
  const { aiSettings, categories, notes, onSetCategoryAiAccess, onSetNoteAiAccess } = ctx;

  /** 「AI 访问权限」里展开了哪些分组（key 为分组 id，未分类用 UNCATEGORIZED_KEY） */
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const toggleCategory = (key: string) =>
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** 未分类笔记：没有分组可继承，只能逐篇设 */
  const uncategorized = useMemo(
    // 加密笔记对 AI 恒为禁止档，不参与权限设置
    () => notes.filter((n) => !n.is_deleted && n.category_id === null && n.enc_mode === 0),
    [notes],
  );

  /**
   * 按分组把笔记分桶，并预先算出被分组档位压低的篇数。
   * 原实现在渲染里对每个分组都 notes.filter 一遍（O(分组数 × 笔记数)），
   * 而弹窗的搜索输入、开关改动都会触发重渲染，笔记一多就会明显拖慢。
   */
  const accessByCategory = useMemo(
    () =>
      new Map(
        // 加密分组及其笔记对 AI 恒为禁止档，权限分区里直接不列出
        categories.filter((c) => !c.is_encrypted).map((c) => {
          const rows = notes.filter((n) => !n.is_deleted && n.enc_mode === 0 && n.category_id === c.id);
          return [c.id, { rows, capped: rows.filter((n) => n.ai_access > c.ai_access).length }] as const;
        }),
      ),
    [categories, notes],
  );

  return (
    <>
      <SectionRows section="access" rows={ctx.rowsOf("access")} groupRefs={ctx.groupRefs} />
      <div className="space-y-3">
        <p className="text-[11px] text-faint leading-relaxed">{t("三档权限：禁止（AI 完全看不到）、只读（能读能总结，不能改）、完全（读写都可以）。分组定的是组内上限，展开分组可以给单篇笔记单独设；两层取更严格的那一档。")}</p>

        {!aiSettings.aiAccessEnabled && (
          <div className="flex items-start gap-2 rounded-xl border border-warning-line bg-warning-soft/70 px-3 py-2.5">
            <Icon name="ai-warning" className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-warning" />
            <p className="text-[11px] leading-relaxed text-warning-deep">{t("总开关已关闭，下面的设置暂时不起作用；AI 无法读取任何笔记。")}</p>
          </div>
        )}

        <div className="rounded-xl border border-line divide-y divide-line-soft">
          {categories.filter((c) => !c.is_encrypted).map((c) => {
            const { rows, capped } = accessByCategory.get(c.id) ?? { rows: [], capped: 0 };
            const expanded = expandedCategories.has(c.id);
            return (
              <div key={c.id}>
                <div className="flex items-center gap-2 px-3 py-2.5">
                  <button
                    type="button"
                    onClick={() => toggleCategory(c.id)}
                    disabled={rows.length === 0}
                    className={`flex-shrink-0 w-4 h-4 rounded flex items-center justify-center transition-colors ${
                      rows.length === 0
                        ? "text-faint-soft cursor-default"
                        : "text-faint hover:bg-surface-alt hover:text-body"
                    }`}
                    title={rows.length === 0 ? t("该分组还没有笔记") : expanded ? t("收起笔记") : t("展开设置单篇笔记")}
                    aria-expanded={expanded}
                  >
                    <Icon
                      name="sidebar-chevron-down"
                      className={`w-2.5 h-2.5 transition-transform ${expanded ? "" : "-rotate-90"}`}
                    />
                  </button>
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-body truncate" title={c.name}>
                      {c.name}
                    </p>
                    <p className="text-[10.5px] text-faint">{t("{note_count} 篇{value2}", { note_count: c.note_count, value2: capped > 0 ? t(" · {capped} 篇被分组限制在更低档", { capped: capped }) : "" })}</p>
                  </div>
                  <AiAccessLevelSelect
                    value={c.ai_access}
                    disabled={!onSetCategoryAiAccess}
                    onChange={(level) => void onSetCategoryAiAccess?.(c, level)}
                  />
                </div>

                {expanded && (
                  <div className="bg-app/70 px-3 pb-2.5 pl-9 space-y-1">
                    {rows.map((n) => {
                      const effective = Math.min(n.ai_access, c.ai_access) as AiAccessLevel;
                      return (
                        <div key={n.id} className="flex items-center gap-2 py-1">
                          <span className="min-w-0 flex-1 truncate text-[11.5px] text-body" title={n.title}>
                            {n.title || t("无标题")}
                          </span>
                          {effective !== n.ai_access && (
                            <span className="flex-shrink-0 text-[10px] text-warning">{t("实际{value1}", { value1: t(AI_ACCESS_LABELS[effective]) })}</span>
                          )}
                          <AiAccessLevelSelect
                            value={n.ai_access}
                            size="xs"
                            disabled={!onSetNoteAiAccess}
                            onChange={(level) => void onSetNoteAiAccess?.(n, level)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {/* 未分类笔记没有分组可继承，只能逐篇设 */}
          {uncategorized.length > 0 && (
            <div>
              <div className="flex items-center gap-2 px-3 py-2.5">
                <button
                  type="button"
                  onClick={() => toggleCategory(UNCATEGORIZED_KEY)}
                  className="flex-shrink-0 w-4 h-4 rounded flex items-center justify-center text-faint hover:bg-surface-alt hover:text-body transition-colors"
                  aria-expanded={expandedCategories.has(UNCATEGORIZED_KEY)}
                  title={t("展开设置单篇笔记")}
                >
                  <Icon
                    name="sidebar-chevron-down"
                    className={`w-2.5 h-2.5 transition-transform ${
                      expandedCategories.has(UNCATEGORIZED_KEY) ? "" : "-rotate-90"
                    }`}
                  />
                </button>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium text-body">{t("未分类")}</p>
                  <p className="text-[10.5px] text-faint">{t("{length} 篇 · 逐篇设置", { length: uncategorized.length })}</p>
                </div>
              </div>
              {expandedCategories.has(UNCATEGORIZED_KEY) && (
                <div className="bg-app/70 px-3 pb-2.5 pl-9 space-y-1">
                  {uncategorized.map((n) => (
                    <div key={n.id} className="flex items-center gap-2 py-1">
                      <span className="min-w-0 flex-1 truncate text-[11.5px] text-body" title={n.title}>
                        {n.title || t("无标题")}
                      </span>
                      <AiAccessLevelSelect
                        value={n.ai_access}
                        size="xs"
                        disabled={!onSetNoteAiAccess}
                        onChange={(level) => void onSetNoteAiAccess?.(n, level)}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {categories.length === 0 && uncategorized.length === 0 && (
          <p className="rounded-xl border border-line px-3.5 py-3 text-[11px] text-faint">{t("还没有任何笔记或分组。")}</p>
        )}
      </div>
    </>
  );
};
