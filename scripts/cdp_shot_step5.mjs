/* 文档配图截取：走 demo 模式五步流程，为 docs/images/ 产出步骤 4/5 截图
   —— 复用 cdp_verify_gen.mjs 的 CDP 驱动方式（Target.attachToTarget 取 sessionId）
   产出：09-step5-link.png（步骤 5 配置+预览）、10-step5-paged.png（预览翻页/页脚）
   运行前置：vite dev --port 1420 + headless Edge --remote-debugging-port=9333 */
import { writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9333';
const APP = 'http://localhost:1420/';
const OUT = 'C:/Users/Administrator/Desktop/CodeDocBench/docs/images';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const ver = await fetch(CDP + '/json/version').then((r) => r.json());
const ws = new WebSocket(ver.webSocketDebuggerUrl);
let idc = 0;
const pending = new Map();
let sessionId = null;
ws.addEventListener('message', (ev) => {
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
await new Promise((res) => ws.addEventListener('open', res, { once: true }));

const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
sessionId = (await cdp('Target.attachToTarget', { targetId, flatten: true })).sessionId;
await cdp('Page.enable');
await cdp('Runtime.enable');
await cdp('Emulation.setDeviceMetricsOverride', {
  width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false,
});

async function evalInPage(expr) {
  const r = await cdp('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error('eval: ' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(expr, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try { if (await evalInPage(`!!(${expr})`)) return true; } catch (e) {}
    await sleep(300);
  }
  throw new Error('waitFor timeout: ' + expr);
}
async function shot(name) {
  const r = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(`${OUT}/${name}`, Buffer.from(r.data, 'base64'));
  log('[shot]', name);
}

try {
  await evalInPage(`window.alert=function(){};window.confirm=function(){return true;};window.prompt=function(){return '';};`);
  await cdp('Page.navigate', { url: APP });
  await sleep(5000);

  // 步骤 1 → 2：确保项目已打开 + 建章节 + 勾根目录挂载
  const step2Disabled = await evalInPage(`(function(){var s=document.querySelector('.step-item[data-step="2"]');return s?s.disabled:null;})()`);
  if (step2Disabled) {
    await evalInPage(`(function(){var h=document.getElementById('open-hint');if(h)h.click();})()`);
    await waitFor(`!document.querySelector('.step-item[data-step="2"]').disabled`);
  }
  await evalInPage(`document.querySelector('.step-item[data-step="2"]').click()`);
  await waitFor(`!document.getElementById('doc-panel').classList.contains('hidden')`);
  await evalInPage(`(function(){
    var rows=document.querySelectorAll('#doc-tree-container .node-row');
    if(rows.length===0){document.getElementById('doc-add-btn').click();rows=document.querySelectorAll('#doc-tree-container .node-row');}
    if(rows[0])rows[0].click();return rows.length;
  })()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 0`);
  await evalInPage(`(() => { const cb=document.querySelector('#doc-project-tree .node-row.dir > input[type=checkbox]')||document.querySelector('#doc-project-tree input[type=checkbox]'); if(!cb) return 'NO_CB'; cb.checked=true; cb.dispatchEvent(new Event('change',{bubbles:true})); return 'OK'; })()`);
  await waitFor(`(() => { let n=0; document.querySelectorAll('#doc-project-tree input[type=checkbox]').forEach(c=>{if(c.checked)n++;}); return n>0; })()`);
  await evalInPage(`document.getElementById('doc-mount-btn').click()`);
  await waitFor(`document.querySelectorAll('#doc-tree-container .node-row').length > 1`);
  log('[ok] step2 mounted');

  // 步骤 3：关联低层需求 + 列映射（闸门：必须先完成步骤 2）
  await evalInPage(`document.querySelector('.step-item[data-step="3"]').click()`);
  await waitFor(`!document.getElementById('rel-panel').classList.contains('hidden')`);
  await evalInPage(`document.getElementById('rel-pick-btn').click()`);
  await waitFor(`(() => { const s=document.getElementById('rel-col-chapter'); return s && s.options.length>1; })()`);
  // demo LLR 的列顺序：1=Requirement ID、2=Section、3=Title / Requirement Text、4=Type。
  // 必须按下标分别映射——若都取 options[1]（Requirement ID），章节/ID/内容列会错位，
  // 结果是 Parent ID 全空、链入 ID 也全空，配图会误导读者。
  await evalInPage(`(() => {
    const pick=(id,idx)=>{ const s=document.getElementById(id); s.value=s.options[idx].value; s.dispatchEvent(new Event('change',{bubbles:true})); };
    pick('rel-col-chapter',2); pick('rel-col-id',1); pick('rel-col-content',3); pick('rel-col-object',4);
    return true;
  })()`);
  await sleep(800);
  log('[ok] step3 mapped', await evalInPage(`JSON.stringify({
    chapter: document.getElementById('rel-col-chapter').value,
    id: document.getElementById('rel-col-id').value,
    content: document.getElementById('rel-col-content').value,
    object: document.getElementById('rel-col-object').value })`));

  // 步骤 4：生成预览
  await evalInPage(`document.querySelector('.step-item[data-step="4"]').click()`);
  await waitFor(`(() => { const t=document.querySelector('#gen-preview tbody'); return t && t.children.length>0; })()`);
  log('[ok] step4 preview');

  // 步骤 5：填链入/链出 → 生成链接文件
  await evalInPage(`document.querySelector('.step-item[data-step="5"]').click()`);
  await waitFor(`!document.getElementById('link-panel').classList.contains('hidden')`);
  await evalInPage(`(() => {
    const set=(id,v)=>{const e=document.getElementById(id); e.value=v; e.dispatchEvent(new Event('input',{bubbles:true}));};
    set('link-in-project','飞行管理系统-软件'); set('link-in-module','F346000SWLR008');
    set('link-in-path','飞行管理系统-软件/软件低层需求/');
    set('link-out-project','飞行管理系统-软件'); set('link-out-module','F346000SCTD004');
    set('link-out-path','飞行管理系统-软件/软件CODE文档/');
    return true;
  })()`);
  await evalInPage(`document.getElementById('link-gen-btn').click()`);
  await waitFor(`(() => { const t=document.querySelector('#link-preview tbody'); return t && t.children.length>0; })()`);
  await sleep(600);
  await shot('09-step5-link.png');

  // 翻到第 2 页看页脚分页（若只有一页则跳过，另截当前页脚）
  const hasNext = await evalInPage(`(() => { const b=document.querySelector('#link-preview .gen-page-next')||document.getElementById('link-page-next'); return !!(b && !b.disabled); })()`);
  if (hasNext) {
    await evalInPage(`(function(){var b=document.getElementById('link-page-next')||document.querySelector('#link-preview .gen-page-next'); b.click(); return true;})()`);
    await sleep(600);
    await shot('10-step5-paged.png');
    log('[ok] paged shot taken');
  } else {
    log('[skip] 链接预览仅一页，未单独截分页图');
  }

  const stat = await evalInPage(`JSON.stringify({ stats: document.getElementById('link-stats').textContent.replace(/\\s+/g,' ').trim(), rows: document.querySelectorAll('#link-preview tbody tr').length })`);
  log('[link stats]', stat);
  ws.close();
  log('DONE');
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
  try { ws.close(); } catch (_) {}
}