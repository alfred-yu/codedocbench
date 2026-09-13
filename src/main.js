import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
// xlsx-js-style：SheetJS 的样式支持分支（API 兼容），用于导出时加粗标题行
import * as XLSX from "xlsx-js-style";

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
  renderStepper();
}

stepperEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".step-item");
  if (btn && !btn.disabled) goStep(Number(btn.dataset.step));
});

genRunBtn.addEventListener("click", () => exportDocExcel());

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

async function renderGenPreview() {
  // 先确保数据行取自最新解析结果
  await refreshAllFileData();

  const acc = countDocNodes(docTree, { chapters: 0, files: 0 });
  const llr = relRows.length
    ? `${relFileName.textContent} · ${relRows.length} 行`
    : "未关联";
  genStats.innerHTML = [
    `<span class="gen-stat">章节 <b>${acc.chapters}</b></span>`,
    `<span class="gen-stat">挂载文件 <b>${acc.files}</b></span>`,
    `<span class="gen-stat">低层需求 <b>${escapeHtml(llr)}</b></span>`,
    relRows.length && !relColChapter.value
      ? '<span class="gen-stat warn">⚠ 未映射「章节列」，函数 Parent ID 关联可能不准</span>'
      : "",
  ].join("");

  const fnIndex = buildLlrFunctionIndex(collectFunctionNames());
  const rows = buildGenRows(fnIndex);
  if (!rows.length) {
    genPreview.innerHTML = '<p class="placeholder">文档目录树为空</p>';
    return;
  }
  const head = ["章节号", "需求内容", "Object Type", "Parent ID"]
    .map((h) => `<th>${h}</th>`)
    .join("");
  const colgroup =
    '<colgroup><col style="width:12%"><col style="width:56%"><col style="width:16%"><col style="width:16%"></colgroup>';
  const body = rows
    .map((r) => {
      const titleCell = `<td class="${r.num !== "" ? "gen-title-cell" : ""}">${escapeHtml(r.title)}</td>`;
      return `<tr><td class="mono">${escapeHtml(r.num)}</td>${titleCell}<td>${escapeHtml(r.objectType)}</td><td class="mono">${escapeHtml(r.parent).replaceAll("\n", "<br>")}</td></tr>`;
    })
    .join("");
  // 表头与表体分属两个区域：表头固定，表体独立滚动（固定列布局保证对齐）
  genPreview.innerHTML =
    `<div class="gen-preview-head"><table class="rel-table gen-table">${colgroup}<thead><tr>${head}</tr></thead></table></div>` +
    `<div class="gen-preview-scroll"><table class="rel-table gen-table">${colgroup}<tbody>${body}</tbody></table></div>` +
    `<div class="gen-preview-info">共 ${rows.length} 行 · 与导出的 Excel 内容一致（标题行导出时加粗）</div>`;
}

/* ---- 低层需求 Excel 加载与列选择 ---- */
const relPickBtn = document.getElementById("rel-pick-btn");
const relFileName = document.getElementById("rel-file-name");
const relColChapter = document.getElementById("rel-col-chapter");
const relColId = document.getElementById("rel-col-id");
const relColContent = document.getElementById("rel-col-content");
const relColObject = document.getElementById("rel-col-object");
const relPreview = document.getElementById("rel-preview");
let relRows = []; // 低层需求数据行
let relColNames = []; // 表头列名
let relFilePath = null; // 当前关联的低层需求文件路径（随项目持久化）

async function loadLlrFile(filePath) {
  const bytes = await invoke("read_file", { path: filePath });
  const wb = XLSX.read(new Uint8Array(bytes), { type: "array" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
  if (!rows.length || typeof rows[0] !== "object") {
    throw new Error("未解析到表头与数据");
  }
  relFilePath = filePath;
  relRows = rows;
  relColNames = Object.keys(rows[0]);
  relFileName.textContent = filePath.split(/[\\/]/).pop();
  fillRelColSelects();
  renderRelPreview();
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
  sel.addEventListener("change", () => saveDocTree());
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
  });
}

/* 恢复/重置低层需求关联（文件路径 + 列映射，随项目持久化） */
function resetLlrState() {
  relFilePath = null;
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
  const m = llr.mapping || {};
  const apply = (sel, v) => {
    if (v) sel.value = v;
  };
  apply(relColChapter, m.chapter);
  apply(relColId, m.id);
  apply(relColContent, m.content);
  apply(relColObject, m.objectType);
  saveDocTree();
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
  let legacyData = null;
  try {
    const bytes = await invoke("read_file", { path: projectDataFilePath(projectRoot) });
    const parsed = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));
    if (Array.isArray(parsed.docTree)) docTree = parsed.docTree;
    savedLlr = parsed.llr || null;
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

function dataSectionNames(res, key) {
  if (!res || res.type === "error") return [];
  const byKey = {
    types: [...(res.typedefs || []), ...(res.structs || []), ...(res.enums || [])],
    globals: res.globals || [],
    macros: res.macros || [],
    constants: res.constants || [],
    functions: res.functions || [],
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
  await Promise.all(paths.map((p) => ensureParsed(p)));
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

   Parent ID 关联规则（参考 PDT_LLR_Requirements.xlsx）：
   低层需求文档中"文档编号到函数名为止"——需求内容列的值恰为函数名的行是函数名行，
   其后直到下一个函数名行之前的所有行是该函数的需求内容行；
   函数符号行的 Parent ID = 这些需求内容行的 ID 列值集合（逗号分隔），
   并排除 Object Type 为 Comment 的行；未关联低层需求或匹配不到时为空。 */

/* 收集文档树中全部函数符号名（用于与低层需求文档的需求内容列做整行匹配） */
function collectFunctionNames() {
  const names = [];
  const walk = (ns) =>
    ns.forEach((n) => {
      if (n.type === "file" && isSourceFile(n)) {
        (n.children || []).forEach((sec) => {
          if (sec.isData === "functions") {
            names.push(...dataSectionNames(parseCache.get(n.path)?.data, "functions"));
          }
        });
      }
      walk(n.children || []);
    });
  walk(docTree);
  return names;
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
        // 数据行：不参与编号；内容来自源码解析 → Source Code，解析不到（N/A 占位）→ Comment
        for (const it of items) {
          let rowParent = "";
          if (sec.isData === "functions" && fromSource && fnIndex) {
            const ids = fnIndex.get(it);
            if (ids && ids.length) rowParent = ids.join("\n");
          }
          rows.push({
            num: "",
            title: it,
            objectType: fromSource ? "Source Code" : "Comment",
            parent: rowParent,
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
  // 先确保所有挂载的 .c 文件已解析，以保证数据行完整
  await refreshAllFileData();

  // 一致性自检：发现异常时由用户确认后再导出
  const warnings = collectParseWarnings();
  if (relRows.length && !relColChapter.value) {
    warnings.unshift("低层需求未映射「章节列」，函数 Parent ID 的关联边界可能不准确");
  }
  if (warnings.length) {
    const preview = warnings.slice(0, 5).join("\n");
    const more = warnings.length > 5 ? `\n……共 ${warnings.length} 处` : "";
    if (!confirm(`解析自检发现 ${warnings.length} 处异常：\n${preview}${more}\n\n仍要继续导出吗？`)) {
      return;
    }
  }

  const fnIndex = buildLlrFunctionIndex(collectFunctionNames());
  const rows = collectDocRows(docTree, [], fnIndex);
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