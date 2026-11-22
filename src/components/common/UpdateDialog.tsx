/**
 * 更新弹窗：展示「发现新版本 / 下载中 / 已下载待安装」流程。
 *
 * - 发现新版本：展示远端更新说明，可直接跳过此版本、稍后再看或下载安装；
 * - 下载中：展示进度（Windows 安装器接管后自动重启，关闭弹窗不会中断下载）。
 *
 * 手动检查在 store 里会把 dialogOpen 置为 true；启动时的静默检查只发提示，不主动弹窗。
 * 安装完成后不再单独提示，启动时不弹任何窗口。
 */
import { lazy, Suspense } from "react";
import { useI18n } from "@/i18n";
import { Modal } from "@/components/common/Modal";
import { formatBytes, formatSpeed } from "@/lib/text/format";
import {
  applyUpdate,
  clearSkippedVersion,
  closeUpdateDialog,
  downloadUpdate,
  refreshLines,
  selectUpdateLine,
  skipVersion,
  useUpdater,
} from "@/stores/updaterStore";
import type { UpdateLineId, UpdateLineProbe } from "@/stores/updaterStore";
import { fastestLine } from "@/lib/updater/lines";

/**
 * 更新说明正文单独懒加载：它依赖整个 Markdown 渲染层（以及 Mermaid / KaTeX 的动态入口），
 * 而更新弹窗很少打开，静态引用会把渲染层拖进首屏主包。
 */
const NotesBody = lazy(() => import("@/components/common/ReleaseNotesBody"));

