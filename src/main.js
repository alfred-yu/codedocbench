import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import * as XLSX from "xlsx";

const pathInput = document.getElementById("path-input");
const openBtn = document.getElementById("open-btn");
const scanBtn = document.getElementById("scan-btn");
const statusEl = document.getElementById("status");
const treeContainer = document.getElementById("tree-container");
const detailPanel = document.getElementById("detail-panel");
const docBtn = document.getElementById("doc-btn");
const docPanel = document.getElementById("doc-panel");
const docBackBtn = document.getElementById("doc-back-btn");
const homebar = document.getElementById("homebar");
const layout = document.getElementById("layout");

let currentSelection = null; // { type, path }
let lastTree = null; // 最近一次扫描的项目目录树

// ---- 文档目录树状态 ----
let docTree = []; // { id, type:'chapter'|'file', title, path?, children:[] }
let docSelection = null; // 当前选中(挂载目标)的文档节点 id
let docEditId = null; // 正在就地编辑标题的节点 id
let mountSelection = new Set(); // 右侧勾选待挂载的项目文件路径
let docIdCounter = 1;

// 文件可输出的数据类型（右键文件节点选择，每类型占一个章节）
const DOC_TYPE_OPTIONS = [
  { key: "functions", label: "函数" },
  { key: "structs", label: "结构体/联合" },
  { key: "enums", label: "枚举" },
  { key: "macros", label: "宏定义" },
  { key: "typedefs", label: "typedef" },
  { key: "globals", label: "全局变量" },
  { key: "includes", label: "Include" },
];

const docAddBtn = document.getElementById("doc-add-btn");
const docRenameBtn = document.getElementById("doc-rename-btn");
const docDeleteBtn = document.getElementById("doc-delete-btn");
const docMountBtn = document.getElementById("doc-mount-btn");
const docClearBtn = document.getElementById("doc-clear-mount-btn");
const docExportBtn = document.getElementById("doc-export-btn");
const docRelBtn = document.getElementById("doc-rel-btn");
const relPanel = document.getElementById("rel-panel");
const relBackBtn = document.getElementById("rel-back-btn");

scanBtn.addEventListener("click", () => doScan());
openBtn.addEventListener("click", () => chooseDirectory());
docBtn.addEventListener("click", () => {
  layout.classList.add("hidden");
  homebar.classList.add("hidden");
  docPanel.classList.remove("hidden");
  renderDocTree();
  renderDocProjectTree();
});
docBackBtn.addEventListener("click", () => {
  docPanel.classList.add("hidden");
  layout.classList.remove("hidden");
  homebar.classList.remove("hidden");
});
docAddBtn.addEventListener("click", () => addDocNode());
docRenameBtn.addEventListener("click", () => renameDocNode());
docDeleteBtn.addEventListener("click", () => deleteDocNode());
docMountBtn.addEventListener("click", () => mountFiles());
docClearBtn.addEventListener("click", () => {
  mountSelection.clear();
  renderDocProjectTree();
});
docExportBtn.addEventListener("click", () => exportDocExcel());
docRelBtn.addEventListener("click", () => {
  docPanel.classList.add("hidden");
  relPanel.classList.remove("hidden");
});
relBackBtn.addEventListener("click", () => {
  relPanel.classList.add("hidden");
  docPanel.classList.remove("hidden");
});

/* ---- 低层需求 Excel 加载与列选择 ---- */
const relPickBtn = document.getElementById("rel-pick-btn");
const relFileName = document.getElementById("rel-file-name");
const relColId = document.getElementById("rel-col-id");
const relColContent = document.getElementById("rel-col-content");
const relColObject = document.getElementById("rel-col-object");
const relPreview = document.getElementById("rel-preview");
let relRows = []; // 低层需求数据行
let relColNames = []; // 表头列名

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
    const bytes = await invoke("read_file", { path: filePath });
    const wb = XLSX.read(new Uint8Array(bytes), { type: "array" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    relRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
    if (!relRows.length || typeof relRows[0] !== "object") {
      throw new Error("未解析到表头与数据");
    }
    relColNames = Object.keys(relRows[0]);
    relFileName.textContent = filePath.split(/[\\/]/).pop();
    fillRelColSelects();
    renderRelPreview();
  } catch (err) {
    relRows = [];
    relColNames = [];
    relFileName.textContent = "解析失败：" + err;
  }
});

