import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
// xlsx-js-style：SheetJS 的样式支持分支（API 兼容），用于导出时加粗标题行
import * as XLSX from "xlsx-js-style";
// 链接文件分片规则（导入系统限定单文件 ≤50 数据行）+ 链入 ID 取数值部分
import {
  LINK_MAX_ROWS,
  splitLinkRows,
  partFileNames,
  encodeLinkSheet,
  stripIdPrefix,
} from "./link-split.js";
// 一致性校验：代码文档 ↔ 低层需求的双向追溯核对（纯逻辑，可脱离界面回归）
import { auditTrace } from "./trace-check.js";
// 报告工作簿编码（ExcelJS 版：数据 sheet + 汇总页嵌入图表 PNG）
import { encodeTraceWorkbook } from "./trace-report-exceljs.js";

// 窗口标题：版本号由 Vite 从 package.json 注入（见 vite.config.js 的 define）
document.title = `CodeDocBench (Powered By 余绍健, v${__APP_VERSION__})`;

const statusEl = document.getElementById("status");
const treeContainer = document.getElementById("tree-container");
const detailPanel = document.getElementById("detail-panel");
const docPanel = document.getElementById("doc-panel");
const layout = document.getElementById("layout");
const treePanel = document.getElementById("tree-panel");
const projectBar = document.getElementById("project-bar");
const projectName = document.getElementById("project-name");

/* ---- SVG 图标（lucide 风格，统一替代 Emoji） ---- */
const svgIcon = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const ICONS = {
  folder: svgIcon(
    '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>'
  ),
  fileCode: svgIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>'
  ),
  file: svgIcon(
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'
  ),
  chevron: svgIcon('<path d="m9 18 6-6-6-6"/>'),
  empty: svgIcon(
    '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>'
  ),
};

const sbProject = document.getElementById("sb-project");

// 启动时恢复上次打开的项目：仅持久化了项目根路径指针，
// 目录树重新扫描、文档树从项目下的 .codedocbench.json 读取
try {
  const savedRoot = localStorage.getItem("lastProjectRoot");
  if (savedRoot) {
    invoke("file_mtime", { path: savedRoot })
      .then(() => doScan(savedRoot))
      .catch(() => {
        // 目录已不存在，清除持久化记录
        localStorage.removeItem("lastProjectRoot");
      });
  }
} catch (e) {
  /* 忽略 */
}

// 桌面端（Tauri）系统标题栏已含应用图标与名称，隐藏应用内品牌区；
// 同时禁用 WebView 默认右键菜单——其中的“刷新”会整页重载、丢失运行状态
if ("__TAURI_INTERNALS__" in window) {
  document.body.classList.add("in-desktop");
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

let currentSelection = null; // { type, path }
let lastTree = null; // 最近一次扫描的项目目录树
let projectRoot = null; // 当前项目的根路径（用于按项目持久化文档目录树）

// ---- 文档目录树状态 ----
let docTree = []; // { id, type:'chapter'|'file', title, path?, children:[] }
let docSelection = null; // 当前选中(挂载目标)的文档节点 id
let docEditId = null; // 正在就地编辑标题的节点 id
let mountSelection = new Set(); // 右侧勾选待挂载的项目文件路径
let docIdCounter = 1;

// 挂载后自动生成的输出子章节：.c 含 Function Definition，.h 不含
const C_FILE_SECTIONS = [
  { key: "types", title: "Type Definition" },
  { key: "globals", title: "Global Variable Definition" },
  { key: "macros", title: "Macro Definition" },
  { key: "constants", title: "Constant Definition" },
  { key: "functions", title: "Function Definition" },
];
const H_FILE_SECTIONS = C_FILE_SECTIONS.filter((s) => s.key !== "functions");

function isSourceFile(node) {
  return !!node && /\.(c|h)$/i.test(node.path || "");
}

function sectionsForFile(path) {
  return /\.h$/i.test(path || "") ? H_FILE_SECTIONS : C_FILE_SECTIONS;
}

function makeDataSections(path) {
  return sectionsForFile(path).map((s) => ({
    id: docIdCounter++,
    type: "chapter",
    title: s.title,
    isData: s.key,
    children: [],
  }));
}

// 解析结果缓存：path -> parse_file 输出
let parseCache = new Map();

const docAddBtn = document.getElementById("doc-add-btn");
const docRenameBtn = document.getElementById("doc-rename-btn");
const docDeleteBtn = document.getElementById("doc-delete-btn");
const docMountBtn = document.getElementById("doc-mount-btn");
const docClearBtn = document.getElementById("doc-clear-mount-btn");
const docExpandBtn = document.getElementById("doc-expand-btn");
const docCollapseBtn = document.getElementById("doc-collapse-btn");
const docFilterBar = document.getElementById("doc-filter-bar");
const docFilterChips = document.getElementById("doc-filter-chips");
let docFilterExt = ""; // 当前筛选的文件后缀（小写含点），空 = 显示全部
const genRunBtn = document.getElementById("gen-run-btn");
const stepperEl = document.getElementById("stepper");
const genPanel = document.getElementById("gen-panel");
const genStats = document.getElementById("gen-stats");
const genPreview = document.getElementById("gen-preview");
const genTraceBtn = document.getElementById("gen-trace-btn");
const relPanel = document.getElementById("rel-panel");
const linkPanel = document.getElementById("link-panel");

/* 仅点击「打开项目目录」引导卡片才打开目录，避免点击左栏其他区域误触 */
treeContainer.addEventListener("click", (e) => {
  if (!lastTree && e.target.closest(".open-hint")) openProject();
});

/* ---- 项目树右键菜单：刷新项目 / 关闭项目 ---- */
let ctxMenuEl = null;

function hideCtxMenu() {
  if (ctxMenuEl) {
    ctxMenuEl.remove();
    ctxMenuEl = null;
  }
}

function showCtxMenu(x, y, items) {
  hideCtxMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  for (const it of items) {
    const item = document.createElement("div");
    item.className = "ctx-item";
    const check = document.createElement("span");
    check.className = "ctx-check";
    const label = document.createElement("span");
    label.textContent = it.label;
    item.appendChild(check);
    item.appendChild(label);
    item.addEventListener("click", () => {
      hideCtxMenu();
      it.action();
    });
    menu.appendChild(item);
  }
  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 8)) + "px";
  menu.style.top = Math.max(4, Math.min(y, window.innerHeight - rect.height - 8)) + "px";
  ctxMenuEl = menu;
}

/* 重新扫描当前项目根目录，刷新目录树与解析结果 */
async function rescanProject() {
  if (!projectRoot) return;
  // 重扫可能新增/删除/修改源码文件 → 挂载文件的符号集变化 → 链接需重做
  invalidateLinkGeneration("项目已刷新");
  await doScan(projectRoot);
}

treePanel.addEventListener("contextmenu", (e) => {
  if (!lastTree) return; // 未打开项目时不弹自定义菜单
  e.preventDefault();
  showCtxMenu(e.clientX, e.clientY, [
    { label: "刷新项目", action: () => rescanProject() },
    { label: "关闭项目", action: () => closeProject() },
  ]);
});

document.addEventListener("click", hideCtxMenu);
window.addEventListener("blur", hideCtxMenu);

/* ---- 五步向导：① 选择与解析项目 → ② 构建文档目录树 → ③ 关联低层需求 → ④ 生成文档 → ⑤ 链接文件生成 ---- */
let currentStep = 1;
let maxStep = 1; // 已解锁的最远步骤（扫描成功后解锁 2）

function renderStepper() {
  stepperEl.querySelectorAll(".step-item").forEach((btn) => {
    const n = Number(btn.dataset.step);
    // 步骤 3 及之后的前置条件：文档目录树必须已创建，未创建时按钮置灰并同步状态
    btn.classList.toggle("active", n === currentStep);
    btn.classList.toggle("done", n < currentStep);
    btn.disabled = n > maxStep || (n >= 3 && !docTree.length);
    const line = btn.previousElementSibling;
    if (line && line.classList.contains("step-line")) {
      line.classList.toggle("done", n <= currentStep);
    }
  });
}

function goStep(n) {
  n = Math.min(5, Math.max(1, n));
  if (n > maxStep) return; // 未解锁的步骤不可进入
  if (n >= 3 && !docTree.length) {
    // 步骤 3 及之后的入口条件：文档目录树必须已创建（流程前置校验，而非后续页面报错）
    alert("请先在步骤 2「构建文档目录树」中添加章节");
    return;
  }
  currentStep = n;
  // 层层递进：真正到达某一步后，才解锁它的下一步（禁止跳跃）
  if (n > 1 && n >= maxStep && n < 5) maxStep = n + 1;
  layout.classList.toggle("hidden", n !== 1);
  docPanel.classList.toggle("hidden", n !== 2);
  relPanel.classList.toggle("hidden", n !== 3);
  genPanel.classList.toggle("hidden", n !== 4);
  linkPanel.classList.toggle("hidden", n !== 5);
  if (n === 2) {
    renderDocTree();
    renderDocProjectTree();
  }
  if (n === 4) renderGenPreview();
  if (n === 5) paintLinkTable();
  renderStepper();
}

stepperEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".step-item");
  if (btn && !btn.disabled) goStep(Number(btn.dataset.step));
});

genRunBtn.addEventListener("click", () => exportDocExcel());
genTraceBtn.addEventListener("click", () => exportTraceReport());

docAddBtn.addEventListener("click", () => addDocNode());
docRenameBtn.addEventListener("click", () => renameDocNode());
docDeleteBtn.addEventListener("click", () => deleteDocNode());
docMountBtn.addEventListener("click", () => mountFiles());
docClearBtn.addEventListener("click", () => {
  mountSelection.clear();
  renderDocProjectTree();
});
docExpandBtn.addEventListener("click", () => setAllDocCollapsed(false));
docCollapseBtn.addEventListener("click", () => setAllDocCollapsed(true));

/* 全部展开/折叠：仅影响有子节点的节点，状态随文档树持久化 */
function setAllDocCollapsed(collapsed) {
  const walk = (ns) =>
    ns.forEach((n) => {
      if (n.children && n.children.length) {
        n.collapsed = collapsed;
        walk(n.children);
      }
    });
  walk(docTree);
  renderDocTree();
}

/* ---- 生成页：Excel 内容预览（与导出文件同源同构） ---- */
function countDocNodes(nodes, acc) {
  for (const n of nodes) {
    if (n.type === "chapter") acc.chapters += 1;
    else acc.files += 1;
    countDocNodes(n.children || [], acc);
  }
  return acc;
}

/* 与 exportDocExcel 完全同源的行数据（章节号/需求内容/Object Type/Parent ID） */
function buildGenRows(fnIndex) {
  return collectDocRows(docTree, [], fnIndex);
}

// 生成预览分页：每页最多渲染 GEN_PAGE_SIZE 行，避免挂载上百文件时一次性将上万行
// 灌入 innerHTML 造成步骤 4 卡顿（架构与步骤 5 链接预览的分页器一致）。
const GEN_PAGE_SIZE = 100;
let genPage = 0; // 当前页（0-based）：仅影响预览、不影响导出
let genRowsCache = null; // 已构建的行数据，翻页时直接切片、无需重新解析源码

async function renderGenPreview() {
  // 先确保数据行取自最新解析结果；低层需求文件被外部修改时自动重读
  await refreshAllFileData();
  await refreshLlrIfChanged();

  const acc = countDocNodes(docTree, { chapters: 0, files: 0 });
  const llr = relRows.length
    ? `${relFileName.textContent} · ${relRows.length} 行`
    : "未关联";
  const fnNames = [...new Set(collectFunctionNames())];
  const fnIndex = buildLlrFunctionIndex(fnNames);
  const fnLinked = fnNames.filter((n) => (fnIndex.get(n) || []).length).length;
  genStats.innerHTML = [
    `<span class="gen-stat">章节 <b>${acc.chapters}</b></span>`,
    `<span class="gen-stat">挂载文件 <b>${acc.files}</b></span>`,
    `<span class="gen-stat">低层需求 <b>${escapeHtml(llr)}</b></span>`,
    relRows.length && fnNames.length
      ? `<span class="gen-stat">Parent ID 关联 <b>${fnLinked}/${fnNames.length}</b></span>`
      : "",
    relRows.length && !relColChapter.value
      ? '<span class="gen-stat warn">⚠ 未映射「章节列」，函数 Parent ID 关联可能不准</span>'
      : "",
    relRows.length && (!relColContent.value || !relColId.value)
      ? '<span class="gen-stat warn">⚠ 未映射「需求内容列/ID 列」，无法生成 Parent ID</span>'
      : "",
  ].join("");

  const rows = buildGenRows(fnIndex);
  if (!rows.length) {
    genPreview.innerHTML = '<p class="placeholder">文档目录树为空</p>';
    return;
  }
  genRowsCache = rows;
  genPage = 0; // 数据刷新后回到首页
  paintGenPreview();
}

