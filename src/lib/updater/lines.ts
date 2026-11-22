/**
 * 更新线路的纯逻辑：探测结果 → 「这次从哪条线下载」与「版本/说明从哪条线取」。
 *
 * 抽成纯函数的原因：这两件事以前混在 store 里，规则一改就要连 UI 一起读。
 * 现在设置层、弹窗、测试共用同一套判定，不会出现「自动选最快」和「用户手选」两套规则。
 *
 * 关键语义（改之前先想清楚）：
 * - **手选线路永远生效**，哪怕它当前探测失败——国内开代理后 GitHub 反而更快，
 *   用探测失败去禁用选项等于把这个场景彻底封死。
 * - 版本/说明允许来自另一条线：手选的线没探到版本时，界面上仍然要能说清「新版本是什么」，
 *   否则用户看到「发现新版本」却不知道版本号。
 */

export type UpdateLineId = "cnb" | "github";

/** auto = 按延迟自动选最快；指定线路 = 用户手动选择（允许该线路当前探测失败） */
export type UpdateLineChoice = "auto" | UpdateLineId;

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

/** 线路显示名：日志与错误详情用英文代号，界面另有一层翻译 */
export const lineName = (id: UpdateLineId): string => (id === "cnb" ? "CNB" : "GitHub");

/** 该线路是否探测到了可下载的新版本（连不上 / 已是最新都不算） */
export const hasUpdate = (line: UpdateLineProbe): boolean =>
  !line.error && Boolean(line.version);

/** 最快且真有新版本的线路；延迟未知的排最后，同延迟保持原顺序 */
export const fastestLine = (lines: UpdateLineProbe[]): UpdateLineProbe | null => {
  const candidates = lines.filter(hasUpdate);
  if (candidates.length === 0) return null;
  return [...candidates].sort(
    (a, b) =>
      (a.latencyMs ?? Number.MAX_SAFE_INTEGER) -
      (b.latencyMs ?? Number.MAX_SAFE_INTEGER),
  )[0];
};

export interface UpdateTarget {
  /**
   * 下载时**优先尝试**的线路。手选时就是它本身（哪怕探测失败）；
   * auto 时是最快的那条；都没有新版本时为 null。
   */
  downloadLine: UpdateLineProbe | null;
  /** 版本号与更新说明的来源；downloadLine 没探到版本时借用另一条能提供新版本的线路 */
  versionLine: UpdateLineProbe | null;
}

/**
 * 解析本次下载目标。
 *
 * @param lines  两条线路的探测结果（顺序无关）
 * @param choice 用户选择：auto 或固定线路
 */
export const resolveUpdateTarget = (
  lines: UpdateLineProbe[],
  choice: UpdateLineChoice,
): UpdateTarget => {
  const fastest = fastestLine(lines);
  const chosen = choice === "auto" ? null : lines.find((line) => line.id === choice) ?? null;
  const downloadLine = choice === "auto" ? fastest : chosen;
  // 手选线路没探到版本（连不上 / 已是最新）时，说明仍然取自有新版本的那条线
  const versionLine = downloadLine && hasUpdate(downloadLine) ? downloadLine : fastest;
  return { downloadLine, versionLine };
};

/**
 * 下载顺序：先用户所选，再其余「版本一致」的线路。
 *
 * 只回退到版本相同的线路：版本不同会装出与弹窗里更新说明对不上的包。
 * 探测失败的线路不参与回退——让用户白等一次 8 秒超时不叫备用线路。
 */
export const downloadCandidates = (
  lines: UpdateLineProbe[],
  first: UpdateLineId | null,
  version: string,
): UpdateLineId[] => {
  if (!first) return [];
  const rest = lines
    .filter((line) => line.id !== first && hasUpdate(line) && line.version === version)
    .map((line) => line.id);
  return [first, ...rest];
};
