// 前端冒烟测试：在 Node 里用 DOM stub + 伪 Tauri 后端执行打包产物，
// 覆盖 `vite build` 与 pytest 都抓不到的一类缺陷——模块顶层引用未声明的标识符
// （会让整个模块求值中断，表现为「打开项目无反应 / 点击按钮无反应」）。
// 另外驱动步骤 5 的「生成 → 导出」真实链路：伪后端喂入 120 行链接数据，
// 校验多文件分片导出的写盘字节（文件个数、文件名、每文件数据行数、ID 不丢不重）。
//
// 用法：npm run smoke   （先构建，再冒烟）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx-js-style");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist", "assets");

const writes = [];
const alerts = [];
const rejections = [];

/* ---------- DOM stub：任意属性可访问、任意方法可调用 ---------- */
function makeThing() {
  const fn = function () {};
  return new Proxy(fn, {
    get(t, k) {
      if (k === "style") return styleStub();
      if (k === "dataset") return {};
      if (k === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === "children" || k === "childNodes") return [];
      if (k === "parentNode" || k === "parentElement") return null;
      if (k === "length") return 0;
      if (k === Symbol.toPrimitive) return () => "";
      if (k === "toString") return () => "";
      return makeThing();
    },
    set() {
      return true;
    },
    has() {
      return false;
    },
    apply() {
      return makeThing();
    },
    construct() {
      return makeThing();
    },
  });
}

function styleStub() {
  return new Proxy({}, { get: () => "", set: () => true });
}

/* 选择器缓存：真实 DOM 里同一节点反复 querySelector 得到同一对象，
   这里按 (父元素 id, 选择器) 缓存，使「innerHTML 动态生成 + addEventListener」
   的节点能被测试脚本主动触发；innerHTML 被覆盖时清空其下缓存，模拟节点重建。 */
const selectorRegistry = new Map();

/* 元素 stub：记录 addEventListener，便于测试主动触发点击 */
function makeEl(id) {
  const listeners = {};
  const state = { id, textContent: "", innerHTML: "", className: "", value: "", disabled: false, options: [] };
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === "addEventListener")
        return (type, fn) => (listeners[type] || (listeners[type] = [])).push(fn);
      if (k === "__listeners") return listeners;
      if (k === "querySelector")
        return (sel) => {
          const key = id + " >> " + sel;
          if (!selectorRegistry.has(key)) selectorRegistry.set(key, makeEl(key));
          return selectorRegistry.get(key);
        };
      if (k === "style") return styleStub();
      if (k === "classList") return { add() {}, remove() {}, toggle() {}, contains: () => false };
      if (k === "dataset") return {};
      if (k === "children" || k === "childNodes") return [];
      if (k === "parentNode" || k === "parentElement") return null;
      if (k in state) return state[k];
      return makeThing();
    },
    set(t, k, v) {
      if (k in state) state[k] = v;
      // <select> 的列映射依赖 .options（applyRelMapping 会用 [...sel.options].some(...) 校验列名），
      // 故写入 innerHTML 时同步解析出 <option value="...">
      if (k === "options") state.options = v;
      if (k === "innerHTML") {
        state.options = [...String(v).matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => ({ value: m[1] }));
        // 覆盖 innerHTML 等于重建子节点（真实 DOM 会丢弃旧节点及其监听器）
        for (const key of [...selectorRegistry.keys()]) {
          if (key.startsWith(id + " >> ")) selectorRegistry.delete(key);
        }
      }
      if ((k === "textContent" || k === "innerHTML") && v)
        writes.push({ id, key: k, value: String(v) });
      return true;
    },
    has() {
      return false;
    },
    apply() {
      return makeThing();
    },
    construct() {
      return makeThing();
    },
  });
}

const registry = new Map();
globalThis.document = {
  getElementById: (id) => {
    if (!registry.has(id)) registry.set(id, makeEl(id));
    return registry.get(id);
  },
  createElement: (tag) => makeEl("new:" + tag),
  createTextNode: () => makeThing(),
  querySelector: (sel) => {
    const key = "document >> " + sel;
    if (!selectorRegistry.has(key)) selectorRegistry.set(key, makeEl(key));
    return selectorRegistry.get(key);
  },
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeEl("body"),
  documentElement: makeEl("html"),
  title: "",
};

