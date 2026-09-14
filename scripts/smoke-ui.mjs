// 前端冒烟测试：在 Node 里用 DOM stub + 伪 Tauri 后端执行打包产物，
// 覆盖 `vite build` 与 pytest 都抓不到的一类缺陷——模块顶层引用未声明的标识符
// （会让整个模块求值中断，表现为「打开项目无反应 / 点击按钮无反应」）。
//
// 用法：npm run smoke   （先构建，再冒烟）
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

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

/* 元素 stub：记录 addEventListener，便于测试主动触发点击 */
function makeEl(id) {
  const listeners = {};
  const state = { id, textContent: "", innerHTML: "", className: "", value: "", disabled: false };
  return new Proxy(function () {}, {
    get(t, k) {
      if (k === "addEventListener")
        return (type, fn) => (listeners[type] || (listeners[type] = [])).push(fn);
      if (k === "__listeners") return listeners;
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
  querySelector: () => makeEl("qs"),
  querySelectorAll: () => [],
  addEventListener() {},
  body: makeEl("body"),
  documentElement: makeEl("html"),
  title: "",
};

/* ---------- 伪 Tauri 后端：决定「打开项目」走哪条分支 ---------- */
const invoked = [];
const tauriInvoke = async (cmd, args) => {
  invoked.push(cmd);
  if (cmd.startsWith("plugin:dialog")) return ROOT; // 模拟用户在对话框里选中项目目录
  if (cmd === "scan_dir") return { type: "dir", name: path.basename(ROOT), path: args.path, children: [] };
  if (cmd === "read_file") throw new Error("ENOENT: 项目文件不存在"); // 走 localStorage 兼容分支
  if (cmd === "save_file") return null;
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
  console.log("[1/4] 模块顶层执行完成");
} catch (e) {
  console.log("[1/4] 模块顶层执行失败 ❌", e.constructor.name + ": " + e.message);
  process.exit(1);
}

// 触发「点击打开项目目录」：找绑定了 click 的容器
const treeEl = [...registry.values()].find((el) => (el.__listeners.click || []).length);
if (!treeEl) {
  console.log("[2/4] 未找到打开项目的 click 监听 ❌");
  process.exit(1);
}
for (const fn of treeEl.__listeners.click) fn({ target: { closest: () => ({}) } });
await new Promise((r) => setTimeout(r, 300));
console.log("[2/4] 打开项目链路 → 后端调用:", [...new Set(invoked)].join(", "));
if (!invoked.includes("scan_dir")) fail.push("打开项目未触发 scan_dir");

// 步骤 5 两个按钮必须已接线
const clickBtn = (id) => {
  const fns = registry.get(id) && registry.get(id).__listeners.click;
  if (!fns || !fns.length) return false;
  for (const fn of fns) fn({});
  return true;
};
const genBound = clickBtn("link-gen-btn");
const runBound = clickBtn("link-run-btn");
await new Promise((r) => setTimeout(r, 50));
console.log("[3/4] 步骤 5 按钮接线: 生成=" + (genBound ? "已绑定" : "未绑定") + " 导出=" + (runBound ? "已绑定" : "未绑定"));
if (!genBound) fail.push("link-gen-btn 未绑定 click");
if (!runBound) fail.push("link-run-btn 未绑定 click");
if (!alerts.some((a) => a.includes("文档目录树为空"))) fail.push("生成按钮未走前置校验");
if (!alerts.some((a) => a.includes("生成链接文件"))) fail.push("导出按钮未走「未生成不可导出」守卫");

const bad = writes.filter((w) => /失败|Error|not defined/.test(w.value));
if (bad.length) fail.push("界面出现错误文案: " + JSON.stringify(bad));
if (rejections.length) fail.push("未处理的 Promise 异常: " + rejections.join(" | "));

console.log("[4/4] 错误文案:", bad.length ? JSON.stringify(bad) : "无", "| 未处理异常:", rejections.length ? rejections.join(" | ") : "无");
if (fail.length) {
  console.log("\n结论: 冒烟失败 ❌");
  fail.forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("\n结论: 冒烟通过 ✅");
