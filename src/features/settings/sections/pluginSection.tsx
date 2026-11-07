/* 插件设置分区：按贡献的 fields schema 渲染控件（复用设置控件，与设置弹窗其余分区同一套映射）。
 * 控件种类：boolean → 开关、number → 数字框、select → 下拉、string → 文本框、
 * shortcut → 组合键捕获框（点一下按键即写入 "Ctrl+Alt+P"）。
 *
 * 这里是插件配置的唯一入口：manifest.config 非空且插件没有主动贡献分区时，宿主会自动生成一个分区。
 * 值存到该插件自己的 config.json：打开时走 plugin_read_config 读盘（不读宿主激活缓存），
 * 改一项立即 plugin_write_config 写盘，并由宿主在极短防抖后重激活插件——
 * 主题 / 隐藏统计这类在 activate 时应用的副作用立刻生效，没有保存按钮。
 * 重激活期间宿主会保留旧的设置分区（registry.beginSettingsSectionRefresh），
 * 所以本分区不会被卸载重建，输入框不会失焦。
 */

import { useEffect, useState } from "react";

import { readPluginConfig } from "@/api/system/plugins";
import { useToast } from "@/components/common/Toast";
import { useI18n } from "@/i18n";
import type { PluginConfigField } from "@/interface/system/plugins";
import { pluginHost } from "@/plugins/host";
import type { PluginSettingsSectionEntry } from "@/plugins/contributions";
import type { PluginSectionField } from "@/plugins/registry";
import { NumberInput, SelectInput, ShortcutInput, Switch } from "../controls";

/** 分组标题样式：与设置弹窗里数据行的分组小标题保持同一套（见 sectionRows.tsx） */
const GROUP_TITLE_CLASS = "pt-3 pb-1 text-[11px] font-semibold text-muted";

/** 把 Tauri 抛出的错误（字符串 / Error / 其他）压成一行提示文案 */
const errorText = (e: unknown) =>
  typeof e === "string" ? e : e instanceof Error ? e.message : String(e);

