// 一致性检查报告工作簿编码（src/trace-report-exceljs.js）回归测试
//   覆盖：① 三个 sheet 结构与「校验汇总」数值/加粗 ② 代码侧空 Parent ID 行整行着色（占位行不着色）
//         ③ 需求侧未被引用行整行着色 ④ 列宽 ⑤ 图表嵌入：渲染器被调用且规格与 buildTraceChartSpecs
//         一致、锚点单元格、ext 固定尺寸、图片字节落库 ⑥ 空报告占位行 + 列映射缺失提示
//   纯 Node 运行：真实 ExcelJS + 注入桩图表渲染器（Canvas 仅浏览器可用，渲染像素本身不在覆盖范围）
//   —— 与 src/link-split.js 注入 XLSX 同款做法：npm run test:trace-report
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const ExcelJS = require("exceljs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const mod = (p) => import("file:///" + path.join(ROOT, p).replace(/\\/g, "/"));
const { auditTrace, buildTraceChartSpecs } = await mod("src/trace-check.js");
const { encodeTraceWorkbook } = await mod("src/trace-report-exceljs.js");
const { CHART_SIZE } = await mod("src/trace-chart-canvas.js");

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

/* 桩渲染器：记录收到的 spec，返回固定 PNG 字节（1×1 透明像素），
   使「渲染器输出 → 工作簿媒体」的字节链路可精确比对 */
const STUB_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const renderedSpecs = [];
const stubRenderChart = (spec) => {
  renderedSpecs.push(spec);
  return STUB_PNG;
};

/* ============ 夹具：auditTrace 产出已知报告 ============
   视角一：4 行 Source Code，fn_b / TypeX 空 Parent ID（跨 Function / Type 两章，各 1 空）；
   视角二：R1 / R2 / R3 三条 Requirement，R3 为孤儿；
   附带核对：R77 悬空引用、R1 被 fn_a 与 fn_c 重复追溯、R8（Comment）被引用构成口径差异。 */
const rows = [
  { num: "1", title: "1 模块A", objectType: "", parent: "" },
  { num: "", title: "fn_a", objectType: "Source Code", parent: "R1\nR2\nR8", sectionKey: "functions", sectionTitle: "Function Definition" },
  { num: "", title: "fn_b", objectType: "Source Code", parent: "", sectionKey: "functions", sectionTitle: "Function Definition" },
  { num: "", title: "fn_c", objectType: "Source Code", parent: "R1\nR77", sectionKey: "functions", sectionTitle: "Function Definition" },
  { num: "2", title: "2 类型定义", objectType: "", parent: "" },
  { num: "", title: "TypeX", objectType: "Source Code", parent: "", sectionKey: "types", sectionTitle: "Type" },
];
const llrRows = [
  { 章节: "1.1", ID: "", 内容: "fn_a", 类型: "Heading" },
  { 章节: "", ID: "R1", 内容: "req one", 类型: "Requirement" },
  { 章节: "", ID: "R2", 内容: "req two", 类型: "Requirement" },
  { 章节: "1.2", ID: "", 内容: "fn_b", 类型: "Heading" },
  { 章节: "", ID: "R3", 内容: "req three", 类型: "Requirement" },
  { 章节: "", ID: "R8", 内容: "design note", 类型: "Comment" },
];
const report = auditTrace({
  rows,
  llrRows,
  colMap: { id: "ID", content: "内容", type: "类型", chapter: "章节" },
  nameSet: new Set(["fn_a", "fn_b", "fn_c"]),
});

/* 夹具自检：数字若不符，后续断言全部失真，先拦截 */
console.log("[1/5] 夹具自检：auditTrace 报告数字");
eq("Source Code 总行数", report.code.sourceTotal, 4);
eq("空 Parent ID 行数", report.code.emptyParent, 2);
eq("孤儿 Requirement 数", report.requirement.orphaned, 1);
eq("悬空引用 ID", report.extra.dangling.map((d) => d.id), ["R77"]);

const META = { generatedAt: "2026-09-30 12:00:00" };
const wb = await encodeTraceWorkbook(report, META, stubRenderChart);

const sheets = wb.worksheets;
const byName = Object.fromEntries(sheets.map((ws) => [ws.name, ws]));
const cellText = (ws, r, c) => {
  const v = ws.getCell(r, c).value;
  return v == null ? "" : String(v);
};
const rowVals = (ws, r, cols) => Array.from({ length: cols }, (_, i) => cellText(ws, r, i + 1));
const labelRow = (ws, label) => {
  for (let r = 1; r <= ws.rowCount; r++) if (cellText(ws, r, 1) === label) return r;
  return -1;
};
const isColored = (ws, r, c) => {
  const f = ws.getCell(r, c).fill;
  return !!f && f.pattern === "solid" && !!f.fgColor && f.fgColor.argb === "FFFFEBE9";
};

/* ============ 第 2 节：sheet 结构 + 校验汇总数值与加粗 ============ */
console.log("[2/5] sheet 结构 + 校验汇总数值与加粗");
eq("sheet 数量", sheets.length, 3);
eq(
  "sheet 名称与顺序",
  sheets.map((s) => s.name),
  ["校验汇总", "代码侧-SourceCode明细", "需求侧-一致性明细"]
);

const sum = byName["校验汇总"];
eq("标题行", rowVals(sum, 1, 2), ["一致性检查报告", ""]);
ok("标题行加粗", sum.getCell(1, 1).font && sum.getCell(1, 1).font.bold === true);
eq("生成时间", cellText(sum, labelRow(sum, "生成时间"), 2), META.generatedAt);
eq("视角一分母", cellText(sum, labelRow(sum, "Source Code 总行数"), 2), "4");
eq("视角一空值", cellText(sum, labelRow(sum, "Parent ID 为空"), 2), "2");
eq("视角一占比", cellText(sum, labelRow(sum, "空值占比"), 2), "50.0%");
eq("视角二分母", cellText(sum, labelRow(sum, "Requirement 总条数"), 2), "3");
eq("视角二遗漏", cellText(sum, labelRow(sum, "未被引用"), 2), "1");
eq("视角二占比", cellText(sum, labelRow(sum, "遗漏占比"), 2), "33.3%");
eq("悬空引用计数", cellText(sum, labelRow(sum, "悬空引用（Parent ID 指向不存在的需求 ID）"), 2), "1");
eq("重复追溯计数", cellText(sum, labelRow(sum, "重复追溯（同一条需求被多个符号引用）"), 2), "1");
eq("口径差异计数", cellText(sum, labelRow(sum, "口径差异（Parent ID 引用了非 Requirement 行）"), 2), "1");
const conclusionRow = cellText(sum, labelRow(sum, "结论"), 2);
ok(
  "结论行汇总三块",
  conclusionRow.includes("视角一空值 2 行（Function 章 1 行）") &&
    conclusionRow.includes("视角二遗漏 1 条") &&
    conclusionRow.includes("附带核对 3 项"),
  conclusionRow
);
/* 分区标题行加粗（正则与编码器保持一致），普通数据行不加粗 */
const bolded = [];
const plainUnbolded = [];
for (let r = 1; r <= sum.rowCount; r++) {
  const head = cellText(sum, r, 1);
  if (/^(视角[一二]|按数据章节|附带核对)/.test(head)) bolded.push(sum.getCell(r, 1).font?.bold === true);
  if (head === "Source Code 总行数") plainUnbolded.push(!!sum.getCell(r, 1).font?.bold);
}
eq("四个分区标题行均加粗", bolded, [true, true, true, true]);
ok("数据行不加粗", plainUnbolded.every((b) => b === false), plainUnbolded);
eq("汇总页 A 列宽", sum.getColumn(1).width, 46);

/* ============ 第 3 节：代码侧 sheet —— 全量明细 + 空 Parent ID 行着色 ============ */
console.log("[3/5] 代码侧 sheet：明细与空值行着色");
const codeWs = byName["代码侧-SourceCode明细"];
eq("代码侧表头", rowVals(codeWs, 1, 4), ["文档序号", "章节号", "需求内容", "Parent ID"]);
eq("全量行数（4 行 Source Code）", codeWs.rowCount - 1, 4);
eq("fn_a 行（序号含标题行坐标系）", rowVals(codeWs, 2, 4), ["2", "1", "fn_a", "R1\nR2\nR8"]);
eq("fn_b 行", rowVals(codeWs, 3, 4), ["3", "1", "fn_b", ""]);
eq("TypeX 行（章节号取自所属标题行）", rowVals(codeWs, 5, 4), ["6", "2", "TypeX", ""]);
for (let c = 1; c <= 4; c++) {
  ok(`fn_b 空 Parent ID 第 ${c} 列着色`, isColored(codeWs, 3, c));
  ok(`TypeX 空 Parent ID 第 ${c} 列着色`, isColored(codeWs, 5, c));
}
ok("fn_a 有 Parent ID 不着色", [1, 2, 3, 4].every((c) => !isColored(codeWs, 2, c)));
ok("fn_c 有 Parent ID 不着色", [1, 2, 3, 4].every((c) => !isColored(codeWs, 4, c)));
ok("着色只到第 4 列（第 5 列不扩散）", !isColored(codeWs, 3, 5) && !isColored(codeWs, 5, 5));

/* ============ 第 4 节：需求侧 sheet —— 反向核对展开 + 未被引用行着色 ============ */
console.log("[4/5] 需求侧 sheet：反向核对与未被引用行着色");
const reqWs = byName["需求侧-一致性明细"];
eq("需求侧表头", rowVals(reqWs, 1, 5), ["低层需求 ID", "低层需求内容", "引用文档序号", "引用章节号", "引用需求内容"]);
eq("R1 双引用展开为两行", rowVals(reqWs, 2, 5), ["R1", "req one", "2", "1", "fn_a"]);
eq("R1 第二条引用", rowVals(reqWs, 3, 5), ["R1", "req one", "4", "1", "fn_c"]);
eq("R2 单引用", rowVals(reqWs, 4, 5), ["R2", "req two", "2", "1", "fn_a"]);
eq("R3 孤儿标记", rowVals(reqWs, 5, 5), ["R3", "req three", "（未被引用）", "", ""]);
ok("引用行的引用文档序号为数值类型", reqWs.getCell(2, 3).value === 2 && typeof reqWs.getCell(2, 3).value === "number");
for (let c = 1; c <= 5; c++) ok(`R3 未被引用第 ${c} 列着色`, isColored(reqWs, 5, c));
ok("被引用行不着色", [1, 2, 3, 4, 5].every((c) => !isColored(reqWs, 2, c) && !isColored(reqWs, 4, c)));
ok("着色只到第 5 列（第 6 列不扩散）", !isColored(reqWs, 5, 6));

/* ============ 第 5 节：图表嵌入 —— 规格 / 锚点 / 尺寸 / 字节 + 空报告占位 ============ */
console.log("[5/5] 图表嵌入与空报告占位");
const specs = buildTraceChartSpecs(report);
eq("渲染器被调用次数", renderedSpecs.length, 4);
eq(
  "渲染规格与纯模块一致（id/kind/锚点/数据）",
  renderedSpecs.map((s) => [s.id, s.kind, s.anchor, s.categories, s.values]),
  specs.map((s) => [s.id, s.kind, s.anchor, s.categories, s.values])
);

const anchorToRC = (ref) => {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { col: col - 1, row: parseInt(m[2], 10) - 1 };
};
const imgs = sum.getImages();
eq("校验汇总嵌入图片数", imgs.length, 4);
eq("其它 sheet 不嵌图", byName["代码侧-SourceCode明细"].getImages().length + byName["需求侧-一致性明细"].getImages().length, 0);
specs.forEach((spec, i) => {
  const tl = imgs[i]?.range?.tl;
  const ext = imgs[i]?.range?.ext;
  const want = anchorToRC(spec.anchor);
  ok(`图 ${i + 1} 锚点 = ${spec.anchor}（0-based {col,row}）`, !!tl && tl.col === want.col && tl.row === want.row, { tl, want });
  ok(`图 ${i + 1} ext 固定尺寸（不随单元格拉伸）`, !!ext && ext.width === CHART_SIZE.width && ext.height === CHART_SIZE.height, ext);
  const media = wb.model.media[imgs[i].imageId];
  ok(`图 ${i + 1} 字节落库且与渲染器输出一致`, !!media && media.base64 === STUB_PNG && media.extension === "png");
});
eq("CHART_SIZE 锚定（ext 断言的前提）", CHART_SIZE, { width: 460, height: 240 });

/* 空报告：占位行出现且不着色、图表仍生成、列映射缺失如实提示 */
const emptyReport = auditTrace({ rows: [], llrRows: [], colMap: {}, nameSet: new Set() });
const wb2 = await encodeTraceWorkbook(emptyReport, {}, stubRenderChart);
const byName2 = Object.fromEntries(wb2.worksheets.map((ws) => [ws.name, ws]));
eq("空报告仍三个 sheet", wb2.worksheets.length, 3);
eq("代码侧占位行", rowVals(byName2["代码侧-SourceCode明细"], 2, 4), ["（无 Source Code 行）", "", "", ""]);
ok(
  "代码侧占位行不着色",
  [1, 2, 3, 4].every((c) => !isColored(byName2["代码侧-SourceCode明细"], 2, c))
);
eq("需求侧占位行", rowVals(byName2["需求侧-一致性明细"], 2, 5), ["（无 Requirement 行）", "", "", "", ""]);
ok(
  "需求侧占位行不着色",
  [1, 2, 3, 4, 5].every((c) => !isColored(byName2["需求侧-一致性明细"], 2, c))
);
eq("空报告仍嵌 4 张图", byName2["校验汇总"].getImages().length, 4);
eq("空报告渲染器累计调用", renderedSpecs.length, 8);
const notesRow2 = cellText(byName2["校验汇总"], labelRow(byName2["校验汇总"], "列映射提示"), 2);
ok("空报告列映射提示如实列出", notesRow2.includes("未映射「ID 列」") && notesRow2.includes("未映射「Object Type 列」"), notesRow2);

console.log("");
console.log(`断言通过 ${pass} 项，失败 ${fail.length} 项`);
if (fail.length) {
  console.log("结论: 失败 ❌");
  fail.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("结论: 通过 ✅");
