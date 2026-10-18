/**
 * AI 访问权限的判定回归测试（纯函数，不依赖 Tauri）。
 * 运行：npm run test:access
 *
 * 覆盖的坑：
 *   1. 分组档位是组内笔记的上限，两层取更严格的；
 *   2. 只读档能读不能写，且读写判定必须分开（早期版本只有一个布尔）；
 *   3. 未分类笔记只看自己；
 *   4. 总开关关闭时，任何一档都不放行；
 *   5. 旧数据兼容：布尔 true 曾表示"完全开放"，不能被当成只读（Number(true)=1）。
 */
import {
  buildAiAccessRules,
  canAiReadCategory,
  canAiReadNote,
  canAiWriteCategory,
  canAiWriteNote,
  normalizeLevel,
  noteAiLevel,
} from "../src/lib/aiAccess.ts";

let pass = 0;
let fail = 0;
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`);
  }
};

const category = (id, ai_access = 2) => ({ id, name: `分组${id}`, created_at: "", note_count: 0, ai_access });
const note = (id, category_id, ai_access = 2) => ({
  id, title: `笔记${id}`, content: "x", category_id, created_at: "", updated_at: "",
  is_deleted: false, deleted_at: null, is_pinned: false, ai_access,
});

console.log("\n[1] 分组档位是组内笔记的上限");
{
  const rules = buildAiAccessRules(true, [category(1, 1), category(2, 2), category(3, 0)]);
  check("笔记完全 + 分组只读 → 生效只读", noteAiLevel(rules, note(10, 1)), 1);
  check("笔记完全 + 分组完全 → 生效完全", noteAiLevel(rules, note(11, 2)), 2);
  check("笔记禁止 + 分组完全 → 生效禁止", noteAiLevel(rules, note(12, 2, 0)), 0);
  check("分组禁止 → 笔记即使完全也不可读", canAiReadNote(rules, note(13, 3)), false);
  check("分组只读 → 笔记仍可读", canAiReadNote(rules, note(14, 1)), true);
  check("分组只读 → 笔记不可写", canAiWriteNote(rules, note(15, 1)), false);
}

console.log("\n[2] 只读档：能读不能写");
{
  const rules = buildAiAccessRules(true, [category(1, 2)]);
  check("只读笔记可读", canAiReadNote(rules, note(20, 1, 1)), true);
  check("只读笔记不可写", canAiWriteNote(rules, note(20, 1, 1)), false);
  check("完全笔记可读", canAiReadNote(rules, note(21, 1, 2)), true);
  check("完全笔记可写", canAiWriteNote(rules, note(21, 1, 2)), true);
  check("禁止笔记不可读", canAiReadNote(rules, note(22, 1, 0)), false);
  check("禁止笔记不可写", canAiWriteNote(rules, note(22, 1, 0)), false);
}

console.log("\n[3] 未分类笔记只看自己");
{
  const rules = buildAiAccessRules(true, [category(1, 0)]);
  check("未分类 + 完全 → 可写", canAiWriteNote(rules, note(30, null, 2)), true);
  check("未分类 + 只读 → 可读不可写", canAiWriteNote(rules, note(31, null, 1)), false);
  check("未分类 + 禁止 → 不可读", canAiReadNote(rules, note(32, null, 0)), false);
}

console.log("\n[4] 总开关优先于一切");
{
  const rules = buildAiAccessRules(false, [category(1, 2)]);
  check("总开关关闭 → 完全档也不可读", canAiReadNote(rules, note(40, 1, 2)), false);
  check("总开关关闭 → 未分类也不可读", canAiReadNote(rules, note(41, null, 2)), false);
  check("总开关关闭 → 分组不可读", canAiReadCategory(rules, category(1, 2)), false);
}

console.log("\n[5] 分组读写分离：只读分组能看能读，不能往里写");
{
  const rules = buildAiAccessRules(true, [category(1, 1)]);
  check("只读分组可读", canAiReadCategory(rules, category(1, 1)), true);
  check("只读分组不可写（不能新建/移动进去）", canAiWriteCategory(rules, category(1, 1)), false);
  check("完全分组可写", canAiWriteCategory(rules, category(1, 2)), true);
}

console.log("\n[6] 档位归一化与旧数据兼容");
{
  check("布尔 true（旧版'开放'）→ 完全", normalizeLevel(true), 2);
  check("布尔 false（旧版'关闭'）→ 禁止", normalizeLevel(false), 0);
  check("数字 2 → 完全", normalizeLevel(2), 2);
  check("数字 1 → 只读", normalizeLevel(1), 1);
  check("数字 0 → 禁止", normalizeLevel(0), 0);
  check("越界 9 → 完全", normalizeLevel(9), 2);
  check("负数 -3 → 禁止", normalizeLevel(-3), 0);
  check("字符串 '1' → 只读", normalizeLevel("1"), 1);
  check("乱码 → 完全（不至于把内容锁死）", normalizeLevel("abc"), 2);
  check("undefined → 完全", normalizeLevel(undefined), 2);
}

console.log("\n[7] 规则快照互不影响");
{
  const a = buildAiAccessRules(true, [category(1, 0)]);
  const b = buildAiAccessRules(true, [category(1, 2)]);
  check("旧快照保持原判定", canAiReadNote(a, note(50, 1)), false);
  check("新快照按新数据判定", canAiReadNote(b, note(50, 1)), true);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
