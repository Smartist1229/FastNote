/**
 * 应用内自动更新的状态层。
 *
 * 数据来源是 Rust 侧的双线更新命令（CNB / GitHub）：启动后静默检查一次，
 * 用户也可以在「关于」里手动检查。检查时会同时探测两条线路的延迟，
 * 默认选最快的一条，用户可以在弹窗里手动切换后再下载。
 *
 * 本地只持久化三件事——用户跳过的版本、手动选择的线路，
 * 以及安装前缓存的更新说明（见 lib/releaseNotes.ts）。
 *
 * 交互约定：
 *   - 启动检查失败保持安静，不把离线等临时问题写进「关于」页；
 *   - 手动检查失败才展示错误；
 *   - 下载完成后 Windows 安装器会结束当前进程并自动重启，其他平台由 relaunch 兜底。
 */
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { relaunch } from "@tauri-apps/plugin-process";
import { useSyncExternalStore } from "react";
import { t } from "@/i18n";
import { clearPendingRelease, recordPendingRelease } from "@/lib/releaseNotes";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  /** 安装包已下载并验签，等待用户确认安装 */
  | "ready"
  /** 正在启动安装程序；Windows 上随后由安装器结束进程 */
  | "installing"
  | "error";

export type UpdateLineId = "cnb" | "github";
/** auto = 按延迟自动选最快；指定线路 = 用户手动选择 */
export type UpdateLineChoice = "auto" | UpdateLineId;

/** Rust `probe_update_lines` 的返回结构（字段已转成 camelCase） */
export interface UpdateLineProbe {
  id: UpdateLineId;
  endpoint: string;
  /** 清单请求耗时；不可达时为 null */
  latencyMs: number | null;
  /** 该线路可提供的新版本；已是最新或不可达时为 null */
  version: string | null;
  notes: string | null;
  error: string | null;
}

export interface UpdaterSnapshot {
  phase: UpdaterPhase;
  /** 当前生效线路提供的新版本；仅在 available / downloading 时有值 */
  version: string | null;
  /** 当前生效线路的更新说明（latest.json 的 notes） */
  notes: string | null;
  /** 下载进度百分比；未知总大小或不在下载中时为 null */
  progress: number | null;
  /** 实时下载速度（字节/秒，指数平滑后）；不在下载中或还没测出时为 null */
  speed: number | null;
  /** 已下载字节数；不在下载中时为 null */
  downloaded: number | null;
  /** 安装包总字节数；不在下载中或服务端未提供时为 null */
  total: number | null;
  /** 本次下载是否因失败自动换过线路 */
  lineFallback: UpdateLineFallback | null;
  /** 手动检查失败时的错误信息 */
  error: string | null;
  /** 用户主动跳过的版本：启动时的静默检查不再提示，手动检查仍然展示 */
  skippedVersion: string | null;
  /** 「发现新版本」弹窗是否打开：手动检查到新版本时自动打开，关闭后可从「关于」再唤出 */
  dialogOpen: boolean;
  /** 两条线路的探测结果，按 Rust 返回顺序（cnb、github） */
  lines: UpdateLineProbe[];
  /** 用户选择：auto 或固定某条线 */
  lineChoice: UpdateLineChoice;
  /** 实际使用的线路：手动线路可用时用它，否则回落到最快线路 */
  activeLine: UpdateLineId | null;
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

/** 下载线路失败后自动换到另一条线的一次记录，用于在弹窗里说明原因 */
export interface UpdateLineFallback {
  from: UpdateLineId;
  to: UpdateLineId;
}

interface UpdateDownloadProgress {
  downloaded: number;
  total: number | null;
}

const SKIPPED_KEY = "fastnote.updater.skippedVersion";
const LINE_KEY = "fastnote.updater.line";

/** 速度采样窗口与界面推送间隔：分片事件每秒几十条，逐条重渲染会拖慢界面 */
const SPEED_SAMPLE_MS = 500;
const PUBLISH_INTERVAL_MS = 400;

const readSkippedVersion = (): string | null => {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
};

const readLineChoice = (): UpdateLineChoice => {
  try {
    const value = localStorage.getItem(LINE_KEY);
    return value === "cnb" || value === "github" ? value : "auto";
  } catch {
    return "auto";
  }
};

const writeLineChoice = (choice: UpdateLineChoice) => {
  try {
    localStorage.setItem(LINE_KEY, choice);
  } catch {
    // 存储不可用时只影响下次启动的默认线路，不打断更新
  }
};

const INITIAL: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  notes: null,
  progress: null,
  speed: null,
  downloaded: null,
  total: null,
  lineFallback: null,
  error: null,
  skippedVersion: readSkippedVersion(),
  dialogOpen: false,
  lines: [],
  lineChoice: readLineChoice(),
  activeLine: null,
};