/** 线路单选行：自动线路和两条固定线路共用同一套样式与无障碍语义 */
const LineOption: React.FC<{
  selected: boolean;
  label: string;
  status: string;
  onSelect: () => void;
}> = ({ selected, label, status, onSelect }) => (
  <button
    type="button"
    role="radio"
    aria-checked={selected}
    onClick={onSelect}
    className={`flex w-full items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors ${
      selected
        ? "border-primary-400 bg-primary-50"
        : "border-line-soft bg-surface-alt hover:bg-app"
    }`}
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

export const UpdateDialog: React.FC = () => {
  const { t } = useI18n();
  const updater = useUpdater();

  const downloading = updater.phase === "downloading";
  /** 安装包已下载并验签，等待用户确认安装 */
  const ready = updater.phase === "ready";
  const installing = updater.phase === "installing";
  const version = updater.version ?? "";
  const notes = updater.notes;
  const skipped = updater.version != null && updater.skippedVersion === updater.version;

  const lineLabel = (id: UpdateLineId) => (id === "cnb" ? t("CNB（国内）") : t("GitHub"));
  const statusText = (line: UpdateLineProbe) => {
    if (line.error) return t("连不上");
    const latency = line.latencyMs != null ? `${line.latencyMs} ms` : "";
    if (!line.version) return latency ? `${latency} · ${t("已是最新")}` : t("已是最新");
    return latency ? `${latency} · v${line.version}` : `v${line.version}`;
  };

  const activeLine = updater.lines.find((line) => line.id === updater.activeLine) ?? null;
  const activeLabel = activeLine ? lineLabel(activeLine.id) : "";
  const showLinePicker = updater.phase === "available" && updater.lines.length > 0;
  /**
   * 手选线路的探测状态。
   * 连不上 / 已是最新都**不阻止选择**：探测只代表这一次请求，开代理后 GitHub 往往反而更快；
   * 选中之后下载会先试它，失败再自动换到另一条，这里只负责把这件事说清楚。
   */
  const chosenLine =
    updater.lineChoice === "auto"
      ? null
      : updater.lines.find((line) => line.id === updater.lineChoice) ?? null;
  const chosenHint = chosenLine
    ? chosenLine.error
      ? t("该线路当前连不上，下载时会重新尝试；仍然失败则自动改用另一条线路。")
      : !chosenLine.version
        ? t("该线路暂未发现新版本，下载时会先尝试它，必要时改用另一条线路。")
        : null
    : null;
  // 「自动」这一行的状态说的是「自动会选谁」，不是当前手选的线路
  const autoLine = fastestLine(updater.lines);
  const autoStatus = autoLine
    ? `${lineLabel(autoLine.id)} · ${statusText(autoLine)}`
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

  const sizeText =
    (downloading || ready) && updater.downloaded != null && updater.total != null
      ? `${formatBytes(updater.downloaded)} / ${formatBytes(updater.total)}`
      : null;
  const speedText = downloading && updater.speed != null ? formatSpeed(updater.speed) : null;
  // 剩余时间只用平滑后的速度估算；速度未知或为 0 时不猜
  const etaText = (() => {
    if (!downloading || updater.speed == null || updater.speed <= 0) return null;
    if (updater.downloaded == null || updater.total == null) return null;
    const remaining = updater.total - updater.downloaded;
    if (remaining <= 0) return null;
    const seconds = Math.max(1, Math.round(remaining / updater.speed));
    return seconds < 60
      ? t("约 {value1} 秒", { value1: seconds })
      : t("约 {value1} 分钟", { value1: Math.round(seconds / 60) });
  })();
  const dynamicText = [speedText, etaText].filter(Boolean).join(" · ");

  const close = () => closeUpdateDialog();

  const title = installing
    ? t("正在安装")
    : ready
      ? t("更新已下载")
      : downloading
        ? t("正在更新")
        : t("发现新版本 {value1}", { value1: version });

  return (
    <Modal isOpen={updater.dialogOpen} onClose={close} title={title} size="lg" zIndex={70}>
      <div>
        <p className="text-[11px] text-faint">
          {installing
            ? t("正在启动安装程序，软件即将关闭。")
            : ready
              ? t("安装包已下载完成并通过校验，现在可以关闭软件并安装。")
              : downloading
                ? t("关闭弹窗不会中断下载。")
                : t("下载完成后可立即安装并重启。")}
        </p>

        <div className="rounded-xl border border-line-soft bg-app px-3.5 py-3 mt-2.5">
          <p className="text-xs font-medium text-body">{t("本次更新内容")}</p>
          {notes ? (
            <Suspense fallback={null}>
              <NotesBody notes={notes} />
            </Suspense>
          ) : (
            <p className="mt-1.5 text-[12px] text-faint">{t("此版本没有附带更新说明。")}</p>
          )}
        </div>

        {showLinePicker && (
          <div className="mt-3 rounded-xl border border-line-soft bg-app px-3.5 py-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-medium text-body">{t("下载线路")}</p>
              <button
                type="button"
                onClick={() => void refreshLines()}
                disabled={updater.linesBusy}
                className="flex-none text-[11px] font-medium text-primary-600 hover:text-primary-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {updater.linesBusy ? t("测速中...") : t("重新测速")}
              </button>
            </div>
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
                  label={lineLabel(line.id)}
                  status={statusText(line)}
                  onSelect={() => selectUpdateLine(line.id)}
                />
              ))}
            </div>
            {chosenHint && <p className="mt-2 text-[11px] text-faint">{chosenHint}</p>}
          </div>
        )}

        {(downloading || ready) && (
          <div className="mt-3">
            <div className="h-1.5 rounded-full bg-surface-alt overflow-hidden">
              <div
                className="h-full rounded-full bg-primary-500 transition-all duration-200"
                style={{ width: ready ? "100%" : `${Math.max(updater.progress ?? 10, 4)}%` }}
              />
            </div>
            <div className="mt-1.5 flex items-center justify-between gap-3 text-[11px] text-faint">
              <span className="min-w-0 truncate">
                {ready ? t("已下载完成") : progressText}
                {sizeText && <span className="text-faint-soft"> · {sizeText}</span>}
              </span>
              {dynamicText && <span className="flex-none tabular-nums">{dynamicText}</span>}
            </div>
          </div>
        )}

        {updater.lineFallback && (
          <p className="mt-1.5 text-[11px] text-faint">
            {t("未能从 {value1} 下载，已自动改用 {value2}", {
              value1: lineLabel(updater.lineFallback.from),
              value2: lineLabel(updater.lineFallback.to),
            })}
          </p>
        )}

        {(updater.phase === "available" || ready) && updater.error && (
          <p className="mt-2 text-[11px] text-danger-strong break-words">
            {t("更新失败：{value1}", { value1: updater.error })}
          </p>
        )}

        {skipped && (
          <p className="mt-2 text-[11px] text-faint">{t("已跳过版本 {value1}，手动检查仍会提示", { value1: version })}</p>
        )}

        {installing ? null : downloading ? (
          <div className="mt-4 flex justify-end">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs rounded-lg border border-line text-body hover:bg-surface-alt transition-colors"
            >
              {t("关闭")}
            </button>
          </div>
        ) : ready ? (
          <div className="mt-4 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="px-3 py-1.5 text-xs rounded-lg border border-line text-body hover:bg-surface-alt transition-colors"
            >
              {t("稍后再说")}
            </button>
            <button
              type="button"
              onClick={() => void applyUpdate()}
              className="btn-primary px-3 py-1.5 text-xs"
            >
              {t("关闭软件并更新")}
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
                onClick={() => void downloadUpdate()}
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
