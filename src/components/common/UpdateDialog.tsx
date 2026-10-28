/**
 * 更新弹窗：把「发现新版本」和「更新完成」合并成一个对话流程。
 *
 * - 发现新版本：展示远端更新说明，可直接跳过此版本、稍后再看或下载安装；
 * - 下载中：展示进度（Windows 安装器接管后自动重启，关闭弹窗不会中断下载）；
 * - 更新完成：启动时版本对得上缓存说明，展示这次更新带来了什么。
 *
 * 手动检查在 store 里会把 dialogOpen 置为 true；启动时的静默检查只发提示，不主动弹窗。
 */
import { useI18n } from "@/i18n";
import { Modal } from "@/components/common/Modal";
import type { ReleaseNotice } from "@/lib/releaseNotes";
import {
  clearSkippedVersion,
  closeUpdateDialog,
  installUpdate,
  selectUpdateLine,
  skipVersion,
  useUpdater,
} from "@/stores/updaterStore";
import type { UpdateLineId, UpdateLineProbe } from "@/stores/updaterStore";

/**
 * 更新说明是 Markdown（发布流程按 Conventional Commits 生成），但这里只做极简排版：
 * 标题加粗、列表加圆点、其余按段落。为了一个说明弹窗把整个编辑器拉进主包不值当。
 */
const NotesBody: React.FC<{ notes: string }> = ({ notes }) => (
  <div className="mt-1.5 max-h-[240px] overflow-y-auto chat-scrollbar pr-1">
    {notes.split("\n").map((line, index) => {
      const text = line.trim();
      if (!text) return <div key={index} className="h-2" />;
      const heading = /^(#{1,6})\s+(.*)$/.exec(text);
      if (heading) {
        return (
          <p
            key={index}
            className={`mt-2 text-[12px] font-semibold ${heading[1].length <= 2 ? "text-ink" : "text-body"}`}
          >
            {heading[2]}
          </p>
        );
      }
      const bullet = /^[-*]\s+(.*)$/.exec(text);
      if (bullet) {
        return (
          <p key={index} className="pl-3 text-[12px] leading-relaxed text-muted">
            <span className="mr-1.5 text-faint-soft">•</span>
            {bullet[1]}
          </p>
        );
      }
      return (
        <p key={index} className="text-[12px] leading-relaxed text-muted">
          {text}
        </p>
      );
    })}
  </div>
);

/** 线路单选行：自动线路和两条固定线路共用同一套样式与无障碍语义 */
const LineOption: React.FC<{
  selected: boolean;
  disabled?: boolean;
  label: string;
  status: string;
  onSelect: () => void;
}> = ({ selected, disabled, label, status, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    disabled={disabled}
    onClick={onSelect}
    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
      selected
        ? "border-primary-400 bg-primary-50"
        : "border-line-soft bg-surface-alt hover:bg-app"
    } ${disabled ? "cursor-not-allowed opacity-45" : ""}`}
  >
    <span
      aria-hidden
      className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-full border ${
        selected ? "border-primary-500" : "border-line"
      }`}
    >
      {selected && <span className="h-1.5 w-1.5 rounded-full bg-primary-500" />}
    </span>
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[12px] font-medium text-body">{label}</span>
      <span className="block truncate text-[11px] text-faint">{status}</span>
    </span>
  </button>
);

