'use strict';
// E2E 复现测试：创建会话 -> 轮询实例状态 -> 读取最新 J002 日志判断推流是否成功
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

async function login() {
  const r = await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  return JSON.parse(r.body).token;
}

function tailLog(n) {
  const dir = 'E:/UPROJECT/J002/Windows/J002/Saved/Logs';
  // 找最新修改的主日志（非 cef3）
  const files = fs.readdirSync(dir).filter((f) => /^J002(_\d+)?\.log$/.test(f))
    .map((f) => ({ f, m: fs.statSync(dir + '/' + f).mtime })).sort((a, b) => b.m - a.m);
  if (!files.length) return '(no log)';
  const lines = fs.readFileSync(dir + '/' + files[0].f, 'utf8').split(/\r?\n/);
  const sf = lines.filter((l) => l.includes('LogStreamForge'));
  return files[0].f + ' (mtime ' + files[0].m.toISOString().slice(11, 19) + ')\n' + sf.slice(-12).join('\n');
}

async function main() {
  const token = await login();
  const mode = process.argv[2]; // 'create' | 'watch' | 'stop'
  if (mode === 'create') {
    const r = await req('POST', '/api/session', { templateId: 2 });
    console.log('CREATE SESSION:', r.status, r.body);
  } else if (mode === 'watch') {
    for (let i = 0; i < 24; i++) {
      const r = await req('GET', '/api/admin/instances', null, token);
      try {
        const j = JSON.parse(r.body);
        const line = (j.instances || []).map((it) =>
          `${it.id} state=${it.state} agentOk=${it.agentOk} stats=${JSON.stringify(it.stats)}`).join(' | ');
        console.log(new Date().toISOString().slice(11, 19), line || '(no instances)');
        const streaming = (j.instances || []).some((it) => it.stats && (it.stats.rtmpOk === true || it.stats.rtmpOk === 'true'));
        if (streaming) { console.log('>>> RTMP OK!'); break; }
      } catch (e) { console.log('parse err', e.message); }
      await new Promise((r2) => setTimeout(r2, 5000));
    }
    console.log('--- LOG TAIL ---');
    console.log(tailLog());
  } else if (mode === 'stop') {
    const r = await req('GET', '/api/admin/instances', null, token);
    const j = JSON.parse(r.body);
    for (const it of j.instances || []) {
      const s = await req('POST', `/api/admin/instances/${it.id}/stop`, null, token);
      console.log('stop', it.id, s.status, s.body.slice(0, 120));
    }
  }
}
main().catch((e) => console.error('ERR', e.message));