/* 仅重绘当前页：翻页/目录树变更后调用，不重新解析源码 */
function paintGenPreview() {
  const rows = genRowsCache || [];
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / GEN_PAGE_SIZE));
  if (genPage > pageCount - 1) genPage = pageCount - 1;
  if (genPage < 0) genPage = 0;
  const start = genPage * GEN_PAGE_SIZE;
  const pageRows = rows.slice(start, start + GEN_PAGE_SIZE);

  const head = ["", "章节号", "需求内容", "Object Type", "Parent ID"]
    .map((h) => `<th>${h}</th>`)
    .join("");
  const colgroup =
    '<colgroup><col style="width:6%"><col style="width:10%"><col style="width:52%"><col style="width:14%"><col style="width:18%"></colgroup>';
  const body = pageRows
    .map((r, i) => {
      const titleCell = `<td class="${r.num !== "" ? "gen-title-cell" : ""}">${escapeHtml(r.title)}</td>`;
      // 序号列反映该行在全表中的位置（跨页连续），表头不参与编号、不写入 Excel
      return `<tr><td class="gen-idx">${start + i + 1}</td><td class="mono">${escapeHtml(r.num)}</td>${titleCell}<td>${escapeHtml(r.objectType)}</td><td class="mono">${escapeHtml(r.parent).replaceAll("\n", "<br>")}</td></tr>`;
    })
    .join("");
  const info =
    pageCount > 1
      ? `第 ${genPage + 1} / ${pageCount} 页 · 第 ${start + 1}–${start + pageRows.length} 行 / 共 ${total} 行 · 与导出的 Excel 内容一致（标题行导出时加粗）`
      : `共 ${total} 行 · 与导出的 Excel 内容一致（标题行导出时加粗）`;
  const pager =
    pageCount > 1
      ? '<span class="gen-pager">' +
        `<button id="gen-page-prev" class="btn btn-ghost btn-sm" type="button"${genPage === 0 ? " disabled" : ""}>上一页</button>` +
        `<span class="gen-page-num">${genPage + 1} / ${pageCount}</span>` +
        `<button id="gen-page-next" class="btn btn-ghost btn-sm" type="button"${genPage === pageCount - 1 ? " disabled" : ""}>下一页</button>` +
        "</span>"
      : "";
  // 表头固定、表体独立滚动（与步骤 3/5 同款布局）
  genPreview.innerHTML =
    `<div class="gen-preview-head"><table class="rel-table gen-table">${colgroup}<thead><tr>${head}</tr></thead></table></div>` +
    `<div class="gen-preview-scroll"><table class="rel-table gen-table">${colgroup}<tbody>${body}</tbody></table></div>` +
    `<div class="gen-preview-info">${info}${pager}</div>`;
  // 横向滚动时表头同步偏移，避免两区错位
  const headBox = genPreview.querySelector(".gen-preview-head");
  const scrollBox = genPreview.querySelector(".gen-preview-scroll");
  scrollBox.addEventListener("scroll", () => {
    headBox.scrollLeft = scrollBox.scrollLeft;
  });
  if (pageCount > 1) {
    genPreview
      .querySelector("#gen-page-prev")
      .addEventListener("click", () => goGenPage(genPage - 1));
    genPreview
      .querySelector("#gen-page-next")
      .addEventListener("click", () => goGenPage(genPage + 1));
  }
}

/* 翻页：只改变预览当前页，导出始终是全部行 */
function goGenPage(n) {
  const total = (genRowsCache || []).length;
  const pageCount = Math.max(1, Math.ceil(total / GEN_PAGE_SIZE));
  const next = Math.min(Math.max(n, 0), pageCount - 1);
  if (next === genPage) return;
  genPage = next;
  paintGenPreview(); // 整块重绘 → 表体自然回到顶部
}

/* ---- 一致性检查报告导出（步骤 4 主入口）：代码文档 ↔ 低层需求的双向追溯核对 ----
   与「生成并导出 Excel」同为显式触发：点击按钮才核对并导出。结果不再弹对话框展示，
   而是导出 Excel 报告（校验汇总 / 代码侧-SourceCode明细 / 需求侧-一致性明细 三个 sheet，
   明细全量不截断），导出后用 alert 给出两视角摘要。判定逻辑与工作簿编码全部在
   src/trace-check.js（纯模块），此处只负责取数与写文件。校验随项目数据即时计算、
   不持有结论状态，切换 / 关闭项目无需作废。 */
async function exportTraceReport() {
  if (!docTree.length) {
    alert("文档目录树为空，请先添加章节");
    return;
  }
  // 与文档导出同源：先确保已挂载源码的解析结果、低层需求均为最新
  await refreshAllFileData();
  await refreshLlrIfChanged();

  const fnNames = collectFunctionNames();
  const rows = collectDocRows(docTree, [], buildLlrFunctionIndex(fnNames));
  const report = auditTrace({
    rows,
    llrRows: relRows, // 模块内低层需求数据行的变量名是 relRows
    colMap: {
      id: relColId.value,
      content: relColContent.value,
      type: relColObject.value,
      chapter: relColChapter.value,
    },
    nameSet: new Set(fnNames),
  });

  const wb = await encodeTraceWorkbook(report, { generatedAt: nowText() });
  const buf = await wb.xlsx.writeBuffer();
  const bytes = new Uint8Array(buf);

  const filePath = await save({
    title: "导出一致性检查报告",
    defaultPath: "一致性检查报告.xlsx",
    filters: [{ name: "Excel 文件", extensions: ["xlsx"] }],
  });
  if (!filePath) return; // 用户取消

  try {
    await invoke("save_file", { path: filePath, data: Array.from(bytes) });
    const { code, requirement } = report;
    alert(
      `已导出：${filePath}\n\n` +
        `视角一 · 代码文档：Source Code ${code.sourceTotal} 行中 Parent ID 为空 ${code.emptyParent} 行（${formatRatio(code.emptyRatio)}）\n` +
        `视角二 · 低层需求：Requirement ${requirement.total} 条中未被引用 ${requirement.orphaned} 条（${formatRatio(requirement.orphanRatio)}）`
    );
  } catch (err) {
    alert(`导出失败：${err}`);
  }
}

/* 占比文案：数值由 src/trace-check.js 算好（分母为 0 时为 null），此处只格式化 */
function formatRatio(r) {
  return r == null ? "—" : `${(r * 100).toFixed(1)}%`;
}

/* 报告页眉用的生成时刻（本地时间，精确到分钟） */
function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---- 低层需求 Excel 加载与列选择 ---- */
const relPickBtn = document.getElementById("rel-pick-btn");
const relLoadingEl = document.getElementById("rel-loading");
const relFileName = document.getElementById("rel-file-name");
const relColChapter = document.getElementById("rel-col-chapter");
const relColId = document.getElementById("rel-col-id");
const relColContent = document.getElementById("rel-col-content");
const relColObject = document.getElementById("rel-col-object");
const relPreview = document.getElementById("rel-preview");
let relRows = []; // 低层需求数据行
let relColNames = []; // 表头列名
let relFilePath = null; // 当前关联的低层需求文件路径（随项目持久化）
let relFileMtime = null; // 关联时记录的文件 mtime，用于检测磁盘文件被外部修改

// 解析低层需求 Excel 字节为数据行。
// 优先用 Web Worker（后台线程，避免大文件冻结 UI，P2 修复）；
// 当环境无 Worker（如 Node 冒烟测试、老旧 webview）时回退主线程同步解析，保证功能不破。
async function parseLlrBytes(bytes) {
  if (typeof Worker !== "undefined") {
    return await new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(new URL("./xlsx-worker.js", import.meta.url), {
          type: "module",
        });
      } catch (e) {
        // Worker 构造失败 → 回退主线程同步解析
        const wb = XLSX.read(new Uint8Array(bytes), { type: "array" });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        return resolve(XLSX.utils.sheet_to_json(sheet, { defval: "" }));
      }
      const msgId = Date.now() + ":" + Math.random();
      const onMsg = (ev) => {
        if (!ev.data || ev.data.msgId !== msgId) return;
        worker.removeEventListener("message", onMsg);
        worker.terminate();
        if (ev.data.ok) resolve(ev.data.rows);
        else reject(new Error(ev.data.error || "解析失败"));
      };
      worker.addEventListener("message", onMsg);
      worker.onerror = (err) => {
        worker.terminate();
        reject(new Error(err.message || "Worker 解析出错"));
      };
      const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      worker.postMessage({ bytes: u8, msgId });
    });
  }
  // 回退：主线程同步解析（无 Worker 环境）
  const wb = XLSX.read(new Uint8Array(bytes), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet, { defval: "" });
}

// 解析期间的 loading 指示：旋转 spinner + 禁用按钮防重复触发 + 状态条提示（P2）
function showRelLoading(on, text) {
  if (relPickBtn) relPickBtn.disabled = on;
  if (relLoadingEl) relLoadingEl.hidden = !on;
  if (on) {
    relFileName.textContent = text || "解析中…";
    setStatus(text || "正在解析低层需求文件…", false);
  } else {
    // 置位时写进状态条的提示必须在复位时清掉，否则「正在解析…」会永远留在左下角
    setStatus("");
  }
}

async function loadLlrFile(filePath) {
  // 先取 mtime 再读内容：若两步之间文件被修改，下次新鲜度检查会再触发重读
  let mtime = null;
  try {
    mtime = await invoke("file_mtime", { path: filePath });
  } catch (e) {
    /* 浏览器 dev 环境无文件命令，退化为不检查新鲜度 */
  }
  // P2：大文件解析移到 Worker，期间给出 loading 提示并禁用按钮防重复触发
  showRelLoading(true, "正在解析低层需求文件…");
  let rows;
  try {
    const bytes = await invoke("read_file", { path: filePath });
    rows = await parseLlrBytes(bytes);
  } catch (err) {
    showRelLoading(false);
    throw err; // 交由调用方处理（rel-pick / restore / refresh 各自有 catch）
  }
  showRelLoading(false);
  if (!rows.length || typeof rows[0] !== "object") {
    throw new Error("未解析到表头与数据");
  }
  relFilePath = filePath;
  relFileMtime = mtime;
  relRows = rows;
  relColNames = Object.keys(rows[0]);
  relFileName.textContent = filePath.split(/[\\/]/).pop();
  fillRelColSelects();
  renderRelPreview();
  // 换了需求文件 → 关联到的 Parent ID 全变，链接的链入 ID 必须重算
  invalidateLinkGeneration("低层需求文件已更换");
  // 关联的文件与列映射随项目持久化
  saveDocTree();
}

relPickBtn.addEventListener("click", async () => {
  const filePath = await open({
    title: "选择低层需求 Excel",
    filters: [
      { name: "Excel 文件", extensions: ["xlsx", "xls"] },
      { name: "CSV", extensions: ["csv"] },
    ],
  });
  if (!filePath) return;
  if (typeof filePath === "object") return; // 多选未启用
  try {
    await loadLlrFile(filePath);
  } catch (err) {
    relFilePath = null;
    relRows = [];
    relColNames = [];
    relFileName.textContent = "解析失败：" + err;
    setStatus(`低层需求解析失败: ${err}`, true);
  }
});

function fillRelColSelects() {
  const opts = relColNames.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  for (const sel of [relColChapter, relColId, relColContent, relColObject]) {
    sel.innerHTML = '<option value="">（未指定）</option>' + opts;
  }
}

// 列映射变更 → 随项目持久化
for (const sel of [relColChapter, relColId, relColContent, relColObject]) {
  sel.addEventListener("change", () => {
    // 列映射决定 Parent ID（即链入 ID 的来源），改动后已生成的链接必须失效
    invalidateLinkGeneration("低层需求列映射已修改");
    saveDocTree();
  });
}

