/* 编辑器：字号、行高、间距、工具栏与颜色预设等，全部由编辑器设置规格表生成。 */

import type { SettingRow } from "@/interface/settings/settingsModal";
import { badges } from "@/config/app/settingBadges";
import { DEFAULT_EDITOR_SETTINGS } from "@/config/app/appDefaults";
import { EDITOR_SETTING_SPECS } from "@/config/editor/editorSettingSpecs";
import type { SettingsRowsContext, SettingsSectionContext } from "../context";
import { SectionRows } from "../sectionRows";

/** 规格 → 设置行：按 kind 取对应类型的值，写回统一走 setApp；依赖未满足的整行不出现 */
export const buildEditorRows = ({ appSettings, setApp }: SettingsRowsContext): SettingRow[] => {
  const editor = appSettings.editor;
  return EDITOR_SETTING_SPECS.filter(
    (spec) => !spec.hiddenWhen?.(editor),
  ).map((spec) => {
    const base = {
      section: "editor" as const,
      group: spec.group,
      title: spec.title,
      desc: spec.desc,
      keywords: spec.keywords,
      badges: badges("live"),
    };
    if (spec.kind === "toggle") {
      return {
        ...base,
        kind: "toggle",
        value: editor[spec.field] as boolean,
        onChange: (v: boolean) => setApp("editor", spec.field, v),
      };
    }
    if (spec.kind === "number") {
      return {
        ...base,
        kind: "number",
        value: editor[spec.field] as number,
        min: spec.min,
        max: spec.max,
        step: spec.step,
        unit: spec.unit,
        onChange: (v: number) => setApp("editor", spec.field, v),
      };
    }
    if (spec.kind === "color") {
      return {
        ...base,
        kind: "color",
        value: editor[spec.field] as string,
        onChange: (v: string) => setApp("editor", spec.field, v),
      };
    }
    if (spec.kind === "colorList") {
      return {
        ...base,
        kind: "colorList",
        value: editor[spec.field] as string,
        placeholder: spec.placeholder,
        onChange: (v: string) => setApp("editor", spec.field, v),
      };
    }
    // segment 与 select 的行形状相同（value + options），只是渲染控件不同。
    // 选项值统一是字符串，但 Tab 宽度这类字段在设置对象里是 number：
    // 展示时转成字符串，写回时再转回 number，否则分段按钮选不中、落库后也读不回来。
    const numeric = typeof DEFAULT_EDITOR_SETTINGS[spec.field] === "number";
    const raw = editor[spec.field] as string | number;
    return {
      ...base,
      kind: spec.kind,
      value: numeric ? String(raw) : (raw as string),
      options: spec.options,
      onChange: (v: string) => setApp("editor", spec.field, numeric ? Number(v) : v),
    };
  });
};

export const EditorSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => (
  <SectionRows section="editor" rows={ctx.rowsOf("editor")} groupRefs={ctx.groupRefs} />
);
