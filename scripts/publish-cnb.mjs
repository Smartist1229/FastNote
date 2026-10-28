/**
 * 把本次发布的 updater 清单与安装包同步到 CNB，作为国内更新线路。
 *
 * 由 GitHub Actions 在 tauri-action 完成构建后调用：
 *   - 版本化 Release（v2.6.9）存放 exe / sig
 *   - 固定 tag 为 latest 的 Release 只存放 latest.json（供固定地址拉取）
 *
 * 需要环境变量：
 *   CNB_TOKEN  CNB 访问令牌（repo-code:rw + repo-release:rw）
 *   TAG        本次发布的 tag，例如 v2.6.9
 * 可选：
 *   CNB_REPO    默认 Yiygc/FastNote
 *   CNB_BRANCH  默认 master
 *   BUNDLE_DIR  默认 src-tauri/target/release/bundle/nsis
 *   NOTES_FILE  默认 release-notes.md
 */
import fs from "node:fs";
import path from "node:path";

const API_BASE = "https://api.cnb.cool";
const PUBLIC_BASE = "https://cnb.cool";
const repo = process.env.CNB_REPO || "Yiygc/FastNote";
const branch = process.env.CNB_BRANCH || "master";
const tag = process.env.TAG;
const bundleDir = process.env.BUNDLE_DIR || "src-tauri/target/release/bundle/nsis";
const notesFile = process.env.NOTES_FILE || "release-notes.md";
const token = process.env.CNB_TOKEN;

if (!token) {
  throw new Error("缺少 CNB_TOKEN，无法发布国内更新线路。");
}
if (!tag) {
  throw new Error("缺少 TAG，无法发布国内更新线路。");
}

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const notes = fs.readFileSync(notesFile, "utf8").trimEnd();
const files = fs.readdirSync(bundleDir);
const exeName = files.find((name) => name.endsWith("-setup.exe"));
if (!exeName) {
  throw new Error(`在 ${bundleDir} 里找不到 NSIS 安装包（*-setup.exe）`);
}
const sigName = `${exeName}.sig`;
const exePath = path.join(bundleDir, exeName);
const sigPath = path.join(bundleDir, sigName);
if (!fs.existsSync(sigPath)) {
  throw new Error(`找不到签名文件 ${sigPath}`);
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function api(method, route, body) {
  const response = await fetch(`${API_BASE}/${repo}/-${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.cnb.api+json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new ApiError(
      `${method} ${route} -> ${response.status} ${text.slice(0, 500)}`,
      response.status,
    );
  }
  return text ? JSON.parse(text) : null;
}

async function ensureRelease(tagName, name, makeLatest) {
  try {
    return await api("GET", `/releases/tags/${encodeURIComponent(tagName)}`);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
  }
  const created = await api("POST", "/releases", {
    tag_name: tagName,
    target_commitish: branch,
    name,
    body: "",
    draft: false,
    prerelease: false,
    make_latest: makeLatest,
  });
  console.log(`创建 CNB Release：${tagName}`);
  return created;
}

const CONTENT_TYPES = {
  ".json": "application/json",
  ".sig": "text/plain; charset=utf-8",
  ".exe": "application/octet-stream",
};

async function uploadAsset(release, filePath, assetName = path.basename(filePath)) {
  const data = fs.readFileSync(filePath);
  const presign = await api("POST", `/releases/${release.id}/asset-upload-url`, {
    asset_name: assetName,
    size: data.length,
    overwrite: true,
    ttl: 0,
  });

  const put = await fetch(presign.upload_url, {
    method: "PUT",
    headers: {
      "Content-Type": CONTENT_TYPES[path.extname(assetName)] || "application/octet-stream",
    },
    body: data,
  });
  if (!put.ok) {
    throw new Error(
      `上传 ${assetName} 失败：PUT ${put.status} ${(await put.text()).slice(0, 300)}`,
    );
  }

  const verifyUrl = presign.verify_url.startsWith("http")
    ? presign.verify_url
    : `${API_BASE}${presign.verify_url}`;
  const confirm = await fetch(verifyUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/vnd.cnb.api+json",
    },
  });
  if (!confirm.ok) {
    throw new Error(
      `确认附件 ${assetName} 失败：POST ${confirm.status} ${(await confirm.text()).slice(0, 300)}`,
    );
  }
  console.log(`已上传 ${assetName}（${(data.length / 1024 / 1024).toFixed(1)} MB）`);
}

const installerUrl = `${PUBLIC_BASE}/${repo}/-/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(exeName)}`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: installerUrl,
    },
  },
};
// 本地文件名带上 cnb 后缀，避免和 tauri-action 给 GitHub 生成的 latest.json 混在一起；
// 但上传时必须叫 latest.json——客户端拉的固定地址就是 .../releases/download/latest/latest.json。
const manifestPath = path.join(bundleDir, "latest.cnb.json");
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

// 顺序很重要：先把安装包传完，最后才更新清单，避免客户端拿到指向空附件的版本
const versionRelease = await ensureRelease(tag, `FastNote ${tag}`, "true");
await uploadAsset(versionRelease, exePath);
await uploadAsset(versionRelease, sigPath);

const latestRelease = await ensureRelease("latest", "FastNote 更新清单", "false");
await uploadAsset(latestRelease, manifestPath, "latest.json");

console.log(`CNB 更新清单已发布：${PUBLIC_BASE}/${repo}/-/releases/download/latest/latest.json`);