let snapshot: UpdaterSnapshot = INITIAL;
const listeners = new Set<() => void>();

const publish = (patch: Partial<UpdaterSnapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach((listener) => listener());
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => snapshot;

/** 正在进行的检查：并发调用共用同一个 Promise，避免重复请求远端 */
let checkTask: Promise<UpdateInfo | null> | null = null;

const describeError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
};

/** Rust 的安装错误是 `code|detail`，在这里按当前语言翻译 */
const describeInstallError = (error: unknown): string => {
  const raw = describeError(error);
  const index = raw.indexOf("|");
  const code = index === -1 ? raw : raw.slice(0, index);
  const detail = index === -1 ? "" : raw.slice(index + 1);
  switch (code) {
    case "no_update":
      return t("该线路当前没有可用更新，请重新检查。");
    case "version_changed":
      return t("该线路的版本已变为 {value1}，请重新检查更新。", { value1: detail });
    case "check_failed":
      return t("检查更新失败：{value1}", { value1: detail });
    case "download_failed":
      return t("下载或安装失败：{value1}", { value1: detail });
    case "not_downloaded":
      return t("没有可安装的更新包，请重新下载。");
    default:
      return raw;
  }
};

const lineName = (id: UpdateLineId): string => (id === "cnb" ? "CNB" : "GitHub");

const hasUpdate = (line: UpdateLineProbe): boolean =>
  !line.error && Boolean(line.version);

/** 最快且真有新版本的线路；延迟未知的排最后 */
const fastestLine = (lines: UpdateLineProbe[]): UpdateLineProbe | null => {
  const candidates = lines.filter(hasUpdate);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      (a.latencyMs ?? Number.MAX_SAFE_INTEGER) -
      (b.latencyMs ?? Number.MAX_SAFE_INTEGER),
  )[0];
};

const resolveLine = (
  lines: UpdateLineProbe[],
  choice: UpdateLineChoice,
): UpdateLineProbe | null => {
  if (choice !== "auto") {
    const chosen = lines.find((line) => line.id === choice);
    if (chosen && hasUpdate(chosen)) return chosen;
  }
  return fastestLine(lines);
};

/**
 * 检查更新（同时探测两条线路）。
 *
 * @param silent 启动时的静默检查：失败只回到 idle，不展示错误
 * @returns 有更新时返回版本与说明，否则 null
 */
export const checkForUpdates = async (silent = false): Promise<UpdateInfo | null> => {
  if (!isTauri()) return null;
  if (checkTask) return checkTask;

  checkTask = (async () => {
    // 跳过状态与线路偏好不属于「这一次检查」，重置展示状态时要保留
    const choice = readLineChoice();
    publish({
      ...INITIAL,
      phase: "checking",
      skippedVersion: readSkippedVersion(),
      lineChoice: choice,
    });
    try {
      const lines = await invoke<UpdateLineProbe[]>("probe_update_lines");
      const available = Array.isArray(lines) ? lines.filter(hasUpdate) : [];

      if (available.length === 0) {
        const reachable = Array.isArray(lines) && lines.some((line) => !line.error);
        if (!reachable) {
          const detail = (lines ?? [])
            .map((line) => `${lineName(line.id)}: ${line.error ?? t("未知错误")}`)
            .join("; ");
          if (silent) {
            publish({ phase: "idle" });
          } else {
            publish({
              phase: "error",
              lines: lines ?? [],
              error: detail || t("无法连接更新服务器"),
            });
          }
          return null;
        }
        publish({ phase: "current", lines });
        return null;
      }

      const active = resolveLine(lines, choice);
      if (!active || !active.version) {
        publish({ phase: "current", lines });
        return null;
      }
      // 用户跳过的版本：启动时的静默检查不再提示，手动检查仍然照常返回
      if (silent && active.version === readSkippedVersion()) {
        publish({ phase: "idle", lines, activeLine: active.id });
        return null;
      }

      const info: UpdateInfo = { version: active.version, notes: active.notes };
      // 手动检查直接弹窗展示更新说明；启动时的静默检查只发一条提示，不打断用户
      publish({
        phase: "available",
        version: info.version,
        notes: info.notes,
        lines,
        activeLine: active.id,
        dialogOpen: !silent,
      });
      return info;
    } catch (error) {
      if (silent) {
        publish({ phase: "idle" });
      } else {
        publish({ phase: "error", error: describeError(error) });
      }
      return null;
    } finally {
      checkTask = null;
    }
  })();

  return checkTask;
};

