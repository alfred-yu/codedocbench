// 链接文件分片回归：直接引用 src/link-split.js（纯模块，不依赖 DOM / Tauri）。
// 覆盖 vite build 与 smoke-ui 都验证不到的规则：
//   切分边界、链出 ID 跨片透传、单片矩阵（表头/合并/加粗）结构、文件名补零、分片后行不丢不重。
// 用法：npm run test:link-split
import { createRequire } from "module";
import {
  LINK_MAX_ROWS,
  LINK_FIELDS,
  LINK_MERGES,
  LINK_COL_WIDTHS,
  LINK_HEADER_CELLS,
  splitLinkRows,
  partFileNames,
  buildLinkAoa,
  encodeLinkSheet,
} from "../src/link-split.js";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx-js-style");

let pass = 0;
const fail = [];
function check(name, actual, expected) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log("  ✅ " + name);
    return;
  }
  fail.push(name);
  console.log(`  ❌ ${name}\n       期望 ${JSON.stringify(expected)}\n       实际 ${JSON.stringify(actual)}`);
}

const mk = (n) => Array.from({ length: n }, (_, i) => ({ outId: i + 1, inId: String(6000 + i) }));
const cfg = {
  inProject: "P-IN", inModule: "SWLR008", inPath: "P/LLR/",
  outProject: "P-OUT", outModule: "SCTD004", outPath: "P/CODE/",
};

console.log(`[1] 切分边界（单文件上限 ${LINK_MAX_ROWS} 行数据，表头不计入）`);
check("LINK_MAX_ROWS 常量", LINK_MAX_ROWS, 50);
for (const [n, sizes] of [
  [0, []], [1, [1]], [49, [49]], [50, [50]],
  [51, [50, 1]], [100, [50, 50]], [101, [50, 50, 1]], [137, [50, 50, 37]],
]) {
  const got = splitLinkRows(mk(n), LINK_MAX_ROWS).map((p) => p.length);
  check(`${String(n).padStart(3)} 行 → 片内行数 ${JSON.stringify(sizes)}`, got, sizes);
}
const big = splitLinkRows(mk(1234), LINK_MAX_ROWS);
check("1234 行 → 25 片", big.length, 25);
check("1234 行每片均 ≤ 上限", big.every((p) => p.length <= LINK_MAX_ROWS), true);

console.log("[2] 链出 ID 跨片透传（不重编、不丢失、不重复）");
check("切片展平后与原始序列逐行相同", splitLinkRows(mk(137), LINK_MAX_ROWS).flat(), mk(137));
{
  // 第 50 行符号关联了第二条需求：严格按行数切，允许它落到下一片
  const rows = mk(50).concat([{ outId: 50, inId: "7001" }]);
  const p = splitLinkRows(rows, LINK_MAX_ROWS);
  check("同符号多条链接允许跨片", p.map((x) => x.length), [50, 1]);
  // 取下标一律做存在性判断：规则一旦被改坏，这里应报断言失败，而不是抛异常中断后续断言
  check("跨片后两侧 outId 均为原值 50", [
    p[0] && p[0][49] ? p[0][49].outId : null,
    p[1] && p[1][0] ? p[1][0].outId : null,
  ], [50, 50]);
  check("跨片后逐行内容与切分前一致", p.flat(), rows);
}

console.log("[3] 分片文件名");
check("单片：沿用原名", partFileNames("链接文件", 1), ["链接文件.xlsx"]);
check("九片：不补零", partFileNames("链接文件", 9).slice(0, 2).concat(partFileNames("链接文件", 9).slice(8)), ["链接文件_1.xlsx", "链接文件_2.xlsx", "链接文件_9.xlsx"]);
check("十二片：补零至 2 位（首/尾）", [partFileNames("链接文件", 12)[0], partFileNames("链接文件", 12)[11]], ["链接文件_01.xlsx", "链接文件_12.xlsx"]);
check("零片：不产生文件", partFileNames("链接文件", 0), []);

console.log("[4] 单片矩阵结构（两行表头 + 数据行，8 列）");
const parts = splitLinkRows(mk(101), LINK_MAX_ROWS);
const aoa0 = buildLinkAoa(parts[0], cfg);
const aoa2 = buildLinkAoa(parts[2], cfg);
check("满片 aoa 行数 = 2 + 50", aoa0.length, 52);
check("末片 aoa 行数 = 2 + 1", aoa2.length, 3);
check("每行均为 8 列", aoa0.every((r) => r.length === 8), true);
check("第 1 行分组表头", [aoa0[0][0], aoa0[0][1], aoa0[0][4], aoa0[0][7]], ["链入", "", "链出", ""]);
check("第 2 行字段表头", aoa0[1], LINK_FIELDS.concat(LINK_FIELDS));
check("第 3 行 = 链入元信息3 + 链入ID + 链出元信息3 + 链出ID", aoa0[2], [
  cfg.inProject, cfg.inModule, cfg.inPath, "6000",
  cfg.outProject, cfg.outModule, cfg.outPath, 1,
]);
check("末片首条数据承接第 101 行", aoa2[2], [
  cfg.inProject, cfg.inModule, cfg.inPath, "6100",
  cfg.outProject, cfg.outModule, cfg.outPath, 101,
]);

