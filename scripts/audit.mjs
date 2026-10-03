/**
 * 一致性审计：确认工具定义在 7 个位置完全对齐、且没有死码/无用导入。
 * 运行：node scripts/audit.mjs
 */
import { readFileSync } from "node:fs";

const PANEL = "src/components/AIChatPanel.tsx";
const PARSE = "src/aiChatParse.ts";
const src = readFileSync(PANEL, "utf8");
const parseSrc = readFileSync(PARSE, "utf8");

let problems = 0;
const bad = (msg) => { problems++; console.log(`  ❌ ${msg}`); };
const ok = (msg) => console.log(`  ✅ ${msg}`);

console.log("=== 1) 死码检查（顶层声明的引用次数） ===");
{
  let dead = 0;
  for (const [file, text] of [[PANEL, src], [PARSE, parseSrc]]) {
    const lines = text.split("\n");
    lines.forEach((line) => {
      const m = line.match(/^(?:const|let|interface|type|function)\s+([A-Za-z_$][\w$]*)/);
      if (!m) return;
      const name = m[1];
      const uses = (text.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
      // 导出的符号允许只出现一次（供外部使用）
      if (uses <= 1 && !line.includes("export")) { dead++; bad(`${file}: ${name} 未被使用`); }
    });
  }
  if (!dead) ok("两个文件均无死码");
}

console.log("\n=== 2) 无用 import 检查 ===");
{
  const importBlocks = [...src.matchAll(/^import \{([\s\S]*?)\} from "[^"]+";$/gm)].map((m) => m[1]);
  let unused = 0;
  for (const block of importBlocks) {
    for (const raw of block.split(",")) {
      const name = raw.trim().replace(/^type\s+/, "");
      if (!name) continue;
      const uses = (src.match(new RegExp(`\\b${name}\\b`, "g")) || []).length;
      if (uses <= 1) { unused++; bad(`未使用的 import: ${name}`); }
    }
  }
  if (!unused) ok("所有 import 均被使用");
}

console.log("\n=== 3) 工具定义 7 处对齐 ===");
const grab = (text, re) => { const m = text.match(re); return m ? m[1] : ""; };
const defsBlock = grab(src, /const TOOL_DEFS = \[([\s\S]*?)\n\];/);
const defs = [...defsBlock.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);
const labels = [...grab(src, /const TOOL_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const execs = [...grab(src, /const TOOL_EXECUTORS:[\s\S]*?= \{([\s\S]*?)\n\};/).matchAll(/^\s{2}(\w+):\s*async/gm)].map((m) => m[1]);
const promptTools = [...grab(src, /## 可用工具（参数都是 JSON 对象）([\s\S]*?)\n\n选工具的要点/).matchAll(/^- (\w+):/gm)].map((m) => m[1]);
const details = [...grab(src, /const toolDetail =[\s\S]*?switch \(name\) \{([\s\S]*?)\n  \}/).matchAll(/case "(\w+)"/g)].map((m) => m[1]);
const summaries = [...grab(src, /const summarizeToolCall[\s\S]*?switch \(c\.name\) \{([\s\S]*?)\n    default:/).matchAll(/case "(\w+)"/g)].map((m) => m[1]);
const claimTools = [...grab(parseSrc, /const ACTION_CLAIM_RULES[\s\S]*?= \[([\s\S]*?)\n\];/).matchAll(/tools:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));

console.log(`  工具总数：${defs.length}`);
for (const [label, list, allowMissing] of [
  ["TOOL_LABELS", labels, false],
  ["TOOL_EXECUTORS", execs, false],
  ["TOOLS_PROMPT", promptTools, false],
  ["toolDetail", details, true],         // 只读工具不需要展示目标信息
  ["summarizeToolCall", summaries, true], // 只有需确认的工具需要确认文案
]) {
  const missing = defs.filter((n) => !list.includes(n));
  const extra = list.filter((n) => !defs.includes(n));
  if (extra.length) bad(`${label} 含未定义工具: ${extra.join(",")}`);
  else if (missing.length && !allowMissing) bad(`${label} 缺少: ${missing.join(",")}`);
  else ok(`${label} 对齐（${allowMissing && missing.length ? `可缺 ${missing.length} 个只读项` : "完整"}）`);
}
{
  const unknown = [...new Set(claimTools)].filter((t) => !defs.includes(t));
  if (unknown.length) bad(`事实校验规则引用了未定义工具: ${unknown.join(",")}`);
  else ok(`事实校验规则引用的 ${new Set(claimTools).size} 个工具均已定义`);
}

console.log("\n=== 4) 需确认工具都有确认文案 ===");
{
  const needsConfirm = [...defsBlock.matchAll(/name:\s*"(\w+)"[\s\S]*?needsConfirm:\s*(true|false)/g)]
    .filter((m) => m[2] === "true").map((m) => m[1]);
  const noSummary = needsConfirm.filter((t) => !summaries.includes(t));
  if (noSummary.length) bad(`缺确认文案: ${noSummary.join(",")}`);
  else ok(`${needsConfirm.length} 个需确认工具文案齐全`);
}

console.log("\n=== 5) Rules of Hooks：hooks 必须全部在条件早退之前 ===");
{
  const lines = src.split("\n");
  const start = lines.findIndex((l) => l.startsWith("export const AIChatPanel"));
  const body = lines.slice(start);
  // 组件体顶层的条件早退：缩进 2 空格、形如 "  if (cond) return ...;"
  const earlyReturn = body.findIndex((l) => /^ {2}if \(.*\) return .*;\s*$/.test(l));
  // 顶层 hook：缩进 2 空格开始的 useXxx(
  const hookLines = body
    .map((l, i) => ({ i, l }))
    .filter(({ l }) => /^ {2}(?:const |let |var )?[A-Za-z_$][\w$]*\s*=\s*use[A-Z]\w*\(/.test(l) || /^ {2}use[A-Z]\w*\(/.test(l));
  if (earlyReturn === -1) bad("未找到组件早退位置，规则失效");
  else {
    const after = hookLines.filter(({ i }) => i > earlyReturn);
    if (after.length) {
      bad(`有 ${after.length} 个 hook 位于早退之后（会导致 hook 数量不一致 → 整页崩溃）:`);
      after.forEach(({ i, l }) => console.log(`      第 ${start + i + 1} 行: ${l.trim().slice(0, 70)}`));
    } else {
      ok(`全部 ${hookLines.length} 个顶层 hook 都在早退（第 ${start + earlyReturn + 1} 行）之前`);
    }
  }
}

console.log(`\n审计结果：${problems === 0 ? "全部通过 ✅" : problems + " 处问题 ❌"}`);
process.exit(problems === 0 ? 0 : 1);
