/* 同名函数消歧回归（src/fn-disambiguate.js 纯模块）
   —— 覆盖真实痛点：各模块都用 static 定义同名私有函数（如都叫 A）

   消歧规则：函数需求块在 LLR 里带章节号，取「同目录级别」（章节号去掉最后一段）的
   其他函数块作为兄弟函数；若某个兄弟函数名出现在当前源码文件里，则该块属于该文件。

   本脚本重点验证三件事：
     1. 重名函数被正确分配到各自文件（不再全部填同一份Parent ID）
     2. 判定不了的情形（无兄弟 / 兄弟也重名）必须返回 null，绝不随便挑一个
     3. 无重名时行为与改动前完全一致（回归防护） */
import {
  siblingNames,
  buildDisambiguateIndex,
  resolveFunctionBlock,
  MATCH_UNIQUE,
  MATCH_BY_SIBLING,
  MATCH_UNRESOLVED,
  MATCH_NONE,
} from "../src/fn-disambiguate.js";

let passed = 0;
const fails = [];
function ok(cond, label, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${label}`);
  } else {
    fails.push(label + (extra ? ` — ${extra}` : ""));
    console.log(`  ❌ ${label}${extra ? "  " + extra : ""}`);
  }
}
const sec = (s, names) => ({ section: s, names });

console.log("[1/6] 章节索引与兄弟集合计算");
{
  const blocks = [
    { name: "A", section: "4.1.1.1", ids: ["r1"] },
    { name: "B", section: "4.1.1.2", ids: ["r2"] },
    { name: "C", section: "4.1.1.3", ids: ["r3"] },
    { name: "D", section: "4.2.1.1", ids: ["r4"] },
    { name: "E", section: "4.2.1.2", ids: ["r5"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  ok(idx.byName.size === 5, "索引覆盖 5 个函数名");
  const sib = siblingNames(blocks[0], idx.sec2names);
  ok(sib.has("B") && sib.has("C"), "4.1.1.1 的兄弟含 B、C（同父 4.1.1）");
  ok(!sib.has("D"), "兄弟不含跨父章节的 D（4.2.1.1）");
  ok(!sib.has("A"), "兄弟不含自身");
  const sib2 = siblingNames(blocks[3], idx.sec2names);
  ok(sib2.has("E") && !sib2.has("B"), "4.2.1.1 的兄弟只含 E");
  // 无点号章节：无从判断层级
  ok(siblingNames({ name: "X", section: "4" }, idx.sec2names).size === 0, "无点号章节判为无兄弟");
  ok(siblingNames({ name: "X", section: "" }, idx.sec2names).size === 0, "空章节判为无兄弟");
}

console.log("[2/6] 无重名：行为与改动前一致（回归防护）");
{
  const blocks = [
    { name: "Foo", section: "1.1.1.1", ids: ["L_1", "L_2"] },
    { name: "Bar", section: "1.1.1.2", ids: ["L_3"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  const r1 = resolveFunctionBlock("Foo", new Set(["Foo", "Bar"]), idx);
  ok(r1.how === MATCH_UNIQUE, "单候选块 → unique（不需要消歧）");
  ok(r1.block.ids.join() === "L_1,L_2", "Foo 拿到自己的 ID", r1.block.ids.join());
  const r2 = resolveFunctionBlock("Nope", new Set(["Foo"]), idx);
  ok(r2.how === MATCH_NONE && r2.block === null, "LLR 中不存在的函数 → none");
}

console.log("[3/6] 核心场景：两个文件各有 static 同名函数 A");
{
  // F1: A + h1 + h2 ；F2: A + h3 + h4
  const blocks = [
    { name: "A", section: "5.1.1.1", ids: ["A1_1", "A1_2"] },
    { name: "h1", section: "5.1.1.2", ids: ["H1_1"] },
    { name: "h2", section: "5.1.1.3", ids: ["H2_1"] },
    { name: "A", section: "5.2.1.1", ids: ["A2_1"] },
    { name: "h3", section: "5.2.1.2", ids: ["H3_1"] },
    { name: "h4", section: "5.2.1.3", ids: ["H4_1"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  ok(idx.byName.get("A").length === 2, "A 有 2 个候选块（旧实现只会留最后一个）");

  const f1 = new Set(["A", "h1", "h2"]);
  const f2 = new Set(["A", "h3", "h4"]);
  const r1 = resolveFunctionBlock("A", f1, idx);
  ok(r1.how === MATCH_BY_SIBLING, "F1 的 A 靠兄弟消歧命中", r1.how);
  ok(r1.block.section === "5.1.1.1", "F1 的 A 归属 5.1.1.1", r1.block.section);
  ok(r1.block.ids.join() === "A1_1,A1_2", "F1 的 A 取到 5.1 块的 ID", r1.block.ids.join());

  const r2 = resolveFunctionBlock("A", f2, idx);
  ok(r2.how === MATCH_BY_SIBLING, "F2 的 A 靠兄弟消歧命中", r2.how);
  ok(r2.block.section === "5.2.1.1", "F2 的 A 归属 5.2.1.1", r2.block.section);
  ok(r2.block.ids.join() === "A2_1", "F2 的 A 取到 5.2 块的 ID（不再错填 F1 的需求）", r2.block.ids.join());

  ok(r1.block.ids.join() !== r2.block.ids.join(), "两个文件拿到的是不同需求 —— 核心目标达成");
}

console.log("[4/6] 边界：兄弟集合为空 → 必须判为无法判定（不瞎猜）");
{
  // A 的两个块同父级且父下只有 A 自己 —— 无兄弟可依据
  const blocks = [
    { name: "A", section: "6.1.1", ids: ["X1"] },
    { name: "A", section: "6.1.2", ids: ["X2"] },
    { name: "A", section: "6.2.1", ids: ["X3"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  const r = resolveFunctionBlock("A", new Set(["A"]), idx);
  ok(r.block === null, "无兄弟 → block 为 null", JSON.stringify(r.block));
  ok(r.how === MATCH_UNRESOLVED, "无兄弟 → unresolved", r.how);
}

console.log("[5/6] 边界：兄弟函数本身也重名 / 多个块都命中 → unresolved");
{
  // X、Y 两个函数在三处都重名；任何文件的兄弟集合都会同时命中多个块
  const blocks = [
    { name: "X", section: "7.1.1", ids: ["x1"] },
    { name: "Y", section: "7.1.2", ids: ["y1"] },
    { name: "X", section: "7.1.3", ids: ["x2"] },
    { name: "Y", section: "7.2.1", ids: ["y2"] },
    { name: "X", section: "7.2.2", ids: ["x3"] },
    { name: "Y", section: "7.2.3", ids: ["y3"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  const r = resolveFunctionBlock("X", new Set(["X", "Y"]), idx);
  ok(r.block === null, "多块同时命中 → block 为 null（不任选其一）");
  ok(r.how === MATCH_UNRESOLVED, "多块同时命中 → unresolved", r.how);
}

console.log("[6/6] 混合场景：部分可判、部分不可判，且不影响其他函数");
{
  const blocks = [
    // 可判：两个文件各有 A，各自兄弟明确
    { name: "A", section: "8.1.1.1", ids: ["ok1"] },
    { name: "p1", section: "8.1.1.2", ids: ["p1r"] },
    { name: "A", section: "8.2.1.1", ids: ["ok2"] },
    { name: "p2", section: "8.2.1.2", ids: ["p2r"] },
    // 不可判：孤立同名，无兄弟
    { name: "Solo", section: "8.3.1", ids: ["s1"] },
    { name: "Solo", section: "8.4.1", ids: ["s2"] },
    // 无关函数
    { name: "Uniq", section: "8.5.1.1", ids: ["u1"] },
  ];
  const idx = buildDisambiguateIndex(blocks);
  const f1 = new Set(["A", "p1"]);
  const rA = resolveFunctionBlock("A", f1, idx);
  ok(rA.block && rA.block.ids.join() === "ok1", "混合场景下可判的 A 仍正确", rA.how);
  const rS = resolveFunctionBlock("Solo", f1, idx);
  ok(rS.block === null, "混合场景下不可判的 Solo 留空", rS.how);
  const rU = resolveFunctionBlock("Uniq", f1, idx);
  ok(rU.block && rU.block.ids.join() === "u1", "混合场景下无关函数不受影响");
}

console.log();
console.log(`断言通过 ${passed} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log("\n失败明细:");
  for (const f of fails) console.log("  - " + f);
  console.log("\n结论: 失败 ❌");
  process.exitCode = 1;
} else {
  console.log("结论: 通过 ✅");
}