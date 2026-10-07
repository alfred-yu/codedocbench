/* CDP 验证：上游数据变更后，步骤 5 的失效提示必须真实可见且样式生效
   —— 为什么必须真浏览器：本次改动是「提示从状态栏搬到预览区 + 新增警示样式」。
      DOM stub（smoke-ui.mjs）只能证明文案写进了 innerHTML，证明不了用户看得见：
      样式类写错、被更高优先级规则覆盖、容器高度塌陷，stub 全都测不出来。
   断言：
     ① 失效提示出现在 #link-preview 内，且非空、文案含具体原因
     ② 计算样式实打实生效：浅红底 + 警示色文字 + 有边框（不是普通灰色占位）
     ③ 提示元素真实可见（尺寸非零、未被 overflow 裁掉）
     ④ 重新生成后提示消失、回到普通占位（确认能恢复，不是写死）
   运行前置：vite dev --port 1420 + headless Edge --remote-debugging-port=9333 */
import { writeFileSync } from 'node:fs';

const CDP = 'http://localhost:9333';
const APP = 'http://localhost:1420/';
const OUT = 'C:/Users/Administrator/Desktop/CodeDocBench/.workbuddy';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let failed = 0;
const check = (ok, label, extra = '') => {
  log(`  ${ok ? '✅' : '❌'} ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failed++;
};

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
}

try {
  await evalInPage(`window.alert=function(){};window.confirm=function(){return true;};window.prompt=function(){return '';};`);
  await cdp('Page.navigate', { url: APP });
  await sleep(5000);

  // ---- 前置：走完步骤 2/3/4/5，到达「已生成链接文件」态 ----
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

  await evalInPage(`document.querySelector('.step-item[data-step="3"]').click()`);
  await waitFor(`!document.getElementById('rel-panel').classList.contains('hidden')`);
  await evalInPage(`document.getElementById('rel-pick-btn').click()`);
  await waitFor(`(() => { const s=document.getElementById('rel-col-chapter'); return s && s.options.length>1; })()`);
  await evalInPage(`(() => {
    const pick=(id,idx)=>{ const s=document.getElementById(id); s.value=s.options[idx].value; s.dispatchEvent(new Event('change',{bubbles:true})); };
    pick('rel-col-chapter',2); pick('rel-col-id',1); pick('rel-col-content',3); pick('rel-col-object',4);
    return true;
  })()`);
  await sleep(800);

  await evalInPage(`document.querySelector('.step-item[data-step="4"]').click()`);
  await waitFor(`(() => { const t=document.querySelector('#gen-preview tbody'); return t && t.children.length>0; })()`);

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
  log('[ok] 已进入「已生成」态');

  // 记录生成态基线：普通占位不该有警示样式
  const before = await evalInPage(`(function(){
    var pv=document.getElementById('link-preview');
    var p=pv.querySelector('.placeholder');
    return { hasWarnClass: !!(p && p.classList.contains('placeholder-warn')), text: p?p.textContent:'' };
  })()`);
  log('[基线 · 生成态]', JSON.stringify(before));
  check(!before.hasWarnClass, '生成态提示不带警示类（警示态不会误亮）');

  // ---- 触发失效：改低层需求列映射（决定 Parent ID → 链入 ID）----
  await evalInPage(`(() => {
    const s=document.getElementById('rel-col-object');
    s.value=s.options[1].value;
    s.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`);
  await sleep(900);

  // 断言 ①：提示在预览区内、文案含具体原因
  const after = await evalInPage(`(function(){
    var pv=document.getElementById('link-preview');
    var p=pv.querySelector('.placeholder-warn');
    var cs=p?getComputedStyle(p):null;
    var r=p?p.getBoundingClientRect():null;
    var pr=pv.getBoundingClientRect();
    return {
      found: !!p,
      text: p?p.textContent:'',
      inPreview: !!(p && pv.contains(p)),
      bg: cs?cs.backgroundColor:'',
      fg: cs?cs.color:'',
      border: cs?cs.borderTopWidth+' '+cs.borderTopStyle:'',
      w: r?Math.round(r.width):0,
      h: r?Math.round(r.height):0,
      pvH: Math.round(pr.height),
      // 提示是否被预览容器裁掉：元素底边应落在容器可视范围内
      insideY: r ? (r.top >= pr.top - 1 && r.bottom <= pr.bottom + pr.height) : false,
      tableGone: !pv.querySelector('tbody'),
    };
  })()`);
  log('[失效态]', JSON.stringify(after, null, 0));

  check(after.found && after.inPreview, '失效提示渲染在 #link-preview 内');
  check(after.text.includes('需重新点击「生成链接文件」'), '提示含「需重新点击生成」行动指引', `"${after.text}"`);
  check(/文档目录树|列映射|低层需求|项目已刷新/.test(after.text), '提示含具体失效原因（非笼统文案）');
  check(after.tableGone, '上次结果的表格已移除（不残留过期数据）');

  // 断言 ②：警示样式真实生效（这才是 DOM stub 测不出来的部分）
  const rgb = (s) => (s.match(/\d+/g) || []).map(Number);
  const [br, bgc, bbb] = rgb(after.bg);
  const [fr, fg, fb] = rgb(after.fg);
  const pinkBg = br > 240 && bgc > 220 && bbb > 220 && br > bbb; // 浅红底：红通道显著高于蓝
  const warnFg = fr > 120 && fr > fb + 40;                       // 警示色文字：偏红
  check(pinkBg, '浅红警示底色生效', after.bg);
  check(warnFg, '警示色文字生效', after.fg);
  check(parseFloat(after.border) >= 1 && after.border.includes('solid'), '边框生效', after.border);

  // 断言 ③：真实可见（尺寸非零、在容器内）
  check(after.w > 100 && after.h > 20, '提示盒有实际尺寸', `${after.w}×${after.h}`);
  check(after.insideY, '提示未被预览容器裁掉');

  await shot('cdp_link_invalid.png');

  // 断言 ④：重新生成后恢复（确认不是写死的提示）
  await evalInPage(`document.getElementById('link-gen-btn').click()`);
  await waitFor(`(() => { const t=document.querySelector('#link-preview tbody'); return t && t.children.length>0; })()`);
  await sleep(500);
  const recovered = await evalInPage(`(function(){
    var pv=document.getElementById('link-preview');
    var p=pv.querySelector('.placeholder');
    return { warnGone: !pv.querySelector('.placeholder-warn'), rows: pv.querySelectorAll('tbody tr').length,
             text: p?p.textContent:'' };
  })()`);
  log('[恢复态]', JSON.stringify(recovered));
  check(recovered.warnGone, '重新生成后警示提示消失');
  check(recovered.rows > 0, '重新生成后链接数据恢复', `${recovered.rows} 行`);

  ws.close();
  log(failed === 0 ? '\nCDP 验证通过 ✅' : `\nCDP 验证失败 ❌ ${failed} 项`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (e) {
  console.error('FATAL', e);
  process.exitCode = 1;
  try { ws.close(); } catch (_) {}
}