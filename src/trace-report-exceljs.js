/* 一致性检查报告工作簿编码（ExcelJS 版）
   —— 数据 sheet（AoA）来自纯模块 src/trace-check.js 的 buildTraceReportSheets；
      首 sheet「校验汇总」的图表来自 buildTraceChartSpecs，浏览器侧用 Canvas 现画 PNG 后嵌入。
   原生图表库（SheetJS / exceljs 4.4.0）都不支持写 Excel 图表，故选「嵌图」路线：
   打开即见图表、直观可靠，代价是图片（非可编辑原生图表对象、数据不联动单元格）。
   本模块只在浏览器（WebView2）运行，依赖 document.createElement('canvas')；Node 回归不引入它。 */
import ExcelJS from "exceljs";
import { buildTraceReportSheets, buildTraceChartSpecs } from "./trace-check.js";

/* 极简灰白工程配色（GitHub / Linear 风），与界面一致 */
const PALETTE = ["#1f883d", "#cf222e", "#d29922", "#8250df", "#0969da"];
const INK = "#1f2328";
const SUB = "#57606a";
const GRID = "#d0d7de";
const BG = "#ffffff";

/* 单元格引用（如 "F3"）→ { col, row }（0-based），供 exceljs.addImage 锚点 */
function refToRC(ref) {
  const m = /^([A-Z]+)(\d+)$/.exec(ref || "");
  if (!m) return { col: 5, row: 2 };
  let col = 0;
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64);
  col -= 1;
  return { col, row: parseInt(m[2], 10) - 1 };
}

function makeCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  return canvas;
}

function drawDoughnut(ctx, W, H, spec) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = INK;
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(spec.title, 12, 22);
  const { categories, values } = spec;
  const total = values.reduce((a, b) => a + b, 0);
  const cx = 92, cy = H / 2 + 14, r = 62, ir = 36;
  if (total === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.arc(cx, cy, ir, 0, Math.PI * 2, true);
    ctx.fillStyle = "#eaeef2";
    ctx.fill("evenodd");
  } else {
    let a0 = -Math.PI / 2;
    values.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a0, a1);
      ctx.closePath();
      ctx.fillStyle = PALETTE[i % PALETTE.length];
      ctx.fill();
      a0 = a1;
    });
    ctx.beginPath();
    ctx.arc(cx, cy, ir, 0, Math.PI * 2);
    ctx.fillStyle = BG;
    ctx.fill();
  }
  let ly = 44;
  const lx = 188;
  categories.forEach((c, i) => {
    ctx.fillStyle = PALETTE[i % PALETTE.length];
    ctx.fillRect(lx, ly - 11, 12, 12);
    ctx.fillStyle = INK;
    ctx.font = "12px sans-serif";
    ctx.fillText(`${c}: ${values[i]}`, lx + 18, ly);
    ly += 20;
  });
}

function drawBar(ctx, W, H, spec) {
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = INK;
  ctx.font = "bold 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(spec.title, 12, 22);
  const { categories, values } = spec;
  const padL = 44, padR = 14, padT = 36, padB = 54;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  const n = categories.length || 1;
  const slot = plotW / n;
  const bw = Math.min(46, slot * 0.6);
  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const h = (v / maxV) * plotH;
    ctx.fillStyle = "#cf222e";
    ctx.fillRect(x, padT + plotH - h, bw, h);
    ctx.fillStyle = INK;
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(String(v), x + bw / 2, padT + plotH - h - 4);
    ctx.save();
    ctx.translate(x + bw / 2, padT + plotH + 6);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = "right";
    ctx.fillStyle = SUB;
    ctx.font = "11px sans-serif";
    ctx.fillText(String(categories[i]), 0, 0);
    ctx.restore();
  });
  ctx.textAlign = "left";
}

/* 一张图 → PNG base64（去掉 data: 前缀），供 exceljs.addImage */
function renderChartPng(spec) {
  const W = 400, H = 260;
  const canvas = makeCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (spec.kind === "doughnut") drawDoughnut(ctx, W, H, spec);
  else drawBar(ctx, W, H, spec);
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
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
