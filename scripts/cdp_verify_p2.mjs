import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx-js-style');

const CDP = 'http://localhost:9333';
const APP = 'http://localhost:1420/';
const OUT = 'C:/Users/Administrator/AppData/Local/Temp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

// ---- 1. Node 端生成超大低层需求 Excel（模拟 2 万行级别大文件）----
const ROWS = 25000;
const data = [];
for (let i = 1; i <= ROWS; i++) {
  data.push({
    章节: `CH${(i % 20) + 1}`,
    需求内容: `低层需求项 ${i}：系统应在接收到有效指令后于限定时间内完成响应并处理`,
    'Object Type': 'Requirement',
    ID: `DEMO_LL_R_${i}`,
    'Parent ID': '',
  });
}
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(data), 'Sheet1');
const b64 = XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
log(`[gen] 生成 ${ROWS} 行大文件，base64 长度 ${b64.length}`);

// 对照：若在**主线程**同步解析，UI 会卡这么久（即 P2 要消除的卡顿）
const t0 = performance.now();
const ab = new Uint8Array(Buffer.from(b64, 'base64'));
XLSX.read(ab, { type: 'array' });
const syncMs = performance.now() - t0;
log(`[sync] 主线程同步 XLSX.read 耗时 ${syncMs.toFixed(0)}ms（无 Worker 时即 UI 卡顿时长）`);

// ---- 2. CDP 封装（复用 cdp_verify_gen.mjs）----
const ver = await fetch(CDP + '/json/version').then((r) => r.json());
const wsUrl = ver.webSocketDebuggerUrl;
let idc = 0;
const pending = new Map();
let loadResolve = null;
let sessionId = null;
const ws = new WebSocket(wsUrl);
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data.toString());
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  } else if (m.method === 'Page.loadEventFired' && (!m.sessionId || m.sessionId === sessionId)) {
    if (loadResolve) {
      loadResolve();
      loadResolve = null;
    }
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
await new Promise((res) => ws.addEventListener('open', res, { once: true }));
const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
sessionId = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

async function evalInPage(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(expr, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await evalInPage(`!!(${expr})`)) return true;
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('waitFor timeout: ' + expr);
}
async function screenshot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'));
  return `${OUT}/${name}`;
}

