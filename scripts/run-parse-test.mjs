/**
 * 解析层回归测试的运行器。
 *
 * 为什么不直接 `node scripts/ai-parse.test.mjs`：src/lib/aiParse 内部用了 `@/` 别名
 * 与无扩展名相对导入（bundler 风格），Node 的 ESM 解析器认不出来。这里先用 esbuild
 * 按 tsconfig 的 paths 打包成一份临时 ESM，再加载执行，测试文件本身不用改。
 *
 * 运行：node scripts/run-parse-test.mjs（package.json 的 test:parse 指向它）
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
const outDir = mkdtempSync(join(tmpdir(), "fastnote-parse-test-"));

try {
  await esbuild.build({
    entryPoints: ["scripts/ai-parse.test.mjs"],
    outfile: join(outDir, "ai-parse.test.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    // 按 tsconfig 的 baseUrl / paths 解析 @/ 开头的别名
    tsconfig: "tsconfig.json",
    logLevel: "warning",
  });
  // 测试文件自身是 .mjs，esbuild 会原样保留；这里必须放到 .mjs 后缀才能按 ESM 加载
  await import(pathToFileURL(join(outDir, "ai-parse.test.mjs")).href);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
