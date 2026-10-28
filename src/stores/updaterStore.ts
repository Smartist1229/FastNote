/**
 * 应用内自动更新的状态层。
 *
 * 数据来源是 Tauri updater 插件：启动后静默检查一次，用户也可以在「关于」里手动检查。
 * 更新与否由远端 latest.json 决定；本地只持久化两件事——用户跳过的版本，
 * 以及安装前缓存的更新说明（见 lib/releaseNotes.ts）。
 *
 * 交互约定：
 *   - 启动检查失败保持安静，不把离线等临时问题写进「关于」页；
 *   - 手动检查失败才展示错误；
 *   - 下载完成后 Windows 安装器会结束当前进程并自动重启，其他平台由 relaunch 兜底。
 */
import { useSyncExternalStore } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { clearPendingRelease, recordPendingRelease } from "@/lib/releaseNotes";

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "error";

export interface UpdaterSnapshot {
  phase: UpdaterPhase;
  /** 远端新版本号；仅在 available / downloading 时有值 */
  version: string | null;
  /** 更新说明（latest.json 的 notes） */
  notes: string | null;
  /** 下载进度百分比；未知总大小或不在下载中时为 null */
  progress: number | null;
  /** 手动检查失败时的错误信息 */
  error: string | null;
  /** 用户主动跳过的版本：启动时的静默检查不再提示，手动检查仍然展示 */
  skippedVersion: string | null;
  /** 「发现新版本」弹窗是否打开：手动检查到新版本时自动打开，关闭后可从「关于」再唤出 */
  dialogOpen: boolean;
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
}

const SKIPPED_KEY = "fastnote.updater.skippedVersion";

const readSkippedVersion = (): string | null => {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
};

const INITIAL: UpdaterSnapshot = {
  phase: "idle",
  version: null,
  notes: null,
  progress: null,
  error: null,
  skippedVersion: readSkippedVersion(),
  dialogOpen: false,
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

/** 当前检查到的更新资源；安装用它，重新检查时释放 */
let pendingUpdate: Update | null = null;
/** 正在进行的检查：并发调用共用同一个 Promise，避免重复请求远端 */
let checkTask: Promise<UpdateInfo | null> | null = null;

const describeError = (error: unknown): string => {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
};

const releasePending = () => {
  const update = pendingUpdate;
  pendingUpdate = null;
  if (update) void update.close().catch(() => {});
};

/**
 * 检查更新。
 *
 * @param silent 启动时的静默检查：失败只回到 idle，不展示错误
 * @returns 有更新时返回版本与说明，否则 null
 */
export const checkForUpdates = async (silent = false): Promise<UpdateInfo | null> => {
  if (!isTauri()) return null;
  if (checkTask) return checkTask;

  checkTask = (async () => {
    releasePending();
    // 跳过状态不属于「这一次检查」，重置展示状态时要保留
    publish({ ...INITIAL, phase: "checking", skippedVersion: readSkippedVersion() });
    try {
      // 超时兜底：网络异常时不让「检查中」永远转下去
      const update = await check({ timeout: 15000 });
      if (!update) {
        publish({ phase: "current" });
        return null;
      }
      // 用户跳过的版本：启动时的静默检查不再提示，手动检查仍然照常返回
      if (silent && update.version === readSkippedVersion()) {
        await update.close().catch(() => {});
        publish({ phase: "idle" });
        return null;
      }
      pendingUpdate = update;
      const info: UpdateInfo = { version: update.version, notes: update.body ?? null };
      // 手动检查直接弹窗展示更新说明；启动时的静默检查只发一条提示，不打断用户
      publish({ phase: "available", version: info.version, notes: info.notes, dialogOpen: !silent });
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

/** 下载并安装当前更新；Windows 上安装器会接管重启 */
export const installUpdate = async (): Promise<void> => {
  const update = pendingUpdate;
  if (!update || snapshot.phase !== "available") return;

  publish({ phase: "downloading", progress: 0, error: null });
  // Windows 的安装器会在下载完成后直接结束进程，后面的代码不保证执行：
  // 更新说明必须在下载前落盘，下次启动才对得上版本
  recordPendingRelease(update.version, snapshot.notes);
  let downloaded = 0;
  let total: number | null = null;

  try {
    await update.downloadAndInstall((event: DownloadEvent) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? null;
        publish({ progress: 0 });
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        if (total && total > 0) {
          const percent = Math.min(100, Math.round((downloaded / total) * 100));
          // 只按整数百分比推送，避免每个分片都触发一次 React 重渲染
          if (percent !== snapshot.progress) publish({ progress: percent });
        }
        return;
      }
      publish({ progress: 100 });
    });
    // Windows 结束当前进程由安装器负责；macOS / Linux 需要手动重启
    await relaunch();
  } catch (error) {
    // 安装没成功：清掉缓存的说明，避免下次启动误报「已更新」
    clearPendingRelease();
    // 安装失败时保留更新资源：回到「可更新」状态，用户可以重试或重新检查
    publish({ phase: "available", error: describeError(error), progress: null });
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
 * 用模块级标记去重：StrictMode 下 effect 会跑两遍，这里只真正调度一次。
 */
let startupCheckScheduled = false;
export const scheduleStartupCheck = (onUpdate: (info: UpdateInfo) => void) => {
  // 开发期版本号低于线上发布版时会被判定为「有更新」，不打扰调试
  if (startupCheckScheduled || import.meta.env.DEV) return;
  startupCheckScheduled = true;
  window.setTimeout(() => {
    void checkForUpdates(true).then((info) => {
      if (info) onUpdate(info);
    });
  }, 5000);
};

export const useUpdater = (): UpdaterSnapshot =>
  useSyncExternalStore(subscribe, getSnapshot);
