// J002 4K auto 模板完整验证：会话 → 实例 → MediaMTX 流
const http = require('http');
function req(method, path, body, token) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    if (token) h.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: 3100, path, method, headers: h }, (resp) => {
      let b = ''; resp.on('data', (c) => b += c); resp.on('end', () => res({ status: resp.statusCode, body: b }));
    });
    r.on('error', rej);
    if (data) r.write(data);
    r.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const token = JSON.parse((await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' })).body).token;
  const c = await req('POST', '/api/session', { templateId: 2 });
  if (c.status !== 200) { console.log('CREATE FAIL', c.body); process.exit(1); }
  const sess = JSON.parse(c.body);
  console.log('session', sess.sessionId, 'instance', sess.instanceId);
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const j = JSON.parse((await req('GET', '/api/admin/instances', null, token)).body);
    const it = (j.instances || []).find((x) => x.id === sess.instanceId);
    if (!it) { console.log('instance gone'); break; }
    const s = it.stats || {};
    console.log(`t+${(i + 1) * 5}s state=${it.state} agentOk=${it.agentOk} rtmpOk=${s.rtmpOk} sentMB=${(s.sentMB || 0).toFixed(1)} reconnects=${s.reconnects}`);
    if (s.rtmpOk && (s.sentMB || 0) > 3) { console.log('>>> STREAMING OK'); break; }
  }
  // MediaMTX API 验证流
  const mtx = await new Promise((res) => {
    http.get('http://127.0.0.1:9997/v3/paths/list', (r) => { let b = ''; r.on('data', (c) => b += c); r.on('end', () => res(JSON.parse(b))); }).on('error', () => res(null));
  });
  if (mtx) {
    const p = (mtx.items || []).find((x) => x.name.includes(sess.instanceId));
    console.log('MTX path:', p ? JSON.stringify({ name: p.name, ready: p.ready, tracks: p.tracks, bytesReceived: p.bytesReceived }) : 'NOT FOUND');
  }
  await req('POST', '/api/session/release', { sessionId: sess.sessionId });
  console.log('released');
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