function renderRelPreview() {
  const rowCount = relRows.length;
  if (!rowCount) {
    relPreview.innerHTML = '<p class="placeholder">此文件未解析到有效数据</p>';
    return;
  }
  const head = ["No.", ...relColNames].map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = relRows
    .slice(0, 50)
    .map(
      (r, i) =>
        `<tr><td>${i + 1}</td>${relColNames
          .map((c) => `<td>${escapeHtml(String(r[c]))}</td>`)
          .join("")}</tr>`
    )
    .join("");
  // 表头与表体分属两个区域：表头固定，表体独立滚动（固定列布局保证对齐）
  const colgroup =
    '<colgroup><col style="width:48px">' +
    relColNames.map(() => "<col>").join("") +
    "</colgroup>";
  relPreview.innerHTML = `
    <div class="rel-preview-info">共 ${rowCount} 行数据 · 预览前 50 行</div>
    <div class="rel-preview-head"><table class="rel-table">${colgroup}<thead><tr>${head}</tr></thead></table></div>
    <div class="rel-preview-scroll"><table class="rel-table">${colgroup}<tbody>${body}</tbody></table></div>`;
}

// 点击文档目录树的空白区域 → 取消选中
const docTreeContainer = document.getElementById("doc-tree-container");
docTreeContainer.addEventListener("click", (e) => {
  if (e.target.closest(".node-row")) return;
  if (docSelection !== null) {
    docSelection = null;
    renderDocTree();
  }
});

// 左右分栏宽度拖拽调整
makeSplitter(document.getElementById("split-home"), document.getElementById("tree-panel"), document.getElementById("layout"));
makeSplitter(document.getElementById("split-doc"), document.getElementById("doc-tree-panel"), document.getElementById("doc-body"));

// 弹出原生目录选择对话框；选择后自动扫描解析
async function openProject() {
  try {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择 C 项目目录",
    });
    if (!dir) return; // 用户取消
    await doScan(dir);
  } catch (err) {
    setStatus(`选择目录失败: ${err}`, true);
  }
}

// 关闭当前项目：清空扫描结果、解析缓存与文档树，回到初始引导状态
function closeProject() {
  flushPendingDocTreeSave();
  lastTree = null;
  projectRoot = null;
  currentSelection = null;
  parseCache.clear();
  docTree = [];
  docSelection = null;
  docEditId = null;
  mountSelection.clear();
  resetLlrState();
  resetLinkGeneration(); // 与低层需求同步复位：关闭项目后步骤 5 回到未生成状态
  try {
    // 仅清除"上次项目"指针；文档树在项目目录的 .codedocbench.json 中保留，
    // 重新打开同一项目时自动恢复
    localStorage.removeItem("lastProjectRoot");
  } catch (e) {
    /* 忽略 */
  }
  if (sbProject) sbProject.textContent = "";
  projectBar.classList.add("hidden");
  setStatus("已关闭项目");
  renderTreePlaceholder();
  renderDetailPlaceholder();
  maxStep = 1;
  goStep(1);
}

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", isError);
}

/* 分栏宽度拖拽：handle 为分隔条，leftPane 为左侧当前要调宽的容器，container 为二者父容器 */
function makeSplitter(handle, leftPane, container) {
  if (!handle || !leftPane || !container) return;
  let dragging = false;
  handle.addEventListener("pointerdown", (e) => {
    dragging = true;
    handle.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    handle.classList.add("dragging");
    e.preventDefault();
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = container.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const clamp = Math.min(0.6, Math.max(0.15, pct));
    leftPane.style.width = `calc(${(clamp * 100).toFixed(2)}% - 3px)`;
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture(e.pointerId);
    document.body.style.userSelect = "";
    document.body.style.cursor = "";
    handle.classList.remove("dragging");
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

async function doScan(dir) {
  if (!dir) return;
  flushPendingDocTreeSave();
  setStatus("正在扫描…");
  try {
    const tree = await invoke("scan_dir", { path: dir });
    if (tree.type === "error") {
      setStatus(tree.message, true);
      if (sbProject) sbProject.textContent = "";
      renderTreePlaceholder();
      renderDetailPlaceholder();
      return;
    }
    setStatus("");
    lastTree = tree;
    projectRoot = normProjectPath(dir);
    localStorage.setItem("lastProjectRoot", projectRoot);
    if (sbProject) sbProject.textContent = dir;
    if (projectName) {
      projectName.textContent = dir.split(/[\\/]/).pop() || dir;
      projectName.title = dir;
    }
    if (projectBar) projectBar.classList.remove("hidden");
    // 解析成功 → 仅解锁步骤 2，后续步骤需逐级到达后解锁
    maxStep = 2;
    renderStepper();
    await loadDocTree();
    renderTree(tree);
  } catch (err) {
    setStatus(`扫描失败: ${err}`, true);
    if (sbProject) sbProject.textContent = "";
    renderTreePlaceholder();
  }
}

/* ---------------- 目录树 ---------------- */
function renderTreePlaceholder() {
  treeContainer.innerHTML =
    '<div id="open-hint" class="open-hint" title="点击选择 C 项目根目录">' +
    '<span class="brand-logo" aria-hidden="true">' + ICONS.fileCode + "</span>" +
    '<p class="open-hint-title">打开项目目录</p>' +
    '<p class="open-hint-sub">点击此处选择 C 项目根目录<br>将自动扫描并解析目录结构</p>' +
    "</div>";
}

/* ================= 文档目录树（左） ================= */
function renderDocTree() {
  // 目录树增删会实时改变步骤 4 的进入条件，同步刷新导航状态
  renderStepper();
  const container = document.getElementById("doc-tree-container");
  container.innerHTML = "";
  if (!docTree.length) {
    container.innerHTML = `<p class="placeholder">${ICONS.empty}点击「章节」添加文档节点</p>`;
    return;
  }
  const rootEl = document.createElement("ul");
  rootEl.className = "tree root";
  let chapterIdx = 0;
  for (const node of docTree) {
    if (node.type === "chapter") {
      chapterIdx += 1;
      rootEl.appendChild(buildChapterNode(node, [chapterIdx]));
    } else {
      rootEl.appendChild(buildFileNode(node));
    }
  }
  container.appendChild(rootEl);
  saveDocTree();
}

/* ---- 文档目录树持久化（存于项目根目录下的 .codedocbench.json） ---- */
function normProjectPath(p) {
  return String(p).trim().replace(/[\\/]+$/, "");
}

const PROJECT_DATA_FILENAME = ".codedocbench.json";
let pendingDocTreeSave = null; // { root, payload }：防抖期间待写盘的数据
let docTreeSaveTimer = null;
let storageWarned = false;

function projectDataFilePath(root) {
  return root + (root.includes("\\") ? "\\" : "/") + PROJECT_DATA_FILENAME;
}

function buildProjectDataPayload() {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    docTree,
    llr: relFilePath
      ? {
          path: relFilePath,
          mapping: {
            chapter: relColChapter.value,
            id: relColId.value,
            content: relColContent.value,
            objectType: relColObject.value,
          },
        }
      : null,
    link: linkCfg(),
  });
}

/* 恢复/重置低层需求关联（文件路径 + 列映射，随项目持久化） */
function resetLlrState() {
  relFilePath = null;
  relFileMtime = null;
  relRows = [];
  relColNames = [];
  relFileName.textContent = "未选择文件";
  for (const sel of [relColChapter, relColId, relColContent, relColObject]) {
    sel.innerHTML = "<option>请先选择文件</option>";
  }
  relPreview.innerHTML = '<p class="placeholder">选择低层需求 Excel 后在此预览</p>';
}

async function restoreLlr(llr) {
  if (!llr || !llr.path) {
    resetLlrState();
    return;
  }
  try {
    await loadLlrFile(llr.path);
  } catch (e) {
    // 低层需求文件被移动/删除时不阻断项目恢复，回退到未选择状态
    console.warn("恢复低层需求关联失败:", e);
    resetLlrState();
    return;
  }
  // 恢复列映射：列名在当前文件表头中不存在时明确提示，避免静默失效
  const invalid = applyRelMapping(llr.mapping || {});
  if (invalid.length) {
    relFileName.textContent += `（注意：列映射已失效：${invalid.join("、")}，请重新映射）`;
  }
  saveDocTree();
}

/* 应用列映射：仅当列名仍存在于当前文件表头时生效，返回失效映射的描述列表 */
function applyRelMapping(m) {
  const invalid = [];
  const apply = (sel, key, label) => {
    const v = m[key];
    if (!v) return;
    if ([...sel.options].some((o) => o.value === v)) {
      sel.value = v;
    } else {
      invalid.push(`「${label}」列「${v}」`);
    }
  };
  apply(relColChapter, "chapter", "章节");
  apply(relColId, "id", "ID");
  apply(relColContent, "content", "需求内容");
  apply(relColObject, "objectType", "Object Type");
  return invalid;
}

/* 低层需求文件新鲜度：磁盘文件被外部修改后自动重读（尽量保持列映射），
   避免预览/导出基于陈旧数据计算 Parent ID。返回是否发生了重读 */
async function refreshLlrIfChanged() {
  if (!relFilePath || !relRows.length || relFileMtime === null) return false;
  let mtime = null;
  try {
    mtime = await invoke("file_mtime", { path: relFilePath });
  } catch (e) {
    return false; // 无法获取 mtime 时不做检查
  }
  if (mtime === relFileMtime) return false;
  const mapping = {
    chapter: relColChapter.value,
    id: relColId.value,
    content: relColContent.value,
    objectType: relColObject.value,
  };
  try {
    await loadLlrFile(relFilePath);
  } catch (e) {
    // 文件暂时不可读（被移动/占用）：保留已加载数据继续，仅提示
    setStatus(`低层需求文件重读失败，使用已加载数据：${e}`, true);
    return false;
  }
  const invalid = applyRelMapping(mapping);
  if (invalid.length) {
    relFileName.textContent += `（注意：原列映射已失效：${invalid.join("、")}，请重新映射）`;
  }
  // 外部修改被重读 → 需求内容与 ID 集合可能变化 → 链接需重做
  invalidateLinkGeneration("低层需求文件已被外部修改");
  saveDocTree();
  return true;
}

/* 从项目文件读取文档树；旧版本数据存于 localStorage，桌面端首次打开时自动迁移 */
async function loadDocTree() {
  if (!projectRoot) {
    docTree = [];
    docIdCounter = 1;
    return;
  }
  docTree = [];
  let savedLlr = null;
  let savedLink = null;
  let legacyData = null;
  try {
    const bytes = await invoke("read_file", { path: projectDataFilePath(projectRoot) });
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
    if (Array.isArray(parsed.docTree)) docTree = parsed.docTree;
    savedLlr = parsed.llr || null;
    savedLink = parsed.link || null;
  } catch {
    // 项目文件不存在或不可读：回退读取旧版 localStorage 数据
    try {
      const raw = localStorage.getItem("docTree:" + projectRoot);
      if (raw) {
        const legacy = JSON.parse(raw);
        if (Array.isArray(legacy)) legacyData = legacy;
        else if (legacy && Array.isArray(legacy.docTree)) {
          legacyData = legacy.docTree;
          savedLlr = legacy.llr || null;
          savedLink = legacy.link || null;
        }
      }
    } catch {
      /* 忽略 */
    }
  }
  if (legacyData) {
    docTree = legacyData;
    // 桌面端：迁移到项目文件后清除旧键；浏览器演示模式保留
    if ("__TAURI_INTERNALS__" in window) {
      try {
        localStorage.removeItem("docTree:" + projectRoot);
      } catch (e) {
        /* 忽略 */
      }
      pendingDocTreeSave = { root: projectRoot, payload: buildProjectDataPayload() };
      writeProjectDocTreeNow();
    }
  }
  if (!Array.isArray(docTree)) docTree = [];
  let maxId = 0;
  const walk = (ns) =>
    ns.forEach((n) => {
      if (n.id > maxId) maxId = n.id;
      walk(n.children || []);
    });
  walk(docTree);
  docIdCounter = maxId + 1;
  renderDocTree();
  refreshAllFileData();
  restoreLlr(savedLlr);
  restoreLink(savedLink);
  // 刷新项目场景下失效原因依然成立（rescanProject 先 invalidate 再走到这里），保留之；
  // 首次打开项目时本就无失效原因，保留空串等于清空，行为一致。
  resetLinkGeneration(true);
}

/* 树变更后防抖写回项目文件，避免频繁编辑时反复落盘 */
function saveDocTree() {
  if (!projectRoot) return;
  // 浏览器演示模式没有文件系统，退回 localStorage
  if (!("__TAURI_INTERNALS__" in window)) {
    try {
      localStorage.setItem("docTree:" + projectRoot, buildProjectDataPayload());
    } catch (e) {
      /* 存储超限等情况静默忽略 */
    }
    return;
  }
  pendingDocTreeSave = { root: projectRoot, payload: buildProjectDataPayload() };
  clearTimeout(docTreeSaveTimer);
  docTreeSaveTimer = setTimeout(writeProjectDocTreeNow, 300);
}

async function writeProjectDocTreeNow() {
  clearTimeout(docTreeSaveTimer);
  const pending = pendingDocTreeSave;
  pendingDocTreeSave = null;
  if (!pending) return;
  try {
    const bytes = Array.from(new TextEncoder().encode(pending.payload));
    await invoke("save_file", { path: projectDataFilePath(pending.root), data: bytes });
  } catch (e) {
    // 项目目录只读等场景：本次会话内文档树仍可用，仅提示一次
    if (!storageWarned) {
      storageWarned = true;
      setStatus("项目目录不可写，文档树仅保存在当前会话中", true);
    }
    console.warn("文档树写入项目文件失败:", e);
  }
}

// 切换/关闭项目前把待写数据落到磁盘，避免数据滞留内存
function flushPendingDocTreeSave() {
  if (pendingDocTreeSave) writeProjectDocTreeNow();
}

window.addEventListener("beforeunload", flushPendingDocTreeSave);

/* ---- C 文件解析缓存与数据行提取 ----
   缓存条目带文件 mtime：文件被外部修改后自动重新解析，避免使用陈旧数据 */
async function ensureParsed(path) {
  let mtime = null;
  try {
    mtime = await invoke("file_mtime", { path });
  } catch (e) {
    /* 获取时间失败（如浏览器 dev 环境）则退化为仅会话内缓存 */
  }
  const cached = parseCache.get(path);
  if (cached && cached.mtime !== null && cached.mtime === mtime) {
    return cached.data;
  }
  try {
    const res = await invoke("parse_file", { path });
    parseCache.set(path, { mtime: res.mtime ?? mtime, data: res });
    return res;
  } catch (e) {
    const empty = {
      functions: [], structs: [], enums: [], typedefs: [],
      globals: [], macros: [], constants: [], mtime,
    };
    parseCache.set(path, { mtime, data: empty });
    return empty;
  }
}

// 带并发上限的批量映射：避免对大量文件同时发起请求导致资源风暴。
// 即使 daemon 失效并回退到单次子进程调用，也不会一次性拉起 N 个进程。
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (cursor < items.length) {
        const idx = cursor++;
        results[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function dataSectionNames(res, key) {
  if (!res || res.type === "error") return [];
  const byKey = {
    types: [...(res.typedefs || []), ...(res.structs || []), ...(res.enums || [])],
    globals: res.globals || [],
    macros: res.macros || [],
    constants: res.constants || [],
    // 函数章只收定义：同文件的原型与 extern 引用（isDefinition=false）不算本文件的函数，
    // 否则会与定义所在文件重复出文档（声明经 #include 进来的本就不在解析结果里）
    functions: (res.functions || []).filter(
      (f) => !(f && typeof f === "object" && f.isDefinition === false)
    ),
  };
  return (byKey[key] || [])
    .map((x) => (x && typeof x === "object" ? x.name : x))
    .filter(Boolean);
}

// 为文档树中所有已挂载的源码文件解析数据并刷新显示
async function refreshAllFileData() {
  const paths = [];
  const walk = (ns) =>
    ns.forEach((n) => {
      if (isSourceFile(n)) {
        paths.push(n.path);
        // 兼容旧数据：数据子章节缺失或与该后缀的期望结构不一致时重建
        //（.c 应为 5 章，.h 应为 4 章且不含 Function Definition）
        const expected = sectionsForFile(n.path).map((s) => s.key);
        const actual = (n.children || []).filter((c) => c.isData).map((c) => c.isData);
        const matches =
          actual.length === expected.length &&
          expected.every((k, i) => actual[i] === k);
        if (!matches) {
          n.children = makeDataSections(n.path);
        }
      }
      if (n.children) walk(n.children);
    });
  walk(docTree);
  // 并发上限 16：daemon 内部 8 worker 并发，前端限 16 路双保险，杜绝进程风暴
  await mapWithConcurrency(paths, 16, (p) => ensureParsed(p));
  renderDocTree();
}

function buildChapterNode(node, nums) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "node-row doc" + (node.id === docSelection ? " selected" : "");

  // 折叠箭头：点击切换展开/折叠（状态存于节点上，随文档树持久化）
  const twisty = document.createElement("span");
  twisty.className = "twisty" + (node.collapsed ? "" : " open");
  twisty.title = node.collapsed ? "展开" : "折叠";
  twisty.innerHTML = ICONS.chevron;
  twisty.addEventListener("click", (e) => {
    e.stopPropagation();
    node.collapsed = !node.collapsed;
    renderDocTree();
  });
  row.appendChild(twisty);

  const num = document.createElement("span");
  num.className = "doc-num";
  num.textContent = nums.join(".") + ".";

  row.appendChild(num);

  if (node.id === docEditId) {
    row.appendChild(makeEditInput(node));
  } else {
    const name = document.createElement("span");
    name.className = "name";
    name.title = node.title;
    name.textContent = node.title;

    const addBtn = document.createElement("button");
    addBtn.className = "mini-btn";
    addBtn.textContent = "＋";
    addBtn.title = "添加子章节";
    addBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addSubChapter(node);
    });

    const penBtn = document.createElement("button");
    penBtn.className = "mini-btn";
    penBtn.textContent = "✎";
    penBtn.title = "就地重命名";
    penBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startInlineEdit(node);
    });

    row.appendChild(name);
    row.appendChild(addBtn);
    row.appendChild(penBtn);
    row.addEventListener("dblclick", () => startInlineEdit(node));
    row.addEventListener("click", () => {
      docSelection = node.id;
      renderDocTree();
    });
  }
  li.appendChild(row);

  // 子节点：章节与挂载文件统一连续编号；折叠时整体隐藏
  if (node.children.length) {
    const ul = document.createElement("ul");
    ul.className = "tree" + (node.collapsed ? " hidden" : "");
    let childIdx = 0;
    for (const child of node.children) {
      childIdx += 1;
      if (child.type === "chapter") {
        ul.appendChild(buildChapterNode(child, nums.concat(childIdx)));
      } else {
        ul.appendChild(buildFileNode(child, nums.concat(childIdx)));
      }
    }
    li.appendChild(ul);
  }
  return li;
}

