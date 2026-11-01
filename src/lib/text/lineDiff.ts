/**
 * 行级差异：历史版本对比用。
 *
 * 先剥离公共前后缀（大多数编辑只动中间一小段），再对中间段做 LCS 动态规划；
 * 中间段规模超过上限时不做逐行对比——长笔记不能让弹窗卡住主线程。
 */

export type DiffKind = "same" | "add" | "remove";

export interface DiffRow {
  kind: DiffKind;
  text: string;
  /** 旧版本行号（1 起）；新增行没有 */
  oldLine: number | null;
  /** 新版本行号（1 起）；删除行没有 */
  newLine: number | null;
}

export interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** 中间段过大、没有逐行对比：rows 只含公共首尾，统计数仍是整段的增删行数 */
  tooLarge: boolean;
}

/** DP 表上限（约 1000 × 1000 行）；Uint32 下最多占 4MB */
const MAX_CELLS = 1_000_000;

/** 行级差异；oldText 为历史版本，newText 为当前内容 */
export const diffLines = (oldText: string, newText: string): LineDiff => {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");

  let prefix = 0;
  const shared = Math.min(oldLines.length, newLines.length);
  while (prefix < shared && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let oldTail = oldLines.length;
  let newTail = newLines.length;
  while (oldTail > prefix && newTail > prefix && oldLines[oldTail - 1] === newLines[newTail - 1]) {
    oldTail -= 1;
    newTail -= 1;
  }

  const rows: DiffRow[] = [];
  for (let i = 0; i < prefix; i += 1) {
    rows.push({ kind: "same", text: oldLines[i], oldLine: i + 1, newLine: i + 1 });
  }

  const oldMid = oldLines.slice(prefix, oldTail);
  const newMid = newLines.slice(prefix, newTail);
  const n = oldMid.length;
  const m = newMid.length;
  let added = 0;
  let removed = 0;
  const tooLarge = n * m > MAX_CELLS;

  if (tooLarge) {
    added = m;
    removed = n;
  } else {
    const width = m + 1;
    /** lcs[i][j] = 旧中间段从 i、新中间段从 j 起的公共子序列长度 */
    const lcs = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i * width + j] =
          oldMid[i] === newMid[j]
            ? lcs[(i + 1) * width + j + 1] + 1
            : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
      }
    }

    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (oldMid[i] === newMid[j]) {
        rows.push({ kind: "same", text: oldMid[i], oldLine: prefix + i + 1, newLine: prefix + j + 1 });
        i += 1;
        j += 1;
      } else if (lcs[(i + 1) * width + j] >= lcs[i * width + j + 1]) {
        // 两侧都能凑出同样长的公共子序列时先报删除，改动处读起来更接近「原文被替换」
        rows.push({ kind: "remove", text: oldMid[i], oldLine: prefix + i + 1, newLine: null });
        removed += 1;
        i += 1;
      } else {
        rows.push({ kind: "add", text: newMid[j], oldLine: null, newLine: prefix + j + 1 });
        added += 1;
        j += 1;
      }
    }
    while (i < n) {
      rows.push({ kind: "remove", text: oldMid[i], oldLine: prefix + i + 1, newLine: null });
      removed += 1;
      i += 1;
    }
    while (j < m) {
      rows.push({ kind: "add", text: newMid[j], oldLine: null, newLine: prefix + j + 1 });
      added += 1;
      j += 1;
    }
  }

  for (let k = 0; k < oldLines.length - oldTail; k += 1) {
    rows.push({
      kind: "same",
      text: oldLines[oldTail + k],
      oldLine: oldTail + k + 1,
      newLine: newTail + k + 1,
    });
  }

  return { rows, added, removed, tooLarge };
};
