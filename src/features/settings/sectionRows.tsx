/* 数据驱动设置行的统一渲染：按 kind 派发控件，并按 group 分段。 */

import { memo } from "react";
import type { RefObject } from "react";
import type { SettingRow, SettingsSection } from "@/interface/settings/settingsModal";
import { ColorPicker } from "@/components/settings/ColorPicker";
import { useI18n } from "@/i18n";
import {
  ColorListInput,
  NumberInput,
  RowBadge,
  SegmentedInput,
  SelectInput,
  Switch,
} from "./controls";

/**
 * 行的统一渲染：左标题 + 说明 + 徽标（按 badges 引用的 id 逐个渲染），右侧按 kind 派发到具体控件。
 *
 * 用 memo 包一层：搜索输入、目录高亮、保存提示等状态变化都会重渲染整个弹窗，
 * 但这些变化并不改动具体某一行的 row 对象（row 引用只在设置值变化时重建），
 * 交给 memo 拦掉无谓的行级重渲染。
 */
const RowView = memo(function RowView({ row }: { row: SettingRow }) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1 basis-[220px]">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-body">{t(row.title)}</span>
          {(row.badges ?? []).map((id) => (
            <RowBadge key={id} id={id} />
          ))}
        </div>
        <p className="text-[11px] text-faint leading-relaxed mt-1">{t(row.desc)}</p>
      </div>
      <div className="max-w-full pt-0.5">
        {row.kind === "toggle" && <Switch value={row.value} onChange={row.onChange} />}
        {row.kind === "number" && (
          <NumberInput
            value={row.value}
            min={row.min}
            max={row.max}
            step={row.step ?? 1}
            unit={row.unit ? t(row.unit) : undefined}
            onChange={row.onChange}
          />
        )}
        {row.kind === "segment" && (
          <SegmentedInput value={row.value} options={row.options} onChange={row.onChange} />
        )}
        {row.kind === "select" && (
          <SelectInput label={t(row.title)} value={row.value} options={row.options} onChange={row.onChange} />
        )}
        {row.kind === "color" && (
          <ColorPicker
            value={row.value}
            onChange={row.onChange}
            label={t(row.title)}
            showValue
            className="min-w-[104px]"
          />
        )}
        {row.kind === "colorList" && (
          <ColorListInput
            value={row.value}
            placeholder={row.placeholder}
            onChange={row.onChange}
          />
        )}
      </div>
    </div>
  );
});

/**
 * 按 group 切段：相邻同组行归为一段，段前带一个小标题。
 * 没有 group 的行（通用 / 列表 / 布局…）整段落在同一个无名分组里，渲染结果与原来一致。
 */
const chunkByGroup = (rows: SettingRow[]): { group: string | null; items: SettingRow[] }[] => {
  const chunks: { group: string | null; items: SettingRow[] }[] = [];
  for (const row of rows) {
    const group = row.group ?? null;
    const last = chunks[chunks.length - 1];
    if (last && last.group === group) last.items.push(row);
    else chunks.push({ group, items: [row] });
  }
  return chunks;
};

/** 分组节点的 key：分组名只在分区内唯一（「视图」这类名字多个分区都有） */
export const groupKey = (section: SettingsSection, group: string | null) =>
  `${section}::${group ?? ""}`;

/**
 * 一个分区的数据行区域：带 group 的分区按组分段，分组节点登记到 groupRefs，
 * 供左侧二级目录跳转与滚动高亮反查。
 */
export const SectionRows: React.FC<{
  section: SettingsSection;
  rows: SettingRow[];
  groupRefs: RefObject<Record<string, HTMLElement | null>>;
}> = ({ section, rows, groupRefs }) => {
  const { t } = useI18n();
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1">
      {chunkByGroup(rows).map((chunk) => (
        <div
          key={chunk.group ?? "_"}
          className="divide-y divide-line-soft"
          ref={(el) => {
            groupRefs.current[groupKey(section, chunk.group)] = el;
          }}
        >
          {chunk.group && (
            <p className="pt-3 pb-1 text-[11px] font-semibold text-muted">
              {t(chunk.group)}
            </p>
          )}
          {chunk.items.map((row) => (
            <RowView key={`${row.section}.${row.title}`} row={row} />
          ))}
        </div>
      ))}
    </div>
  );
};