function buildFileNode(node, nums) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "node-row doc" + (node.id === docSelection ? " selected" : "");

  // 挂载的 .c 文件带有 5 个数据子章节，提供折叠箭头；普通文件仅占位对齐
  const hasChildren = isSourceFile(node) && node.children.length;
  const twisty = document.createElement("span");
  twisty.className = "twisty" + (hasChildren && !node.collapsed ? " open" : "");
  if (hasChildren) {
    twisty.title = node.collapsed ? "展开" : "折叠";
    twisty.innerHTML = ICONS.chevron;
    twisty.addEventListener("click", (e) => {
      e.stopPropagation();
      node.collapsed = !node.collapsed;
      renderDocTree();
    });
  }
  row.appendChild(twisty);

  if (nums) {
    const num = document.createElement("span");
    num.className = "doc-num";
    num.textContent = nums.join(".") + ".";
    row.appendChild(num);
  }

  const tag = document.createElement("span");
  tag.className = "file-tag";
  tag.textContent = "文件";

  row.appendChild(tag);

  if (node.id === docEditId) {
    row.appendChild(makeEditInput(node));
  } else {
    const name = document.createElement("span");
    name.className = "name";
    name.title = node.path || node.title;
    name.textContent = node.title;

    const removeBtn = document.createElement("button");
    removeBtn.className = "mini-btn";
    removeBtn.textContent = "✕";
    removeBtn.title = "移除该文件的挂载";
    removeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      removeDocNode(docTree, node.id);
      if (docSelection === node.id) docSelection = null;
      renderDocTree();
    });

    row.appendChild(name);
    row.appendChild(removeBtn);
    row.addEventListener("dblclick", () => startInlineEdit(node));
    row.addEventListener("click", () => {
      docSelection = node.id;
      renderDocTree();
    });
  }
  li.appendChild(row);

  // .c 文件：渲染自动生成的 5 个数据子章节及其数据行（随文件节点折叠）
  if (hasChildren) {
    const ul = document.createElement("ul");
    ul.className = "tree" + (node.collapsed ? " hidden" : "");
    let childIdx = 0;
    for (const child of node.children) {
      childIdx += 1;
      const secLi = buildChapterNode(child, (nums || []).concat(childIdx));
      const dnames = dataSectionNames(parseCache.get(node.path)?.data, child.isData);
      const items = dnames.length ? dnames : ["N/A"];
      const dul = document.createElement("ul");
      dul.className = "tree data" + (child.collapsed ? " hidden" : "");
      for (const it of items) {
        const dli = document.createElement("li");
        dli.className = "data-row" + (dnames.length ? "" : " empty");
        dli.textContent = it;
        dul.appendChild(dli);
      }
      secLi.appendChild(dul);
      ul.appendChild(secLi);
    }
    li.appendChild(ul);
  }
  return li;
}

function makeEditInput(node) {
  const input = document.createElement("input");
  input.type = "text";
  input.id = "doc-edit-input";
  input.className = "doc-edit-input";
  input.value = node.title;
  input.placeholder = node.type === "chapter" ? "章节标题…" : "名称…";
  input.spellcheck = false;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitDocEdit(node, input.value, false);
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitDocEdit(node, "", true);
    }
  });
  input.addEventListener("blur", () => commitDocEdit(node, input.value, false));
  return input;
}

function focusDocEditInput() {
  requestAnimationFrame(() => {
    const input = document.getElementById("doc-edit-input");
    if (input) {
      input.focus();
      input.select();
    }
  });
}

function startInlineEdit(node) {
  docSelection = node.id;
  docEditId = node.id;
  renderDocTree();
  focusDocEditInput();
}

function commitDocEdit(node, value, cancelled) {
  if (docEditId !== node.id) return;
  if (cancelled) {
    if (!node.title.trim()) removeDocNode(docTree, node.id);
  } else {
    node.title = value.trim() || "未命名章节";
  }
  docEditId = null;
  // 新增/重命名/取消新增都会改变导出行（章节号与符号行位置随之变化），已生成的链接需重做
  invalidateLinkGeneration("文档目录树已修改");
  renderDocTree();
}

function findDocNode(nodes, id) {
  for (const n of nodes) {
    if (n.id === id) return n;
    const r = findDocNode(n.children, id);
    if (r) return r;
  }
  return null;
}

function findParentArray(nodes, id) {
  for (const n of nodes) {
    if (n.children.some((c) => c.id === id)) return n.children;
    const r = findParentArray(n.children, id);
    if (r) return r;
  }
  return docTree;
}

function removeDocNode(nodes, id) {
  const idx = nodes.findIndex((n) => n.id === id);
  if (idx >= 0) {
    nodes.splice(idx, 1);
    return;
  }
  nodes.forEach((n) => removeDocNode(n.children, id));
}

function addDocNode() {
  const node = { id: docIdCounter++, type: "chapter", title: "", children: [] };
  if (!docSelection) {
    // 未选中任何节点 → 添加一级标题
    docTree.push(node);
  } else {
    const parent = findDocNode(docTree, docSelection);
    if (parent && parent.type === "chapter") {
      parent.children.push(node);
    } else {
      findParentArray(docTree, docSelection).push(node);
    }
  }
  startInlineEdit(node);
}

function addSubChapter(parent) {
  const node = { id: docIdCounter++, type: "chapter", title: "", children: [] };
  parent.children.push(node);
  startInlineEdit(node);
}

function renameDocNode() {
  const node = findDocNode(docTree, docSelection);
  if (!node) {
    alert("请先在左侧选择一个文档节点");
    return;
  }
  startInlineEdit(node);
}

function deleteDocNode() {
  const node = findDocNode(docTree, docSelection);
  if (!node) {
    alert("请先在左侧选择一个文档节点");
    return;
  }
  if (!confirm(`删除「${node.title}」及其子节点？`)) return;
  removeDocNode(docTree, docSelection);
  docSelection = null;
  invalidateLinkGeneration("文档目录树已修改");
  renderDocTree();
}

