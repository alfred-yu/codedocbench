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
  const classOps = []; // classList.add/remove 调用流水，用于断言对话框的开合
  const state = { id, textContent: "", innerHTML: "", className: "", value: "", disabled: false, options: [] };
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === "addEventListener")
        return (type, fn) => (listeners[type] || (listeners[type] = [])).push(fn);
      if (k === "__listeners") return listeners;
      if (k === "__classOps") return classOps;
      if (k === "querySelector")
        return (sel) => {
          const key = id + " >> " + sel;
          if (!selectorRegistry.has(key)) selectorRegistry.set(key, makeEl(key));
          return selectorRegistry.get(key);
        };
      if (k === "style") return styleStub();
      if (k === "classList")
        return {
          add: (c) => classOps.push(["add", c]),
          remove: (c) => classOps.push(["remove", c]),
          toggle: (c) => classOps.push(["toggle", c]),
          contains: () => false,
        };
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

/* 低层需求（LLR）真实形态：ID 列带前缀 `DEMO_LL_R_<n>`。
   每个函数一个需求块（函数名行 + 一条 Requirement 行），
   用于端到端验证「链入 ID 只保留尾部数值部分」。 */
const LLR_PATH = path.join(ROOT, "Demo_LLR_Requirements.xlsx");
const LLR_HEADER = ["Requirement ID", "Section", "Title / Requirement Text", "Type"];
const LLR_AOA = [LLR_HEADER];
for (let i = 1; i <= FUNC_COUNT; i++) {
  const name = FUNCS[i - 1].name;
  LLR_AOA.push(["", `4.2.4.1.${i}`, name, ""]); // 章节/函数名边界行
  LLR_AOA.push([`DEMO_LL_R_${i}`, "", `The ${name} function shall do its job.`, "Requirement"]);
}
/* 末尾额外追加一个「不属于任何已挂载函数」的需求块，块内放 55 条 Requirement：
   这些 ID 不会出现在任何 Parent ID 中 → 视角二应逐条列出 55 条孤儿。
   条数刻意 >50：这样才能锁住「孤儿清单全量列出、不截断」（上限 50 的老实现会在这条上翻车）。
   函数名刻意不叫 fn_xxx，避免被文档树里的函数名匹配到而算作已关联。 */