/** 切换下载线路：auto 或固定某条线；立即刷新弹窗里展示的版本与说明 */
export const selectUpdateLine = (choice: UpdateLineChoice) => {
  if (choice !== "auto") {
    const line = snapshot.lines.find((item) => item.id === choice);
    // 不可用/没有新版本的线路不允许选中，避免下载按钮指向空线路
    if (!line || line.error || !line.version) return;
  }
  writeLineChoice(choice);
  const active = resolveLine(snapshot.lines, choice);
  publish({
    lineChoice: choice,
    activeLine: active?.id ?? null,
    version: active?.version ?? snapshot.version,
    notes: active?.notes ?? snapshot.notes,
    lineFallback: null,
  });
};

/** 从指定线路下载并安装，进度经 Channel 推给状态层 */
const downloadFrom = async (line: UpdateLineId, version: string): Promise<void> => {
  const channel = new Channel<UpdateDownloadProgress>();
  let total: number | null = null;
  // 速度按「两个采样点之间的字节差」估算：分片事件间隔只有几毫秒，
  // 单次直接算全是抖动，所以攒够 500ms 再算一次，并做指数平滑
  let sampleAt = performance.now();
  let sampleBytes = 0;
  let speed: number | null = null;
  let publishedAt = -PUBLISH_INTERVAL_MS;
  channel.onmessage = (event) => {
    if (event.total && event.total > 0) total = event.total;

    const now = performance.now();
    const elapsed = now - sampleAt;
    if (elapsed >= SPEED_SAMPLE_MS) {
      const instant = Math.max(0, ((event.downloaded - sampleBytes) / elapsed) * 1000);
      speed = speed === null ? instant : speed * 0.65 + instant * 0.35;
      sampleAt = now;
      sampleBytes = event.downloaded;
    }

    // 进度与速度一起节流推送，避免每个分片都触发一次 React 重渲染
    if (now - publishedAt < PUBLISH_INTERVAL_MS) return;
    publishedAt = now;
    const progress = total ? Math.min(100, Math.round((event.downloaded / total) * 100)) : null;
    publish({
      progress,
      speed: speed === null ? null : Math.round(speed),
      downloaded: event.downloaded,
      total,
    });
  };

  await invoke("download_update", {
    line,
    expectedVersion: version,
    onEvent: channel,
  });
};

/** 应用已下载的更新：Windows 上安装器启动后由它结束本进程，其他平台安装完再重启 */
export const applyUpdate = async (): Promise<void> => {
  const version = snapshot.version;
  if (!version || snapshot.phase !== "ready") return;

  publish({ phase: "installing", error: null });
  try {
    await invoke("install_downloaded_update", { expectedVersion: version });
  } catch (error) {
    // 安装包已丢失或版本对不上：回到「已下载」状态，用户可以重试或重新下载
    publish({ phase: "ready", error: describeInstallError(error) });
    return;
  }
  try {
    await relaunch();
  } catch {
    // 已经装好、只是自动重启失败：保留缓存的说明，用户手动重启即可
  }
};

/**
 * 下载当前线路的安装包（失败时自动换到另一条能提供同一版本的线路重试一次）。
 *
 * 下载与安装是分开的：完成后停在「已下载」，不再自动关闭软件。
 * 下载完成时如果弹窗还开着就直接安装；弹窗已被关闭则重新打开弹窗询问，
 * 之后从弹窗或侧栏图标都能直接安装，不需要重新下载。
 *
 * 只回退到版本相同的线路：版本不同会装出与弹窗里更新说明对不上的包。
 * 换线只影响这次会话的目标与展示，不写入用户保存的线路偏好。
 */