console.log("[5] xlsx 真实编码 → 读回校验");
function readSheet(part) {
  const bytes = encodeLinkSheet(part, cfg, XLSX);
  return XLSX.read(bytes, { type: "array" }).Sheets["链接文件"];
}
const full = readSheet(parts[0]);
check("满片区域 = A1:H52（50 数据行）", full["!ref"], "A1:H52");
check("合并 = 链入 A1:D1 / 链出 E1:H1", (full["!merges"] || []).map((m) => [m.s.r, m.s.c, m.e.r, m.e.c]), [[0, 0, 0, 3], [0, 4, 0, 7]]);
check("数据首行 链入 ID（D3）", full.D3.v, "6000");
check("数据首行 链出 ID（H3）", full.H3.v, 1);
check("数据末行 链出 ID（H52）", full.H52.v, 50);
const last = readSheet(parts[2]);
check("末片区域 = A1:H3（1 数据行）", last["!ref"], "A1:H3");
check("末片数据行 链出 ID（H3）", last.H3.v, 101);
readSheet(parts[0]);
check("重复编码不污染共享常量 LINK_MERGES", LINK_MERGES, [{ s: { r: 0, c: 0 }, e: { r: 0, c: 3 } }, { s: { r: 0, c: 4 }, e: { r: 0, c: 7 } }]);

console.log("[5b] 加粗表头：文件级校验（xlsx-js-style 读侧不还原字体，故直接解 zip 读 styles/sheet XML）");
/* 说明：本库 1.2.0 的 XLSX.read 即使带 cellStyles:true，读回的单元格样式只有 {patternType:"none"}，
   不含 font —— 这是读侧限制（已用最小样例确认，与本项目代码无关）。
   因此加粗改由产物内部的 xl/styles.xml / xl/worksheets/sheet1.xml 验证：表头单元格的样式索引
   必须指向字体表中那条带 <b/> 的加粗字体。 */
function readXmlParts(bytes) {
  const wb = XLSX.read(bytes, { type: "array", bookFiles: true });
  const text = (p) => {
    const c = wb.files[p].content;
    return new TextDecoder("utf-8").decode(c instanceof Uint8Array ? c : new Uint8Array(c));
  };
  return { styles: text("xl/styles.xml"), sheet: text("xl/worksheets/sheet1.xml") };
}
const boldFontId = (styles) => {
  const seg = styles.match(/<fonts[^>]*>([\s\S]*?)<\/fonts>/);
  const list = seg ? seg[1].match(/<font>[\s\S]*?<\/font>/g) || [] : [];
  return list.findIndex((f) => f.includes("<b/>"));
};
const xfFontIds = (styles) => {
  const seg = styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/);
  const list = seg ? seg[1].match(/<xf\b[^>]*\/>/g) || [] : [];
  return list.map((x) => {
    const m = /fontId="(\d+)"/.exec(x);
    return m ? Number(m[1]) : 0;
  });
};
const cellXf = (sheet, addr) => {
  const m = new RegExp(`<c r="${addr}"(?: s="(\\d+)")?`).exec(sheet);
  return m ? (m[1] === undefined ? 0 : Number(m[1])) : -1;
};
{
  const p = readXmlParts(encodeLinkSheet(parts[0], cfg, XLSX));
  const bid = boldFontId(p.styles);
  const fonts = xfFontIds(p.styles);
  check("styles.xml 中存在加粗字体记录", bid >= 0, true);
  for (const addr of LINK_HEADER_CELLS) {
    check(`表头 ${addr} 的样式指向加粗字体`, fonts[cellXf(p.sheet, addr)], bid);
  }
  check("数据单元格 D3 未加粗", fonts[cellXf(p.sheet, "D3")] === bid, false);
  check("sheet 维度 = A1:H52", (/<dimension ref="([^"]+)"/.exec(p.sheet) || [])[1], "A1:H52");
  // 列宽同理不走读回（!cols 不往返）：直接从 sheet XML 取 <col> 的存储宽度比对字符宽。
  // Excel 存储宽度 = 字符宽 + 内边距（本例约 0.83），故用容差比对。
  const cols = [...p.sheet.matchAll(/<col min="(\d+)" max="(\d+)" width="([\d.]+)"/g)].map((m) => ({
    i: Number(m[1]),
    w: Number(m[3]),
  }));
  check("列宽 8 列且顺序正确", cols.map((c) => c.i), [1, 2, 3, 4, 5, 6, 7, 8]);
  check(
    "每列宽度与期望字符宽一致",
    cols.map((c) => Math.abs(c.w - LINK_COL_WIDTHS[c.i - 1]) < 1.5),
    cols.map(() => true)
  );
}

console.log("[6] 端到端：137 行 → 3 片，逐片行数正确且合起来不丢不重");
const parts137 = splitLinkRows(mk(137), LINK_MAX_ROWS);
const outIds = [];
parts137.forEach((p, i) => {
  const s = readSheet(p);
  const lastRow = XLSX.utils.decode_range(s["!ref"]).e.r + 1;
  check(`第 ${i + 1}/${parts137.length} 片数据行数（${partFileNames("链接文件", parts137.length)[i]}）`, lastRow - 2, p.length);
  for (let r = 3; r <= lastRow; r++) outIds.push(s["H" + r].v);
});
check("三片合并后链出 ID = 1..137", outIds, Array.from({ length: 137 }, (_, i) => i + 1));

if (fail.length) {
  console.log(`\n结论: 分片回归失败 ❌  ${pass} 通过 / ${fail.length} 失败`);
  fail.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log(`\n结论: 分片回归通过 ✅  ${pass} 项断言`);
