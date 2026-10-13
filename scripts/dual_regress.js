// 双模板回归：ffmpeg 后端 + auto(NVENC) 后端
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

async function runRound(token, templateId, label) {
  const c = await req('POST', '/api/session', { templateId });
  if (c.status !== 200) { console.log(`[${label}] CREATE FAIL`, c.status, c.body.slice(0, 150)); return false; }
  const sess = JSON.parse(c.body);
  console.log(`[${label}] session=${sess.sessionId} instance=${sess.instanceId}`);
  let ok = false;
  for (let i = 0; i < 24; i++) {
    await sleep(5000);
    const j = JSON.parse((await req('GET', '/api/admin/instances', null, token)).body);
    const it = (j.instances || []).find((x) => x.id === sess.instanceId);
    if (!it) { console.log(`[${label}]   instance gone (restart loop?)`); break; }
    const s = it.stats || {};
    console.log(`[${label}]   t+${(i + 1) * 5}s state=${it.state} agentOk=${it.agentOk} rtmpOk=${s.rtmpOk} sentMB=${(s.sentMB || 0).toFixed(1)} backend=${s.encoderBackend || '?'} err=${it.lastError || ''}`);
    if (s.rtmpOk === true && (s.sentMB || 0) > 1) { ok = true; break; }
    if (it.lastError) break;
  }
  await req('POST', '/api/session/release', { sessionId: sess.sessionId });
  console.log(`[${label}] => ${ok ? 'PASS' : 'FAIL'}`);
  await sleep(4000);
  return ok;
}

(async () => {
  const token = JSON.parse((await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' })).body).token;
  const r1 = await runRound(token, 3, 'FFmpeg软编码');
  const r2 = await runRound(token, 2, 'Auto(NVENC)');
  console.log(`\n==== RESULT: ffmpeg=${r1 ? 'PASS' : 'FAIL'} nvenc=${r2 ? 'PASS' : 'FAIL'} ====`);
  process.exit(r1 && r2 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