export const UpdateDialog: React.FC<{
  /** 更新完成后的说明；null 表示当前是「发现新版本 / 下载中」模式 */
  notice: ReleaseNotice | null;
  onCloseNotice: () => void;
}> = ({ notice, onCloseNotice }) => {
  const { t } = useI18n();
  const updater = useUpdater();

  const done = notice != null;
  const downloading = !done && updater.phase === "downloading";
  const version = done ? notice.version : updater.version ?? "";
  const notes = done ? notice.notes : updater.notes;
  const skipped = !done && updater.version != null && updater.skippedVersion === updater.version;

  const lineLabel = (id: UpdateLineId) => (id === "cnb" ? t("CNB（国内）") : t("GitHub"));
  const statusText = (line: UpdateLineProbe) => {
    if (line.error) return t("不可用");
    const latency = line.latencyMs != null ? `${line.latencyMs} ms` : "";
    if (!line.version) return latency ? `${latency} · ${t("已是最新")}` : t("已是最新");
    return latency ? `${latency} · v${line.version}` : `v${line.version}`;
  };

  const activeLine = updater.lines.find((line) => line.id === updater.activeLine) ?? null;
  const activeLabel = activeLine ? lineLabel(activeLine.id) : "";
  const showLinePicker = !done && updater.phase === "available" && updater.lines.length > 0;
  // 手动选的线路这次没有新版本时，store 会回落到最快线路，这里把回落原因说清楚
  const fallbackLine =
    updater.lineChoice !== "auto" && activeLine != null && activeLine.id !== updater.lineChoice;
  const autoStatus = activeLine
    ? `${lineLabel(activeLine.id)} · ${statusText(activeLine)}`
    : t("无可用线路");
  const progressText =
    updater.progress == null
      ? activeLabel
        ? t("正在从 {value1} 下载更新...", { value1: activeLabel })
        : t("正在下载更新...")
      : activeLabel
        ? t("正在从 {value1} 下载更新... {value2}%", {
            value1: activeLabel,
            value2: updater.progress,
          })
        : t("正在下载更新... {value1}%", { value1: updater.progress });

  const close = () => {
    closeUpdateDialog();
    onCloseNotice();
  };

  const title = done ? t("更新完成") : downloading ? t("正在更新") : t("发现新版本 {value1}", { value1: version });

  return (
    <Modal isOpen={done || updater.dialogOpen} onClose={close} title={title} size="lg">
      <div>
        {done ? (
          <>
            <p className="text-sm font-semibold text-ink">{t("已更新到 {value1}", { value1: version })}</p>
            {notice.previousVersion && (
              <p className="mt-1 text-[11px] text-faint">
                {t("从 {value1} 更新而来", { value1: notice.previousVersion })}
              </p>
            )}
          </>
        ) : (
          <p className="text-[11px] text-faint">
            {downloading ? t("关闭窗口不会中断更新，完成后会自动安装并重启。") : t("下载完成后会自动安装并重启。")}
          </p>
        )}

        <div className={`rounded-xl border border-line-soft bg-app px-3.5 py-3 ${done ? "mt-3" : "mt-2.5"}`}>
          <p className="text-xs font-medium text-body">{t("本次更新内容")}</p>
          {notes ? (
            <NotesBody notes={notes} />
          ) : (
            <p className="mt-1.5 text-[12px] text-faint">{t("此版本没有附带更新说明。")}</p>
          )}
        </div>

        {showLinePicker && (
          <div className="mt-3 rounded-xl border border-line-soft bg-app px-3.5 py-3">
            <p className="text-xs font-medium text-body">{t("下载线路")}</p>
            <div role="radiogroup" aria-label={t("下载线路")} className="mt-2 space-y-1.5">
              <LineOption
                selected={updater.lineChoice === "auto"}
                label={t("自动（最快）")}
                status={autoStatus}
                onSelect={() => selectUpdateLine("auto")}
              />
              {updater.lines.map((line) => (
                <LineOption
                  key={line.id}
                  selected={updater.lineChoice === line.id}
                  disabled={Boolean(line.error) || !line.version}
                  label={lineLabel(line.id)}
                  status={statusText(line)}
                  onSelect={() => selectUpdateLine(line.id)}
                />
              ))}
            </div>
            {fallbackLine && activeLine && (
              <p className="mt-2 text-[11px] text-faint">
                {t("所选线路暂无更新，已自动使用 {value1}", { value1: lineLabel(activeLine.id) })}
              </p>
            )}
          </div>
        )}

        {downloading && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-200"
                style={{ width: `${Math.max(updater.progress ?? 10, 4)}%` }}
              />
            </div>
            <p className="mt-1.5 text-[11px] text-faint">{progressText}</p>
          </div>
        )}

        {!done && updater.phase === "available" && updater.error && (
          <p className="mt-2 text-[11px] text-danger-strong break-words">
            {t("更新失败：{value1}", { value1: updater.error })}
          </p>
        )}

        {skipped && (
          <p className="mt-2 text-[11px] text-faint">{t("已跳过版本 {value1}，手动检查仍会提示", { value1: version })}</p>
        )}

        {done ? (
          <div className="mt-4 flex justify-end">
            <button type="button" onClick={close} className="btn-primary px-4 py-1.5 text-xs">
              {t("知道了")}
            </button>
          </div>
        ) : downloading ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs rounded-lg border border-line text-body hover:bg-surface-alt transition-colors"
            >
              {t("关闭")}
            </button>
          </div>
        ) : (
          <div className="mt-4 flex items-center gap-2">
            {skipped ? (
              <button
                type="button"
                onClick={clearSkippedVersion}
                className="text-[11px] text-faint hover:text-body transition-colors"
              >
                {t("取消跳过")}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  if (updater.version) skipVersion(updater.version);
                }}
                title={t("启动时不再提示这个版本；下次有新版本仍会提醒")}
                className="text-[11px] text-faint hover:text-body transition-colors"
              >
                {t("跳过此版本")}
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={close}
                className="px-3 py-1.5 text-xs rounded-lg border border-line text-body hover:bg-surface-alt transition-colors"
              >
                {t("稍后再说")}
              </button>
              <button
                type="button"
                onClick={() => void installUpdate()}
                className="btn-primary px-3 py-1.5 text-xs"
              >
                {activeLabel
                  ? t("从 {value1} 下载并安装", { value1: activeLabel })
                  : t("下载并安装")}
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
};
