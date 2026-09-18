/* 一致性检查报告工作簿编码（ExcelJS 版）
   —— 数据 sheet（AoA）来自纯模块 src/trace-check.js 的 buildTraceReportSheets；
      首 sheet「校验汇总」的图表来自 buildTraceChartSpecs，浏览器侧用 Canvas 现画 PNG 后嵌入。
   原生图表库（SheetJS / exceljs 4.4.0）都不支持写 Excel 图表，故选「嵌图」路线：
   打开即见图表、直观可靠，代价是图片（非可编辑原生图表对象、数据不联动单元格）。
   本模块只在浏览器（WebView2）运行，依赖 document.createElement('canvas')；Node 回归不引入它。 */
import ExcelJS from "exceljs";
import { buildTraceReportSheets, buildTraceChartSpecs } from "./trace-check.js";
import { renderChartPng } from "./trace-chart-canvas.js";

/* 单元格引用（如 "F3"）→ { col, row }（0-based），供 exceljs.addImage 锚点 */
function refToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return { col: 5, row: 2 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return { col, row: parseInt(m[2], 10) - 1 };
}

/* 主入口：编工作簿 + 在「校验汇总」嵌入图表 PNG。返回 ExcelJS.Workbook（调用方 await wb.xlsx.writeBuffer() 取字节）。 */
export async function encodeTraceWorkbook(report, meta = {}) {
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
    if (name === "校验汇总") {
      for (const spec of buildTraceChartSpecs(report)) {
        const b64 = renderChartPng(spec);
        const tl = refToRC(spec.anchor);
        // 正确姿势：workbook 级先注册图片拿到 imageId，再 worksheet 级按 id 引用
        const imageId = wb.addImage({ base64: b64, extension: "png" });
        ws.addImage(imageId, {
          tl: { col: tl.col, row: tl.row },
          br: { col: tl.col + spec.size.cols, row: tl.row + spec.size.rows },
        });
      }
    }
  }
  return wb;
}