const ORPHAN_COUNT = 55;
const ORPHAN_ID = (i) => `DEMO_LL_R_9${String(i).padStart(3, "0")}`;
const ORPHAN_TEXT = "The fn_not_mounted function shall be traced nowhere.";
LLR_AOA.push(["", "4.2.4.1.999", "fn_not_mounted", ""]);
for (let i = 1; i <= ORPHAN_COUNT; i++) {
  LLR_AOA.push([ORPHAN_ID(i), "", `${ORPHAN_TEXT} (#${i})`, "Requirement"]);
}
const REQ_TOTAL = FUNC_COUNT + ORPHAN_COUNT; // 175 条 Requirement（120 已关联 + 55 孤儿）
const REQ_ORPHAN_RATIO = (ORPHAN_COUNT / REQ_TOTAL) * 100; // 31.4%
const EXPECT_REQ_RATIO = REQ_ORPHAN_RATIO.toFixed(1) + "%";
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
  if (cmd === "plugin:dialog|save") {
    // 真实 plugin-dialog 把选项包在 { options } 下 invoke（见插件 dist-js index.js save()）；
    // 兼容裸传形态，按调用方默认文件名返回
    const opts = args.options || args;
    return path.join(ROOT, opts.defaultPath || "链接文件.xlsx"); // 另存为
  }
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
/* 与 clickSelector 同机制，但支持任意容器（生成预览分页器挂在 gen-preview 下） */
const clickSelectorIn = (containerId, sel) => {
  const el = selectorRegistry.get(containerId + " >> " + sel);
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
// P2 回归：LLR 恢复加载走 showRelLoading(true)→(false)，状态条提示必须在复位时清掉
// （否则「正在解析低层需求文件…」永远挂在左下角——真机曾复现）
const statusText = () => String((registry.get("status") && registry.get("status").textContent) || "");
if (statusText().includes("正在解析")) fail.push(`解析完成后状态条未复位：「${statusText()}」`);

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
// 链入 ID：源数据带前缀 DEMO_LL_R_<n>，导出必须只剩数值部分
console.log("  链入 ID 前 3 个:", JSON.stringify(inIds.slice(0, 3)), "末 1 个:", JSON.stringify(inIds.slice(-1)));
if (inIds.some((v) => v == null || v === "")) fail.push("存在空的链入 ID（低层需求未关联）");
if (inIds.some((v) => String(v).includes("DEMO_LL_R_"))) fail.push("链入 ID 仍带前缀：" + JSON.stringify(inIds.filter((v) => String(v).includes("DEMO_LL_R_")).slice(0, 3)));
{
  const expect = Array.from({ length: 120 }, (_, i) => String(i + 1));
  if (JSON.stringify(inIds.map(String)) !== JSON.stringify(expect))
    fail.push("链入 ID 去前缀后应为 1..120，实际前 3 个 " + JSON.stringify(inIds.slice(0, 3)));
}
// 预览也必须同步去前缀（预览与导出同口径）
if (previewHtml.includes("DEMO_LL_R_")) fail.push("预览中的链入 ID 仍带前缀（预览与导出口径不一致）");
const summary = alerts.slice(-1)[0] || "";
if (!summary.includes("3 个链接文件")) fail.push("导出汇总未说明切分结果：" + summary.slice(0, 120));

console.log("[6/7] 一致性检查报告导出：按钮触发 → 另存为 → Excel 内容（步骤 4 主入口）");
{
  // DOM stub 的 getElementById 永远返回对象，标记丢失不会暴露；故直接核对构建产物里的节点。
  // 结果已从对话框改为导出报告：对话框标记必须不存在，防止死节点回潮
  const distHtml = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
  if (!distHtml.includes(`id="gen-trace-btn"`)) fail.push("dist/index.html 缺少 #gen-trace-btn");
  for (const id of ["trace-dialog", "trace-dialog-close", "gen-trace-panel"])
    if (distHtml.includes(`id="${id}"`)) fail.push(`dist/index.html 仍残留对话框节点 #${id}（展示已改为导出报告）`);

  const bound = clickBtn("gen-trace-btn");
  await settle(600);
  if (!bound) fail.push("gen-trace-btn 未绑定 click");

  const reps = savedFiles.filter(
    (f) => f.path.endsWith(".xlsx") && path.basename(f.path) === "一致性检查报告.xlsx"
  );
  if (reps.length !== 1) fail.push(`应导出 1 份一致性检查报告，实际 ${reps.length}`);
  if (reps.length) {
    const bytes = new Uint8Array(reps[0].data);
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) fail.push("一致性检查报告不是 zip/xlsx 字节");
    const wb = XLSX.read(bytes, { type: "array" });
    const names = wb.SheetNames;
    if (JSON.stringify(names) !== JSON.stringify(["校验汇总", "代码侧-SourceCode明细", "需求侧-一致性明细"]))
      fail.push("报告 sheet 结构不符：" + names.join(", "));
    // 汇总页：两个视角的「分母 · 命中 · 占比」
    const sum = XLSX.utils.sheet_to_json(wb.Sheets["校验汇总"], { header: 1, defval: "" });
    const val = (label) => {
      const r = sum.find((row) => row[0] === label);
      return r ? r[1] : undefined;
    };
    if (val("Source Code 总行数") !== FUNC_COUNT) fail.push("汇总页视角一分母不符（应 " + FUNC_COUNT + "）");
    if (val("Parent ID 为空") !== 0) fail.push("汇总页视角一空值不符（应 0）");
    if (val("空值占比") !== "0.0%") fail.push("汇总页视角一占比不符（应 0.0%）");
    if (val("Requirement 总条数") !== REQ_TOTAL)
      fail.push(`汇总页视角二分母不符（应 ${REQ_TOTAL}）`);
    if (val("未被引用") !== ORPHAN_COUNT) fail.push(`汇总页视角二遗漏不符（应 ${ORPHAN_COUNT}）`);
    if (val("遗漏占比") !== EXPECT_REQ_RATIO) fail.push(`汇总页视角二占比不符（应 ${EXPECT_REQ_RATIO}）`);
    if (!String(val("结论") || "").includes(`视角二遗漏 ${ORPHAN_COUNT} 条`)) fail.push("汇总页缺少结论行");
    // 代码侧明细页：全量 Source Code 行（120 函数全关联 → 无空 Parent ID 行）
    const codeRows = XLSX.utils.sheet_to_json(wb.Sheets["代码侧-SourceCode明细"], { header: 1, defval: "" });
    if (codeRows.length !== 1 + FUNC_COUNT)
      fail.push(`代码侧明细应全量列出 ${FUNC_COUNT} 行 Source Code，实际 ${codeRows.length - 1} 行`);
    if (JSON.stringify(codeRows[0]) !== JSON.stringify(["文档序号", "章节号", "需求内容", "Parent ID"]))
      fail.push("代码侧明细表头不符：" + JSON.stringify(codeRows[0]));
    if (codeRows.slice(1).some((r) => !String(r[3] ?? "").trim()))
      fail.push("代码侧明细存在空 Parent ID 行（smoke 数据应全关联）");
    // 需求侧明细页（反向核对）：全量 175 条 Requirement（120 已引用展开 + 55 孤儿标记行，>50 防截断）
    const reqRows = XLSX.utils.sheet_to_json(wb.Sheets["需求侧-一致性明细"], { header: 1, defval: "" });
    if (JSON.stringify(reqRows[0]) !== JSON.stringify(["低层需求 ID", "低层需求内容", "引用文档序号", "引用章节号", "引用需求内容"]))
      fail.push("需求侧明细表头不符：" + JSON.stringify(reqRows[0]));
    const unref = reqRows.slice(1).filter((r) => String(r[2] ?? "") === "（未被引用）");
    if (unref.length !== ORPHAN_COUNT)
      fail.push(`需求侧明细应有 ${ORPHAN_COUNT} 条未被引用标记行，实际 ${unref.length} 条`);
    const refRowsAll = reqRows.slice(1).filter((r) => r[0] && !String(r[0]).startsWith("（无") && String(r[2] ?? "") !== "（未被引用）");
    if (refRowsAll.length !== FUNC_COUNT)
      fail.push(`需求侧明细应展开 ${FUNC_COUNT} 条引用行（1:1 关联），实际 ${refRowsAll.length} 条`);
    if (refRowsAll.some((r) => typeof r[2] !== "number" || String(r[3] ?? "") === "" || String(r[4] ?? "") === ""))
      fail.push("需求侧明细存在引用三列不齐的行：" + JSON.stringify(refRowsAll.find((r) => typeof r[2] !== "number")));
    if (String(unref[0]?.[0] ?? "") !== ORPHAN_ID(1) || unref[0]?.[1] !== `${ORPHAN_TEXT} (#1)`)
      fail.push("未被引用首条 ID/内容不符：" + JSON.stringify(unref[0]));
    if (String(unref[unref.length - 1]?.[0] ?? "") !== ORPHAN_ID(ORPHAN_COUNT))
      fail.push(`未被引用末条 ID 不符（应 ${ORPHAN_ID(ORPHAN_COUNT)}）—— 疑似截断`);
  }
  // 对话框没了，导出后的 alert 摘要是唯一的结果快照：两视角数字必须直接可见
  const lastAlert = alerts.slice(-1)[0] || "";
  if (!lastAlert.includes("已导出")) fail.push("导出后未给出提示：" + lastAlert.slice(0, 120));
  if (!lastAlert.includes(`Source Code ${FUNC_COUNT} 行中 Parent ID 为空 0 行（0.0%）`))
    fail.push("摘要缺少视角一统计：" + lastAlert.slice(0, 220));
  if (!lastAlert.includes(`Requirement ${REQ_TOTAL} 条中未被引用 ${ORPHAN_COUNT} 条（${EXPECT_REQ_RATIO}）`))
    fail.push("摘要缺少视角二统计：" + lastAlert.slice(0, 220));
  console.log("  报告已导出，摘要:", lastAlert.replace(/\n/g, " | ").slice(0, 170));
}

