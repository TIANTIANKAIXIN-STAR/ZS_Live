'use strict';
const http = require('http');
const fs = require('fs');
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: 3100, path, method, headers }, (resp) => {
      let b = '';
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const token = JSON.parse((await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' })).body).token;
  let target = process.argv[2] || '';
  for (let i = 0; i < 20; i++) {
    const j = JSON.parse((await req('GET', '/api/admin/instances', null, token)).body);
    if (!target) {
      const first = (j.instances || []).find((x) => x.state !== 'stopping' && x.state !== 'dead');
      if (first) target = first.id;
    }
    const it = (j.instances || []).find((x) => x.id === target);
    if (!it) { console.log(new Date().toISOString().slice(11, 19), 'instance', target || '(none)', 'gone'); }
    else {
      console.log(new Date().toISOString().slice(11, 19), `state=${it.state} agentOk=${it.agentOk} stats=${JSON.stringify(it.stats)}`);
      if (it.stats && it.stats.rtmpOk === true) { console.log('>>> RTMP OK'); break; }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  // 最新 J002 日志
  const dir = 'E:/UPROJECT/J002/Windows/J002/Saved/Logs';
  const files = fs.readdirSync(dir).filter((f) => /^J002(_\d+)?\.log$/.test(f)).map((f) => ({ f, m: fs.statSync(dir + '/' + f).mtime })).sort((a, b) => b.m - a.m);
  const lines = fs.readFileSync(dir + '/' + files[0].f, 'utf8').split(/\r?\n/);
  const sf = lines.filter((l) => l.includes('LogStreamForge'));
  console.log('--- ' + files[0].f + ' SF tail ---');
  console.log(sf.slice(-14).join('\n'));
})();
