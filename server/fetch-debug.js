// 在页面上下文直接测试 fetch /api/session 并观察网络行为
const http = require('http');
const WebSocket = require('ws');

function getJson(path) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: 9223, path }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

(async () => {
  const targets = await getJson('/json/list');
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); return; }
    if (m.method === 'Network.requestWillBeSent') console.log('>>', m.params.request.method, m.params.request.url);
    if (m.method === 'Network.responseReceived') console.log('<<', m.params.response.status, m.params.response.url);
    if (m.method === 'Network.loadingFailed') console.log('!! FAIL', m.params.errorText, m.params.type);
  });
  await new Promise(r => ws.on('open', r));
  await send('Network.enable');
  await send('Page.enable');
  await send('Page.navigate', { url: 'http://10.3.18.189:3100/player?template=2' });
  await new Promise(r => setTimeout(r, 8000));
  // 页面内手动 fetch 测试
  const r = await send('Runtime.evaluate', {
    expression: `fetch('/api/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templateId:2})}).then(r=>r.text()).then(t=>'OK:'+t.slice(0,120)).catch(e=>'ERR:'+e.message)`,
    awaitPromise: true, returnByValue: true, timeout: 15000,
  });
  console.log('manual fetch result:', JSON.stringify(r.result));
  ws.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
