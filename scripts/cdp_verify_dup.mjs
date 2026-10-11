/* CDP 验证：`.link-dup-notice` 样式在真实浏览器里必须生效
   —— 为什么只验样式、不跑完整五步：告警块的**行为**（同名消歧、未决留空、导出拦截）
      已由 scripts/test-fn-disambiguate.mjs（25 项纯模块断言）与 smoke-ui 第 10 组
      （端到端 124 行 / 123 关联 / 1 未决留空 / 导出确认拦截）充分证明。
      DOM stub 唯一测不到的是「这段样式用户看不看得见」——而这只需要把产品实际输出的
      同一段 HTML 放进真实页面断言 getComputedStyle，不必驱动整个向导。

   断言：
     ① 浅红警示底色生效（红通道显著高于蓝）
     ② 警示色文字生效（偏红，不是普通灰）
     ③ 左侧粗边框生效（≥2px，区别于普通占位的细边框）
     ④ 圆角与内边距生效（未被更高优先级规则覆盖）
     ⑤ 有实际尺寸、未被容器裁掉
     ⑥ 对照：普通 `.placeholder` 不带警示底色（防样式泄漏到别处）

   运行前置：vite dev --port 1420 + headless Edge --remote-debugging-port=9333 */
import { writeFileSync } from "node:fs";

const CDP = "http://localhost:9333";
const APP = "http://localhost:1420/";
const OUT = "C:/Users/Administrator/Desktop/CodeDocBench/.workbuddy";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failed = 0;
const check = (ok, label, extra = "") => {
  log(`  ${ok ? "✅" : "❌"} ${label}${extra ? "  " + extra : ""}`);
  if (!ok) failed++;
};

const ver = await fetch(CDP + "/json/version").then((r) => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let idc = 0;
const pending = new Map();
let sessionId = null;
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});
function cdp(method, params = {}, sess = sessionId) {
  return new Promise((res, rej) => {
    const id = ++idc;
    pending.set(id, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
    const msg = { id, method, params };
    if (sess) msg.sessionId = sess;
    ws.send(JSON.stringify(msg));
  });
}
await new Promise((res) => ws.addEventListener("open", res, { once: true }));

const { targetId } = await cdp("Target.createTarget", { url: "about:blank" });
sessionId = (await cdp("Target.attachToTarget", { targetId, flatten: true })).sessionId;
await cdp("Page.enable");
await cdp("Runtime.enable");
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false,
});

async function evalInPage(expr) {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function shot(name) {
  const r = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, "base64"));
}

try {
  await cdp("Page.navigate", { url: APP });
  await sleep(5000);

  // 进入步骤 5，把产品实际输出的告警块 HTML 注入 #link-preview
  const injected = await evalInPage(`(() => {
    const panel = document.getElementById('link-panel');
    if (!panel) return 'NO_PANEL';
    panel.classList.remove('hidden');
    const pv = document.getElementById('link-preview');
    pv.style.display = 'block';
    pv.innerHTML =
      '<div class="link-dup-notice"><b>同名函数无法判定归属（链入 ID 已留空）</b><ul>' +
      '<li>函数「Dup_Fn」在低层需求中有多个同名需求块，且无法根据同目录级别的其他函数判定归属（涉及 Demo_IF_ReqMod2Process.c），该函数的 Parent ID 已留空，请核对低层需求章节结构</li>' +
      '</ul></div>';
    return 'OK';
  })()`);
  check(injected === "OK", "告警块已注入 #link-preview", injected);
  await sleep(400);

  const info = await evalInPage(`(function(){
    var pv = document.getElementById('link-preview');
    var n = pv.querySelector('.link-dup-notice');
    if (!n) return { found: false };
    var cs = getComputedStyle(n);
    var r = n.getBoundingClientRect();
    var pr = pv.getBoundingClientRect();
    var li = n.querySelector('li');
    var liCs = li ? getComputedStyle(li) : null;
    return {
      found: true,
      bg: cs.backgroundColor, fg: cs.color,
      borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor,
      radius: cs.borderTopLeftRadius, padTop: cs.paddingTop,
      fontSize: cs.fontSize, listStyle: liCs ? liCs.listStyleType : '',
      w: Math.round(r.width), h: Math.round(r.height),
      top: Math.round(r.top), bottom: Math.round(r.bottom),
      pvTop: Math.round(pr.top), pvBottom: Math.round(pr.bottom),
    };
  })()`);
  log("  [告警块] " + JSON.stringify(info));
  check(info.found, "告警块已渲染在 #link-preview 内");

  const rgb = (s) => (String(s).match(/\d+/g) || []).map(Number);
  const [br, bgc, bbb] = rgb(info.bg);
  const [fr, fg, fb] = rgb(info.fg);
  check(br > 240 && bgc > 215 && bbb > 215 && br > bbb + 10, "浅红警示底色生效", info.bg);
  check(fr > 120 && fr > fb + 40, "警示色文字生效", info.fg);
  const bl = parseFloat(info.borderLeft);
  check(bl >= 2 && info.borderLeft.includes("solid"), "左侧粗边框生效（≥2px）", info.borderLeft);
  check(parseFloat(info.radius) > 0, "圆角生效", info.radius);
  check(parseFloat(info.padTop) >= 8, "内边距生效（未被覆盖）", info.padTop);
  check(info.w > 200 && info.h > 30, "有实际尺寸", `${info.w}×${info.h}`);
  check(
    info.top >= info.pvTop - 2 && info.bottom <= info.pvBottom + 2,
    "真实可见且未被容器裁掉",
    `元素 ${info.top}~${info.bottom} / 容器 ${info.pvTop}~${info.pvBottom}`
  );

  await shot("cdp_dup_notice.png");

  // 对照：普通 placeholder 不应带警示底色（防样式泄漏）
  const plain = await evalInPage(`(function(){
    var pv = document.getElementById('link-preview');
    var p = document.createElement('p');
    p.className = 'placeholder';
    p.textContent = '填写链入/链出信息后，点击「生成链接文件」';
    pv.appendChild(p);
    var cs = getComputedStyle(p);
    return { bg: cs.backgroundColor, fg: cs.color, border: cs.borderTopWidth };
  })()`);
  const [pr2, , pb2] = rgb(plain.bg);
  log("  [对照·普通占位] " + JSON.stringify(plain));
  check(!(pr2 > 240 && pr2 > pb2 + 10), "普通占位不带浅红底（样式未泄漏）", plain.bg);

  ws.close();
  log(failed === 0 ? "\nCDP 验证通过 ✅" : `\nCDP 验证失败 ❌ ${failed} 项`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error("FATAL", e);
  process.exitCode = 1;
  try { ws.close(); } catch (_) {}
}