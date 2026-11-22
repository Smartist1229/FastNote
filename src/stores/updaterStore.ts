/**
 * 应用内自动更新的状态层。
 *
 * 数据来源是 Rust 侧的双线更新命令（CNB / GitHub）：启动后静默检查一次，
 * 用户也可以在「关于」里手动检查。检查时会同时探测两条线路的延迟，
 * 默认选最快的一条，用户可以在弹窗里手动切换后再下载。
 *
 * 本地只持久化两件事——用户跳过的版本和手动选择的线路。
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
import { downloadCandidates, lineName, resolveUpdateTarget } from "@/lib/updater/lines";
import type { UpdateLineChoice, UpdateLineId, UpdateLineProbe } from "@/lib/updater/lines";

export type { UpdateLineChoice, UpdateLineId, UpdateLineProbe } from "@/lib/updater/lines";

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

export interface UpdaterSnapshot {
  phase: UpdaterPhase;
  /** 本次要下载的新版本；仅在 available / downloading 时有值 */
  version: string | null;
  /** 该版本的更新说明（latest.json 的 notes） */
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
  /** 是否正在重新测速：只影响「重新测速」按钮的文案与禁用态 */
  linesBusy: boolean;
  /**
   * 最近一次检查更新的时间与触发方式。
   * 自动检查完全静默（不弹窗、不占「检查中」），这一行是它唯一留下的痕迹。
   */
  lastCheck: { at: number; mode: "auto" | "manual" } | null;
  /** 用户选择：auto 或固定某条线（固定线路即使连不上也保持选中） */
  lineChoice: UpdateLineChoice;
  /** 本次下载优先尝试的线路：手选就是所选线路，auto 时是最快线路 */
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
  linesBusy: false,
  lastCheck: null,
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

const describeError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
};

/** Rust 的错误统一是 `code|detail`：code 用于分支，detail 用于展示 */
const splitError = (error: unknown): { code: string; detail: string } => {
  const raw = describeError(error);
  const index = raw.indexOf("|");
  return index === -1
    ? { code: raw, detail: "" }
    : { code: raw.slice(0, index), detail: raw.slice(index + 1) };
};

/** 只取错误码：下载失败后据此决定是否重测线路 */
const errorCode = (error: unknown): string => splitError(error).code;

/** Rust 的安装错误是 `code|detail`，在这里按当前语言翻译 */
const describeInstallError = (error: unknown): string => {
  const { code, detail } = splitError(error);
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
      return describeError(error);
  }
};

/**
 * 正在进行的探测。静默检查、手动检查、「重新测速」共用同一份结果：
 * 同一时刻最多只打两次 HTTP，谁也不必为别人的请求再等一轮。
 */
let probeTask: Promise<ProbeOutcome> | null = null;

/** 一次探测的原始结果。怎么展示（静默/手动/重测）由调用方决定，不在这里定 */
interface ProbeOutcome {
  lines: UpdateLineProbe[];
  /** 两条线都连不上、或命令本身失败；null 表示至少有一条线给了答复 */
  failure: string | null;
}

const runProbe = (): Promise<ProbeOutcome> => {
  if (probeTask) return probeTask;

  probeTask = (async (): Promise<ProbeOutcome> => {
    try {
      const probed = await invoke<UpdateLineProbe[]>("probe_update_lines");
      const lines = Array.isArray(probed) ? probed : [];
      const unreachable = lines.length === 0 || lines.every((line) => line.error);
      const detail = lines
        .map((line) => `${lineName(line.id)}: ${line.error ?? t("未知错误")}`)
        .join("; ");
      return { lines, failure: unreachable ? detail || t("无法连接更新服务器") : null };
    } catch (error) {
      return { lines: [], failure: describeError(error) };
    }
  })().finally(() => {
    probeTask = null;
  });

  return probeTask;
};

/**
 * 检查更新（同时探测两条线路）。
 *
 * 两种语义共用一次探测，**互不排挤**：
 * - `silent = true`（启动 / 定时）：只更新状态，不弹窗、失败不打扰；
 * - `silent = false`（设置里手动点）：显示「检查中...」，有更新就弹窗，失败显示原因。
 *
 * 自动检查不占用「检查中」这个界面状态，所以手动按钮不会被锁住；
 * 手动点击时如果后台正好在探测，直接等同一份结果，不会白跑第二趟。
 *
 * @param silent 静默检查：失败只保持现状，不展示错误
 * @returns 有更新时返回版本与说明，否则 null
 */
