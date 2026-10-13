// CDP 驱动 headless Chrome 验证播放器页面真实渲染 + WHEP 拉流，并截图
// 用法: node player-screenshot.js <url> <outPng> [waitMs]
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');

const url = process.argv[2] || 'http://10.3.18.189:3100/player?template=2';
const outPng = process.argv[3] || 'player_shot.png';
const waitMs = parseInt(process.argv[4] || '90000', 10);
const DBG_PORT = 9224;

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  // 等 Chrome 调试端口起来
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try { targets = await getJson('/json/list'); break; } catch { await new Promise(r => setTimeout(r, 500)); }
  }
  if (!targets) throw new Error('chrome debug port not ready');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const consoleLogs = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map(a => a.value !== undefined ? a.value : (a.description || '')).join(' ');
      consoleLogs.push(`[console.${m.params.type}] ${text}`);
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleLogs.push('[exception] ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    }
  });
  await new Promise(r => ws.on('open', r));

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 810, deviceScaleFactor: 1, mobile: false });
  console.log('navigate:', url);
  await send('Page.navigate', { url });

  // 分阶段轮询页面状态
  const t0 = Date.now();
  let lastState = '';
  while (Date.now() - t0 < waitMs) {
    await new Promise(r => setTimeout(r, 5000));
    console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] poll...`);
    try {
      const st = await send('Runtime.evaluate', { expression: `JSON.stringify({state: document.getElementById('stateTag')?.textContent, ov: document.getElementById('ovTitle')?.textContent, video: (()=>{const v=document.querySelector('video'); return v? {readyState:v.readyState, w:v.videoWidth, h:v.videoHeight, t:v.currentTime} : null})()})`, returnByValue: true });
      const s = st.result.value;
      if (s !== lastState) { console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] page:`, s); lastState = s; }
      const parsed = JSON.parse(s);
      if (parsed.video && parsed.video.readyState >= 2 && parsed.video.t > 0.5) {
        console.log('video playing, capturing in 3s...');
        await new Promise(r => setTimeout(r, 3000));
        break;
      }
    } catch (e) { console.log('eval err', e.message); }
  }

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(outPng, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved:', outPng, fs.statSync(outPng).size, 'bytes');
  console.log('--- console logs ---');
  consoleLogs.slice(-40).forEach(l => console.log(l));
  ws.close();
  process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