function mountFiles() {
  if (!docSelection) {
    alert("请先在左侧选择一个文档节点作为挂载目标");
    return;
  }
  const names = [...mountSelection];
  if (!names.length) {
    alert("请先在右侧勾选要挂载的项目文件");
    return;
  }
  const target = findDocNode(docTree, docSelection);
  if (!target) return;
  const existing = new Set(
    target.children.filter((c) => c.type === "file").map((c) => c.path)
  );
  const creates = [];
  for (const p of names) {
    if (existing.has(p)) continue;
    const fname = p.split(/[\\/]/).pop();
    // .c 生成 5 个数据子章节，.h 生成 4 个（不含 Function Definition），其余文件无
    const children = isSourceFile({ path: p }) ? makeDataSections(p) : [];
    creates.push({ path: p, node: {
      id: docIdCounter++,
      type: "file",
      title: fname,
      path: p,
      children,
    } });
  }
  for (const c of creates) target.children.push(c.node);
  mountSelection.clear();
  if (creates.length) invalidateLinkGeneration("文档目录树已修改");
  renderDocTree();
  renderDocProjectTree();
  if (creates.length) {
    // 异步解析数据后刷新数据行，挂载结果直接反映在文档树中，不再弹窗提示
    Promise.all(creates.filter((c2) => isSourceFile(c2.node)).map((c2) => ensureParsed(c2.path))).then(() => renderDocTree());
  } else {
    alert("这些文件已在该节点下");
  }
}

/* ---- 导出代码文档 Excel（章节号 / 需求内容 / Object Type / Parent ID） ----

   Parent ID 关联规则（参考 Demo_LLR_Requirements.xlsx）：
   低层需求文档中"文档编号到函数名为止"——需求内容列的值恰为函数名的行是函数名行，
   其后直到下一个函数名行之前的所有行是该函数的需求内容行；
   函数符号行的 Parent ID = 这些需求内容行的 ID 列值集合（换行分隔），
   并排除 Object Type 为 Comment 的行；未关联低层需求或匹配不到时为空。 */

/* 收集文档树中全部函数符号名及其所在文件（用于匹配与同名歧义检查） */
function collectFunctionNameFiles() {
  const map = new Map(); // 函数名 -> 所在文件标题集合
  const walk = (ns) =>
    ns.forEach((n) => {
      if (n.type === "file" && isSourceFile(n)) {
        (n.children || []).forEach((sec) => {
          if (sec.isData === "functions") {
            for (const name of dataSectionNames(parseCache.get(n.path)?.data, "functions")) {
              if (!map.has(name)) map.set(name, new Set());
              map.get(name).add(n.title);
            }
          }
        });
      }
      walk(n.children || []);
    });
  walk(docTree);
  return map;
}

/* 收集文档树中全部函数符号名（用于与低层需求文档的需求内容列做整行匹配） */
function collectFunctionNames() {
  return [...collectFunctionNameFiles().keys()];
}

/* 建立函数名 → 需求内容行 ID 列表的索引 */
function buildLlrFunctionIndex(functionNames) {
  const index = new Map();
  const contentCol = relColContent.value;
  const idCol = relColId.value;
  const typeCol = relColObject.value;
  const chapterCol = relColChapter.value;
  if (!contentCol || !idCol || !relRows.length || !functionNames.length) {
    return index;
  }
  const nameSet = new Set(functionNames);
  let current = null;
  for (const r of relRows) {
    const content = String(r[contentCol] ?? "").trim();
    const chapter = chapterCol ? String(r[chapterCol] ?? "").trim() : "";
    // 标题行边界：章节列非空（文档编号到符号名为止），或内容恰为已解析的函数名。
    // 章节标题对应的符号即使不在代码树中，也同样终止上一个函数的需求块。
    if ((chapterCol && chapter) || nameSet.has(content)) {
      current = nameSet.has(content) ? [] : null;
      if (current) index.set(content, current);
      continue; // 函数名行自身不计入需求内容行
    }
    if (!current) continue;
    const type = typeCol ? String(r[typeCol] ?? "").trim().toLowerCase() : "";
    if (type === "comment") continue; // 排除 Comment 行
    const id = String(r[idCol] ?? "").trim();
    if (id) current.push(id);
  }
  return index;
}

/* 扫描低层需求行（与 buildLlrFunctionIndex 相同的边界规则）：
   统计每个函数的需求块数量，并找出未关联到文档树函数的需求块 */
function scanLlrBlocks(nameSet) {
  const contentCol = relColContent.value;
  const idCol = relColId.value;
  const typeCol = relColObject.value;
  const chapterCol = relColChapter.value;
  const blockCounts = new Map(); // 函数名 -> 需求块数量
  const uncovered = []; // { title, reqCount }
  let current = null; // { known, title, reqCount }
  const closeBlock = () => {
    if (current && !current.known && current.reqCount > 0) uncovered.push(current);
  };
  for (const r of relRows) {
    const content = String(r[contentCol] ?? "").trim();
    const chapter = chapterCol ? String(r[chapterCol] ?? "").trim() : "";
    if ((chapterCol && chapter) || nameSet.has(content)) {
      closeBlock();
      const known = nameSet.has(content);
      if (known) blockCounts.set(content, (blockCounts.get(content) || 0) + 1);
      current = { known, title: `${chapter} ${content}`.trim(), reqCount: 0 };
      continue;
    }
    if (!current) continue;
    const type = typeCol ? String(r[typeCol] ?? "").trim().toLowerCase() : "";
    if (type === "comment") continue;
    if (String(r[idCol] ?? "").trim()) current.reqCount += 1;
  }
  closeBlock();
  return { blockCounts, uncovered };
}

function collectDocRows(nodes, nums, fnIndex) {
  const rows = [];
  let idx = 0;
  for (const node of nodes) {
    idx += 1;
    const num = nums.concat(idx).join(".");
    // 挂载的源码文件：输出文件行 + 数据子章节行 + 数据行（.c 5 章 / .h 4 章）
    if (node.type === "file" && isSourceFile(node)) {
      rows.push({ num, title: node.title, objectType: "", parent: "" });
      let sIdx = 0;
      for (const sec of node.children) {
        sIdx += 1;
        const snum = `${num}.${sIdx}`;
        // 数据子章节标题行：标题不参与 Object Type
        rows.push({ num: snum, title: sec.title, objectType: "", parent: "" });
        const names = dataSectionNames(parseCache.get(node.path)?.data, sec.isData);
        const fromSource = names.length > 0;
        const items = fromSource ? names : ["N/A"];
        // 数据行：不参与编号。Object Type 口径：仅全局变量与函数章视为 Source Code，
        // 其余数据章（Type / Macro / Constant）即使解析自源码也按 Comment 处理；N/A 占位恒为 Comment
        for (const it of items) {
          let rowParent = "";
          if (sec.isData === "functions" && fromSource && fnIndex) {
            const ids = fnIndex.get(it);
            if (ids && ids.length) rowParent = ids.join("\n");
          }
          rows.push({
            num: "",
            title: it,
            objectType:
              fromSource && (sec.isData === "globals" || sec.isData === "functions")
                ? "Source Code"
                : "Comment",
            parent: rowParent,
            // 一致性校验按数据章节分组统计空 Parent ID，需带上归属（导出/链接表只取前 4 个字段，不受影响）
            sectionKey: sec.isData,
            sectionTitle: sec.title,
          });
        }
      }
      continue;
    }
    // 普通节点行：标题不参与 Object Type；Parent ID 仅供函数行关联低层需求，其余为空
    rows.push({ num, title: node.title, objectType: "", parent: "" });
    if (node.children.length) {
      rows.push(...collectDocRows(node.children, nums.concat(idx), fnIndex));
    }
  }
  return rows;
}

/* Parent ID 关联校验（与导出行数据同源）：
   ID 存在性、函数覆盖、同名歧义、低层需求侧需求块覆盖，问题汇总为可确认的告警 */
function collectParentIdWarnings(fnIndex, rows) {
  if (!relRows.length) return [];
  const warnings = [];
  const contentCol = relColContent.value;
  const idCol = relColId.value;

  // 列映射缺失：Parent ID 必然为空，明确提示而非静默导出
  if (!contentCol || !idCol) {
    const missing = [!contentCol && "需求内容列", !idCol && "ID 列"].filter(Boolean).join("、");
    warnings.push(`低层需求未映射「${missing}」，所有函数的 Parent ID 将为空`);
    return warnings;
  }
  if (!relColChapter.value) {
    warnings.push("低层需求未映射「章节列」，函数 Parent ID 的关联边界可能不准确");
  }

  // 1) 行数据中的每个 Parent ID 都必须存在于低层需求 ID 列
  const idSet = new Set(relRows.map((r) => String(r[idCol] ?? "").trim()).filter(Boolean));
  for (const r of rows) {
    if (!r.parent) continue;
    for (const id of r.parent.split("\n")) {
      if (!idSet.has(id)) {
        warnings.push(`函数「${r.title}」的 Parent ID「${id}」未在低层需求 ID 列中找到`);
      }
    }
  }

  // 2)/3) 文档树侧：未关联到任何需求的函数；跨文件同名函数将得到相同的 Parent ID
  const nameFiles = collectFunctionNameFiles();
  for (const [name, files] of nameFiles) {
    if (!(fnIndex.get(name) || []).length) {
      warnings.push(`函数「${name}」（${[...files].join("、")}）未关联到低层需求，Parent ID 将为空`);
    }
    if (files.size > 1) {
      warnings.push(`函数「${name}」在多个文件中同名（${[...files].join("、")}），这些行将关联到相同的 Parent ID`);
    }
  }

  // 4) 低层需求侧：同名函数块后者覆盖前者；未关联到文档树任何函数的需求块
  const { blockCounts, uncovered } = scanLlrBlocks(new Set(nameFiles.keys()));
  for (const [name, count] of blockCounts) {
    if (count > 1) {
      warnings.push(`低层需求中函数「${name}」出现 ${count} 个需求块，导出采用最后一个块`);
    }
  }
  for (const b of uncovered) {
    warnings.push(`低层需求「${b.title}」下的 ${b.reqCount} 行需求未关联到文档树中的任何函数`);
  }
  return warnings;
}

/* ---- 导出前一致性自检：行号越界 / 重复符号 ----
   利用后端输出的 lineCount 与行号做廉价校验，异常时提示用户而非静默导出 */
function collectParseWarnings() {
  const warnings = [];
  const cats = (res) => [
    ["函数", res.functions, (it) => (it.isDefinition ? "def" : "decl")],
    ["全局变量", res.globals, () => ""],
    ["宏定义", res.macros, () => ""],
    ["常量", res.constants, () => ""],
    ["typedef", res.typedefs, () => ""],
    ["结构体", res.structs, () => ""],
    ["枚举", res.enums, () => ""],
  ];
  const walk = (ns) =>
    ns.forEach((n) => {
      if (isSourceFile(n)) {
        const res = parseCache.get(n.path)?.data;
        if (res && res.type !== "error") {
          const lineCount = res.lineCount;
          for (const [label, items, kindOf] of cats(res)) {
            const seen = new Map();
            for (const it of items || []) {
              if (Number.isFinite(lineCount) && Number.isFinite(it.line) && it.line > lineCount) {
                warnings.push(
                  `${n.title}：${label}「${it.name}」行号 ${it.line} 超出文件总行数 ${lineCount}`
                );
              }
              const key = it.name + kindOf(it);
              if (seen.has(key)) {
                warnings.push(
                  `${n.title}：${label}「${it.name}」疑似重复（行 ${seen.get(key)} 与 ${it.line}）`
                );
              } else {
                seen.set(key, it.line);
              }
            }
          }
        }
      }
      walk(n.children || []);
    });
  walk(docTree);
  return warnings;
}

