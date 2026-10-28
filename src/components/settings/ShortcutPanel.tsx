import { useI18n } from "@/i18n";
/**
 * 设置 · 快捷键：把全软件键位按用途列成一张只读清单。
 *
 * 三条设计取舍：
 * - **数据只从 `config/shortcuts.ts` 来**：那份清单又直接引用编辑器包里的键位表，
 *   所以这里不会出现"文档说 Ctrl+K、实际按了没反应"；
 * - **跟着设置置灰**：编辑器快捷键、查找、字号缩放任一被关掉，对应行变灰并标出原因，
 *   而不是让用户对着一条按不出反应的键位发愁；
 * - **不做改键**：目前没有任何改键入口，做一张能改的表等于暴露假功能。
 */
import { Icon } from "@/components/common/Icon";
import { KeyChips } from "@/components/common/KeyChips";
import { buildShortcutGroups } from "@/config/shortcuts";
import type { AppSettings } from "@/interface/settings";

export const ShortcutPanel: React.FC<{ settings: AppSettings }> = ({ settings }) => {
  const { t, locale } = useI18n();
  const groups = buildShortcutGroups(locale);
  return (
  <div className="space-y-6">
    <p className="text-[11px] text-faint leading-relaxed">{t("下表是当前生效的全部键位。Ctrl 在 macOS 上是 ⌘，Alt 对应 ⌥。部分键位可在「编辑器」分区关闭，关闭后对应行会置灰。")}</p>

    {groups.map((group) => (
      <div key={group.id}>
        <div className="flex flex-wrap items-baseline gap-2 mb-1 pb-1.5 border-b border-line-soft">
          <p className="text-[11px] font-semibold text-muted">{t(group.id === "app" ? "软件" : group.title)}</p>
          {group.desc && <p className="text-[10px] text-faint-soft">{t(group.desc)}</p>}
        </div>
        <div className="divide-y divide-line-soft">
          {group.entries.map((entry) => {
            const enabled = entry.available ? entry.available(settings) : true;
            return (
              <div
                key={`${group.id}.${entry.keys}.${entry.label}`}
                className={`flex items-center gap-3 py-2 ${enabled ? "" : "opacity-55"}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className={`text-xs ${enabled ? "text-body" : "text-faint"}`}>{t(entry.label)}</p>
                    {!enabled && (
                      <span className="px-1 rounded text-[9px] text-warning bg-warning-soft border border-warning-line/60">
                        {t(entry.offHint ?? "已关闭")}
                      </span>
                    )}
                  </div>
                  {entry.note && <p className="mt-0.5 text-[10px] text-faint-soft">{t(entry.note)}</p>}
                </div>
                <KeyChips accelerator={entry.keys} dimmed={!enabled} />
              </div>
            );
          })}
        </div>
      </div>
    ))}

    <div className="flex items-start gap-2 rounded-xl border border-line-soft bg-app/60 px-3 py-2.5">
      <Icon name="toast-info" className="w-3.5 h-3.5 text-faint mt-[1px]" />
      <p className="text-[11px] leading-relaxed text-faint">{t("编辑器里的格式快捷键全部由「编辑器 → 启用快捷键」控制；关闭后仍可用工具栏按钮完成同样的操作。")}</p>
    </div>
  </div>
);
};