export const downloadUpdate = async (): Promise<void> => {
  const first = snapshot.activeLine;
  const version = snapshot.version;
  if (!first || !version || snapshot.phase !== "available") return;

  const candidates: UpdateLineId[] = [
    first,
    ...snapshot.lines
      .filter((line) => line.id !== first && hasUpdate(line) && line.version === version)
      .map((line) => line.id),
  ];

  publish({
    phase: "downloading",
    progress: 0,
    speed: null,
    downloaded: null,
    total: null,
    error: null,
    lineFallback: null,
  });
  // 安装完成后会结束进程，后面的代码不保证执行：
  // 更新说明必须在下载前落盘，下次启动才对得上版本
  recordPendingRelease(version, snapshot.notes);

  let downloaded = false;
  let lastError: unknown = null;
  for (const [index, line] of candidates.entries()) {
    if (index > 0) {
      publish({
        activeLine: line,
        lineChoice: line,
        progress: 0,
        speed: null,
        downloaded: null,
        total: null,
        lineFallback: { from: first, to: line },
      });
    }
    try {
      await downloadFrom(line, version);
      downloaded = true;
      break;
    } catch (error) {
      lastError = error;
    }
  }

  if (!downloaded) {
    // 下载没成功：清掉缓存的说明，避免下次启动误报「已更新」
    clearPendingRelease();
    // 保留线路与更新资源：回到「可更新」状态，用户可以重试或换线
    publish({
      phase: "available",
      error: describeInstallError(lastError),
      progress: null,
      speed: null,
      downloaded: null,
      total: null,
    });
    return;
  }

  publish({ phase: "ready", progress: 100, speed: null, error: null });
  if (snapshot.dialogOpen) {
    void applyUpdate();
  } else {
    // 弹窗已经关掉：重新打开它询问是否立即安装
    publish({ dialogOpen: true });
  }
};

/** 跳过某个版本：启动静默检查不再提示它，直到用户取消跳过或换到更高版本 */
export const skipVersion = (version: string) => {
  try {
    localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    return;
  }
  publish({ skippedVersion: version, dialogOpen: false });
};

export const clearSkippedVersion = () => {
  try {
    localStorage.removeItem(SKIPPED_KEY);
  } catch {
    return;
  }
  publish({ skippedVersion: null });
};

/** 打开「发现新版本」弹窗：手动检查后自动打开，关闭后也可从「关于」再唤出 */
export const openUpdateDialog = () => publish({ dialogOpen: true });
export const closeUpdateDialog = () => publish({ dialogOpen: false });

/**
 * 启动后静默检查一次（延迟执行，避开启动时的读库与首屏渲染）。
 * 结果只写进状态层：有更新时由侧栏底部的「更新」按钮提示，不弹弹窗也不弹 Toast。
 * 用模块级标记去重：StrictMode 下 effect 会跑两遍，这里只真正调度一次。
 */
let startupCheckScheduled = false;
export const scheduleStartupCheck = () => {
  // 开发期版本号低于线上发布版时会被判定为「有更新」，不打扰调试
  if (startupCheckScheduled || import.meta.env.DEV) return;
  startupCheckScheduled = true;
  window.setTimeout(() => {
    void checkForUpdates(true);
  }, 5000);
};

/** 运行期间的定时检查计时器；null = 未启动或已关闭 */
let periodicTimer: number | null = null;

/**
 * 按设置里的间隔在运行期间定时检查更新（0 = 关闭）。
 *
 * 结果只走静默检查：发现新版本只点亮侧栏更新图标，不弹窗。
 * 检查会重置整个更新状态，所以手动检查进行中、下载 / 已下载待安装 / 安装中、
 * 或更新弹窗正开着时都跳过这一轮，避免抹掉进度或已缓存的安装包。
 * 重复调用会先清掉旧计时器，设置改动立即按新间隔重新计时。
 */
export const schedulePeriodicCheck = (minutes: number) => {
  if (periodicTimer !== null) {
    window.clearInterval(periodicTimer);
    periodicTimer = null;
  }
  // 与启动检查一致：开发期版本号低于线上发布版时，不打扰调试
  if (minutes <= 0 || import.meta.env.DEV) return;
  periodicTimer = window.setInterval(() => {
    const busy =
      checkTask !== null ||
      snapshot.dialogOpen ||
      snapshot.phase === "checking" ||
      snapshot.phase === "downloading" ||
      snapshot.phase === "ready" ||
      snapshot.phase === "installing";
    if (busy) return;
    void checkForUpdates(true);
  }, minutes * 60_000);
};

export const useUpdater = (): UpdaterSnapshot =>
  useSyncExternalStore(subscribe, getSnapshot);