async function exportDocExcel() {
  if (!docTree.length) {
    alert("文档目录树为空，请先添加章节");
    return;
  }
  // 先确保所有挂载的 .c 文件已解析、低层需求为最新，再构建导出行数据
  await refreshAllFileData();
  await refreshLlrIfChanged();

  const fnIndex = buildLlrFunctionIndex(collectFunctionNames());
  const rows = collectDocRows(docTree, [], fnIndex);

  // 一致性自检：解析异常 + Parent ID 关联校验（与导出行数据同源），异常时由用户确认后再导出
  const warnings = [...collectParseWarnings(), ...collectParentIdWarnings(fnIndex, rows)];
  if (warnings.length) {
    const preview = warnings.slice(0, 5).join("\n");
    const more = warnings.length > 5 ? `\n……共 ${warnings.length} 处` : "";
    if (!confirm(`导出自检发现 ${warnings.length} 处异常：\n${preview}${more}\n\n仍要继续导出吗？`)) {
      return;
    }
  }

  const data = rows.map((r) => ({
    章节号: r.num,
    需求内容: r.title,
    "Object Type": r.objectType,
    "Parent ID": r.parent,
  }));
  const ws = XLSX.utils.json_to_sheet(data, {
    header: ["章节号", "需求内容", "Object Type", "Parent ID"],
  });
  ws["!cols"] = [{ wch: 12 }, { wch: 60 }, { wch: 14 }, { wch: 16 }];
  // 标题行（有章节号的行：章节/文件/数据子章节标题）的需求内容单元格加粗
  rows.forEach((r, i) => {
    if (r.num !== "") {
      const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 1 })];
      if (cell) cell.s = { font: { bold: true } };
    }
    // 多个 Parent ID 以换行分隔，开启自动换行以在 Excel 中逐行显示
    if (String(r.parent).includes("\n")) {
      const pCell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 3 })];
      if (pCell) pCell.s = { alignment: { wrapText: true, vertical: "top" } };
    }
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "代码文档");
  const b64 = XLSX.write(wb, { bookType: "xlsx", type: "base64" });
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const filePath = await save({
    title: "导出代码文档",
    defaultPath: "代码文档.xlsx",
    filters: [{ name: "Excel 文件", extensions: ["xlsx"] }],
  });
  if (!filePath) return; // 用户取消

  try {
    await invoke("save_file", { path: filePath, data: Array.from(bytes) });
    alert(`已导出：${filePath}`);
  } catch (err) {
    alert(`导出失败：${err}`);
  }
}

/* ================= 步骤 5：链接文件生成 =================
   链接关系表：链出 = Code 文档，链入 = 低层需求。
   - 行范围：生成文档页中 Object Type 为 Source Code 的行（由源码解析出的符号行）
   - 链出 ID：该行在生成文档页「序号」列的值（序号列即为此索引引入）
   - 链入 ID：该行的 Parent ID，按 `_` 切分后取最后一段（数值部分），不假定固定前缀；
     一个符号关联多个需求 ID 时拆成多行，各自成一条链接
   - 链入/链出的项目名称、模块名称、模块路径均由用户输入，逐行填同一组值
   - 分片：导入系统限定单个链接文件最多 LINK_MAX_ROWS 行数据，超出按行序切分为多个文件
     （切分规则与矩阵构造见 src/link-split.js，便于脱离界面回归） */

const linkInProject = document.getElementById("link-in-project");
const linkInModule = document.getElementById("link-in-module");
const linkInPath = document.getElementById("link-in-path");
const linkOutProject = document.getElementById("link-out-project");
const linkOutModule = document.getElementById("link-out-module");
const linkOutPath = document.getElementById("link-out-path");
const linkStats = document.getElementById("link-stats");
const linkPreviewEl = document.getElementById("link-preview");
const linkRunBtn = document.getElementById("link-run-btn");
const linkGenBtn = document.getElementById("link-gen-btn");

/* 用户输入的链入/链出元信息（随项目持久化） */
function linkCfg() {
  return {
    inProject: linkInProject.value.trim(),
    inModule: linkInModule.value.trim(),
    inPath: linkInPath.value.trim(),
    outProject: linkOutProject.value.trim(),
    outModule: linkOutModule.value.trim(),
    outPath: linkOutPath.value.trim(),
  };
}

function restoreLink(link) {
  const c = link || {};
  linkInProject.value = c.inProject || "";
  linkInModule.value = c.inModule || "";
  linkInPath.value = c.inPath || "";
  linkOutProject.value = c.outProject || "";
  linkOutModule.value = c.outModule || "";
  linkOutPath.value = c.outPath || "";
}

let linkRows = []; // 链接行：{ outId, inId }
let linkSourceCount = 0; // Source Code 行数（链接来源记录数）
let linkLinkedCount = 0; // 其中已关联到需求的符号数
let linkGenerated = false; // 是否已由「生成链接文件」按钮触发过生成（未生成时预览只给提示、不可导出）
let linkPage = 0; // 预览当前页（0-based）：一页 = 一个导出文件（≤ LINK_MAX_ROWS 行数据），仅影响预览、不影响导出
/* 上次生成结果失效的原因（空串=无失效）。写进预览区而非只靠状态栏：
   状态栏是瞬时的，会被「正在扫描…」「正在解析低层需求文件…」等进度文案整条覆盖掉
   （刷新项目时 invalidate → doScan → loadDocTree → loadLlrFile 连续写状态栏），
   用户点完只会看到进度，看不到「为什么链接没了」。预览区是常驻的，且紧挨着生成按钮。 */
let linkInvalidReason = "";
const LINK_FILE_BASE = "链接文件"; // 分片文件名前缀（单片导出时由用户在「另存为」对话框里自定文件名）

/* 构建链接行：与生成文档页同源（collectDocRows），保证 ID 口径一致 */
function buildLinkRows(fnIndex) {
  const rows = collectDocRows(docTree, [], fnIndex);
  const out = [];
  let sourceCount = 0;
  let linkedCount = 0;
  rows.forEach((r, i) => {
    if (r.objectType !== "Source Code") return; // 仅源码符号行
    sourceCount += 1;
    const outId = i + 1; // 生成文档页序号列的值（该行在整张文档表中的位置）
    const ids = String(r.parent || "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (ids.length) linkedCount += 1;
    // 多个需求 ID 拆成多行：链出索引相同，链入 ID 各占一行；
    // 链入 ID 只保留数值部分（按 `_` 切分取最后一段；前缀形态不固定）
    for (const inId of ids.length ? ids : [""]) {
      out.push({ outId, inId: stripIdPrefix(inId) });
    }
  });
  return { rows: out, sourceCount, linkedCount };
}

function linkColgroup() {
  const widths = [150, 135, 215, 70, 150, 135, 215, 70];
  return `<colgroup>${widths.map((w) => `<col style="width:${w}px">`).join("")}</colgroup>`;
}

/* 仅按当前输入与已构建数据重绘（输入元信息时无需重新解析源码） */
function paintLinkTable() {
  if (!linkGenerated) {
    // 未生成：只提示下一步操作，不渲染任何链接数据（生成必须由按钮显式触发）
    linkStats.innerHTML = "";
    linkPreviewEl.innerHTML = linkInvalidReason
      ? `<p class="placeholder placeholder-warn">${escapeHtml(
          linkInvalidReason
        )}，链接文件需重新点击「生成链接文件」</p>`
      : '<p class="placeholder">填写链入/链出信息后，点击「生成链接文件」</p>';
    return;
  }
  const cfg = linkCfg();
  // 分片：导入系统限定单文件 ≤ LINK_MAX_ROWS 行数据，预览与导出用同一份切分结果
  const parts = splitLinkRows(linkRows, LINK_MAX_ROWS);
  const partNames = partFileNames(LINK_FILE_BASE, parts.length);
  linkStats.innerHTML = [
    `<span class="gen-stat">链出记录（Source Code 行）<b>${linkSourceCount}</b></span>`,
    `<span class="gen-stat">链接行 <b>${linkRows.length}</b></span>`,
    `<span class="gen-stat">已关联需求 <b>${linkLinkedCount}/${linkSourceCount}</b></span>`,
    parts.length > 1
      ? `<span class="gen-stat">超出单文件 ${LINK_MAX_ROWS} 行上限，将切分为 <b>${parts.length}</b> 个文件</span>`
      : "",
    linkSourceCount && !linkLinkedCount
      ? '<span class="gen-stat warn">⚠ 尚未关联低层需求，链入 ID 将为空</span>'
      : "",
  ].join("");

  if (!linkRows.length) {
    linkPreviewEl.innerHTML =
      '<p class="placeholder">文档目录树中暂无 Source Code 行（请先在步骤 2 挂载 .c/.h 文件）</p>';
    return;
  }
  // 分页：一页 = 一个导出文件（≤ LINK_MAX_ROWS 行数据），与导出共用同一份切分结果
  const pageCount = parts.length;
  // 页码夹取：重新生成 / 切换项目后行数变化，旧页码可能越界
  if (linkPage > pageCount - 1) linkPage = pageCount - 1;
  if (linkPage < 0) linkPage = 0;
  const part = parts[linkPage];
  const from = linkPage * LINK_MAX_ROWS + 1;
  const to = from + part.length - 1;

  const cols = linkColgroup();
  const fields = ["项目名称", "模块名称", "模块路径", "ID"];
  const head =
    '<thead><tr><th class="link-group" colspan="4">链入</th>' +
    '<th class="link-group" colspan="4">链出</th></tr>' +
    `<tr>${fields.concat(fields).map((h) => `<th>${h}</th>`).join("")}</tr></thead>`;
  const rowHtml = (r) =>
    `<tr><td class="link-meta">${escapeHtml(cfg.inProject)}</td>` +
    `<td class="link-meta">${escapeHtml(cfg.inModule)}</td>` +
    `<td class="link-meta">${escapeHtml(cfg.inPath)}</td>` +
    `<td class="link-id">${escapeHtml(r.inId)}</td>` +
    `<td class="link-meta">${escapeHtml(cfg.outProject)}</td>` +
    `<td class="link-meta">${escapeHtml(cfg.outModule)}</td>` +
    `<td class="link-meta">${escapeHtml(cfg.outPath)}</td>` +
    `<td class="link-id">${r.outId}</td></tr>`;
  const body = part.map(rowHtml).join("");
  // 页脚 = 当前页 ↔ 导出文件 ↔ 行区间的对应关系；多页时并排给出翻页控件
  const info =
    pageCount > 1
      ? `第 ${linkPage + 1} / ${pageCount} 页 · ${escapeHtml(partNames[linkPage])} · 第 ${from}–${to} 行 · 与导出的 Excel 内容一致`
      : `共 ${linkRows.length} 行 · 与导出的 Excel 内容一致`;
  const pager =
    pageCount > 1
      ? '<span class="link-pager">' +
        `<button id="link-page-prev" class="btn btn-ghost btn-sm" type="button"${
          linkPage === 0 ? " disabled" : ""
        }>上一页</button>` +
        `<span class="link-page-num">${linkPage + 1} / ${pageCount}</span>` +
        `<button id="link-page-next" class="btn btn-ghost btn-sm" type="button"${
          linkPage === pageCount - 1 ? " disabled" : ""
        }>下一页</button>` +
        "</span>"
      : "";
  // 表头与表体分属两个区域：表头固定、表体独立纵向滚动（与步骤 3/4 同款布局）
  linkPreviewEl.innerHTML =
    `<div class="rel-preview-head"><table class="rel-table link-table">${cols}${head}</table></div>` +
    `<div class="rel-preview-scroll"><table class="rel-table link-table">${cols}<tbody>${body}</tbody></table></div>` +
    `<div class="rel-preview-info link-preview-info"><span class="link-page-info">${info}</span>${pager}</div>`;
  // 宽表横向滚动时表头同步偏移，避免两区错位
  const headBox = linkPreviewEl.querySelector(".rel-preview-head");
  const scrollBox = linkPreviewEl.querySelector(".rel-preview-scroll");
  scrollBox.addEventListener("scroll", () => {
    headBox.scrollLeft = scrollBox.scrollLeft;
  });
  if (pageCount > 1) {
    linkPreviewEl
      .querySelector("#link-page-prev")
      .addEventListener("click", () => goLinkPage(linkPage - 1));
    linkPreviewEl
      .querySelector("#link-page-next")
      .addEventListener("click", () => goLinkPage(linkPage + 1));
  }
}

/* 翻页：只改变预览当前页，导出始终是全部页（全部文件） */
function goLinkPage(n) {
  const pageCount = Math.max(1, Math.ceil(linkRows.length / LINK_MAX_ROWS));
  const next = Math.min(Math.max(n, 0), pageCount - 1);
  if (next === linkPage) return;
  linkPage = next;
  paintLinkTable(); // 整块重绘 → 表体自然回到顶部
}

/* 生成链接文件：唯一入口是「生成链接文件」按钮
   - 前置校验：文档目录树非空，且链入/链出 6 项均已填写
   - 数据行取自最新解析结果；低层需求被外部修改时自动重读 */
async function generateLink() {
  if (!docTree.length) {
    alert("文档目录树为空，请先构建文档目录树");
    return;
  }
  const cfg = linkCfg();
  const missing = [
    ["链入-项目名称", cfg.inProject],
    ["链入-模块名称", cfg.inModule],
    ["链入-模块路径", cfg.inPath],
    ["链出-项目名称", cfg.outProject],
    ["链出-模块名称", cfg.outModule],
    ["链出-模块路径", cfg.outPath],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length) {
    alert("请先填写完整的链入/链出信息：\n" + missing.join("、"));
    return;
  }
  await refreshAllFileData();
  await refreshLlrIfChanged();
  const fnIndex = buildLlrFunctionIndex(collectFunctionNames());
  const built = buildLinkRows(fnIndex);
  linkRows = built.rows;
  linkSourceCount = built.sourceCount;
  linkLinkedCount = built.linkedCount;
  linkGenerated = true;
  linkInvalidReason = ""; // 已按最新上游数据重算，失效原因随之作废
  linkPage = 0; // 重新生成后回到第 1 页
  linkRunBtn.disabled = false;
  linkRunBtn.removeAttribute("title");
  paintLinkTable();
}

/* 回到「未生成」状态，需重新点击按钮生成。
   keepReason=true 时保留上一次的失效原因（刷新项目会经 loadDocTree 复位，
   但失效原因在复位之后依然成立，不能被顺手抹掉）。 */
function resetLinkGeneration(keepReason) {
  linkRows = [];
  linkSourceCount = 0;
  linkLinkedCount = 0;
  linkGenerated = false;
  linkPage = 0;
  if (!keepReason) linkInvalidReason = "";
  linkRunBtn.disabled = true;
  linkRunBtn.title = "请先点击「生成链接文件」";
  paintLinkTable();
}

/* 步骤 5 结果的失效判定
   —— 链接行只依赖三样东西：文档目录树结构、挂载文件的解析结果、低层需求数据（含列映射）。
      任一变化都会让上次生成的结果过期，而用户看到的是「预览还在、导出也能点」，
      于是会静默导出过期数据。故上游变更时主动复位（预览明确回到未生成态），
      导出前再核一次签名兜底（源码被外部程序修改这类不经过交互的路径）。
   reason 写进预览区（常驻，必被看到）；状态栏只做即时提示，会被后续进度文案覆盖。
   未生成时静默返回，避免无谓的重绘与提示噪音。 */
function invalidateLinkGeneration(reason) {
  if (!linkGenerated) return;
  linkInvalidReason = reason || "上游数据已变更";
  resetLinkGeneration(true);
  if (reason) setStatus(`${reason}，链接文件需重新生成`);
}

/* 导出前兜底核验：重算链接行与生成时比对，不一致说明上游数据在生成之后被改动过。
   源码重解析（mtime 变化、刷新项目）与低层需求外部修改都不经过界面交互，
   只能在这里拦住。返回 true 表示仍与生成时一致。 */
async function linkRowsUpToDate() {
  await refreshAllFileData();
  await refreshLlrIfChanged();
  const fnIndex = buildLlrFunctionIndex(collectFunctionNames());
  const rebuilt = buildLinkRows(fnIndex);
  if (JSON.stringify(rebuilt.rows) === JSON.stringify(linkRows)) return true;
  invalidateLinkGeneration("文档目录树、源码或低层需求在生成之后发生了变化");
  return false;
}

/* 多片导出时的文件名前缀在链接状态区声明（LINK_FILE_BASE） */

/* 目录 + 文件名拼接（分隔符沿用路径自身的风格，与 projectDataFilePath 一致） */
function joinPath(dir, name) {
  return dir.replace(/[\\/]+$/, "") + (dir.includes("\\") ? "\\" : "/") + name;
}

/* 目标文件是否已存在：save_file 直接覆盖，多片导出走「选目录」没有原生覆盖确认，需自行探测 */
async function fileExists(path) {
  try {
    await invoke("read_file", { path });
    return true;
  } catch {
    return false;
  }
}

/* 导出链接文件：链入（项目名称/模块名称/模块路径/ID）+ 链出（同 4 列），双行表头。
   导入系统限定单个链接文件最多 LINK_MAX_ROWS 行数据，超出自动切分为多个文件：
   - 单文件：沿用「另存为」对话框（可自定文件名与位置）
   - 多文件：选择导出目录，批量写出 链接文件_1..N.xlsx（多文件不适用单文件对话框语义）
   链出 ID 保持「生成文档页序号列」的原值，分片不重编，跨片仍可回查源文档。 */
async function exportLinkExcel() {
  // 导出内容即预览内容：未生成时不允许导出，避免导出未经确认的数据
  if (!linkGenerated) {
    alert("请先点击「生成链接文件」生成链接文件后再导出");
    return;
  }
  // 兜底核验：源码被外部程序改动、或低层需求文件被外部修改（两者都不经过界面交互，
  // 拿不到 invalidateLinkGeneration 的钩子）都可能让上次生成的结果过期。
  // 重算比对不一致就复位并中止，绝不静默导出过期数据。
  if (!(await linkRowsUpToDate())) {
    alert("文档目录树、源码或低层需求在生成之后发生了变化，链接文件已失效。\n请重新点击「生成链接文件」后再导出。");
    return;
  }
  if (!linkRows.length) {
    alert("没有可导出的链接记录：文档目录树中暂无 Source Code 行");
    return;
  }
  const unlinked = linkSourceCount - linkLinkedCount;
  if (unlinked > 0) {
    const ok = confirm(
      `有 ${unlinked} 个符号行未关联到低层需求，这些行的链入 ID 为空。\n是否继续导出？`
    );
    if (!ok) return;
  }

  const cfg = linkCfg();
  const parts = splitLinkRows(linkRows, LINK_MAX_ROWS);
  const names = partFileNames(LINK_FILE_BASE, parts.length);

  let targets;
  if (parts.length > 1) {
    const dir = await open({
      directory: true,
      multiple: false,
      title: `选择链接文件导出目录（共 ${parts.length} 个文件）`,
    });
    if (!dir) return; // 用户取消
    targets = names.map((n) => joinPath(dir, n));
  } else {
    const filePath = await save({
      title: "导出链接文件",
      defaultPath: names[0],
      filters: [{ name: "Excel 文件", extensions: ["xlsx"] }],
    });
    if (!filePath) return; // 用户取消
    targets = [filePath];
  }

  if (targets.length > 1) {
    const exist = [];
    for (const p of targets) {
      if (await fileExists(p)) exist.push(p);
    }
    if (exist.length) {
      const ok = confirm(
        `导出目录下已有 ${exist.length} 个同名文件，继续将覆盖：\n` +
          exist.map((p) => p.split(/[\\/]/).pop()).join("\n")
      );
      if (!ok) return;
    }
  }

  const written = [];
  const failed = [];
  let cursor = 1; // 该片首行在整个链接表中的行号（用于导出后汇报行区间）
  for (let i = 0; i < parts.length; i++) {
    const from = cursor;
    const to = cursor + parts[i].length - 1;
    cursor = to + 1;
    try {
      const bytes = encodeLinkSheet(parts[i], cfg, XLSX);
      await invoke("save_file", { path: targets[i], data: Array.from(bytes) });
      written.push({ path: targets[i], from, to });
    } catch (err) {
      failed.push(`${targets[i]}：${err}`);
    }
  }

  if (failed.length) {
    alert(
      `导出未全部完成：成功 ${written.length}/${parts.length} 个文件\n` +
        `失败：\n${failed.join("\n")}`
    );
    return;
  }
  if (parts.length > 1) {
    alert(
      `已按每文件 ${LINK_MAX_ROWS} 行上限切分，导出 ${parts.length} 个链接文件（共 ${linkRows.length} 行）：\n` +
        written.map((w) => `${w.path}（第 ${w.from}–${w.to} 行）`).join("\n")
    );
  } else {
    alert(`已导出：${written[0].path}`);
  }
}

// 输入变更：随项目持久化；已生成时同步刷新预览中的元信息列（无需重新解析源码）
// 链接行只依赖文档目录树，与元信息无关，故改元信息不会让已生成的结果失效
for (const el of [
  linkInProject, linkInModule, linkInPath,
  linkOutProject, linkOutModule, linkOutPath,
]) {
  el.addEventListener("input", () => {
    saveDocTree();
    if (currentStep === 5) paintLinkTable();
  });
}
linkGenBtn.addEventListener("click", () => generateLink());
linkRunBtn.addEventListener("click", () => exportLinkExcel());

/* ================= 项目文件目录树（右，可勾选挂载） ================= */

function fileExt(name) {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i).toLowerCase() : "";
}

