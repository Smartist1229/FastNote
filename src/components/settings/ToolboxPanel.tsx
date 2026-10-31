import { t, useI18n } from "@/i18n";
/**
 * 设置 · 工具箱：通用下载工具（粘贴链接下载文件）。
 *
 * 与语义模型下载共用后端下载模块（`src-tauri/src/download.rs`）：
 * - 线程数存在 general.downloadThreads（默认 32，1–128），下一次任务生效；
 * - 文件保存到软件安装目录的 `download` 文件夹，不可写时退回应用数据目录；
 * - 文件名默认取链接路径最后一段；用户填了自定义文件名时优先使用（非法字符与重名仍由后端处理）；
 * - 后端把文件切成远多于线程数的小分片，先下完的线程接着取下一片，避免快的闲着；
 * - 进度走 `toolbox-download-progress`：`segments` 是并发连接数，
 *   `segment_progress` 只包含尚未下完的分片，界面按快照渲染，
 *   `elapsed` 是后端计的已用时长（毫秒），界面重开也能接上；
 * - 下载中可以取消，取消后后端会清理临时文件。
 */
import { useEffect, useRef, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import * as toolboxApi from "@/api/toolbox";
import type { ToolboxDownloadProgress, ToolboxSegmentProgress } from "@/api/toolbox";
import { openAppFolder } from "@/api/system";
import { Icon } from "@/components/common/Icon";
import { ProgressBar } from "@/components/common/ProgressBar";
import { useToast } from "@/components/common/Toast";
import { useActionGuard } from "@/hooks/useActionGuard";
import { formatBytes, formatDuration, formatSpeed } from "@/lib/format";
import { FingerprintPanel } from "@/components/settings/FingerprintPanel";

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 工具箱的两个二级分类：下载设置与指纹信息 */
const TABS = [
  { id: "download", label: "下载工具" },
  { id: "fingerprint", label: "指纹信息" },
] as const;

/** 链接里的文件名只用来在首个事件到达前占位，真实文件名以后端事件为准 */
const guessFilename = (raw: string): string => {
  try {
    const last = new URL(raw).pathname.split("/").filter(Boolean).pop();
    if (!last) return t("文件");
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  } catch {
    return t("文件");
  }
};

/**
 * 线程数输入：输入过程中不夹取，失焦/回车时收敛到 [1, 128]。
 * 与通用设置里的数值项同样的交互，避免刚敲第一个数字就被弹回。
 */
const ThreadInput: React.FC<{ value: number; onChange: (value: number) => void }> = ({
  value,
  onChange,
}) => {
  const { t } = useI18n();
  const [text, setText] = useState(String(value));

  useEffect(() => {
    setText(String(value));
  }, [value]);

  const commit = () => {
    const next = Number(text);
    if (!Number.isFinite(next)) {
      setText(String(value));
      return;
    }
    const clamped = Math.min(128, Math.max(1, Math.round(next)));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className="flex flex-shrink-0 items-center gap-1.5">
      <input
        type="number"
        value={text}
        min={1}
        max={128}
        step={1}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
        }}
        className="w-16 px-2 py-1 text-right text-xs input-modern bg-app/60 transition-colors focus:bg-surface"
      />
      <span className="whitespace-nowrap text-[11px] text-faint">{t("线程")}</span>
    </div>
  );
};

interface ToolboxPanelProps {
  /** 下载线程数（general.downloadThreads） */
  threads: number;
  onThreadsChange: (value: number) => void;
}

