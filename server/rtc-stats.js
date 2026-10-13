// 读取页面内 RTCPeerConnection 统计，判断视频是否解码
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
  const page = targets.find(t => t.type === 'page' && t.url.includes('player'));
  if (!page) { console.log('no player tab'); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map();
  const send = (m, p = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  ws.on('message', (raw) => { const m = JSON.parse(raw); if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); } });
  await new Promise(r => ws.on('open', r));
  await send('Runtime.enable');
  const expr = `(async () => {
    const v = document.querySelector('video');
    const pc = window.__pc || (window.state && state.pc);
    // 从 player.js 的 state 找 pc
    let pcObj = null;
    try { pcObj = (typeof state !== 'undefined') ? state.pc : null; } catch(e) {}
    if (!pcObj) return JSON.stringify({err:'no pc in state', keys: (typeof state!=='undefined')?Object.keys(state):null});
    const stats = await pcObj.getStats();
    const out = [];
    stats.forEach(s => {
      if (s.type === 'inbound-rtp') out.push({kind:s.kind, framesReceived:s.framesReceived, framesDecoded:s.framesDecoded, framesDropped:s.framesDropped, bytesReceived:s.bytesReceived, packetsLost:s.packetsLost, decoderImplementation:s.decoderImplementation, frameWidth:s.frameWidth, frameHeight:s.frameHeight});
      if (s.type === 'codec') out.push({codec:s.mimeType, pt:s.payloadType});
      if (s.type === 'candidate-pair' && s.state==='succeeded') out.push({pair:'succeeded', bytesSent:s.bytesSent, bytesReceived:s.bytesReceived});
    });
    return JSON.stringify({video:{rs:v?.readyState, err:v?.error?.code, w:v?.videoWidth, t:v?.currentTime, paused:v?.paused}, pcState:pcObj.connectionState, ice:pcObj.iceConnectionState, stats:out});
  })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(r.result.value || JSON.stringify(r));
  ws.close(); process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
