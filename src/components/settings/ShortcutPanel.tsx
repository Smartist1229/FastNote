import { useCallback, useEffect, useMemo, useRef, useState } from "react";
/**
 * 设置 · 快捷键：全软件键位的可编辑清单。
 *
 * 数据只从 `config/shortcuts` 来（那份表又直接引用编辑器包里的键位表），
 * 所以这里不会出现「文档说 Ctrl+K、实际按了没反应」。
 *
 * 三条行为约定：
 * - **改键即时生效**：写入 `app.config.shortcuts.<动作 id>`，App 读回后推给快捷键运行时，
 *   编辑器那份通过 `buildNoteEditorConfig` 传进组件；写库与生效不是两条路。
 * - **冲突当场拦下**：抓到的新键位先问运行时「这组键现在被谁占着」（宿主动作、其他插件都算），
 *   有占用就拒绝写入并说明是谁占的 —— 允许写进去只会变成「按下去两个功能一起跑」。
 * - **置灰跟着功能开关走**：编辑器快捷键 / 查找 / 字号缩放任一关掉，对应行变灰并标出原因；
 *   关掉的动作仍可改键位（改完再开总开关就能用）。
 */
import { Icon } from "@/components/common/Icon";
import { KeyChips } from "@/components/common/KeyChips";
import { useI18n } from "@/i18n";
import type { AppSettings } from "@/interface/settings/settings";
import {
  DEFAULT_SHORTCUT_SETTINGS,
  SHORTCUT_ACTIONS,
  SHORTCUT_GROUPS,
  resolveShortcutBindings,
  type ShortcutActionSpec,
} from "@/config/shortcuts";
import { comboIsUsable, comboFromEvent, joinCombos, splitCombos } from "@/lib/shortcuts/combo";
import {
  globalFailureOf,
  setShortcutCapture,
  shortcutOwnerLabel,
  shortcutOwners,
  subscribeGlobalShortcuts,
} from "@/features/shortcuts/runtime";

interface ShortcutPanelProps {
  settings: AppSettings;
  /** 写入单个动作的键位；空字符串表示关掉该动作的快捷键 */
  onChange: (actionId: string, combo: string) => void;
}

/** 作用域角标文案 */
const SCOPE_LABEL: Record<string, string> = { global: "全局", app: "窗口" };

/** 捕获态里的一行：按下的键位先落在这里，通过校验才写回设置 */
interface CaptureState {
  actionId: string;
  /** 目前抓到的候选键位（可能因为冲突没写回） */
  combo: string;
  /** 候选键位不可用时的原因 */
  problem?: string;
}