export const ToolboxPanel: React.FC<ToolboxPanelProps> = ({ threads, onThreadsChange }) => {
  const { t } = useI18n();
  const { showToast } = useToast();
  const guard = useActionGuard();
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("download");

  const [url, setUrl] = useState("");
  const [filename, setFilename] = useState("");
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ToolboxDownloadProgress | null>(null);
  const [speed, setSpeed] = useState(0);
  /** 线程进度默认折叠：大多数时候看总进度就够了 */
  const [threadsOpen, setThreadsOpen] = useState(false);
  /** 已下载用时（毫秒）：事件里以后端绝对值为准，没事件时由本地秒表续着走 */
  const [elapsed, setElapsed] = useState(0);
  const [lastFile, setLastFile] = useState<{
    name: string;
    path: string;
    elapsed: number;
  } | null>(null);
  const [downloadDir, setDownloadDir] = useState("");

  const aliveRef = useRef(true);
  const speedSampleRef = useRef<{ time: number; bytes: number; speed: number } | null>(null);
  /** 用时锚点：后端绝对值 + 收到事件的本地时刻，两次事件之间据此推算 */
  const elapsedAnchorRef = useRef<{ at: number; elapsed: number } | null>(null);

  /** 事件订阅：面板卸载时统一取消 */
  useEffect(() => {
    aliveRef.current = true;
    void toolboxApi
      .getDownloadDir()
      .then((dir) => {
        if (aliveRef.current) setDownloadDir(dir);
      })
      .catch(() => undefined);

    const unlisteners: Array<() => void> = [];
    let disposed = false;
    void (async () => {
      const off = await toolboxApi.onDownloadProgress((next) => {
        if (!aliveRef.current) return;

        if (next.stage === "download") {
          const now = performance.now();
          const prev = speedSampleRef.current;
          let nextSpeed = 0;
          if (prev && next.downloaded >= prev.bytes && now > prev.time) {
            const instant = ((next.downloaded - prev.bytes) * 1000) / (now - prev.time);
            nextSpeed = prev.speed > 0 ? prev.speed * 0.7 + instant * 0.3 : instant;
          }
          speedSampleRef.current = { time: now, bytes: next.downloaded, speed: nextSpeed };
          elapsedAnchorRef.current = { at: now, elapsed: next.elapsed };
          setSpeed(nextSpeed);
          setElapsed(next.elapsed);
          setProgress(next);
          return;
        }

        setSpeed(0);
        speedSampleRef.current = null;
        elapsedAnchorRef.current = null;
        setProgress(null);
        setDownloading(false);
        if (next.stage === "done") {
          setLastFile({ name: next.filename, path: next.path, elapsed: next.elapsed });
          showToast(t("「{filename}」已保存到 {path}", { filename: next.filename, path: next.path }), "success");
        } else if (next.stage === "cancelled") {
          showToast(t("已取消下载"), "info");
        } else {
          showToast(t("下载失败：{value1}", { value1: next.error ?? t("未知错误") }), "error");
        }
      });

      if (disposed) {
        off();
      } else {
        unlisteners.push(off);
      }
    })();

    return () => {
      disposed = true;
      aliveRef.current = false;
      unlisteners.forEach((off) => off());
    };
  }, [showToast, t]);

  // 事件大约 250ms 一次，但连接卡住时可能长时间没有事件；
  // 以最后一次事件为锚点按真实经过时间往后推，事件到达时再用后端绝对值重新对齐——
  // 不能用「每秒 +1000」的累加：界面比后端早起步，事件一来数字会往回跳。
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => {
      const anchor = elapsedAnchorRef.current;
      if (anchor) setElapsed(anchor.elapsed + (performance.now() - anchor.at));
    }, 250);
    return () => window.clearInterval(timer);
  }, [downloading]);

  const handleDownload = async () => {
    const target = url.trim();
    if (!target) {
      showToast(t("请先粘贴下载链接"), "info");
      return;
    }
    if (!/^https?:\/\//i.test(target)) {
      showToast(t("只支持 http / https 链接"), "info");
      return;
    }

    const customName = filename.trim();
    setDownloading(true);
    setLastFile(null);
    setSpeed(0);
    setElapsed(0);
    speedSampleRef.current = null;
    elapsedAnchorRef.current = null;
    // 先用目标文件名画 0%，后端事件到达后会覆盖成清理后的真实文件名
    setProgress({
      stage: "download",
      filename: customName || guessFilename(target),
      path: "",
      downloaded: 0,
      total: 0,
      segments: 0,
      segment_progress: [],
      elapsed: 0,
      error: null,
    });

    try {
      await toolboxApi.startDownload(target, customName);
    } catch (e) {
      setDownloading(false);
      setProgress(null);
      showToast(t("开始下载失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const handleCancel = async () => {
    try {
      const stopped = await toolboxApi.cancelDownload();
      // 任务可能刚好自己结束；没有任务时不用提示，避免和完成 toast 打架
      if (!stopped) return;
    } catch (e) {
      showToast(t("取消失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const openDir = async () => {
    if (!downloadDir) return;
    try {
      await openAppFolder(downloadDir);
    } catch (e) {
      showToast(t("打开下载目录失败：{value1}", { value1: errorText(e) }), "error");
    }
  };

  const percent =
    progress && progress.total > 0
      ? Math.max(0, Math.min(100, Math.round((progress.downloaded / progress.total) * 100)))
      : null;
  const detail = progress
    ? progress.total > 0
      ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)}${
          speed > 0 ? ` · ${formatSpeed(speed)}` : ""
        }`
      : t("准备下载…")
    : "";
  // 只渲染还在下载的分片：下完的随快照消失，被其他线程接走的新分片会自己出现
  const activeSegments: ToolboxSegmentProgress[] = progress
    ? [...progress.segment_progress].sort((a, b) => a.index - b.index)
    : [];
  // 文件大于 1 MiB 却只有单流，说明服务器没理会 Range，不是线程数没生效
  const singleThreadFallback =
    progress?.stage === "download" &&
    progress.segments === 1 &&
    progress.total > 1024 * 1024 &&
    threads > 1;

  return (
    <div className="space-y-3">
      <div className="flex w-fit items-center gap-1 rounded-lg border border-line-soft bg-app p-0.5">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            aria-pressed={tab === item.id}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              tab === item.id
                ? "bg-primary-50 font-medium text-primary-600"
                : "text-muted hover:text-body"
            }`}
          >
            {t(item.label)}
          </button>
        ))}
      </div>

      <div
        className={
          tab === "download"
            ? "rounded-xl border border-line bg-surface px-3.5 py-3"
            : "hidden"
        }
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-body">{t("下载线程")}</p>
            <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{t("同时发起的连接数，默认 32，最高 128。文件会切成更多小分片，先下完的线程自动接手下一片，不会闲着；语义模型下载也使用这个值，线程过多可能被服务器限速。")}</p>
          </div>
          <ThreadInput value={threads} onChange={onThreadsChange} />
        </div>
      </div>

      <div
        className={
          tab === "download" ? "overflow-hidden rounded-xl border border-line" : "hidden"
        }
      >
        <div className="px-3.5 py-2.5">
          <p className="text-xs font-medium text-body">{t("下载文件")}</p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-faint">{t("粘贴 http / https 链接即可下载，可自定义保存文件名；留空时按链接自动获取。重名时自动加序号，不会覆盖已有文件。")}</p>
        </div>

        <div className="space-y-2.5 border-t border-line-soft px-3.5 py-3">
          <div className="flex items-center gap-2">
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !downloading) void guard(handleDownload);
              }}
              placeholder="https://example.com/file.zip"
              spellCheck={false}
              className="min-w-0 flex-1 px-2 py-1.5 text-xs input-modern"
            />
            <button
              type="button"
              onClick={() => void guard(handleDownload)}
              disabled={downloading}
              className="flex flex-shrink-0 items-center gap-1.5 rounded-lg bg-primary-500 px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="editor-export" className="w-3.5 h-3.5" />
              {downloading ? t("下载中…") : t("下载")}
            </button>
            {downloading && (
              <button
                type="button"
                onClick={() => void guard(handleCancel)}
                className="flex flex-shrink-0 items-center gap-1.5 rounded-lg border border-line px-2.5 py-1.5 text-xs text-body transition-colors hover:bg-surface-alt"
              >
                <Icon name="ai-stop" className="w-3.5 h-3.5" />
                {t("取消")}</button>
            )}
          </div>

          <input
            type="text"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !downloading) void guard(handleDownload);
            }}
            placeholder={t("自定义文件名（留空则按链接自动识别）")}
            spellCheck={false}
            className="w-full px-2 py-1.5 text-xs input-modern"
          />

          <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
            <p className="selectable min-w-0 flex-1 break-all text-[10px] leading-relaxed text-faint-soft">{t("保存位置：{value1}", { value1: downloadDir || t("软件安装目录/download") })}</p>
            <button
              type="button"
              onClick={() => void guard(openDir)}
              disabled={!downloadDir}
              className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint transition-colors hover:bg-surface-alt hover:text-body disabled:cursor-not-allowed disabled:opacity-40"
              title={t("在文件管理器中打开下载目录")}
            >
              <Icon name="sidebar-folder-thin" className="w-3 h-3" />
              {t("打开目录")}</button>
          </div>
        </div>
      </div>

      {/* 下载状态单独成区：先给完整文件信息与总进度，再列正在下载的线程（分片） */}
      {tab === "download" && (progress || (lastFile && !downloading)) && (
        <div className="space-y-2">
          {progress && (
            <div className="rounded-xl border border-line bg-surface px-3.5 py-3">
              <div className="flex items-start gap-2">
                <Icon
                  name="editor-export"
                  className="mt-[1px] h-3.5 w-3.5 flex-shrink-0 text-primary-500"
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium text-body">
                    {progress.filename || t("正在下载")}
                  </p>
                  {progress.path && (
                    <p className="selectable break-all font-mono text-[10px] leading-relaxed text-faint">
                      {progress.path}
                    </p>
                  )}
                </div>
                <span className="flex-shrink-0 whitespace-nowrap text-[10px] tabular-nums text-faint">
                  {t("用时 {value1}", { value1: formatDuration(elapsed) })}
                </span>
              </div>

              <ProgressBar
                className="mt-2.5"
                value={percent}
                label={t("总进度")}
                detail={detail}
                // 进度未知时 detail 已经写了「准备下载…」，再挂一个占位「…」就重复了
                showPercent={percent !== null}
              />

              {progress.segments > 1 && (
                <p className="mt-1 text-[10px] text-faint-soft">
                  {t("{segments} 个线程并发 · 先下完的线程自动接下一片", {
                    segments: progress.segments,
                  })}
                </p>
              )}

              {singleThreadFallback && (
                <p className="mt-1 text-[10px] leading-relaxed text-faint-soft">{t("服务器不支持分段下载，已自动改用单线程（线程数设置在下次支持分段的链接上生效）。")}</p>
              )}

              {progress.segments > 1 && (
                <div className="mt-2.5 border-t border-line-soft pt-2">
                  <button
                    type="button"
                    onClick={() => setThreadsOpen((open) => !open)}
                    aria-expanded={threadsOpen}
                    className="flex w-full items-center justify-between rounded-md py-0.5 text-[10px] text-faint transition-colors hover:text-body"
                  >
                    <span className="flex items-center gap-1">
                      <Icon
                        name={threadsOpen ? "ai-chevron-down" : "ai-chevron-right"}
                        className="h-2.5 w-2.5"
                      />
                      {t("线程进度")}
                    </span>
                    <span className="tabular-nums">
                      {t("{value1} 个线程下载中", { value1: activeSegments.length })}
                    </span>
                  </button>
                  {threadsOpen &&
                    (activeSegments.length === 0 ? (
                      <p className="py-1 text-[10px] text-faint-soft">{t("等待分片分配…")}</p>
                    ) : (
                      <div className="mt-1 max-h-44 space-y-1 overflow-y-auto pr-0.5">
                        {activeSegments.map((item, position) => {
                          const segPercent =
                            item.total > 0
                              ? Math.max(0, Math.min(100, (item.downloaded / item.total) * 100))
                              : 0;
                          return (
                            <div
                              key={item.index}
                              className="flex items-center gap-2 text-[10px] tabular-nums"
                            >
                              <span className="w-9 flex-shrink-0 text-faint">#{position + 1}</span>
                              <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-strong">
                                <div
                                  className="h-full rounded-full bg-primary-500 transition-[width] duration-300"
                                  style={{ width: `${segPercent}%` }}
                                />
                              </div>
                              <span className="w-8 flex-shrink-0 text-right text-faint">
                                {Math.round(segPercent)}%
                              </span>
                              <span className="w-16 flex-shrink-0 text-right text-faint">
                                {formatSpeed(item.speed)}
                              </span>
                              <span className="w-28 flex-shrink-0 whitespace-nowrap text-right text-body">
                                {formatBytes(item.downloaded)} / {formatBytes(item.total)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                </div>
              )}
            </div>
          )}

          {lastFile && !downloading && (
            <div className="flex items-start gap-2 rounded-lg border border-line bg-app px-2.5 py-2">
              <Icon
                name="editor-check"
                className="mt-[1px] h-3.5 w-3.5 flex-shrink-0 text-success"
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[11px] text-body">{lastFile.name}</p>
                <p className="selectable break-all font-mono text-[10px] leading-relaxed text-faint">
                  {lastFile.path}
                </p>
              </div>
              <span className="flex-shrink-0 self-center whitespace-nowrap text-[10px] tabular-nums text-faint">
                {t("用时 {value1}", { value1: formatDuration(lastFile.elapsed) })}
              </span>
              <button
                type="button"
                onClick={() =>
                  void guard(async () => {
                    try {
                      await revealItemInDir(lastFile.path);
                    } catch (e) {
                      showToast(t("打开文件位置失败：{value1}", { value1: errorText(e) }), "error");
                    }
                  })
                }
                className="flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[10px] text-faint hover:bg-surface-alt hover:text-body"
                title={t("在文件管理器中显示")}
              >
                <Icon name="sidebar-folder-thin" className="w-3 h-3" />
                {t("打开")}</button>
            </div>
          )}
        </div>
      )}

      {tab === "fingerprint" && <FingerprintPanel />}
    </div>
  );
};