export const PluginSectionView: React.FC<{ entry: PluginSettingsSectionEntry }> = ({ entry }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const { pluginId, section } = entry;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);

  // 打开 / 切换分区时重新读盘：读取失败只提示，表单回退到 schema 默认值
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    readPluginConfig(pluginId)
      .then((next) => {
        if (!cancelled) setValues(next);
      })
      .catch((e) => {
        if (!cancelled) {
          setValues({});
          showToast(t("读取配置失败：{value1}", { value1: errorText(e) }), "error");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // fields 随 section 引用变化，但真正需要重新读取的只有 pluginId
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pluginId]);

  /** 当前值：用户未改过时回落到 schema 默认值 */
  const valueOf = (field: PluginConfigField): unknown =>
    values[field.key] !== undefined ? values[field.key] : field.default;

  /** 即时生效：本地更新 + 立即写盘（只写这一项，后端按 schema 过滤并浅合并） */
  const update = (key: string, value: unknown) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    // 走 pluginHost.setConfig：落盘后宿主会重激活插件，activate 时应用的副作用立刻生效
    pluginHost.setConfig(pluginId, { [key]: value }).catch((e) => {
      showToast(t("保存配置失败：{value1}", { value1: errorText(e) }), "error");
    });
  };

  const renderControl = (field: PluginConfigField) => {
    const value = valueOf(field);
    switch (field.kind) {
      case "boolean":
        return <Switch value={value === true} onChange={(next) => update(field.key, next)} />;
      case "number":
        return (
          <NumberInput
            value={typeof value === "number" ? value : 0}
            min={field.min ?? 0}
            max={field.max ?? 999999}
            step={field.step ?? 1}
            onChange={(next) => update(field.key, next)}
          />
        );
      case "select":
        return (
          <SelectInput
            label={t(field.label)}
            value={typeof value === "string" ? value : ""}
            options={field.options ?? []}
            onChange={(next) => update(field.key, next)}
          />
        );
      case "shortcut":
        // 组合键：点一下捕获，按什么就是什么（不用手写 "Ctrl+Alt+P"）
        return (
          <ShortcutInput
            value={typeof value === "string" ? value : ""}
            onChange={(next) => update(field.key, next)}
          />
        );
      case "string":
      default:
        return (
          <input
            type="text"
            value={typeof value === "string" ? value : ""}
            onChange={(e) => update(field.key, e.target.value)}
            className="w-[280px] px-2 py-1.5 text-xs input-modern bg-app/60 focus:bg-surface transition-colors"
          />
        );
    }
  };

  if (loading) {
    return <p className="text-[11px] text-faint">{t("读取中…")}</p>;
  }

  /**
   * 渲染计划：先 groups 顺序、再顶层 fields；同一 key 只渲染一次（按出现顺序保留第一次）。
   * 空组跳过，但保留原始分组对象以便继续展示标题 / 说明——字段为空时整组不出现。
   */
  const seen = new Set<string>();

  /**
   * 字段归一化：分区里**只写 key 就够**——kind / default / options / min / max / step 从
   * manifest.config 继承（唯一事实源）。以前两处各写一份，kind 不一致时后端按 schema
   * 过滤会把写入静默丢掉，表现为「改了没反应」。
   * key 不在 manifest 里且自己没写 kind 的（拼错 / 已删除）直接跳过，别渲染一个写不进去的控件。
   */
  const normalizeField = (field: PluginSectionField): PluginConfigField | null => {
    const schema = entry.config.find((item) => item.key === field.key);
    if (!schema && !field.kind) return null;
    return {
      key: field.key,
      kind: field.kind ?? schema?.kind ?? "string",
      label: field.label ?? schema?.label ?? field.key,
      description: field.description ?? schema?.description,
      default: field.default ?? schema?.default,
      options: field.options ?? schema?.options,
      min: field.min ?? schema?.min,
      max: field.max ?? schema?.max,
      step: field.step ?? schema?.step,
    };
  };

  const takeFields = (fields: PluginSectionField[] | undefined): PluginConfigField[] => {
    const out: PluginConfigField[] = [];
    for (const field of fields ?? []) {
      if (seen.has(field.key)) continue;
      const normalized = normalizeField(field);
      if (!normalized) continue;
      seen.add(field.key);
      out.push(normalized);
    }
    return out;
  };
  const groupBlocks = (section.groups ?? []).map((group) => ({
    group,
    fields: takeFields(group.fields),
  }));
  const looseFields = takeFields(section.fields);

  const fieldRow = (field: PluginConfigField) => (
    <div
      key={field.key}
      className="flex items-center justify-between gap-6 px-3 py-2.5 rounded-xl bg-app border border-line-soft"
    >
      <div className="min-w-0">
        <span className="text-xs font-medium text-body">{t(field.label)}</span>
        {field.description && (
          <p className="text-[10px] text-faint leading-relaxed mt-0.5">
            {t(field.description)}
          </p>
        )}
      </div>
      <div className="flex-shrink-0">{renderControl(field)}</div>
    </div>
  );

  return (
    <div className="space-y-3">
      <p className="text-[10px] text-faint leading-relaxed">
        {t("由插件「{name}」提供，改动即时生效。", { name: entry.pluginName })}
      </p>
      {groupBlocks.map(({ group, fields }) =>
        fields.length === 0 ? null : (
          <div key={group.id} className="space-y-3">
            <div>
              <p className={GROUP_TITLE_CLASS}>{t(group.title)}</p>
              {group.description && (
                <p className="pb-1 text-[10px] text-faint leading-relaxed">
                  {t(group.description)}
                </p>
              )}
            </div>
            {fields.map(fieldRow)}
          </div>
        ),
      )}
      {looseFields.map(fieldRow)}
    </div>
  );
};
