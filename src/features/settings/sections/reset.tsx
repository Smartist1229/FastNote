/* 恢复默认：编辑器 / 主题 / 软件 / AI 四块互相独立，按需单独恢复。 */

import { DEFAULT_AI_SETTINGS } from "@/config/ai/aiDefaults";
import { useI18n } from "@/i18n";
import type { SettingsSectionContext } from "../context";

export const ResetSection: React.FC<{ ctx: SettingsSectionContext }> = ({ ctx }) => {
  const { t } = useI18n();
  const { onResetEditorSettings, onResetThemeSettings, onResetAppSettings, onAiSettingsChange } = ctx;
  return (
    <div className="space-y-2.5 pt-1">
      <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">{t("恢复编辑器默认设置")}</p>
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("字号、行高、间距、工具栏与颜色预设等编辑器选项回到默认值，不影响主题与 AI 设置。")}</p>
        </div>
        <button
          onClick={onResetEditorSettings}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
        >{t("恢复")}</button>
      </div>

      <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">{t("恢复主题默认设置")}</p>
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("明暗模式、预设配色、自定义取色与「我的主题」回到默认，不影响其他软件设置。")}</p>
        </div>
        <button
          onClick={onResetThemeSettings}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
        >{t("恢复")}</button>
      </div>

      <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">{t("恢复软件默认设置")}</p>
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("通用、编辑器、笔记列表、界面布局与主题回到默认值，不影响 AI 设置。")}</p>
        </div>
        <button
          onClick={onResetAppSettings}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
        >{t("恢复")}</button>
      </div>

      <div className="flex items-center justify-between gap-6 rounded-xl border border-line px-3.5 py-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-body">{t("恢复 AI 默认设置")}</p>
          <p className="text-[11px] text-faint mt-0.5 leading-relaxed">{t("对话行为、上下文等 AI 参数回到默认值，不影响服务商与记忆条目。")}</p>
        </div>
        <button
          onClick={() => onAiSettingsChange({ ...DEFAULT_AI_SETTINGS })}
          className="px-3 py-1.5 text-xs font-medium text-body bg-surface-alt rounded-lg hover:bg-surface-strong transition-colors flex-shrink-0"
        >{t("恢复")}</button>
      </div>
    </div>
  );
};