/* ---------- 伪 Tauri 后端 ----------
   让「打开项目 → 生成链接文件 → 导出分片」整条链路可跑通：
   - 项目数据文件里挂载一个 .c，解析结果为 120 个函数
   - 120 行链接 > 单文件上限 50 → 导出必然走多文件分片分支            */
const PROJECT_DATA_FILENAME = ".codedocbench.json";
const SOURCE_PATH = path.join(ROOT, "samples", "cproject", "src", "big.c");
const FUNC_COUNT = 120;
const FUNCS = Array.from({ length: FUNC_COUNT }, (_, i) => ({
  name: "fn_" + String(i + 1).padStart(3, "0"),
}));

/* 低层需求（LLR）真实形态：ID 列带前缀 `PDTMGR_LL_R_<n>`。
   每个函数一个需求块（函数名行 + 一条 Requirement 行），
   用于端到端验证「链入 ID 只保留尾部数值部分」。 */
const LLR_PATH = path.join(ROOT, "PDT_LLR_Requirements.xlsx");
const LLR_HEADER = ["Requirement ID", "Section", "Title / Requirement Text", "Type"];
const LLR_AOA = [LLR_HEADER];
for (let i = 1; i <= FUNC_COUNT; i++) {
  const name = FUNCS[i - 1].name;
  LLR_AOA.push(["", `4.2.4.1.${i}`, name, ""]); // 章节/函数名边界行
  LLR_AOA.push([`PDTMGR_LL_R_${i}`, "", `The ${name} function shall do its job.`, "Requirement"]);
}
const LLR_BYTES = (() => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(LLR_AOA), "LLR");
  return Array.from(new Uint8Array(XLSX.write(wb, { bookType: "xlsx", type: "buffer" })));
})();

const PROJECT_PAYLOAD = JSON.stringify({
  version: 1,
  savedAt: 0,
  docTree: [{ id: 1, type: "file", title: "big.c", path: SOURCE_PATH, children: [] }],
  llr: {
    path: LLR_PATH,
    mapping: {
      chapter: "Section",
      id: "Requirement ID",
      content: "Title / Requirement Text",
      objectType: "Type",
    },
  },
  link: {
    inProject: "P-IN", inModule: "SWLR008", inPath: "P/LLR/",
    outProject: "P-OUT", outModule: "SCTD004", outPath: "P/CODE/",
  },
});

const invoked = [];
const savedFiles = [];
const tauriInvoke = async (cmd, args) => {
  invoked.push(cmd);
  if (cmd === "plugin:dialog|save") return path.join(ROOT, "链接文件.xlsx"); // 另存为：返回文件路径
  if (cmd.startsWith("plugin:dialog")) return ROOT; // 选目录：返回目录路径
  if (cmd === "scan_dir") return { type: "dir", name: path.basename(ROOT), path: args.path, children: [] };
  if (cmd === "read_file") {
    if (String(args.path).endsWith(PROJECT_DATA_FILENAME)) {
      return Array.from(new TextEncoder().encode(PROJECT_PAYLOAD));
    }
    if (args.path === LLR_PATH) return LLR_BYTES; // 低层需求 Excel
    throw new Error("ENOENT: 文件不存在"); // 导出时的同名覆盖探测走这条
  }
  if (cmd === "parse_file")
    return { functions: FUNCS, structs: [], enums: [], typedefs: [], globals: [], macros: [], constants: [], mtime: 1 };
  if (cmd === "file_mtime") return 1;
  if (cmd === "save_file") {
    savedFiles.push({ path: args.path, data: args.data });
    return null;
  }
  return null;
};

globalThis.window = new Proxy(
  {
    __TAURI_INTERNALS__: { invoke: tauriInvoke, transformCallback: () => 1, metadata: {} },
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(cb, 0),
    matchMedia: () => makeThing(),
    location: { href: "http://localhost/" },
  },
  { get: (t, k) => (k in t ? t[k] : makeThing()), set: (t, k, v) => ((t[k] = v), true) }
);
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.alert = (m) => alerts.push(String(m));
globalThis.confirm = () => true;
globalThis.getComputedStyle = () => styleStub();
process.on("unhandledRejection", (e) => rejections.push(String((e && e.message) || e)));

/* ---------- 执行 ---------- */
const bundle = fs.readdirSync(DIST).find((f) => /^index-.*\.js$/.test(f));
if (!bundle) {
  console.error("未找到 dist 产物，请先执行 npm run build");
  process.exit(2);
}
const fail = [];
console.log("[smoke] 打包产物:", bundle);

