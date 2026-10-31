/**
 * 「更新完成」提示的数据来源。
 *
 * 安装开始前把 latest.json 里的说明存进 localStorage，下次启动时版本号对得上才展示；
 * 对不上说明这次安装没生效（下载失败 / 用户取消），缓存直接丢掉，不留到以后误报。
 * 同时记录上次运行的版本，手动覆盖安装时也能提示版本变化。
 */

const PENDING_KEY = "fastnote.updater.pendingRelease";
const LAST_RUN_KEY = "fastnote.updater.lastRunVersion";

export interface ReleaseNotice {
  version: string;
  /** 之前运行的版本；首次安装或版本号没变时为 null */
  previousVersion: string | null;
  /** 安装前缓存的更新说明；手动覆盖安装时为 null */
  notes: string | null;
}

/** 解析缓存：字段缺失或类型不对都按「没有缓存」处理，坏数据不能让启动流程中断 */
const readPending = (): { version: string; notes: string | null } | null => {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { version, notes } = parsed as { version?: unknown; notes?: unknown };
    if (typeof version !== "string" || version.length === 0) return null;
    return { version, notes: typeof notes === "string" ? notes : null };
  } catch {
    return null;
  }
};

/** 安装开始前调用：说明只在这次启动有效，失败时由 clearPendingRelease 清掉 */
export const recordPendingRelease = (version: string, notes: string | null) => {
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify({ version, notes }));
  } catch {
    // 隐私模式 / 配额满：提示缺失不影响更新本身
  }
};

export const clearPendingRelease = () => {
  try {
    localStorage.removeItem(PENDING_KEY);
  } catch {
    // 同上
  }
};

/**
 * 启动时调用一次：返回本次需要展示的更新说明，并刷新「上次运行版本」。
 * StrictMode 下 effect 会跑两遍，但第二次因为没有缓存、版本也没变会返回 null。
 */
export const consumeReleaseNotice = (currentVersion: string): ReleaseNotice | null => {
  let previous: string | null = null;
  let pending: { version: string; notes: string | null } | null = null;
  try {
    previous = localStorage.getItem(LAST_RUN_KEY);
    pending = readPending();
    localStorage.removeItem(PENDING_KEY);
    localStorage.setItem(LAST_RUN_KEY, currentVersion);
  } catch {
    return null;
  }

  if (pending && pending.version === currentVersion) {
    return {
      version: currentVersion,
      previousVersion: previous && previous !== currentVersion ? previous : null,
      notes: pending.notes,
    };
  }
  if (previous && previous !== currentVersion) {
    return { version: currentVersion, previousVersion: previous, notes: null };
  }
  return null;
};