/* 统计项目中各后缀的文件数，用于生成筛选 chip */
function collectExtCounts() {
  const counts = new Map();
  let total = 0;
  const walk = (n) => {
    if (n.type === "file") {
      total += 1;
      const e = fileExt(n.name);
      counts.set(e, (counts.get(e) || 0) + 1);
    } else {
      (n.children || []).forEach(walk);
    }
  };
  if (lastTree) walk(lastTree);
  return { counts: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])), total };
}

/* 筛选条：全部 / 各后缀 chip（带数量）+ 勾选筛选结果按钮 */
function renderDocFilterBar() {
  if (!lastTree) {
    docFilterBar.classList.add("hidden");
    return;
  }
  docFilterBar.classList.remove("hidden");
  const { counts, total } = collectExtCounts();
  docFilterChips.innerHTML = "";
  const mkChip = (label, ext, count) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "filter-chip" + (docFilterExt === ext ? " active" : "");
    b.title = ext ? `只显示 ${ext} 文件` : "显示全部文件";
    b.innerHTML = `${escapeHtml(label)}<span class="count">${count}</span>`;
    b.addEventListener("click", () => {
      docFilterExt = docFilterExt === ext ? "" : ext;
      renderDocProjectTree();
    });
    docFilterChips.appendChild(b);
  };
  mkChip("全部", "", total);
  counts.forEach(([ext, count]) => mkChip(ext || "(无后缀)", ext, count));
}

/* 深拷贝视图：筛选模式下剔除没有任何匹配文件的目录分支 */
function subtreeHasMatch(node) {
  if (node.type === "file") {
    return !docFilterExt || fileExt(node.name) === docFilterExt;
  }
  return (node.children || []).some(subtreeHasMatch);
}

function filteredTreeView(node) {
  if (!docFilterExt || node.type === "file") return node;
  return {
    ...node,
    children: (node.children || []).filter(subtreeHasMatch).map(filteredTreeView),
  };
}

/* 收集某节点下全部子孙文件路径（目录勾选时批量加入/移出勾选集合） */
function collectFilePaths(node) {
  const paths = [];
  const walk = (n) => {
    if (n.type === "file") {
      paths.push(n.path);
    } else {
      (n.children || []).forEach(walk);
    }
  };
  walk(node);
  return paths;
}

/* 按已渲染 DOM 同步各级祖先目录复选框的全选/半选状态（不重建树，保留展开状态） */
function refreshAncestorChecks(li) {
  let p = li.parentElement ? li.parentElement.closest("li") : null;
  while (p) {
    const dirCb = p.querySelector(":scope > .node-row input[type=checkbox]");
    if (dirCb) {
      const boxes = p.querySelectorAll("ul input[type=checkbox]");
      let total = 0;
      let selected = 0;
      boxes.forEach((b) => {
        total += 1;
        if (b.checked) selected += 1;
      });
      dirCb.checked = total > 0 && selected === total;
      dirCb.indeterminate = selected > 0 && selected < total;
    }
    p = p.parentElement.closest("li");
  }
}

function buildMountNode(node) {
  const li = document.createElement("li");
  if (node.type === "dir") {
    const row = document.createElement("div");
    row.className = "node-row dir";

    // 目录复选框：勾选即全选/取消其下所有文件；半选表示部分勾选
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.title = "勾选目录下全部文件";
    cb.addEventListener("click", (e) => e.stopPropagation()); // 不触发折叠
    cb.addEventListener("change", () => {
      collectFilePaths(node).forEach((p) =>
        cb.checked ? mountSelection.add(p) : mountSelection.delete(p)
      );
      li.querySelectorAll("ul input[type=checkbox]").forEach((el) => {
        el.checked = cb.checked;
        el.indeterminate = false;
      });
      refreshAncestorChecks(li);
    });

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.innerHTML = ICONS.chevron;
    const icon = document.createElement("span");
    icon.className = "icon dir";
    icon.innerHTML = ICONS.folder;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;
    row.appendChild(cb);
    row.appendChild(twisty);
    row.appendChild(icon);
    row.appendChild(name);

    const childrenUl = document.createElement("ul");
    childrenUl.className = "tree";
    node.children.forEach((c) => childrenUl.appendChild(buildMountNode(c)));

    row.addEventListener("click", () => {
      const collapsed = childrenUl.classList.toggle("hidden");
      twisty.classList.toggle("open", !collapsed);
    });

    li.appendChild(row);
    li.appendChild(childrenUl);
  } else {
    const row = document.createElement("div");
    row.className = "node-row file";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = mountSelection.has(node.path);
    cb.addEventListener("change", () => {
      if (cb.checked) mountSelection.add(node.path);
      else mountSelection.delete(node.path);
      refreshAncestorChecks(li);
    });
    const icon = document.createElement("span");
    icon.className = "icon file";
    icon.innerHTML = ICONS.file;
    const name = document.createElement("span");
    name.className = "name";
    name.title = node.path;
    name.textContent = node.name;
    row.appendChild(cb);
    row.appendChild(icon);
    row.appendChild(name);
    li.appendChild(row);
  }
  return li;
}

