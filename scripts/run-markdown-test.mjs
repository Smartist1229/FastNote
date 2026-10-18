/**
 * Markdown 编辑器测试运行器（与 run-parse-test.mjs 同构）。
 *
 * 测试文件 import 了带 `.ts` 后缀的源码，Node 无法直接加载，
 * 这里先用 esbuild 打包成临时 ESM 再执行。
 *
 * 运行：npm run test:editor
 */
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

/** esbuild 在 pnpm 下不提升到顶层，先试常规解析，再退回 .pnpm 里的实际目录 */
const loadEsbuild = () => {
  try {
    return require("esbuild");
  } catch {
    const pnpmDir = join(process.cwd(), "node_modules", ".pnpm");
    const dir = readdirSync(pnpmDir).find((name) => name.startsWith("esbuild@"));
    if (!dir) throw new Error("找不到 esbuild，请先执行 pnpm install");
    return require(join(pnpmDir, dir, "node_modules", "esbuild"));
  }
};

const esbuild = loadEsbuild();
const outDir = mkdtempSync(join(tmpdir(), "fastnote-md-test-"));

try {
  await esbuild.build({
    entryPoints: ["scripts/markdown-editor.test.mjs"],
    outfile: join(outDir, "markdown-editor.test.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  await import(pathToFileURL(join(outDir, "markdown-editor.test.mjs")).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
