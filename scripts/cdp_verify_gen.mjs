import { writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9333';
const APP = 'http://localhost:1420/';
const OUT = 'C:/Users/Administrator/AppData/Local/Temp';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

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
const attach = await cdp('Target.attachToTarget', { targetId, flatten: true });
sessionId = attach.sessionId;

await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});

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

(async () => {
  await evalInPage(`window.alert=function(){};window.confirm=function(){return true;};window.prompt=function(){return '';};`);
  log('[nav] goto', APP);
  await cdp('Page.navigate', { url: APP });
  await sleep(5000);
  const navDiag = await evalInPage(`JSON.stringify({ href: location.href, ready: document.readyState, hasHint: !!document.getElementById('open-hint'), step2Disabled: (function(){var s=document.querySelector('.step-item[data-step="2"]');return s?s.disabled:null;})(), bodyClass: document.body.className })`).catch((e) => 'EVAL_ERR:' + e.message);
  log('[navDiag]', navDiag);

  // demo 环境项目常已自动打开（open-hint 不存在）；未解锁时才点 open-hint
  const step2Disabled = await evalInPage(`(function(){var s=document.querySelector('.step-item[data-step="2"]');return s?s.disabled:null;})()`);
  if (step2Disabled) {
    await evalInPage(`(function(){var h=document.getElementById('open-hint');if(h)h.click();})()`);
    await waitFor(`document.querySelector('.step-item[data-step="2"]') && !document.querySelector('.step-item[data-step="2"]').disabled`);
    log('[ok] opened via open-hint, step2 unlocked');
  } else {
    log('[ok] already opened (demo auto-open), step2 unlocked');
  }

  // 步骤 2：确保有选中的章节节点
  await evalInPage(`document.querySelector('.step-item[data-step="2"]').click()`);
  await waitFor(`!document.getElementById('doc-panel').classList.contains('hidden')`);
  const chapOk = await evalInPage(`(function(){
    var rows = document.querySelectorAll('#doc-tree-container .node-row');
    if (rows.length === 0) {
      document.getElementById('doc-add-btn').click();
      rows = document.querySelectorAll('#doc-tree-container .node-row');
    }
    var first = rows[0];
    if (first) first.click();
    return rows.length;
  })()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 0`);
  log('[ok] chapter ready (count=' + chapOk + ')');

  const cbOk = await evalInPage(`(() => { const cb = document.querySelector('#doc-project-tree .node-row.dir > input[type=checkbox]') || document.querySelector('#doc-project-tree input[type=checkbox]'); if(!cb) return 'NO_CB'; cb.checked = true; cb.dispatchEvent(new Event('change', {bubbles:true})); return 'OK'; })()`);
  log('[root cb]', cbOk);
  await waitFor(`(() => { let n=0; document.querySelectorAll('#doc-project-tree input[type=checkbox]').forEach(c=>{if(c.checked)n++;}); return n>0; })()`);
  await evalInPage(`document.getElementById('doc-mount-btn').click()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 1`);
  log('[ok] files mounted into chapter');

  // 步骤 3：关联低层需求
  await evalInPage(`document.querySelector('.step-item[data-step="3"]').click()`);
  await waitFor(`!document.getElementById('rel-panel').classList.contains('hidden')`);
  await evalInPage(`document.getElementById('rel-pick-btn').click()`);
  await waitFor(`(() => { const s=document.getElementById('rel-col-chapter'); return s && s.options.length>1; })()`);
  log('[ok] LLR file loaded');
  await evalInPage(`(() => { for (const id of ['rel-col-chapter','rel-col-id','rel-col-content','rel-col-object']) { const s=document.getElementById(id); if(s && s.options.length>1){ s.value = s.options[1].value; s.dispatchEvent(new Event('change',{bubbles:true})); } } return true; })()`);
  log('[ok] column mapping set');

  // 步骤 4：生成预览
  await evalInPage(`document.querySelector('.step-item[data-step="4"]').click()`);
  await waitFor(`(() => { const t=document.querySelector('#gen-preview tbody'); return t && t.children.length>0; })()`);
  log('[ok] entered step4, gen preview rendered');
  const st1 = await evalInPage(`(() => { const t=document.querySelector('#gen-preview tbody'); const next=document.getElementById('gen-page-next'); const num=document.querySelector('.gen-page-num'); return JSON.stringify({ rows: t?t.children.length:0, hasPager: !!next, nextDisabled: next?next.disabled:null, pageNum: num?num.textContent.trim():null }); })()`);
  log('[gen p1]', st1);
  const shot1 = await screenshot('gen_preview_p1.png');
  log('[shot]', shot1);

  const hasNext = await evalInPage(`(() => { const next=document.getElementById('gen-page-next'); return !!(next && !next.disabled); })()`);
  if (hasNext) {
    await evalInPage(`document.getElementById('gen-page-next').click()`);
    await waitFor(`(() => { const num=document.querySelector('.gen-page-num'); return num && num.textContent.trim().startsWith('2'); })()`);
    const st2 = await evalInPage(`(() => { const t=document.querySelector('#gen-preview tbody'); const num=document.querySelector('.gen-page-num'); return JSON.stringify({ rows: t?t.children.length:0, pageNum: num?num.textContent.trim():null }); })()`);
    log('[gen p2]', st2);
    const shot2 = await screenshot('gen_preview_p2.png');
    log('[shot]', shot2);
  } else {
    log('[gen p2] no next page (total <= 100 rows)');
  }

  const report = await evalInPage(`JSON.stringify({
    genStats: document.getElementById('gen-stats').textContent.trim(),
    scrollH: (document.querySelector('.gen-preview-scroll')||{scrollHeight:0}).scrollHeight,
    headH: (document.querySelector('.gen-preview-head')||{offsetHeight:0}).offsetHeight,
    pagerHTML: (document.querySelector('.gen-pager')||{outerHTML:''}).outerHTML
  })`);
  log('[report]', report);

  ws.close();
  log('DONE');
})().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