// ---- 3. 真实浏览器驱动：注入大文件 → 走 Worker 解析 → 监控主线程 ----
(async () => {
  await evalInPage(`window.alert=()=>{};window.confirm=()=>true;window.prompt=()=>'';`);
  log('[nav] goto', APP);
  await cdp('Page.navigate', { url: APP });
  await sleep(5000);

  const step2Disabled = await evalInPage(`(function(){var s=document.querySelector('.step-item[data-step="2"]');return s?s.disabled:null;})()`);
  if (step2Disabled) {
    await evalInPage(`(function(){var h=document.getElementById('open-hint');if(h)h.click();})()`);
    await waitFor(`document.querySelector('.step-item[data-step="2"]') && !document.querySelector('.step-item[data-step="2"]').disabled`);
    log('[ok] opened via open-hint');
  } else {
    log('[ok] already opened (demo auto-open)');
  }

  // 步骤 2：建目录树 + 挂载（解锁步骤 3 的 maxStep 闸门）
  await evalInPage(`document.querySelector('.step-item[data-step="2"]').click()`);
  await waitFor(`!document.getElementById('doc-panel').classList.contains('hidden')`);
  const chapOk = await evalInPage(`(function(){
    var rows = document.querySelectorAll('#doc-tree-container .node-row');
    if (rows.length === 0) { document.getElementById('doc-add-btn').click(); rows = document.querySelectorAll('#doc-tree-container .node-row'); }
    var first = rows[0]; if (first) first.click();
    return rows.length;
  })()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 0`);
  const cbOk = await evalInPage(`(() => { const cb = document.querySelector('#doc-project-tree .node-row.dir > input[type=checkbox]') || document.querySelector('#doc-project-tree input[type=checkbox]'); if(!cb) return 'NO_CB'; cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); return 'OK'; })()`);
  log('[root cb]', cbOk);
  await waitFor(`(() => { let n=0; document.querySelectorAll('#doc-project-tree input[type=checkbox]').forEach(c=>{if(c.checked)n++;}); return n>0; })()`);
  await evalInPage(`document.getElementById('doc-mount-btn').click()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 1`);
  log('[ok] files mounted, step2 done');

  // 进入步骤 3（低层需求面板）
  await evalInPage(`document.querySelector('.step-item[data-step="3"]').click()`);
  await waitFor(`!document.getElementById('rel-panel').classList.contains('hidden')`);

  // patch demo 后端：open 返回 BIGLLR 路径，read_file 在该路径返回超大字节
  const patchRes = await evalInPage(`(function(){
    window.__BIGLLR_B64 = ${JSON.stringify(b64)};
    var orig = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = function(cmd, args){
      if(cmd==='plugin:dialog|open') return Promise.resolve('C:\\\\DemoProject\\\\BIGLLR.xlsx');
      if(cmd==='read_file' && args && args.path && args.path.indexOf('BIGLLR')>=0){
        var bin = atob(window.__BIGLLR_B64);
        var bytes = new Uint8Array(bin.length);
        for(var i=0;i<bin.length;i++) bytes[i]=bin.charCodeAt(i);
        return Promise.resolve(bytes);
      }
      return orig(cmd, args);
    };
    // 主线程 rAF 监控：若主线程被 XLSX.read 卡住，__raf 会停滞、__rafMaxGap 会飙升
    window.__raf=0; window.__rafMaxGap=0; window.__rafLast=performance.now();
    var tick=function(){ window.__raf++; var n=performance.now(); var g=n-window.__rafLast; if(g>window.__rafMaxGap) window.__rafMaxGap=g; window.__rafLast=n; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    // 记录 loading 是否曾可见（即便窗口极短也能捕获，避免粗轮询漏检）
    window.__loadingEverVisible=false;
    var relEl=document.getElementById('rel-loading');
    if(relEl){ window.__relMO=new MutationObserver(function(){ if(!relEl.hidden) window.__loadingEverVisible=true; }); window.__relMO.observe(relEl,{attributes:true,attributeFilter:['hidden']}); if(!relEl.hidden) window.__loadingEverVisible=true; }
    return 'patched';
  })()`);
  log('[ok] invoke patched + rAF monitor started:', patchRes);

  // 触发大文件解析（showRelLoading 在 loadLlrFile 第一行即同步显示 → 紧接截图即可抓到 loading 态）
  const clickT = Date.now();
  await evalInPage(`document.getElementById('rel-pick-btn').click()`);
  const shotLoading = await screenshot('p2_loading.png');
  log('[shot loading]', shotLoading);

  // 轮询：loading 曾可见 + 解析完成
  let loadingSeen = false;
  for (let i = 0; i < 120; i++) {
    const s = await evalInPage(`JSON.stringify({ hidden: document.getElementById('rel-loading').hidden, everVis: window.__loadingEverVisible, file: document.getElementById('rel-file-name').textContent, cols: document.getElementById('rel-col-chapter').options.length })`);
    const o = JSON.parse(s);
    if (!o.hidden || o.everVis) loadingSeen = true;
    if (o.hidden && o.file && o.file.indexOf('BIGLLR.xlsx') >= 0) break;
    await sleep(80);
  }
  const done = await evalInPage(`JSON.stringify({ hidden: document.getElementById('rel-loading').hidden, everVis: window.__loadingEverVisible, file: document.getElementById('rel-file-name').textContent, raf: window.__raf, maxGap: window.__rafMaxGap, cols: document.getElementById('rel-col-chapter').options.length, previewLen: document.getElementById('rel-preview').innerHTML.length })`);
  const d = JSON.parse(done);
  const shotDone = await screenshot('p2_done.png');
  log('[shot done]', shotDone);

  const wallSinceClick = Date.now() - clickT;
  log('=== RESULT ===');
  log('loadingSeen(ever):', d.everVis);
  log('file:', d.file);
  log('cols:', d.cols, ' previewLen:', d.previewLen);
  log('rAF total:', d.raf, ' maxFrameGap(ms):', d.maxGap.toFixed(1));
  log('wall since click(ms):', wallSinceClick, ' | sync parse(Node) ms:', syncMs.toFixed(0));

  const okLoading = loadingSeen || d.everVis;
  const okParsed = !!(d.file && d.file.indexOf('BIGLLR.xlsx') >= 0 && d.cols > 1 && d.previewLen > 0);
  const okNotFrozen = d.maxGap < 100; // 主线程未被 XLSX.read 卡死
  log('--- VERDICT ---');
  log('① loading 解析中可见:', okLoading ? 'PASS' : 'FAIL');
  log('② 大文件解析成功(UI 更新):', okParsed ? 'PASS' : 'FAIL');
  log('③ 主线程未冻结(rAF 连续, maxGap<100ms):', okNotFrozen ? 'PASS' : 'FAIL');
  log(`   参考：若同步解析会卡 ${syncMs.toFixed(0)}ms，实测主线程最长单帧仅 ${d.maxGap.toFixed(1)}ms`);

  ws.close();
  process.exit(okLoading && okParsed && okNotFrozen ? 0 : 2);
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