export const checkForUpdates = async (silent = false): Promise<UpdateInfo | null> => {
  if (!isTauri()) return null;
  // 只有手动检查才让界面进入「检查中」：自动检查是后台行为，不该锁住入口
  if (!silent) publish({ phase: "checking", error: null });

  const outcome = await runProbe();
  // 探测一结束就记下时间：无论有没有新版本、成功还是失败，「检查过」这件事是真的
  publish({ lastCheck: { at: Date.now(), mode: silent ? "auto" : "manual" } });
  // 线路偏好在探测期间可能被改（弹窗里换线），这里按当前值重新解析
  const target = resolveUpdateTarget(outcome.lines, snapshot.lineChoice);
  const version = target.versionLine?.version ?? null;
  const notes = target.versionLine?.notes ?? null;
  const activeLine = target.downloadLine?.id ?? null;

  if (!version) {
    if (outcome.failure) {
      // 静默检查失败时保持现状：把已经探测到的更新抹掉（侧栏图标闪一下）比不报错更糟
      if (!silent) {
        publish({ phase: "error", lines: outcome.lines, error: outcome.failure });
      }
      return null;
    }
    publish({ phase: "current", lines: outcome.lines, activeLine });
    return null;
  }

  // 用户跳过的版本：启动时的静默检查不再提示，手动检查仍然照常返回
  if (silent && version === readSkippedVersion()) {
    publish({ phase: "idle", lines: outcome.lines, activeLine });
    return null;
  }

  // 手动检查直接弹窗展示更新说明；静默检查只发一条提示，不打断用户
  publish({
    phase: "available",
    version,
    notes,
    lines: outcome.lines,
    activeLine,
    dialogOpen: silent ? snapshot.dialogOpen : true,
    error: null,
  });
  return { version, notes };
};

/**
 * 探测两条线路并把结果写回状态（供「重新测速」与下载失败恢复共用）。
 *
 * 不做阶段守卫：`version_changed` 的恢复要在 downloading 阶段执行。
 * 阶段判断留给调用方——「重新测速」按钮不该在下载中生效，而恢复路径必须生效。
 */
const probeLines = async (): Promise<void> => {
  publish({ linesBusy: true });
  try {
    const outcome = await runProbe();
    // 命令本身失败（IPC 异常）时保留上一次结果：用户手上可能正对着一个可下载的版本
    if (outcome.failure && outcome.lines.length === 0) return;
    const target = resolveUpdateTarget(outcome.lines, snapshot.lineChoice);
    const version = target.versionLine?.version ?? null;
    publish({
      lines: outcome.lines,
      activeLine: target.downloadLine?.id ?? null,
      version,
      notes: target.versionLine?.notes ?? null,
    });
    // 重测后两条线都没有新版本（例如发布被撤回）：从「可更新」退回首屏状态
    if (!version && snapshot.phase === "available") {
      publish({ phase: "current", progress: null, speed: null, downloaded: null, total: null });
    }
  } finally {
    publish({ linesBusy: false });
  }
};

/**
 * 重新测速（不动当前阶段与已下载的安装包）。
 *
 * 用途：自动选线路看的是上一次探测结果，开/关代理后延迟会翻转；
 * 用户可以随时重测而不必走一遍「检查更新」（后者会重置整个状态、关掉弹窗）。
 * 下载中 / 已下载 / 安装中不测速：这些阶段的结果已经与界面上的安装包绑定。
 */
export const refreshLines = async (): Promise<void> => {
  if (!isTauri()) return;
  if (
    snapshot.phase === "downloading" ||
    snapshot.phase === "ready" ||
    snapshot.phase === "installing"
  ) {
    return;
  }
  await probeLines();
};

/**
 * 切换下载线路（auto 或固定某条线），立即刷新弹窗里展示的版本与说明。
 *
 * **不做可用性拦截**：探测失败只说明这一次请求没通，开代理 / 换网络后仍然可能连上；
 * 用探测结果禁用选项，等于把「GitHub 走代理更快」这类场景彻底封死。
 * 版本号取自「能提供新版本的那条线」，所以手选一条连不上的线路时弹窗照样显示新版本是什么。
 */
export const selectUpdateLine = (choice: UpdateLineChoice) => {
  writeLineChoice(choice);
  const target = resolveUpdateTarget(snapshot.lines, choice);
  publish({
    lineChoice: choice,
    activeLine: target.downloadLine?.id ?? null,
    version: target.versionLine?.version ?? snapshot.version,
    notes: target.versionLine?.notes ?? snapshot.notes,
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
    // 已经装好、只是自动重启失败：用户手动重启即可
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
 * 换线只影响这次会话的目标与展示，不写入用户保存的线路偏好——
 * 用户手选的线路是长期偏好，不能因为一次下载失败就被悄悄改掉。
 */
export const downloadUpdate = async (): Promise<void> => {
  const first = snapshot.activeLine;
  const version = snapshot.version;
  if (!first || !version || snapshot.phase !== "available") return;

  const candidates = downloadCandidates(snapshot.lines, first, version);

  publish({
    phase: "downloading",
    progress: 0,
    speed: null,
    downloaded: null,
    total: null,
    error: null,
    lineFallback: null,
  });

  let downloaded = false;
  let lastError: unknown = null;
  for (const [index, line] of candidates.entries()) {
    if (index > 0) {
      publish({
        activeLine: line,
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
    // 线路上的版本在检查与下载之间变了：重测一次，让弹窗里的版本号与说明跟上，
    // 否则用户会对着旧版本反复重试，每次都撞同一个 version_changed
    if (errorCode(lastError) === "version_changed") {
      await probeLines();
      publish({
        phase: snapshot.version ? "available" : "current",
        error: describeInstallError(lastError),
        progress: null,
        speed: null,
        downloaded: null,
        total: null,
      });
      return;
    }
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
    // 用户已经自己点了「检查更新」或正开着更新弹窗：让手动操作说了算，别再插一脚
    if (snapshot.phase === "checking" || snapshot.dialogOpen) return;
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
      probeTask !== null ||
      snapshot.linesBusy ||
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
