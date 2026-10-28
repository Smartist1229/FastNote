/**
 * 键位角标：把 `mod+shift+p` 画成 `Ctrl` `Shift` `P` 三个小键帽。
 *
 * 命令面板与设置里的快捷键清单共用：两处各画一套的话，字号、圆角、`⌘/Ctrl` 的平台差异
 * 迟早会跑偏。`/` 分隔的等价键之间插一个「或」。
 */
import { useI18n } from "@/i18n";
import { parseKeys } from "@/lib/keyLabel";

export const KeyChips: React.FC<{ accelerator: string; dimmed?: boolean; className?: string }> = ({
  accelerator,
  dimmed = false,
  className = "",
}) => {
  const { t } = useI18n();
  return (
  <span className={`flex items-center gap-1 flex-shrink-0 ${className}`}>
    {parseKeys(accelerator).map((keys, groupIndex) => (
      <span key={groupIndex} className="flex items-center gap-0.5">
        {groupIndex > 0 && <span className="text-[10px] text-faint-soft px-0.5">{t("或")}</span>}
        {keys.map((key, index) => (
          <kbd
            key={index}
            className={`px-1.5 py-[1px] rounded border border-line bg-app text-[10px] leading-4 font-medium ${
              dimmed ? "text-faint-soft" : "text-muted"
            }`}
          >
            {t(key)}
          </kbd>
        ))}
      </span>
    ))}
  </span>
);
};