export const ShortcutPanel: React.FC<ShortcutPanelProps> = ({ settings, onChange }) => {
  const { t } = useI18n();
  const captureRef = useRef<HTMLButtonElement | null>(null);
  const [capture, setCapture] = useState<CaptureState | null>(null);
  /** 全局热键注册结果变化时重渲染（系统占用只有异步注册完才知道） */
  const [, bumpFailures] = useState(0);

  useEffect(() => subscribeGlobalShortcuts(() => bumpFailures((n) => n + 1)), []);

  /** 当前生效键位：动作 id → 键位数组 */
  const bindings = useMemo(
    () => resolveShortcutBindings(settings.shortcuts),
    [settings.shortcuts],
  );

  /** 进入捕获态：把焦点放到捕获框上，按键才会落在它身上 */
  const startCapture = useCallback((actionId: string) => {
    setCapture({ actionId, combo: "" });
    setShortcutCapture(true);
    // 等 React 把捕获框换成真实节点再聚焦
    requestAnimationFrame(() => captureRef.current?.focus());
  }, []);

  const stopCapture = useCallback(() => {
    setCapture(null);
    setShortcutCapture(false);
  }, []);

  useEffect(() => () => setShortcutCapture(false), []);

  const handleCaptureKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (!capture) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      stopCapture();
      return;
    }
    if (event.key === "Backspace" || event.key === "Delete") {
      // 退格 = 清空这个动作的键位（与捕获框的「清除」按钮等价）
      onChange(capture.actionId, "");
      stopCapture();
      return;
    }
    const combo = comboFromEvent(event.nativeEvent);
    if (!combo) return;
    if (!comboIsUsable(combo)) {
      setCapture({ actionId: capture.actionId, combo: "", problem: t("至少要带 Ctrl / ⌘ 或 Alt 修饰键") });
      return;
    }
    const owners = shortcutOwners(combo, capture.actionId);
    if (owners.length > 0) {
      setCapture({
        actionId: capture.actionId,
        combo,
        problem: t("已被「{name}」占用", { name: owners.map((id) => t(shortcutOwnerLabel(id))).join(t("、")) }),
      });
      return;
    }
    onChange(capture.actionId, joinCombos([combo]));
    stopCapture();
  };

  const resetOne = (actionId: string) => {
    onChange(actionId, DEFAULT_SHORTCUT_SETTINGS[actionId] ?? "");
  };

  const resetAll = () => {
    for (const [actionId, value] of Object.entries(DEFAULT_SHORTCUT_SETTINGS)) {
      onChange(actionId, value);
    }
  };

  /** 每行的派生状态（是否被改过 / 有没有冲突 / 系统注册失败原因） */
  const rowState = (spec: ShortcutActionSpec) => {
    const combos = bindings[spec.id] ?? [];
    const value = settings.shortcuts[spec.id] ?? spec.default;
    /*
     * 按「键位数组」比较，不能只 normalize 整个字符串：
     * 默认值可能是 `"mod+shift+z / mod+y"`，parseCombo 只认最后一个主键，
     * 整体归一后两边永远相等，改键后的「默认」按钮就不会出现。
     */
    const changed = joinCombos(splitCombos(value)) !== joinCombos(splitCombos(spec.default));
    const disabled = combos.length === 0;
    const enabled = spec.available ? spec.available(settings) : true;
    const conflict = combos.some((combo) => shortcutOwners(combo, spec.id).length > 0);
    // 一个动作用多组键时，任一组被系统占用都要提示，不能只看第一组
    const systemFailure = spec.scope === "global"
      ? (combos.map((combo) => globalFailureOf(combo)).find(Boolean) ?? "")
      : "";
    return { combos, value, changed, disabled, enabled, conflict, systemFailure };
  };

  return (
  <div className="space-y-6">
    <div className="flex items-start gap-3">
      <p className="flex-1 text-[11px] text-faint leading-relaxed">
        {t("点「修改」后按下新的组合键即可改键，Esc 取消、退格清除。Ctrl 在 macOS 上是 ⌘，Alt 对应 ⌥。标「全局」的键在窗口最小化或藏在托盘里时同样生效，其余只在窗口有焦点时生效。")}
      </p>
      <button
        type="button"
        onClick={resetAll}
        className="flex-none flex items-center gap-1 px-2 py-1 rounded-lg text-[10px] text-muted border border-line bg-surface hover:bg-surface-alt transition-colors"
      >
        <Icon name="sidebar-refresh" className="w-3 h-3" />
        {t("全部恢复默认")}
      </button>
    </div>

    {SHORTCUT_GROUPS.map((group) => {
      const rows = SHORTCUT_ACTIONS.filter((spec) => spec.group === group.id);
      if (rows.length === 0) return null;
      return (
        <div key={group.id}>
          <div className="flex flex-wrap items-baseline gap-2 mb-1 pb-1.5 border-b border-line-soft">
            <p className="text-[11px] font-semibold text-muted">{t(group.title)}</p>
            {group.desc && <p className="text-[10px] text-faint-soft">{t(group.desc)}</p>}
          </div>
          <div className="divide-y divide-line-soft">
            {rows.map((spec) => {
              const state = rowState(spec);
              const capturing = capture?.actionId === spec.id;
              return (
                <div key={spec.id} className={`flex items-center gap-3 py-2 ${state.enabled ? "" : "opacity-55"}`}>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <p className={`text-xs ${state.enabled ? "text-body" : "text-faint"}`}>{t(spec.label)}</p>
                      {spec.scope === "global" && (
                        <span className="px-1 rounded text-[9px] text-primary-600 bg-primary-50 border border-primary-200/60">
                          {t(SCOPE_LABEL[spec.scope])}
                        </span>
                      )}
                      {!state.enabled && (
                        <span className="px-1 rounded text-[9px] text-warning bg-warning-soft border border-warning-line/60">
                          {t(spec.offHint ?? "已关闭")}
                        </span>
                      )}
                      {state.disabled && (
                        <span className="px-1 rounded text-[9px] text-faint bg-app border border-line-soft">
                          {t("未设置")}
                        </span>
                      )}
                      {state.conflict && (
                        <span className="px-1 rounded text-[9px] text-danger bg-danger-soft border border-danger-line/60">
                          {t("与其他功能冲突")}
                        </span>
                      )}
                      {state.systemFailure && (
                        <span
                          className="px-1 rounded text-[9px] text-warning bg-warning-soft border border-warning-line/60"
                          title={state.systemFailure}
                        >
                          {t("被系统或其他软件占用")}
                        </span>
                      )}
                    </div>
                    {spec.note && <p className="mt-0.5 text-[10px] text-faint-soft">{t(spec.note)}</p>}
                  </div>

                  <div className="flex items-center gap-1.5 flex-none">
                    {capturing ? (
                      <button
                        ref={captureRef}
                        type="button"
                        onKeyDown={handleCaptureKeyDown}
                        onBlur={stopCapture}
                        className={`min-w-[132px] px-2 py-1 rounded-lg border text-[10px] text-center transition-colors ${
                          capture?.problem
                            ? "border-danger-line bg-danger-soft text-danger"
                            : "border-primary-300 bg-primary-50 text-primary-600"
                        }`}
                      >
                        {capture?.problem ? capture.problem : t("按下新的组合键…")}
                      </button>
                    ) : (
                      <KeyChips accelerator={state.value || ""} dimmed={!state.enabled || state.disabled} />
                    )}

                    {!capturing && (
                      <>
                        <button
                          type="button"
                          onClick={() => startCapture(spec.id)}
                          className="px-1.5 py-1 rounded-md text-[10px] text-muted hover:bg-surface-alt transition-colors"
                          title={t("修改快捷键")}
                        >
                          {t("修改")}
                        </button>
                        {state.changed && (
                          <button
                            type="button"
                            onClick={() => resetOne(spec.id)}
                            className="px-1.5 py-1 rounded-md text-[10px] text-faint hover:bg-surface-alt transition-colors"
                            title={t("恢复默认键位")}
                          >
                            {t("默认")}
                          </button>
                        )}
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    })}

    <div className="flex items-start gap-2 rounded-xl border border-line-soft bg-app/60 px-3 py-2.5">
      <Icon name="toast-info" className="w-3.5 h-3.5 text-faint mt-[1px]" />
      <p className="text-[11px] leading-relaxed text-faint">
        {t("编辑器里的格式快捷键全部由「编辑器 → 启用快捷键」控制；关闭后仍可用工具栏按钮完成同样的操作。插件注册的全局快捷键与这里的键位互斥，冲突时会被拒绝并提示占用者。")}
      </p>
    </div>
  </div>
);
};
