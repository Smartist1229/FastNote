import { describe, expect, it } from "vitest";
import {
  downloadCandidates,
  fastestLine,
  hasUpdate,
  resolveUpdateTarget,
} from "./lines";
import type { UpdateLineProbe } from "./lines";

const line = (patch: Partial<UpdateLineProbe> & { id: UpdateLineProbe["id"] }): UpdateLineProbe => ({
  endpoint: `https://example.com/${patch.id}`,
  latencyMs: null,
  version: null,
  notes: null,
  error: null,
  ...patch,
});

const cnbFast = line({ id: "cnb", latencyMs: 60, version: "2.9.4", notes: "cnb notes" });
const githubFast = line({ id: "github", latencyMs: 40, version: "2.9.4", notes: "gh notes" });
const githubDown = line({ id: "github", latencyMs: null, error: "timeout" });
const cnbCurrent = line({ id: "cnb", latencyMs: 80 });

describe("hasUpdate", () => {
  it("连不上的线路不算有新版本", () => {
    expect(hasUpdate(githubDown)).toBe(false);
    // 探测失败但残留版本号也不该被当成可下载
    expect(hasUpdate({ ...githubDown, version: "2.9.4" })).toBe(false);
  });

  it("已是最新的线路不算有新版本", () => {
    expect(hasUpdate(cnbCurrent)).toBe(false);
  });
});

describe("fastestLine", () => {
  it("只在有新版本的线路里挑延迟最低的", () => {
    expect(fastestLine([cnbFast, githubFast])?.id).toBe("github");
    expect(fastestLine([cnbFast, githubDown])?.id).toBe("cnb");
  });

  it("延迟未知的排在有延迟的后面", () => {
    expect(fastestLine([line({ id: "cnb", latencyMs: null, version: "2.9.4" }), githubFast])?.id).toBe(
      "github",
    );
  });

  it("没有可用线路时返回 null", () => {
    expect(fastestLine([cnbCurrent, githubDown])).toBeNull();
  });
});

describe("resolveUpdateTarget", () => {
  it("auto 用最快线路，版本也来自它", () => {
    const target = resolveUpdateTarget([cnbFast, githubFast], "auto");
    expect(target.downloadLine?.id).toBe("github");
    expect(target.versionLine?.version).toBe("2.9.4");
  });

  it("手选一条连不上的线路仍然以它为下载目标", () => {
    const target = resolveUpdateTarget([cnbFast, githubDown], "github");
    expect(target.downloadLine?.id).toBe("github");
    expect(target.downloadLine?.error).toBe("timeout");
  });

  it("手选线路没探到版本时，版本与说明借自另一条线", () => {
    const target = resolveUpdateTarget([cnbFast, githubDown], "github");
    expect(target.versionLine?.id).toBe("cnb");
    expect(target.versionLine?.notes).toBe("cnb notes");
  });

  it("手选线路已是最新时，仍然可以选中它，版本来自另一条线", () => {
    const target = resolveUpdateTarget([cnbCurrent, githubFast], "cnb");
    expect(target.downloadLine?.id).toBe("cnb");
    expect(target.versionLine?.id).toBe("github");
  });

  it("两条线都没有新版本时没有下载目标", () => {
    const target = resolveUpdateTarget([cnbCurrent, githubDown], "github");
    expect(target.downloadLine?.id).toBe("github");
    expect(target.versionLine).toBeNull();
  });
});

describe("downloadCandidates", () => {
  it("先把手选线路排在第一位", () => {
    expect(downloadCandidates([cnbFast, githubFast], "github", "2.9.4")).toEqual([
      "github",
      "cnb",
    ]);
  });

  it("只回退到版本相同的线路", () => {
    const older = line({ id: "github", latencyMs: 90, version: "2.9.3" });
    expect(downloadCandidates([cnbFast, older], "cnb", "2.9.4")).toEqual(["cnb"]);
  });

  it("探测失败的线路不参与回退", () => {
    expect(downloadCandidates([cnbFast, githubDown], "cnb", "2.9.4")).toEqual(["cnb"]);
  });

  it("没有下载线路时返回空数组", () => {
    expect(downloadCandidates([cnbFast], null, "2.9.4")).toEqual([]);
  });
});