function renderDocProjectTree() {
  const container = document.getElementById("doc-project-tree");
  container.innerHTML = "";
  renderDocFilterBar();
  if (!lastTree) {
    container.innerHTML = `<p class="placeholder">${ICONS.empty}请在主页扫描项目目录后再次进入</p>`;
    return;
  }
  const rootEl = document.createElement("ul");
  rootEl.className = "tree root";
  rootEl.appendChild(buildMountNode(filteredTreeView(lastTree)));
  container.appendChild(rootEl);
}

function renderTree(node) {
  treeContainer.innerHTML = "";
  const rootEl = document.createElement("ul");
  rootEl.className = "tree root";
  rootEl.appendChild(buildNode(node));
  treeContainer.appendChild(rootEl);
}

function buildNode(node) {
  const li = document.createElement("li");

  if (node.type === "dir") {
    const row = document.createElement("div");
    row.className = "node-row dir";

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.innerHTML = ICONS.chevron;

    const icon = document.createElement("span");
    icon.className = "icon dir";
    icon.innerHTML = ICONS.folder;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;

    row.appendChild(twisty);
    row.appendChild(icon);
    row.appendChild(name);

    const childCount = node.children.length;
    if (childCount) {
      const count = document.createElement("span");
      count.className = "count";
      count.textContent = String(childCount);
      row.appendChild(count);
    }

    const childrenUl = document.createElement("ul");
    childrenUl.className = "tree";
    node.children.forEach((c) => childrenUl.appendChild(buildNode(c)));

    row.addEventListener("click", () => {
      const collapsed = childrenUl.classList.toggle("hidden");
      twisty.classList.toggle("open", !collapsed);
    });

    li.appendChild(row);
    li.appendChild(childrenUl);
  } else {
    const row = document.createElement("div");
    row.className = "node-row file";
    if (!node.parsable) row.style.opacity = "0.55";

    const twisty = document.createElement("span");
    twisty.className = "twisty";

    const icon = document.createElement("span");
    icon.className = "icon " + (node.parsable ? "code" : "file");
    icon.innerHTML = node.parsable ? ICONS.fileCode : ICONS.file;

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;

    row.appendChild(twisty);
    row.appendChild(icon);
    row.appendChild(name);

    if (node.parsable) {
      row.addEventListener("click", () => {
        document
          .querySelectorAll(".node-row.selected")
          .forEach((el) => el.classList.remove("selected"));
        row.classList.add("selected");
        currentSelection = { type: "file", path: node.path };
        loadFile(node.path, node.name);
      });
    }
    li.appendChild(row);
  }
  return li;
}

/* ---------------- 详情区域 ---------------- */
function renderDetailPlaceholder() {
  detailPanel.innerHTML = `<div class="detail-empty">${ICONS.empty}<p>在左侧选择 <code>.c</code>/<code>.h</code> 文件以查看解析结果</p></div>`;
}

async function loadFile(path, name) {
  detailPanel.innerHTML = '<div class="detail-empty"><p>正在解析…</p></div>';
  try {
    const data = await invoke("parse_file", { path });
    if (data.type === "error") {
      detailPanel.innerHTML = `<div class="detail-empty"><p class="status error">${escapeHtml(data.message)}</p></div>`;
      return;
    }
    renderDetail(data, name, path);
  } catch (err) {
    detailPanel.innerHTML = `<div class="detail-empty"><p class="status error">解析失败: ${escapeHtml(String(err))}</p></div>`;
  }
}

function renderDetail(data, name, path) {
  const container = document.createElement("div");

  // 文件头卡片
  const head = document.createElement("div");
  head.className = "detail-head";
  const headIcon = document.createElement("span");
  headIcon.className = "head-icon";
  headIcon.innerHTML = ICONS.fileCode;
  const headText = document.createElement("div");
  headText.className = "head-text";
  const hName = document.createElement("h2");
  hName.className = "detail-panel-title";
  hName.textContent = name;
  const hPath = document.createElement("p");
  hPath.className = "detail-path";
  hPath.textContent = path;
  headText.appendChild(hName);
  headText.appendChild(hPath);
  head.appendChild(headIcon);
  head.appendChild(headText);
  container.appendChild(head);

  // 概览统计卡片
  container.appendChild(buildOverview(data));

  // 分类细节
  container.appendChild(sectionInclude(data.includes));
  container.appendChild(
    sectionSimple("宏定义", data.macros, ["name", "value", "line"],
      { name: "宏名", value: "值", line: "行号" }, ["name-col"], "#")
  );
  container.appendChild(
    sectionSimple("typedef", data.typedefs, ["name", "type", "line"],
      { name: "别名", type: "类型", line: "行号" }, ["name-col"], "T")
  );
  container.appendChild(sectionFunctions(data.functions));
  container.appendChild(
    sectionSimple("全局变量", data.globals, ["name", "type", "line"],
      { name: "变量名", type: "类型", line: "行号" }, ["name-col"], "=")
  );
  container.appendChild(sectionStructs(data.structs));
  container.appendChild(sectionEnums(data.enums));

  detailPanel.innerHTML = "";
  detailPanel.appendChild(container);
}

function buildOverview(data) {
  const items = [
    { icon: "ƒ", label: "函数", count: data.functions.length, color: "#2f6fed" },
    { icon: "{}", label: "结构体/联合", count: data.structs.length, color: "#0f8a5f" },
    { icon: "≡", label: "枚举", count: data.enums.length, color: "#b8860b" },
    { icon: "#", label: "宏定义", count: data.macros.length, color: "#8e44ad" },
    { icon: "T", label: "typedef", count: data.typedefs.length, color: "#c0392b" },
    { icon: "=", label: "全局变量", count: data.globals.length, color: "#16a085" },
    { icon: "α", label: "Include", count: data.includes.length, color: "#5a6270" },
  ];
  const grid = document.createElement("div");
  grid.className = "overview";
  items.forEach((it) => {
    const card = document.createElement("div");
    card.className = "stat-card";
    card.style.setProperty("--accent", it.color);
    const icon = document.createElement("span");
    icon.className = "stat-icon";
    icon.textContent = it.icon;
    const num = document.createElement("span");
    num.className = "stat-num";
    num.textContent = String(it.count);
    const label = document.createElement("span");
    label.className = "stat-label";
    label.textContent = it.label;
    card.appendChild(icon);
    card.appendChild(num);
    card.appendChild(label);
    grid.appendChild(card);
  });
  return grid;
}

function sectionHead(icon, label, count) {
  const h = document.createElement("h3");
  const hIcon = document.createElement("span");
  hIcon.className = "h-icon";
  hIcon.textContent = icon;
  const hLabel = document.createElement("span");
  hLabel.className = "h-label";
  hLabel.textContent = label;
  const hBadge = document.createElement("span");
  hBadge.className = "badge";
  hBadge.textContent = String(count);
  h.appendChild(hIcon);
  h.appendChild(hLabel);
  h.appendChild(hBadge);
  return h;
}

function sectionInclude(includes) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.appendChild(sectionHead("#", "Include", includes.length));
  if (!includes.length) {
    sec.appendChild(emptyNote("无"));
    return sec;
  }
  const ul = document.createElement("ul");
  ul.className = "chips";
  includes.forEach((inc) => {
    const li = document.createElement("li");
    li.className = "chip";
    li.textContent = inc;
    ul.appendChild(li);
  });
  sec.appendChild(ul);
  return sec;
}

function sectionFunctions(functions) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.appendChild(sectionHead("ƒ", "函数", functions.length));
  if (!functions.length) {
    sec.appendChild(emptyNote("无"));
    return sec;
  }
  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML = `
    <thead>
      <tr><th>行号</th><th>类型</th><th>函数</th><th>签名</th></tr>
    </thead>`;
  const tbody = document.createElement("tbody");
  functions.forEach((fn) => {
    const tr = document.createElement("tr");
    const rowNum = el("td", `<span class="lineno">${fn.line}</span>`);
    const typeTd = el("td", "");
    const tag = document.createElement("span");
    tag.className = `tag ${fn.isDefinition ? "definition" : "declaration"}`;
    tag.textContent = fn.isDefinition ? "定义" : "声明";
    typeTd.appendChild(tag);
    const nameTd = el("td", "");
    nameTd.className = "name-col mono";
    nameTd.textContent = fn.name;
    const paramsTd = el("td", "");
    paramsTd.className = "mono";
    paramsTd.textContent = `${fn.returnType} (${fn.params})`;
    tr.appendChild(rowNum);
    tr.appendChild(typeTd);
    tr.appendChild(nameTd);
    tr.appendChild(paramsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

function sectionStructs(structs) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.appendChild(sectionHead("{}", "结构体 / 联合", structs.length));
  if (!structs.length) {
    sec.appendChild(emptyNote("无"));
    return sec;
  }
  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML =
    "<thead><tr><th>行号</th><th>类型</th><th>名称</th><th>成员</th></tr></thead>";
  const tbody = document.createElement("tbody");
  structs.forEach((s) => {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", `<span class="lineno">${s.line}</span>`));
    tr.appendChild(el("td", s.kind));
    tr.appendChild(el("td", s.name, "name-col mono"));
    const fieldsTd = el("td", "");
    const ul = document.createElement("ul");
    ul.className = "chips";
    (s.fields || []).forEach((f) => {
      const li = document.createElement("li");
      li.className = "chip";
      li.textContent = f;
      ul.appendChild(li);
    });
    fieldsTd.appendChild(ul);
    tr.appendChild(fieldsTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

function sectionEnums(enums) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.appendChild(sectionHead("≡", "枚举", enums.length));
  if (!enums.length) {
    sec.appendChild(emptyNote("无"));
    return sec;
  }
  const table = document.createElement("table");
  table.className = "table";
  table.innerHTML =
    "<thead><tr><th>行号</th><th>名称</th><th>枚举值</th></tr></thead>";
  const tbody = document.createElement("tbody");
  enums.forEach((en) => {
    const tr = document.createElement("tr");
    tr.appendChild(el("td", `<span class="lineno">${en.line}</span>`));
    tr.appendChild(el("td", en.name, "name-col mono"));
    const membersTd = el("td", "");
    const ul = document.createElement("ul");
    ul.className = "chips";
    (en.members || []).forEach((m) => {
      const li = document.createElement("li");
      li.className = "chip";
      li.textContent = m;
      ul.appendChild(li);
    });
    membersTd.appendChild(ul);
    tr.appendChild(membersTd);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

/* 通用表格渲染：字段驱动的简单符号类别 */
function sectionSimple(title, items, fields, headers, nameClass, icon) {
  const sec = document.createElement("div");
  sec.className = "section";
  sec.appendChild(sectionHead(icon || "·", title, items.length));
  if (!items.length) {
    sec.appendChild(emptyNote("无"));
    return sec;
  }
  const table = document.createElement("table");
  table.className = "table";
  const thead = document.createElement("thead");
  const trh = document.createElement("tr");
  fields.forEach((f) => {
    const th = document.createElement("th");
    th.textContent = headers[f] ?? f;
    trh.appendChild(th);
  });
  thead.appendChild(trh);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  items.forEach((item) => {
    const tr = document.createElement("tr");
    fields.forEach((f) => {
      const td = document.createElement("td");
      if (f === "line") {
        td.innerHTML = `<span class="lineno">${item[f]}</span>`;
      } else {
        td.textContent = String(item[f] ?? "");
        if (nameClass.includes(f)) td.className = "name-col mono";
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  sec.appendChild(table);
  return sec;
}

function emptyNote(text) {
  const p = document.createElement("p");
  p.className = "placeholder";
  p.textContent = text;
  p.style.marginTop = "0";
  return p;
}

function el(tag, html, cls) {
  const node = document.createElement(tag);
  if (html !== undefined) node.innerHTML = html;
  if (cls) node.className = cls;
  return node;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// 初始：若浏览器环境非 webview（如直接 vite 打开），invoke 会失败，忽略。
window.addEventListener(
  "error",
  (e) => {
    if (String(e.message || "").includes("__TAURI_INTERNALS__")) {
      e.preventDefault();
    }
  },
  true
);