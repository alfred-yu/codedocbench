/* 一致性检查报告图表 —— 纯 Canvas 绘制（浏览器侧），输出 PNG。
   不依赖任何 xlsx 库：可被 src/trace-report-exceljs.js 嵌入 Excel，也可被预览页直接 import 渲染。
   设计要点：
   - 高 DPI（SCALE=2）保证嵌入 Excel 后清晰锐利，不糊。
   - 极简灰白工程风（GitHub / Linear），卡片化 + 细描边 + 分隔线标题。
   - 环形图中心显示主指标（占比%），右侧图例带数值 + 占比。
   - 柱状图带横向网格 + Y 刻度、圆角柱、数据标签、旋转 X 标签。
   - 画布比例 ~1.9:1，与 Excel 嵌入单元格区域（约 8~10 列 × 11~12 行）比例接近，减少变形。 */
const C = {
  green: "#1a7f37",
  red: "#cf222e",
  blue: "#0969da",
  amber: "#9a6700",
  purple: "#8250df",
  ink: "#1f2328",
  sub: "#656d76",
  grid: "#eaeef2",
  cardBorder: "#d0d7de",
  track: "#eaeef2",
};
const FONT = "-apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif";
const SCALE = 2;

function makeCanvas(w, h) {
  const canvas = document.createElement("canvas");
  canvas.width = w * SCALE;
  canvas.height = h * SCALE;
  const ctx = canvas.getContext("2d");
  ctx.scale(SCALE, SCALE);
  ctx.textBaseline = "alphabetic";
  return { canvas, ctx, W: w, H: h };
}

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function card(ctx, W, H) {
  ctx.fillStyle = "#ffffff";
  roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, 12);
  ctx.fill();
  ctx.strokeStyle = C.cardBorder;
  ctx.lineWidth = 1;
  roundRectPath(ctx, 0.5, 0.5, W - 1, H - 1, 12);
  ctx.stroke();
}

function title(ctx, W, t) {
  ctx.fillStyle = C.ink;
  ctx.font = `600 15px ${FONT}`;
  ctx.textAlign = "left";
  ctx.fillText(t, 18, 30);
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(18, 42);
  ctx.lineTo(W - 18, 42);
  ctx.stroke();
}

function sliceColor(i) {
  return [C.green, C.red, C.blue, C.amber, C.purple][i % 5];
}

function drawDoughnut(ctx, W, H, spec) {
  const { categories, values } = spec;
  const total = values.reduce((a, b) => a + b, 0);
  const padT = 56;
  const cx = 106, cy = (H + padT) / 2 + 4;
  const R = 60, IR = 38;
  if (total === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.arc(cx, cy, IR, 0, Math.PI * 2, true);
    ctx.fillStyle = C.track;
    ctx.fill("evenodd");
  } else {
    let a0 = -Math.PI / 2;
    values.forEach((v, i) => {
      const a1 = a0 + (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, a0, a1);
      ctx.closePath();
      ctx.fillStyle = sliceColor(i);
      ctx.fill();
      a0 = a1;
    });
    // 扇区间白色细缝，提升分离感
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    let s = -Math.PI / 2;
    values.forEach((v) => {
      const a1 = s + (v / total) * Math.PI * 2;
      [s, a1].forEach((a) => {
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(a) * IR, cy + Math.sin(a) * IR);
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
        ctx.stroke();
      });
      s = a1;
    });
    // 内圆挖空
    ctx.beginPath();
    ctx.arc(cx, cy, IR, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
  }
  // 中心主指标：第一项占比（"好"的一侧）
  const pct = total ? Math.round((values[0] / total) * 100) : 0;
  ctx.textAlign = "center";
  ctx.fillStyle = total ? sliceColor(0) : C.sub;
  ctx.font = `700 22px ${FONT}`;
  ctx.fillText(`${pct}%`, cx, cy - 1);
  ctx.fillStyle = C.sub;
  ctx.font = `11px ${FONT}`;
  ctx.fillText(`共 ${total}`, cx, cy + 16);
  // 图例（带数值 + 占比）
  ctx.textAlign = "left";
  let ly = padT + 4;
  const lx = 200;
  categories.forEach((c, i) => {
    ctx.fillStyle = sliceColor(i);
    roundRectPath(ctx, lx, ly - 10, 11, 11, 3);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.font = `12px ${FONT}`;
    ctx.fillText(c, lx + 18, ly);
    ctx.fillStyle = C.sub;
    ctx.font = `11px ${FONT}`;
    const vp = total ? Math.round((values[i] / total) * 100) : 0;
    ctx.fillText(`${values[i]} · ${vp}%`, lx + 18, ly + 16);
    ly += 38;
  });
}

function drawBar(ctx, W, H, spec) {
  const { categories, values } = spec;
  const padL = 64, padR = 18, padT = 56, padB = 58;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const maxV = Math.max(1, ...values);
  const ticks = 4;
  ctx.strokeStyle = C.grid;
  ctx.fillStyle = C.sub;
  ctx.font = `10px ${FONT}`;
  ctx.textAlign = "right";
  for (let t = 0; t <= ticks; t++) {
    const val = Math.round((maxV * t) / ticks);
    const y = padT + plotH * (1 - t / ticks);
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(padL + plotW, y + 0.5);
    ctx.stroke();
    ctx.fillText(String(val), padL - 6, y + 3.5);
  }
  const n = categories.length || 1;
  const slot = plotW / n;
  const bw = Math.min(46, slot * 0.5);
  values.forEach((v, i) => {
    const x = padL + slot * i + (slot - bw) / 2;
    const h = (v / maxV) * plotH;
    const y = padT + plotH - h;
    ctx.fillStyle = C.red;
    roundRectPath(ctx, x, y, bw, h, 4);
    ctx.fill();
    ctx.fillStyle = C.ink;
    ctx.font = `600 11px ${FONT}`;
    ctx.textAlign = "center";
    ctx.fillText(String(v), x + bw / 2, y - 6);
    ctx.save();
    ctx.translate(x + bw / 2, padT + plotH + 12);
    ctx.rotate(-Math.PI / 4);
    ctx.textAlign = "right";
    ctx.fillStyle = C.sub;
    ctx.font = `11px ${FONT}`;
    const raw = String(categories[i]);
    ctx.fillText(raw.length > 14 ? raw.slice(0, 13) + "…" : raw, 0, 0);
    ctx.restore();
  });
  // 轴线（基线加粗）
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT);
  ctx.lineTo(padL, padT + plotH);
  ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
}

/* 图表逻辑尺寸（CSS 像素）：ext 固定尺寸嵌入 Excel 时引用，保证图片不随单元格拉伸变形 */
export const CHART_SIZE = { width: 460, height: 240 };

/* 同步绘制并返回 canvas 元素（供预览页直接挂载，截图无需等异步） */
export function renderChartCanvas(spec) {
  const W = CHART_SIZE.width, H = CHART_SIZE.height;
  const { canvas, ctx } = makeCanvas(W, H);
  card(ctx, W, H);
  title(ctx, W, spec.title);
  if (spec.kind === "doughnut") drawDoughnut(ctx, W, H, spec);
  else drawBar(ctx, W, H, spec);
  return canvas;
}

/* 一张图 → PNG base64（去掉 data: 前缀），供 exceljs.addImage */
export function renderChartPng(spec) {
  const canvas = renderChartCanvas(spec);
  const url = canvas.toDataURL("image/png");
  return url.slice(url.indexOf(",") + 1);
}