console.log("[7/8] 生成预览分页：进入步骤 4，断言只渲染当前页、翻页生效");
{
  // 用户操作顺序点击 stepper 解锁步骤（maxStep 闸门），最终触发 renderGenPreview
  const stepFns = registry.get("stepper") && registry.get("stepper").__listeners.click;
  const clickStep = (n) => {
    if (!stepFns || !stepFns.length) return false;
    const ev = { target: { closest: () => ({ dataset: { step: String(n) }, disabled: false }) } };
    for (const fn of stepFns) fn(ev);
    return true;
  };
  if (!clickStep(2)) fail.push("stepper 未绑定 click（无法进入步骤 4 测试）");
  await settle(40);
  clickStep(3);
  await settle(40);
  clickStep(4);
  await settle(400); // 等 renderGenPreview 的 async 刷新（refreshAllFileData / refreshLlrIfChanged）

  const genWrites = () => writes.filter((w) => w.id === "gen-preview" && w.key === "innerHTML");
  if (!genWrites().length) {
    fail.push("进入步骤 4 后 gen-preview 未渲染（renderGenPreview 可能未执行或抛错）");
  } else {
    const html = genWrites()[genWrites().length - 1].value;
    // 取 tbody 片段统计本页实际渲染的数据行数（thead 内的 <tr> 不计入）
    const tbody = (html.match(/<tbody>([\s\S]*?)<\/tbody>/) || [, ""])[1];
    const rowCount = (tbody.match(/<tr>/g) || []).length;
    const total = Number((html.match(/共 (\d+) 行/) || [, 0])[1]);
    if (rowCount === 0) fail.push("gen-preview 表格体无数据行");
    // 核心回归：单页绝不超过分页上限 100 行（原实现会一次性灌入上万行导致卡顿）
    if (rowCount > 100) fail.push(`gen-preview 单页渲染 ${rowCount} 行，超过分页上限 100（老 bug 回潮）`);
    if (total > 100 && !/id="gen-page-next"/.test(html))
      fail.push(`数据共 ${total} 行（>100）却未出现分页器`);
    if (total > 100) {
      // 翻页：点击下一页，断言表体变化、回到首页按钮可用、末页下一页禁用
      if (!clickSelectorIn("gen-preview", "#gen-page-next")) {
        fail.push("gen-page-next 未绑定 click（分页器接线失败）");
      } else {
        await settle(40);
        const html2 = genWrites()[genWrites().length - 1].value;
        const row2 = (html2.match(/<tbody>([\s\S]*?)<\/tbody>/) || [, ""])[1];
        const c2 = (row2.match(/<tr>/g) || []).length;
        if (c2 < 0) fail.push("翻页后 gen-preview 表体为空");
        if (c2 === rowCount) fail.push("翻页后渲染行数与首页相同（翻页未生效）");
        if (/id="gen-page-prev"[^>]*disabled/.test(html2))
          fail.push("翻到末页后「上一页」被错误禁用");
        if (!/id="gen-page-next"[^>]*disabled/.test(html2))
          fail.push("翻到末页后「下一页」未禁用");
      }
    }
    console.log(`  生成预览：共 ${total} 行 · 首页渲染 ${rowCount} 行 · 分页器 ${total > 100 ? "已出现" : "未出现（数据未超一页）"}`);
  }
}

console.log("[8/8] 错误文案 / 未处理异常");
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