function fillRelColSelects() {
  const opts = relColNames.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  for (const sel of [relColId, relColContent, relColObject]) {
    sel.innerHTML = '<option value="">（未指定）</option>' + opts;
  }
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
  relPreview.innerHTML = `
    <div class="rel-preview-info">共 ${rowCount} 行数据 · 预览前 50 行</div>
    <table class="rel-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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
pathInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") doScan();
});

// 弹出原生目录选择对话框，选中后填入路径并自动扫描
async function chooseDirectory() {
  try {
    const dir = await open({
      directory: true,
      multiple: false,
      title: "选择 C 项目目录",
    });
    if (!dir) return; // 用户取消
    pathInput.value = dir;
    await doScan();
  } catch (err) {
    setStatus(`选择目录失败: ${err}`, true);
  }
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

async function doScan() {
  const dir = pathInput.value.trim();
  if (!dir) {
    setStatus("请输入目录路径", true);
    return;
  }
  scanBtn.disabled = true;
  setStatus("正在扫描…");
  try {
    const tree = await invoke("scan_dir", { path: dir });
    if (tree.type === "error") {
      setStatus(tree.message, true);
      renderTreePlaceholder();
      renderDetailPlaceholder();
      return;
    }
    setStatus("");
    lastTree = tree;
    renderTree(tree);
  } catch (err) {
    setStatus(`扫描失败: ${err}`, true);
    renderTreePlaceholder();
  } finally {
    scanBtn.disabled = false;
  }
}

/* ---------------- 目录树 ---------------- */
function renderTreePlaceholder() {
  treeContainer.innerHTML = '<p class="placeholder">输入目录并点击“扫描”以加载目录树</p>';
}

/* ================= 文档目录树（左） ================= */
function renderDocTree() {
  const container = document.getElementById("doc-tree-container");
  container.innerHTML = "";
  if (!docTree.length) {
    container.innerHTML = '<p class="placeholder">点击「＋ 章节」添加文档节点</p>';
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
}

function buildChapterNode(node, nums) {
  const li = document.createElement("li");
  const row = document.createElement("div");
  row.className = "node-row doc" + (node.id === docSelection ? " selected" : "");

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

  // 子节点：章节与挂载文件统一连续编号
  if (node.children.length) {
    const ul = document.createElement("ul");
    ul.className = "tree";
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
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      docSelection = node.id;
      renderDocTree();
      showFileTypeMenu(e.clientX, e.clientY, node);
    });
    row.addEventListener("click", () => {
      docSelection = node.id;
      renderDocTree();
    });
  }
  li.appendChild(row);
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
  let added = 0;
  for (const p of names) {
    if (existing.has(p)) continue;
    const fname = p.split(/[\\/]/).pop();
    target.children.push({
      id: docIdCounter++,
      type: "file",
      title: fname,
      path: p,
      children: [],
    });
    added += 1;
  }
  mountSelection.clear();
  renderDocTree();
  renderDocProjectTree();
  alert(added ? `已挂载 ${added} 个文件` : "这些文件已在该节点下");
}

/* ---- 文件右键菜单：选择输出的数据类型（每类型占一个章节） ---- */
function showFileTypeMenu(x, y, node) {
  closeFileTypeMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.id = "file-type-menu";

  const title = document.createElement("div");
  title.className = "ctx-title";
  title.textContent = `输出类型 · ${node.title}`;
  menu.appendChild(title);

  DOC_TYPE_OPTIONS.forEach((opt) => {
    const has = node.children.some((c) => c.typeKey === opt.key);
    const item = document.createElement("div");
    item.className = "ctx-item" + (has ? " checked" : "");
    const mark = document.createElement("span");
    mark.className = "ctx-check";
    mark.textContent = has ? "☑" : "☐";
    const label = document.createElement("span");
    label.textContent = opt.label;
    item.appendChild(mark);
    item.appendChild(label);
    item.addEventListener("click", () => {
      toggleFileType(node, opt);
    });
    menu.appendChild(item);
  });

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;

  // 点击菜单外的任意位置关闭（延迟注册，避免本次右键的 click 立即关闭）
  setTimeout(() => {
    document.addEventListener("click", closeFileTypeMenu, { once: true });
  }, 0);
}

function toggleFileType(node, opt) {
  const idx = node.children.findIndex((c) => c.typeKey === opt.key);
  if (idx >= 0) {
    node.children.splice(idx, 1);
  } else {
    node.children.push({
      id: docIdCounter++,
      type: "chapter",
      typeKey: opt.key,
      title: opt.label,
      children: [],
    });
  }
  closeFileTypeMenu();
  renderDocTree();
}

function closeFileTypeMenu() {
  const menu = document.getElementById("file-type-menu");
  if (menu) menu.remove();
}

/* ---- 导出代码文档 Excel（章节号 / 需求 / Parent ID） ---- */
function collectDocRows(nodes, nums) {
  const rows = [];
  let idx = 0;
  for (const node of nodes) {
    idx += 1;
    const num = nums.concat(idx).join(".");
    // Parent ID 用于链接低层需求文档中的 ID，暂不处理，留空
    rows.push({ num, title: node.title, parent: "" });
    if (node.children.length) {
      rows.push(...collectDocRows(node.children, nums.concat(idx)));
    }
  }
  return rows;
}

async function exportDocExcel() {
  if (!docTree.length) {
    alert("文档目录树为空，请先添加章节");
    return;
  }
  const rows = collectDocRows(docTree, []);
  const data = rows.map((r) => ({
    章节号: r.num,
    需求: r.title,
    "Parent ID": r.parent,
  }));
  const ws = XLSX.utils.json_to_sheet(data, {
    header: ["章节号", "需求", "Parent ID"],
  });
  ws["!cols"] = [{ wch: 12 }, { wch: 60 }, { wch: 16 }];
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
function renderDocProjectTree() {
  const container = document.getElementById("doc-project-tree");
  container.innerHTML = "";
  if (!lastTree) {
    container.innerHTML = '<p class="placeholder">请在主页扫描项目目录后再次进入</p>';
    return;
  }
  const rootEl = document.createElement("ul");
  rootEl.className = "tree root";
  rootEl.appendChild(buildMountNode(lastTree));
  container.appendChild(rootEl);
}

function buildMountNode(node) {
  const li = document.createElement("li");
  if (node.type === "dir") {
    const row = document.createElement("div");
    row.className = "node-row dir";

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = "▶";
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📁";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = node.name;
    row.appendChild(twisty);
    row.appendChild(icon);
    row.appendChild(name);

    const childrenUl = document.createElement("ul");
    childrenUl.className = "tree";
    node.children.forEach((c) => childrenUl.appendChild(buildMountNode(c)));

    row.addEventListener("click", () => {
      const collapsed = childrenUl.classList.toggle("hidden");
      twisty.textContent = collapsed ? "▶" : "▼";
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
    });
    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📄";
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
    twisty.textContent = "▶";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = "📁";

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
      twisty.textContent = collapsed ? "▶" : "▼";
    });

    li.appendChild(row);
    li.appendChild(childrenUl);
  } else {
    const row = document.createElement("div");
    row.className = "node-row file";
    if (!node.parsable) row.style.opacity = "0.6";

    const twisty = document.createElement("span");
    twisty.className = "twisty";
    twisty.textContent = "";

    const icon = document.createElement("span");
    icon.className = "icon";
    icon.textContent = node.parsable ? "📄" : "🗎";

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
  detailPanel.innerHTML =
    '<div class="detail-empty"><p>在左侧选择 <code>.c</code>/<code>.h</code> 文件以查看解析结果</p></div>';
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
  headIcon.textContent = "📄";
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