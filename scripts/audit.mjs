/**
 * 一致性审计：确认工具定义在 7 个位置完全对齐、且没有死码/无用导入。
 * 运行：node scripts/audit.mjs
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PANEL = "src/components/ai/AIChatPanel.tsx";
const PARSE = "src/lib/aiParse/parse.ts";
const TEXT = "src/lib/aiParse/text.ts";
const CONFIG = "src/config/aiDefaults.ts";
/** 统一换行符：仓库里部分文件是 CRLF，正则按 \n 写，不归一化会静默匹配失败 */
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const src = read(PANEL);
const parseSrc = read(PARSE);
const textSrc = read(TEXT);
const cfgSrc = read(CONFIG);

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
const defsBlock = grab(cfgSrc, /const TOOL_DEFS = \[([\s\S]*?)\n\];/);
const defs = [...defsBlock.matchAll(/name:\s*"(\w+)"/g)].map((m) => m[1]);
const labels = [...grab(src, /const TOOL_LABELS: Record<string, string> = \{([\s\S]*?)\n\};/).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
const execs = [...grab(src, /const TOOL_EXECUTORS:[\s\S]*?= \{([\s\S]*?)\n\};/).matchAll(/^\s{2}(\w+):\s*async/gm)].map((m) => m[1]);
const promptTools = [...grab(cfgSrc, /## Tools \(all parameters are JSON objects\)([\s\S]*?)\n## Choosing tools/).matchAll(/^- (\w+):/gm)].map((m) => m[1]);
const details = [...grab(src, /const toolDetail =[\s\S]*?switch \(name\) \{([\s\S]*?)\n  \}/).matchAll(/case "(\w+)"/g)].map((m) => m[1]);
const summaries = [...grab(src, /const summarizeToolCall[\s\S]*?switch \(c\.name\) \{([\s\S]*?)\n    default:/).matchAll(/case "(\w+)"/g)].map((m) => m[1]);
const claimTools = [...grab(textSrc, /const ACTION_CLAIM_RULES[\s\S]*?= \[([\s\S]*?)\n\];/).matchAll(/tools:\s*\[([^\]]*)\]/g)]
  .flatMap((m) => [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]));

console.log(`  工具总数：${defs.length}`);
for (const [label, list, allowMissing] of [
  ["TOOL_LABELS", labels, false],
  ["TOOL_EXECUTORS", execs, false],
  ["AI_SYSTEM_PROMPT", promptTools, false],
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

console.log("\n=== 5) 每个工具都要有明确的轨迹详情（toolDetail 分支） ===");
{
  const detailBlock = grab(src, /(const toolDetail = \(name[\s\S]*?\n  \}\n\};)/);
  const detailCases = [...detailBlock.matchAll(/case "(\w+)"/g)].map((m) => m[1]);
  const missing = defs.filter((n) => !detailCases.includes(n));
  const extra = detailCases.filter((n) => !defs.includes(n));
  if (extra.length) bad(`toolDetail 含未定义工具: ${extra.join(",")}`);
  if (missing.length) {
    bad(`以下工具没有专门的轨迹详情（只有兜底文案，用户看不出细节）: ${missing.join(",")}`);
  } else {
    ok(`${defs.length} 个工具都有专门的轨迹详情`);
  }
}

console.log("\n=== 6) Rules of Hooks：hooks 必须全部在条件早退之前 ===");
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

/**
 * 7) 主题化检查。
 *
 * 颜色只允许走语义色（bg-surface / text-body / border-line / bg-danger-soft …），
 * 这些名字由 tailwind.config.cjs 映射到 CSS 变量，因此换主题、切暗色只改变量值即可。
 * 写错的名字 Tailwind 会**静默丢弃**（类名不生成 → 该处没有颜色），编译也不报错，
 * 只能靠这里扫出来；同时禁止再出现 slate-500 / indigo-600 这类写死的色板名。
 */
console.log("\n=== 7) 主题化：语义色名有效、无写死色板 ===");
{
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const colors = require(join(process.cwd(), "tailwind.config.cjs")).theme.extend.colors;

  const valid = new Set();
  for (const [k, v] of Object.entries(colors)) {
    if (typeof v === "string") { valid.add(k); continue; }
    for (const sub of Object.keys(v)) valid.add(sub === "DEFAULT" ? k : `${k}-${sub}`);
  }

  const files = [];
  (function walk(dir) {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx|ts)$/.test(f)) files.push(p);
    }
  })("src");

  const ROOTS = "(app|surface|surface-alt|surface-strong|ink|body|muted|faint|faint-soft|line|line-soft|line-strong|on-accent|primary|danger|warning|success|info|tooltip)";
  const PREFIX = "(?:bg|text|border|ring|divide|from|to|via|fill|stroke|decoration|outline|placeholder|caret|accent)";
  const semanticRe = new RegExp(`^${PREFIX}-${ROOTS}(-[a-z0-9]+)?(/\\d+)?$`);
  const paletteRe = new RegExp(`^${PREFIX}-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\\d{2,3}(/\\d+)?$`);
  const variantRe = /^(?:hover|focus|focus-within|active|group-hover|dark|disabled|first|last|even|odd|aria-[a-z]+|sm|md|lg|xl):/;

  const invalid = new Map();
  const palette = new Map();
  for (const f of files) {
    const text = read(f);
    for (const m of text.matchAll(/["'`]([^"`']*?)["'`]/g)) {
      for (const raw of m[1].split(/\s+/)) {
        let c = raw;
        while (variantRe.test(c)) c = c.replace(variantRe, "");
        if (!c || c.includes("{") || c.includes("$")) continue;
        if (paletteRe.test(c)) palette.set(`${f}: ${c}`, true);
        else if (semanticRe.test(c)) {
          const key = c.match(semanticRe)[1] + (c.match(semanticRe)[2] || "");
          if (!valid.has(key)) invalid.set(key, (invalid.get(key) || 0) + 1);
        }
      }
    }
  }

  if (invalid.size) {
    bad(`${invalid.size} 个语义色名 Tailwind 里没有定义（类名会被静默丢弃 → 该处无颜色）:`);
    for (const [k, n] of invalid) console.log(`      ${k} (x${n})`);
  } else ok("使用到的语义色名都在 tailwind 配置中有定义");

  if (palette.size) {
    bad(`${palette.size} 处写死了具体色板（换主题/暗色不会跟随）:`);
    for (const k of [...palette.keys()].slice(0, 20)) console.log(`      ${k}`);
  } else ok("没有写死的具体色板名（slate-500 / indigo-600 之类）");
}

console.log(`\n审计结果：${problems === 0 ? "全部通过 ✅" : problems + " 处问题 ❌"}`);
process.exit(problems === 0 ? 0 : 1);
