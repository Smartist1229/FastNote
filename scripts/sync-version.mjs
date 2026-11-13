/**
 * 版本号单一来源：`package.json`。
 *
 * 同步到 `src-tauri/tauri.conf.json`（安装包 / updater / 日志里的版本）
 * 与 `src-tauri/Cargo.toml`（crate 版本，之前长期停在 0.1.0）。
 *
 * 由 `pnpm version:sync` 调用，而 tauri 的 `beforeBuildCommand` 会先跑它，
 * 所以本地构建与 CI 都不会带着三个不同的版本号出去。
 *
 * `pnpm version:check`（`--check`）只比较、不写盘：打 tag 之前跑一次，
 * 三处不一致就退出码 1。**这个判断放在本地**，不要放进发布流水线——
 * CI 上任何无关文件（比如 release-notes.md）都会让「工作区是否干净」这句话失真。
 *
 * 只改「不一样」的文件：值相同时连写入都不做，避免每次构建都动一遍工作区。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const checkOnly = process.argv.includes("--check");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;

if (!version) {
  console.error("[version] package.json 缺少 version 字段");
  process.exit(1);
}

const mismatched = [];
const report = (file, actual) => {
  if (actual !== version) {
    mismatched.push(`${file}: ${actual ?? "(未找到)"} ≠ ${version}`);
  }
};

/*
 * tauri.conf.json：只替换顶层那一行（`^  "version"`），不整体重排。
 * 用 JSON.parse + stringify 会改动数组/对象的内联格式，diff 会铺满整个文件，
 * 把「这次只改了版本号」这个信息淹没掉。
 */
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const confRaw = fs.readFileSync(confPath, "utf8");
const confNext = confRaw.replace(/^ {2}"version": "[^"]*"/m, `  "version": "${version}"`);
report("src-tauri/tauri.conf.json", /^ {2}"version": "([^"]*)"/m.exec(confRaw)?.[1]);
if (!checkOnly && confNext !== confRaw) {
  fs.writeFileSync(confPath, confNext);
  console.log(`[version] tauri.conf.json → ${version}`);
}

// Cargo.toml：只改 [package] 段那一条裸 `version = "..."`，不碰依赖项
const cargoPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoRaw = fs.readFileSync(cargoPath, "utf8");
const cargoNext = cargoRaw.replace(/^version = "[^"]*"/m, `version = "${version}"`);
report("src-tauri/Cargo.toml", /^version = "([^"]*)"/m.exec(cargoRaw)?.[1]);
if (!checkOnly && cargoNext !== cargoRaw) {
  fs.writeFileSync(cargoPath, cargoNext);
  console.log(`[version] Cargo.toml → ${version}`);
}

if (checkOnly) {
  if (mismatched.length > 0) {
    console.error("[version] 三处版本不一致：");
    for (const line of mismatched) console.error(`  ${line}`);
    console.error("[version] 执行 `pnpm version:sync` 对齐后再打 tag");
    process.exit(1);
  }
  console.log(`[version] 已一致：${version}`);
  process.exit(0);
}

console.log(`[version] ${version}`);