try {
  await import("file:///" + path.join(DIST, bundle).replace(/\\/g, "/"));
  console.log("[1/7] 模块顶层执行完成");
} catch (e) {
  console.log("[1/7] 模块顶层执行失败 ❌", e.constructor.name + ": " + e.message);
  process.exit(1);
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const clickBtn = (id) => {
  const fns = registry.get(id) && registry.get(id).__listeners.click;
  if (!fns || !fns.length) return false;
  for (const fn of fns) fn({});
  return true;
};
/* 点击 innerHTML 动态生成、由 JS 在重绘后绑定监听的节点（如预览区的翻页按钮） */
const clickSelector = (sel) => {
  const el = selectorRegistry.get("link-preview >> " + sel);
  const fns = el && el.__listeners.click;
  if (!fns || !fns.length) return false;
  for (const fn of fns) fn({});
  return true;
};

// 触发「点击打开项目目录」：找绑定了 click 的容器
const treeEl = [...registry.values()].find((el) => (el.__listeners.click || []).length);
if (!treeEl) {
  console.log("[2/7] 未找到打开项目的 click 监听 ❌");
  process.exit(1);
}
for (const fn of treeEl.__listeners.click) fn({ target: { closest: () => ({}) } });
await settle(400);
console.log("[2/7] 打开项目链路 → 后端调用:", [...new Set(invoked)].join(", "));
if (!invoked.includes("scan_dir")) fail.push("打开项目未触发 scan_dir");
if (!invoked.includes("parse_file")) fail.push("打开项目未解析挂载的源码文件");

console.log("[3/7] 步骤 5 按钮接线 +「未生成不可导出」守卫");
const genBound = clickBtn("link-gen-btn");
const runBound = clickBtn("link-run-btn");
await settle(80);
const xlsxWritten = () => savedFiles.filter((f) => f.path.endsWith(".xlsx"));
console.log(`  生成按钮=${genBound ? "已绑定" : "未绑定"}  导出按钮=${runBound ? "已绑定" : "未绑定"}  未生成时导出文件=${xlsxWritten().length} 个`);
if (!genBound) fail.push("link-gen-btn 未绑定 click");
if (!runBound) fail.push("link-run-btn 未绑定 click");
if (!alerts.some((a) => a.includes("请先点击「生成链接文件」"))) fail.push("导出按钮未走「未生成不可导出」守卫");
if (xlsxWritten().length) fail.push("未生成时不应导出任何 Excel");

console.log("[4/7] 生成链接文件 + 预览分页（120 个函数 → 3 页 / 3 个文件）");
const wMark = writes.length;
clickBtn("link-gen-btn");
await settle(400);
const htmlOf = (id) =>
  writes.slice(wMark).filter((w) => w.id === id).map((w) => w.value).pop() || "";
const statsHtml = htmlOf("link-stats");
const previewHtml = htmlOf("link-preview");
if (!/链接行 <b>120<\/b>/.test(statsHtml)) fail.push("统计未显示 120 行链接：" + statsHtml.slice(0, 160));
if (!/切分为 <b>3<\/b> 个文件/.test(statsHtml)) fail.push("统计未显示将切分为 3 个文件：" + statsHtml.slice(0, 160));
console.log("  统计:", statsHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());

// --- 预览分页：一页 = 一个导出文件（≤50 行数据），翻页只影响预览 ---
const rowsIn = (h) => (h.match(/<tr><td class="link-meta">/g) || []).length;
const firstInId = (h) => (/<td class="link-id">([^<]*)</.exec(h) || [])[1];
const prevDisabled = (h) => /id="link-page-prev"[^>]*disabled/.test(h);
const nextDisabled = (h) => /id="link-page-next"[^>]*disabled/.test(h);
const pageLabel = (h) => (/第 (\d+) \/ (\d+) 页/.exec(h) || []).slice(1).join("/");

console.log(`  第 1 页: ${pageLabel(previewHtml)} 行数=${rowsIn(previewHtml)} 首行链入ID=${firstInId(previewHtml)}`);
if (pageLabel(previewHtml) !== "1/3") fail.push("生成后默认不在第 1 页：" + pageLabel(previewHtml));
if (rowsIn(previewHtml) !== 50) fail.push(`第 1 页应显示 50 行数据，实际 ${rowsIn(previewHtml)} 行`);
if (firstInId(previewHtml) !== "1") fail.push("第 1 页首行链入 ID 应为 1，实际 " + firstInId(previewHtml));
if (!previewHtml.includes("第 1–50 行")) fail.push("第 1 页页脚未标出「第 1–50 行」");
if (!previewHtml.includes("链接文件_1.xlsx")) fail.push("第 1 页页脚未标出对应文件名");
if (!prevDisabled(previewHtml)) fail.push("第 1 页「上一页」未禁用");
if (nextDisabled(previewHtml)) fail.push("第 1 页「下一页」不应禁用");

if (!clickSelector("#link-page-next")) fail.push("「下一页」未绑定 click");
await settle(80);
const h2 = htmlOf("link-preview");
console.log(`  第 2 页: ${pageLabel(h2)} 行数=${rowsIn(h2)} 首行链入ID=${firstInId(h2)}`);
if (pageLabel(h2) !== "2/3") fail.push("「下一页」未切到第 2 页：" + pageLabel(h2));
if (rowsIn(h2) !== 50) fail.push(`第 2 页应显示 50 行数据，实际 ${rowsIn(h2)} 行`);
if (firstInId(h2) !== "51") fail.push("第 2 页首行链入 ID 应为 51，实际 " + firstInId(h2));
if (!h2.includes("第 51–100 行")) fail.push("第 2 页页脚未标出「第 51–100 行」");
if (prevDisabled(h2)) fail.push("第 2 页「上一页」不应禁用");

clickSelector("#link-page-next");
await settle(80);
const h3 = htmlOf("link-preview");
console.log(`  第 3 页: ${pageLabel(h3)} 行数=${rowsIn(h3)} 首行链入ID=${firstInId(h3)}`);
if (pageLabel(h3) !== "3/3") fail.push("未切到第 3 页：" + pageLabel(h3));
if (rowsIn(h3) !== 20) fail.push(`第 3 页应显示 20 行数据，实际 ${rowsIn(h3)} 行`);
if (firstInId(h3) !== "101") fail.push("第 3 页首行链入 ID 应为 101，实际 " + firstInId(h3));
if (!h3.includes("第 101–120 行")) fail.push("第 3 页页脚未标出「第 101–120 行」");
if (!nextDisabled(h3)) fail.push("末页「下一页」未禁用");

clickSelector("#link-page-prev");
await settle(80);
const h2b = htmlOf("link-preview");
console.log(`  上一页后: ${pageLabel(h2b)} 行数=${rowsIn(h2b)} 首行链入ID=${firstInId(h2b)}`);
if (pageLabel(h2b) !== "2/3") fail.push("「上一页」未回到第 2 页：" + pageLabel(h2b));
if (firstInId(h2b) !== "51") fail.push("返回第 2 页后首行链入 ID 应为 51，实际 " + firstInId(h2b));

console.log("[5/7] 导出分片：校验真实写盘字节");
clickBtn("link-run-btn");
await settle(600);
// 注意：save_file 也用于写工程数据文件（.codedocbench.json），这里只看导出的 Excel
const xlsxFiles = savedFiles.filter((f) => f.path.endsWith(".xlsx"));
const names = xlsxFiles.map((f) => path.basename(f.path));
console.log("  写出 Excel:", xlsxFiles.length, "→", names.join(", "));
if (xlsxFiles.length !== 3) fail.push(`应导出 3 个 Excel，实际 ${xlsxFiles.length} 个：${names.join(", ")}`);
if (JSON.stringify(names) !== JSON.stringify(["链接文件_1.xlsx", "链接文件_2.xlsx", "链接文件_3.xlsx"]))
  fail.push("文件名为 " + JSON.stringify(names));
// 逐文件解码：数据行数、zip 魔数、链出 ID 连续且不重复、链入 ID 已去前缀
const rowsPerFile = [];
const outIds = [];
const inIds = [];
for (const f of xlsxFiles) {
  const bytes = new Uint8Array(f.data);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail.push(`${path.basename(f.path)} 不是 zip/xlsx 字节`);
  const sheet = XLSX.read(bytes, { type: "array" }).Sheets["链接文件"];
  if (!sheet) {
    fail.push(`${path.basename(f.path)} 内无「链接文件」工作表`);
    continue;
  }
  const lastRow = XLSX.utils.decode_range(sheet["!ref"]).e.r + 1;
  rowsPerFile.push(lastRow - 2); // 去掉两行表头
  for (let r = 3; r <= lastRow; r++) {
    outIds.push(sheet["H" + r].v);
    inIds.push(sheet["D" + r].v);
  }
}
console.log("  每文件数据行数:", JSON.stringify(rowsPerFile), "| 链出 ID 共", outIds.length, "个");
if (JSON.stringify(rowsPerFile) !== JSON.stringify([50, 50, 20]))
  fail.push("每文件数据行数应为 [50,50,20]，实际 " + JSON.stringify(rowsPerFile));
if (outIds.length !== 120) fail.push(`三片合计应为 120 行，实际 ${outIds.length} 行`);
if (new Set(outIds).size !== outIds.length) fail.push("链出 ID 跨片出现重复");
if (!outIds.every((v, i) => i === 0 || v > outIds[i - 1])) fail.push("链出 ID 未保持递增（可能被重编）");
// 链入 ID：源数据带前缀 PDTMGR_LL_R_<n>，导出必须只剩数值部分
console.log("  链入 ID 前 3 个:", JSON.stringify(inIds.slice(0, 3)), "末 1 个:", JSON.stringify(inIds.slice(-1)));
if (inIds.some((v) => v == null || v === "")) fail.push("存在空的链入 ID（低层需求未关联）");
if (inIds.some((v) => String(v).includes("PDTMGR"))) fail.push("链入 ID 仍带前缀：" + JSON.stringify(inIds.filter((v) => String(v).includes("PDTMGR")).slice(0, 3)));
{
  const expect = Array.from({ length: 120 }, (_, i) => String(i + 1));
  if (JSON.stringify(inIds.map(String)) !== JSON.stringify(expect))
    fail.push("链入 ID 去前缀后应为 1..120，实际前 3 个 " + JSON.stringify(inIds.slice(0, 3)));
}
// 预览也必须同步去前缀（预览与导出同口径）
if (previewHtml.includes("PDTMGR_LL_R_")) fail.push("预览中的链入 ID 仍带前缀（预览与导出口径不一致）");
const summary = alerts.slice(-1)[0] || "";
if (!summary.includes("3 个链接文件")) fail.push("导出汇总未说明切分结果：" + summary.slice(0, 120));

console.log("[6/7] 一致性校验：按钮触发 + 面板渲染（步骤 4 主入口）");
{
  const wMark = writes.length;
  const bound = clickBtn("gen-trace-btn");
  await settle(400);
  if (!bound) fail.push("gen-trace-btn 未绑定 click");
  const panelHtml =
    writes.slice(wMark).filter((w) => w.id === "gen-trace-panel").map((w) => w.value).pop() || "";
  console.log("  面板:", panelHtml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140));
  if (!panelHtml) fail.push("点击一致性校验后面板无内容");
  // 120 个函数全部关联到需求、每条需求均被引用 → 两侧都应为 0 问题
  if (!/Source Code <b>120<\/b> 行 · Parent ID 为空 <b class="ok">0<\/b>/.test(panelHtml))
    fail.push("代码侧统计不符（应 Source Code 120 行、空 0）：" + panelHtml.slice(0, 180));
  if (!/Requirement <b>120<\/b> 行 · 未被引用 <b class="ok">0<\/b>/.test(panelHtml))
    fail.push("需求侧统计不符（应 Requirement 120 行、未被引用 0）：" + panelHtml.slice(0, 180));
  if (!panelHtml.includes("Function Definition 章")) fail.push("未按数据章节分组渲染");
  if (!panelHtml.includes("未被引用的 Requirement")) fail.push("缺少需求侧分组");
  if (!/trace-group-count ok">空 0 \/ 总 120/.test(panelHtml))
    fail.push("章节摘要未给出「空 N / 总 M」：" + panelHtml.slice(0, 200));
  if (!panelHtml.includes("全部行均已关联需求") && !panelHtml.includes("均已被代码文档引用"))
    fail.push("零问题分组未给出通过文案");
}

console.log("[7/7] 错误文案 / 未处理异常");
const bad = writes.filter((w) => /失败|Error|not defined/.test(w.value));
if (bad.length) fail.push("界面出现错误文案: " + JSON.stringify(bad));
if (rejections.length) fail.push("未处理的 Promise 异常: " + rejections.join(" | "));
console.log("  错误文案:", bad.length ? JSON.stringify(bad) : "无", "| 未处理异常:", rejections.length ? rejections.join(" | ") : "无");

if (fail.length) {
  console.log("\n结论: 冒烟失败 ❌");
  fail.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("\n结论: 冒烟通过 ✅");
