/**
 * 版本比较（极简）：按 `.` 切分，能解析成数字的段按数值比，否则按字典序。
 * 与 Rust 侧 `manifest::compare_versions` 口径一致——两边都只用来判「装得上吗」，
 * 不追求 semver 的预发布规则。
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = String(a ?? "").trim().split(".");
  const pb = String(b ?? "").trim().split(".");
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] ?? "0";
    const y = pb[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
};
