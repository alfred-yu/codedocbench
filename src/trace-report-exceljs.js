/* 一致性检查报告工作簿编码（ExcelJS 版）
   —— 数据 sheet（AoA）来自纯模块 src/trace-check.js 的 buildTraceReportSheets；
      首 sheet「校验汇总」的图表来自 buildTraceChartSpecs，浏览器侧用 Canvas 现画 PNG 后嵌入。
   原生图表库（SheetJS / exceljs 4.4.0）都不支持写 Excel 图表，故选「嵌图」路线：
   打开即见图表、直观可靠，代价是图片（非可编辑原生图表对象、数据不联动单元格）。
   本模块在浏览器（WebView2）运行；Node 回归（scripts/test-trace-report.mjs）通过第三参注入
   桩渲染器替代 renderChartPng（Canvas 仅浏览器可用），ExcelJS 本身用真实库，着色/嵌图可断言。 */
import ExcelJS from "exceljs";
import { buildTraceReportSheets, buildTraceChartSpecs } from "./trace-check.js";
import { renderChartPng, CHART_SIZE } from "./trace-chart-canvas.js";

/* 单元格引用（如 "F3"）→ { col, row }（0-based），供 exceljs.addImage 锚点 */
function refToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return { col: 5, row: 2 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return { col, row: parseInt(m[2], 10) - 1 };
}

/* 主入口：编工作簿 + 在「校验汇总」嵌入图表 PNG。返回 ExcelJS.Workbook（调用方 await wb.xlsx.writeBuffer() 取字节）。
   renderChart：spec → PNG base64，默认用 Canvas 渲染；Node 回归注入桩以脱离浏览器断言锚点与字节。 */
export async function encodeTraceWorkbook(report, meta = {}, renderChart = renderChartPng) {
  const wb = new ExcelJS.Workbook();
  const sheets = buildTraceReportSheets(report, meta);
  for (const { name, aoa, cols } of sheets) {
    const ws = wb.addWorksheet(name);
    if (cols && cols.length) ws.columns = cols.map((c) => ({ width: c.wch }));
    aoa.forEach((row, r) => {
      row.forEach((v, c) => {
        ws.getCell(r + 1, c + 1).value = v == null ? "" : v;
      });
      const head = String(row[0] ?? "");
      if (r === 0 || /^(视角[一二]|按数据章节|附带核对)/.test(head)) {
        ws.getCell(r + 1, 1).font = { bold: true };
      }
    });
    if (name === "代码侧-SourceCode明细") {
      // 空 Parent ID 行整行浅红着色（GitHub danger subtle 风），一眼定位缺口；占位行不着色
      aoa.forEach((row, r) => {
        if (r === 0) return;
        if (String(row[0] ?? "").startsWith("（无")) return;
        if (String(row[3] ?? "").trim()) return;
        for (let c = 0; c < Math.max(4, row.length); c++) {
          ws.getCell(r + 1, c + 1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFEBE9" },
          };
        }
      });
    }
    if (name === "需求侧-一致性明细") {
      // 未被引用的 Requirement 行整行浅红着色（与代码侧空值行同一视觉语言）；占位行不着色
      aoa.forEach((row, r) => {
        if (r === 0) return;
        if (String(row[0] ?? "").startsWith("（无")) return;
        if (String(row[2] ?? "") !== "（未被引用）") return;
        for (let c = 0; c < Math.max(5, row.length); c++) {
          ws.getCell(r + 1, c + 1).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFFFEBE9" },
          };
        }
      });
    }
    if (name === "校验汇总") {
      for (const spec of buildTraceChartSpecs(report)) {
        const b64 = renderChart(spec);
        const tl = refToRC(spec.anchor);
        // 正确姿势：workbook 级先注册图片拿到 imageId，再 worksheet 级按 id 引用。
        // 用 ext 固定像素尺寸（oneCellAnchor），不传 br——否则 Excel 按 tl~br 单元格区域
        // 拉伸图片，区域比例与图片不符时会水平/垂直变形（真机已踩坑）。
        const imageId = wb.addImage({ base64: b64, extension: "png" });
        ws.addImage(imageId, {
          tl: { col: tl.col, row: tl.row },
          ext: { width: CHART_SIZE.width, height: CHART_SIZE.height },
        });
      }
    }
  }
  return wb;
}
