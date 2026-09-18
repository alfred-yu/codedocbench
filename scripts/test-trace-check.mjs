// 一致性校验模块（src/trace-check.js）回归测试
//   覆盖：① 空 Parent ID 按章节分组 ② Requirement 反向覆盖 ③ 悬空引用 / 重复追溯 /
//         口径差异 ④ 列映射缺失降级 ⑤ 真实项目数据端到端 ⑥ 灵敏度注入 ⑦ 报告导出
// 纯 Node 运行，不依赖 DOM / Tauri：npm run test:trace-check
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx-js-style");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const { auditTrace, scanRequirementBlocks, buildTraceReportSheets, buildTraceChartSpecs } = await import(
  "file:///" + path.join(ROOT, "src", "trace-check.js").replace(/\\/g, "/")
);

const fail = [];
let pass = 0;
function ok(label, cond, detail) {
  if (cond) {
    pass += 1;
  } else {
    fail.push(label + (detail === undefined ? "" : " → " + JSON.stringify(detail)));
  }
}
function eq(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

/* 列名与 Demo_LLR_Requirements.xlsx 一致（Section / Requirement ID / Title / Type） */
const COL = { id: "Requirement ID", content: "Title / Requirement Text", type: "Type", chapter: "Section" };
const EMPTY_LLR = [];

/* ============ 第 1 节：代码侧 —— 空 Parent ID 按数据章节分组 ============ */
console.log("[1/6] 代码侧：Source Code 行的 Parent ID 空值分组");
{
  const rows = [
    { num: "1", title: "第 1 章", objectType: "", parent: "" },
    { num: "1.1", title: "Function Definition", objectType: "", parent: "" },
    { num: "", title: "fnA", objectType: "Source Code", parent: "R_1", sectionKey: "functions", sectionTitle: "Function Definition" },
    { num: "", title: "fnB", objectType: "Source Code", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
    { num: "", title: "N/A", objectType: "Comment", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
    { num: "", title: "ST1", objectType: "Source Code", parent: "", sectionKey: "types", sectionTitle: "Type Definition" },
    { num: "", title: "ST2", objectType: "Source Code", parent: "", sectionKey: "types", sectionTitle: "Type Definition" },
  ];
  const r = auditTrace({ rows, llrRows: EMPTY_LLR, colMap: COL, nameSet: new Set() });
  eq("Source Code 总数（Comment 占位不计入）", r.code.sourceTotal, 4);
  eq("空 Parent ID 数", r.code.emptyParent, 3);
  eq("已关联数", r.code.filledParent, 1);
  eq("分组数（按 sectionKey 合并）", r.code.sections.length, 2);
  const fn = r.code.sections.find((s) => s.key === "functions");
  eq("Function 章 总/空", [fn.total, fn.empty], [2, 1]);
  eq("Function 章 明细序号（对齐生成文档页序号列）", fn.details.map((x) => x.index), [4]);
  eq("Function 章 明细符号名", fn.details.map((x) => x.title), ["fnB"]);
  const ty = r.code.sections.find((s) => s.key === "types");
  eq("Type 章 总/空", [ty.total, ty.empty], [2, 2]);
  eq("Type 章 章节标题", ty.title, "Type Definition");
  // 只有 N/A 占位（Comment）的章节不应进入分组，否则会把「解析不到」的章节误报成空 Parent ID
  const onlyComment = auditTrace({
    rows: [
      { num: "", title: "N/A", objectType: "Comment", parent: "", sectionKey: "globals", sectionTitle: "Global Variable Definition" },
    ],
    llrRows: EMPTY_LLR,
    colMap: COL,
    nameSet: new Set(),
  });
  eq("全为 Comment 的章节不进入分组", [onlyComment.code.sourceTotal, onlyComment.code.sections.length], [0, 0]);
  // 占比：分母必须是「Source Code 行数」，不是命中数、更不是硬编码
  eq("代码侧空值占比（分母 = Source Code 总数 4）", r.code.emptyRatio, 3 / 4);
  eq("Function 章空值占比（分母 = 该章总数 2）", fn.emptyRatio, 1 / 2);
  eq("Type 章空值占比（2 / 2）", ty.emptyRatio, 1);
  eq("分母为 0 时占比不可计算（null，渲染层显示「—」）", onlyComment.code.emptyRatio, null);
}

/* ============ 第 2 节：需求侧 —— Requirement 反向覆盖 ============ */
console.log("[2/6] 需求侧：Requirement 行的引用覆盖");
{
  // 块结构：章节行 → 函数名行 → 该块下的需求行
  const llrRows = [
    { Section: "1.1", "Requirement ID": "", "Title / Requirement Text": "Functions", Type: "" },
    { Section: "", "Requirement ID": "", "Title / Requirement Text": "fnA", Type: "" },
    { Section: "", "Requirement ID": "R_1", "Title / Requirement Text": "fnA shall work", Type: "Requirement" },
    { Section: "", "Requirement ID": "R_2", "Title / Requirement Text": "orphan", Type: "Requirement" },
    { Section: "", "Requirement ID": "R_3", "Title / Requirement Text": "a comment", Type: "Comment" },
    { Section: "", "Requirement ID": "R_4", "Title / Requirement Text": "no type", Type: "" },
  ];
  const rows = [
    { num: "", title: "fnA", objectType: "Source Code", parent: "R_1", sectionKey: "functions", sectionTitle: "Function Definition" },
  ];
  const r = auditTrace({ rows, llrRows, colMap: COL, nameSet: new Set(["fnA"]) });

  eq("Requirement 总数（Comment / 空 Type 不计入）", r.requirement.total, 2);
  eq("被引用数", r.requirement.referenced, 1);
  eq("未被引用数", r.requirement.orphaned, 1);
  eq("孤儿需求 ID", r.requirement.orphans.map((o) => o.id), ["R_2"]);
  eq("孤儿需求所属块", r.requirement.orphans[0].block, "fnA");
  eq("孤儿需求内容", r.requirement.orphans[0].content, "orphan");
  eq("孤儿需求行号（1-based，便于定位）", r.requirement.orphans[0].line, 4);
  eq("Comment 行不进需求口径", r.requirement.orphans.some((o) => o.id === "R_3"), false);
  eq("空 Type 行不进需求口径", r.requirement.orphans.some((o) => o.id === "R_4"), false);
  // 占比：分母必须是「Requirement 条数」（2），不是全表行数（6）、也不是命中数
  eq("需求侧遗漏占比（分母 = Requirement 条数 2）", r.requirement.orphanRatio, 1 / 2);
  eq("非 Requirement 未被引用 → 不计入口径差异", r.extra.nonRequirementRefs, []);

  // 反例：Parent ID 指向一条「非 Requirement」行 → 口径差异应暴露
  const rows2 = [
    { num: "", title: "fnA", objectType: "Source Code", parent: "R_4", sectionKey: "functions", sectionTitle: "Function Definition" },
  ];
  const r2 = auditTrace({ rows: rows2, llrRows, colMap: COL, nameSet: new Set(["fnA"]) });
  eq("Parent ID 引用了非 Requirement 行 → 口径差异", r2.extra.nonRequirementRefs, ["R_4"]);
  eq("该口径下 Requirement 未被引用", r2.requirement.orphaned, 2);

  // 块扫描边界：与生成侧同一排除规则（只排除 Comment，空 Type 仍计入块内需求）
  const blocks = scanRequirementBlocks(llrRows, COL, new Set(["fnA"]));
  eq("块扫描：章节行 + 函数名行各成一个块", blocks.length, 2);
  eq("块扫描：函数块命中标记", blocks[1].known, true);
  eq("块扫描：块内需求 ID（排除 Comment）", blocks[1].ids, ["R_1", "R_2", "R_4"]);
  eq("块扫描：章节块无需求", blocks[0].ids, []);
}

/* ============ 第 3 节：悬空引用 / 重复追溯 ============ */
console.log("[3/6] 悬空引用与重复追溯");
{
  const llrRows = [
    { Section: "1.1", "Requirement ID": "", "Title / Requirement Text": "Functions", Type: "" },
    { Section: "", "Requirement ID": "", "Title / Requirement Text": "fnA", Type: "" },
    { Section: "", "Requirement ID": "R_1", "Title / Requirement Text": "a", Type: "Requirement" },
  ];
  const rows = [
    { num: "", title: "fnA", objectType: "Source Code", parent: "R_1\nR_999", sectionKey: "functions", sectionTitle: "Function Definition" },
    { num: "", title: "fnC", objectType: "Source Code", parent: "R_1", sectionKey: "functions", sectionTitle: "Function Definition" },
  ];
  const r = auditTrace({ rows, llrRows, colMap: COL, nameSet: new Set(["fnA", "fnC"]) });
  eq("悬空引用 ID", r.extra.dangling.map((d) => d.id), ["R_999"]);
  eq("悬空引用所属符号", r.extra.dangling[0].title, "fnA");
  eq("重复追溯条数", r.extra.duplicated.length, 1);
  eq("重复追溯 ID / 次数", [r.extra.duplicated[0].id, r.extra.duplicated[0].count], ["R_1", 2]);
  eq("重复追溯引用方", r.extra.duplicated[0].owners, ["fnA", "fnC"]);
  eq("多 ID 换行分隔被拆分引用", r.requirement.referenced, 1);
}

/* ============ 第 4 节：列映射缺失降级 ============ */
console.log("[4/6] 列映射缺失降级");
{
  const llrRows = [{ Section: "", "Requirement ID": "R_1", "Title / Requirement Text": "fnA", Type: "Requirement" }];
  const rows = [
    { num: "", title: "fnA", objectType: "Source Code", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
  ];
  const noType = auditTrace({ rows, llrRows, colMap: { ...COL, type: "" }, nameSet: new Set() });
  eq("未映射 Object Type 列 → 标注", noType.typeMapped, false);
  eq("未映射 Object Type 列 → 需求口径退化为所有带 ID 行", noType.requirement.total, 1);
  eq("未映射 Object Type 列 → notes 提示", noType.colMissing.type, true);

  const noId = auditTrace({ rows, llrRows, colMap: { ...COL, id: "" }, nameSet: new Set() });
  eq("未映射 ID 列 → 无需求可比对", noId.requirement.total, 0);
  eq("未映射 ID 列 → 标注", noId.colMissing.id, true);

  const noContent = auditTrace({ rows, llrRows, colMap: { ...COL, content: "" }, nameSet: new Set() });
  eq("未映射需求内容列 → 标注", noContent.colMissing.content, true);
}

/* ============ 辅助：用真实项目数据构造代码文档行（复现 collectDocRows 规则） ============ */
const src = fs.readFileSync(path.join(ROOT, "demo", "mock.js"), "utf8");
function grab(name) {
  const start = src.indexOf(`const ${name} = `);
  if (start < 0) throw new Error("demo/mock.js 中未找到 " + name);
  let i = src.indexOf("=", start) + 1;
  while (src[i] === " ") i++;
  const open = src[i];
  if (open === '"') return src.slice(i + 1, src.indexOf('"', i + 1));
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === open) depth++;
    else if (src[j] === close && --depth === 0) return src.slice(i, j + 1);
  }
  throw new Error("解析失败 " + name);
}
const C_SECTIONS = [
  { key: "types", title: "Type Definition" },
  { key: "globals", title: "Global Variable Definition" },
  { key: "macros", title: "Macro Definition" },
  { key: "constants", title: "Constant Definition" },
  { key: "functions", title: "Function Definition" },
];
const sectionNames = (res, key) => {
  if (!res || res.type === "error") return [];
  const byKey = {
    types: [...(res.typedefs || []), ...(res.structs || []), ...(res.enums || [])],
    globals: res.globals || [],
    macros: res.macros || [],
    constants: res.constants || [],
    functions: res.functions || [],
  };
  return (byKey[key] || []).map((x) => (x && typeof x === "object" ? x.name : x)).filter(Boolean);
};
function buildRealRows(fnIndex) {
  const TREE = JSON.parse(grab("TREE"));
  const PARSES = JSON.parse(grab("PARSES"));
  const files = [];
  (function walk(n) {
    if (n.type === "file" && /\.(c|h)$/i.test(n.path)) files.push(n);
    for (const c of n.children || []) walk(c);
  })(TREE);
  const rows = [];
  for (const [fi, f] of files.entries()) {
    const secs = /\.h$/i.test(f.path) ? C_SECTIONS.filter((s) => s.key !== "functions") : C_SECTIONS;
    for (const [si, sec] of secs.entries()) {
      // 章节标题行（与真实 collectDocRows 同构：带编号、objectType 空），需求侧明细的「引用章节号」取自它
      rows.push({ num: `${fi + 2}.${si + 1}`, title: sec.title, objectType: "", parent: "" });
      const names = sectionNames(PARSES[f.path], sec.key);
      const fromSource = names.length > 0;
      for (const it of fromSource ? names : ["N/A"]) {
        let parent = "";
        if (sec.key === "functions" && fromSource && fnIndex) {
          const ids = fnIndex.get(it);
          if (ids && ids.length) parent = ids.join("\n");
        }
        rows.push({
          num: "",
          title: it,
          // 与 src/main.js collectDocRows 同口径：仅全局变量与函数章视为 Source Code
          objectType:
            fromSource && (sec.key === "globals" || sec.key === "functions")
              ? "Source Code"
              : "Comment",
          parent,
          sectionKey: sec.key,
          sectionTitle: sec.title,
        });
      }
    }
  }
  return rows;
}
/* 需求索引：与 src/main.js buildLlrFunctionIndex 同一排除规则（排除 Comment） */
function buildIndex(llrRows, fnNames) {
  const index = new Map();
  const nameSet = new Set(fnNames);
  let cur = null;
  for (const r of llrRows) {
    const content = String(r[COL.content] ?? "").trim();
    const chapter = String(r[COL.chapter] ?? "").trim();
    if (chapter || nameSet.has(content)) {
      cur = nameSet.has(content) ? [] : null;
      if (cur) index.set(content, cur);
      continue;
    }
    if (!cur) continue;
    if (String(r[COL.type] ?? "").trim().toLowerCase() === "comment") continue;
    const id = String(r[COL.id] ?? "").trim();
    if (id) cur.push(id);
  }
  return index;
}

/* ============ 第 5 节：真实项目数据端到端 ============ */
console.log("[5/6] 演示项目数据端到端（demo/mock.js 内嵌合成 DemoProject）");
let realReport = null; // 供第 7 节报告导出断言复用
const realLlr = XLSX.utils.sheet_to_json(
  XLSX.read(Buffer.from(grab("LLR_B64").replace(/\s/g, ""), "base64"), { type: "buffer" }).Sheets["LLR"],
  { defval: "" }
);
{
  const fnNames = [];
  {
    const PARSES = JSON.parse(grab("PARSES"));
    for (const [, res] of Object.entries(PARSES)) for (const n of sectionNames(res, "functions")) fnNames.push(n);
  }
  const uniq = [...new Set(fnNames)];
  const rows = buildRealRows(buildIndex(realLlr, uniq));
  const r = auditTrace({ rows, llrRows: realLlr, colMap: COL, nameSet: new Set(uniq) });
  realReport = r;

  // Object Type 新口径：仅 globals/functions 为 Source Code（types 31 / macros 5 / constants 7 行退出口径）
  eq("真实数据：Source Code 行数（globals 3 + functions 62）", r.code.sourceTotal, 65);
  eq("真实数据：空 Parent ID 行数（globals 章结构性空值）", r.code.emptyParent, 3);
  eq("真实数据：Function 章零空值", r.code.sections.find((s) => s.key === "functions").empty, 0);
  eq("真实数据：Function 章总数", r.code.sections.find((s) => s.key === "functions").total, 62);
  // 非函数章中仅 globals 留在 Source Code 口径内；types/macros/constants 已按 Comment 排除
  const byKey = Object.fromEntries(r.code.sections.map((s) => [s.key, [s.total, s.empty]]));
  eq("真实数据：Global 章 总/空", byKey.globals, [3, 3]);
  eq("真实数据：Type 章不进入 Source Code 口径", byKey.types, undefined);
  eq("真实数据：Macro 章不进入 Source Code 口径", byKey.macros, undefined);
  eq("真实数据：Constant 章不进入 Source Code 口径", byKey.constants, undefined);
  eq("真实数据：Requirement 行数", r.requirement.total, 271);
  eq("真实数据：Requirement 全覆盖（0 孤儿）", r.requirement.orphaned, 0);
  eq("真实数据：无悬空引用", r.extra.dangling.length, 0);
  eq("真实数据：无重复追溯", r.extra.duplicated.length, 0);
  eq("真实数据：无非 Requirement 引用（生成与校验口径当前一致）", r.extra.nonRequirementRefs, []);
  eq("真实数据：低层需求总行数", realLlr.length, 406);
  // 占比（界面两视角直接展示的两个数）
  eq("真实数据：代码侧空值占比 = 3 / 65", r.code.emptyRatio, 3 / 65);
  eq("真实数据：Function 章空值占比 = 0", r.code.sections.find((s) => s.key === "functions").emptyRatio, 0);
  eq("真实数据：需求侧遗漏占比 = 0 / 271", r.requirement.orphanRatio, 0);
  // 空值行数与「非函数章行数」完全吻合 → 空值全部来自 globals 章，函数章零空值
  const nonFn = r.code.sections.filter((s) => s.key !== "functions").reduce((s, g) => s + g.total, 0);
  eq("真实数据：空 Parent ID 全部来自非函数章", r.code.emptyParent, nonFn);
  const emptySections = r.code.sections.filter((s) => s.empty > 0).map((s) => s.key).sort();
  eq("真实数据：仅 globals 章为结构性空值", emptySections, ["globals"]);
}

/* ============ 第 6 节：灵敏度注入（注入缺陷必须被检出） ============ */
console.log("[6/6] 灵敏度：注入缺陷检出");
{
  const PARSES = JSON.parse(grab("PARSES"));
  const fnNames = [];
  for (const [, res] of Object.entries(PARSES)) for (const n of sectionNames(res, "functions")) fnNames.push(n);
  const uniq = [...new Set(fnNames)];

  // 缺陷 A：删掉某函数块下的全部需求行 → 该函数失去需求关联（Parent ID 为空）
  {
    const llrRows = realLlr.map((r) => ({ ...r }));
    const nameSet = new Set(uniq);
    const isBoundary = (r) =>
      !!String(r[COL.chapter] ?? "").trim() || nameSet.has(String(r[COL.content] ?? "").trim());
    const i = llrRows.findIndex((r) => String(r[COL.content]).trim() === uniq[0]);
    let j = i + 1;
    while (j < llrRows.length && !isBoundary(llrRows[j])) j++;
    const removed = j - i - 1;
    llrRows.splice(i + 1, removed);
    ok("缺陷 A 前提：该函数块下确有需求行", removed > 0, removed);
    const rows = buildRealRows(buildIndex(llrRows, uniq));
    const r = auditTrace({ rows, llrRows, colMap: COL, nameSet });
    const fnSection = r.code.sections.find((s) => s.key === "functions");
    ok("删掉整块需求行 → 空 Parent ID 数上升", r.code.emptyParent > 3, r.code.emptyParent);
    ok("删掉整块需求行 → Function 章出现空值", fnSection.empty > 0, fnSection.empty);
    ok(
      "删掉整块需求行 → 空值明细为该函数",
      fnSection.details.some((s) => s.title === uniq[0]),
      fnSection.details.map((s) => s.title)
    );
  }

  // 缺陷 B：把某条需求行复制到另一个函数块下（一个需求被两个符号引用）→ 重复追溯
  {
    const llrRows = realLlr.map((r) => ({ ...r }));
    const iy = llrRows.findIndex((r) => String(r[COL.content]).trim() === uniq[0]);
    const iz = llrRows.findIndex((r) => String(r[COL.content]).trim() === uniq[1]);
    llrRows.splice(iz + 1, 0, { ...llrRows[iy + 1] });
    const rows = buildRealRows(buildIndex(llrRows, uniq));
    const r = auditTrace({ rows, llrRows, colMap: COL, nameSet: new Set(uniq) });
    ok("需求行复制到另一函数块 → 检出重复追溯", r.extra.duplicated.length > 0, r.extra.duplicated.length);
  }

  // 缺陷 C：在章节标题下插入一条孤立 Requirement（不属于任何函数块）→ 未被引用
  {
    const llrRows = realLlr.map((r) => ({ ...r }));
    const head = llrRows.findIndex((r) => String(r[COL.chapter] ?? "").trim() !== "");
    llrRows.splice(head + 1, 0, {
      [COL.chapter]: "",
      [COL.id]: "DEMO_LL_R_9999",
      [COL.content]: "Orphan requirement.",
      [COL.type]: "Requirement",
    });
    const rows = buildRealRows(buildIndex(llrRows, uniq));
    const r = auditTrace({ rows, llrRows, colMap: COL, nameSet: new Set(uniq) });
    ok("孤立 Requirement → 计入未被引用", r.requirement.orphaned > 0, r.requirement.orphaned);
    ok("孤立 Requirement → 出现在孤儿列表", r.requirement.orphans.some((o) => o.id === "DEMO_LL_R_9999"));
  }

  // 缺陷 D：低层需求 ID 整体改号 → Parent ID 全体悬空
  {
    const llrRows = realLlr.map((r) => ({ ...r, [COL.id]: r[COL.id] ? "X_" + r[COL.id] : "" }));
    const rows = buildRealRows(buildIndex(realLlr, uniq)); // 代码侧仍用旧 ID
    const r = auditTrace({ rows, llrRows, colMap: COL, nameSet: new Set(uniq) });
    ok("需求 ID 整体改号 → 检出悬空引用", r.extra.dangling.length > 0, r.extra.dangling.length);
    ok("需求 ID 整体改号 → Requirement 全部未被引用", r.requirement.orphaned === r.requirement.total);
  }

  // 缺陷 E：明细全量列出（报告是导出文件，不截断；任何上限回潮都会在这里翻车）
  {
    const N = 257;
    const rows = Array.from({ length: N }, (_, i) => ({
      num: "",
      title: "sym_" + i,
      objectType: "Source Code",
      parent: "",
      sectionKey: "types",
      sectionTitle: "Type Definition",
    }));
    const r = auditTrace({ rows, llrRows: EMPTY_LLR, colMap: COL, nameSet: new Set() });
    eq("明细全量列出（不截断）", r.code.sections[0].details.length, N);
    eq("计数与明细一致", r.code.emptyParent, N);
    eq("明细序号对齐文档序号列（末条 = N）", r.code.sections[0].details[N - 1].index, N);
  }
}

/* ============ 第 7 节：报告导出（buildTraceReportSheets / encodeTraceWorkbook） ============ */
console.log("[7/7] 报告导出：AOA 结构与工作簿编码");
{
  const sheets = buildTraceReportSheets(realReport, { generatedAt: "2026-09-15 00:00" });
  eq("报告 sheet 名称", sheets.map((s) => s.name), ["校验汇总", "代码侧-SourceCode明细", "需求侧-一致性明细"]);
  const [sum, codeDet, reqDet] = sheets.map((s) => s.aoa);
  const val = (label) => {
    const row = sum.find((r) => r[0] === label);
    return row ? row[1] : undefined;
  };
  // 汇总页：真实数据的两视角数字（与第 5 节断言同一坐标系）
  eq("汇总：生成时间写入", val("生成时间"), "2026-09-15 00:00");
  eq("汇总：视角一分母（Source Code 总行数）", val("Source Code 总行数"), 65);
  eq("汇总：视角一空值", val("Parent ID 为空"), 3);
  eq("汇总：视角一占比 3/65", val("空值占比"), "4.6%");
  eq("汇总：视角二分母（Requirement 条数）", val("Requirement 总条数"), 271);
  eq("汇总：视角二遗漏", val("未被引用"), 0);
  eq("汇总：视角二占比", val("遗漏占比"), "0.0%");
  ok(
    "汇总：结论行含两视角数字",
    String(val("结论")).includes("视角一空值 3 行（Function 章 0 行）") &&
      String(val("结论")).includes("视角二遗漏 0 条")
  );
  ok("汇总：按数据章节逐章列出", sum.some((r) => r[0] === "Global Variable Definition 章"));
  ok("汇总：Type 章已退出 Source Code 口径", !sum.some((r) => r[0] === "Type Definition 章"));
  ok("汇总：无列映射提示时给（无）", val("列映射提示") === "（无）");
  // 代码侧明细：全量 Source Code 行（65 行，不只空值行），四列；空值行由 exceljs 侧着色
  eq("代码侧明细行数（全量 Source Code）", codeDet.length - 1, 65);
  eq("代码侧明细表头", codeDet[0], ["文档序号", "章节号", "需求内容", "Parent ID"]);
  eq("代码侧明细空值行数与汇总一致", codeDet.slice(1).filter((r) => !String(r[3] ?? "").trim()).length, 3);
  ok(
    "代码侧明细文档序号升序（对齐链出 ID 坐标系）",
    codeDet.slice(1).every((r, i, a) => i === 0 || a[i - 1][0] < r[0])
  );
  // 需求侧明细（反向核对）：全量 271 条 Requirement，真实数据全覆盖 → 无「（未被引用）」标记行
  eq("需求侧明细表头（反向核对五列）", reqDet[0], ["低层需求 ID", "低层需求内容", "引用文档序号", "引用章节号", "引用需求内容"]);
  eq(
    "需求侧明细：未被引用标记行数 = 孤儿数（0）",
    reqDet.slice(1).filter((r) => String(r[2] ?? "") === "（未被引用）").length,
    0
  );
  eq("需求侧明细：覆盖的 Requirement 数（去重）", new Set(reqDet.slice(1).map((r) => r[0])).size, 271);
  ok(
    "需求侧明细：已引用行三列齐全（序号/章节号/内容）",
    reqDet.slice(1).every((r) => typeof r[2] === "number" && String(r[3] ?? "") !== "" && String(r[4] ?? "") !== "")
  );

  // 有孤儿的数据上：孤儿行整行标记未被引用（exceljs 侧据此着色）
  const llr7 = [
    { "Requirement ID": "R_9", "Title / Requirement Text": "orphan text", Type: "Requirement", Section: "" },
  ];
  const rows7 = [
    { num: "", title: "fnA", objectType: "Source Code", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
  ];
  const rep7 = auditTrace({ rows: rows7, llrRows: llr7, colMap: COL, nameSet: new Set() });
  const req7 = buildTraceReportSheets(rep7).find((s) => s.name === "需求侧-一致性明细").aoa;
  eq("需求侧明细：孤儿行 ID", req7[1][0], "R_9");
  eq("需求侧明细：孤儿行内容", req7[1][1], "orphan text");
  eq("需求侧明细：孤儿行标记未被引用", req7[1][2], "（未被引用）");
  ok("需求侧明细：孤儿行引用列为空", req7[1][3] === "" && req7[1][4] === "");

  // 反向核对展开：一条需求被多行引用 → 逐引用一行，引用三列取自 Code 文档行（序号/章节号/符号名）
  {
    const llr9 = [
      { "Requirement ID": "R_1", "Title / Requirement Text": "fnA shall work", Type: "Requirement", Section: "" },
    ];
    const rows9 = [
      { num: "2", title: "sample.c", objectType: "", parent: "" },
      { num: "2.2", title: "Function Definition", objectType: "", parent: "" },
      { num: "", title: "fnA", objectType: "Source Code", parent: "R_1", sectionKey: "functions", sectionTitle: "Function Definition" },
      { num: "", title: "fnB", objectType: "Source Code", parent: "R_1", sectionKey: "functions", sectionTitle: "Function Definition" },
    ];
    const rep9 = auditTrace({ rows: rows9, llrRows: llr9, colMap: COL, nameSet: new Set() });
    const req9 = buildTraceReportSheets(rep9).find((s) => s.name === "需求侧-一致性明细").aoa;
    eq("需求侧明细：多引用逐行展开", req9.length - 1, 2);
    eq("需求侧明细：引用文档序号 = rows 全局序号", req9[1][2], 3);
    eq("需求侧明细：引用章节号取自标题行", req9[1][3], "2.2");
    eq("需求侧明细：引用需求内容 = 符号名", req9[1][4], "fnA");
    eq("需求侧明细：第二引用行内容", req9[2][4], "fnB");
  }

  // 代码侧明细：章节号取自最近的章节标题行；文档序号 = rows 全局序号（对齐链出 ID 坐标系）
  {
    const rows8 = [
      { num: "2", title: "sample.c", objectType: "", parent: "" },
      { num: "2.1", title: "Global Variable Definition", objectType: "", parent: "" },
      { num: "", title: "g1", objectType: "Source Code", parent: "R_1", sectionKey: "globals", sectionTitle: "Global Variable Definition" },
      { num: "2.2", title: "Function Definition", objectType: "", parent: "" },
      { num: "", title: "fnA", objectType: "Source Code", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
    ];
    const rep8 = auditTrace({ rows: rows8, llrRows: llr7, colMap: COL, nameSet: new Set() });
    const code8 = buildTraceReportSheets(rep8).find((s) => s.name === "代码侧-SourceCode明细").aoa;
    eq("代码侧明细：全量 Source Code 行数", code8.length - 1, 2);
    eq("章节号取自所属章节标题行", code8[1][1], "2.1");
    eq("章节号随文档推进更新", code8[2][1], "2.2");
    eq("文档序号 = rows 全局序号（对齐链出 ID）", [code8[1][0], code8[2][0]], [3, 5]);
    eq("Parent ID 原值列入", code8[1][3], "R_1");
    eq("空 Parent ID 原样留空（着色由 exceljs 侧做）", code8[2][3], "");
  }

  // 图表描述（纯数据，可断言；与界面两视角同一坐标系，真实数据：视角一 已关联62/空3、视角二 已引用271/遗漏0、附带核对 0/0/0）
  const specs = buildTraceChartSpecs(realReport);
  eq("图表数量", specs.length, 4);
  eq("图表 id", specs.map((s) => s.id), ["codeOverview", "codeBySection", "reqOverview", "extra"]);
  const byId = Object.fromEntries(specs.map((s) => [s.id, s]));
  eq("图表类型", [byId.codeOverview.kind, byId.codeBySection.kind, byId.reqOverview.kind, byId.extra.kind],
    ["doughnut", "bar", "doughnut", "bar"]);
  eq("视角一环形图：已关联 / 空 Parent ID", byId.codeOverview.values, [62, 3]);
  eq("视角一环形图：标签", byId.codeOverview.categories, ["已关联 Parent ID", "空 Parent ID"]);
  eq("视角二环形图：已引用 / 未被引用", byId.reqOverview.values, [271, 0]);
  eq("按数据章节柱状图：标签为各章标题", byId.codeBySection.categories, realReport.code.sections.map((s) => s.title));
  eq("按数据章节柱状图：空值数", byId.codeBySection.values, realReport.code.sections.map((s) => s.empty));
  eq("附带核对柱状图：0 / 0 / 0", byId.extra.values, [0, 0, 0]);
  ok("每个图表均有锚点单元格（列 F 起）", specs.every((s) => /^[A-Z]+\d+$/.test(s.anchor)));
}

console.log("");
console.log(`断言通过 ${pass} 项，失败 ${fail.length} 项`);
if (fail.length) {
  console.log("结论: 失败 ❌");
  fail.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("结论: 通过 ✅");
