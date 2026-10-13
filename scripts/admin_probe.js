'use strict';
// 诊断脚本：登录管理后台，列出模板/实例/设置，可选：修改预设并创建会话复现 Bug
const http = require('http');

function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: 3100, path, method, headers }, (resp) => {
      let b = '';
      resp.on('data', (c) => { b += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  const cmd = process.argv[2] || 'status';
  const login = await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  if (login.status !== 200) { console.log('LOGIN FAILED', login.status, login.body); return; }
  const token = JSON.parse(login.body).token;
  console.log('LOGIN OK');

  if (cmd === 'status') {
    const tpl = JSON.parse((await req('GET', '/api/admin/templates', null, token)).body);
    console.log('== TEMPLATES ==');
    console.log(JSON.stringify(tpl.templates || tpl, null, 1).slice(0, 3000));
    const inst = await req('GET', '/api/admin/instances', null, token);
    console.log('== INSTANCES ==', inst.status);
    console.log(inst.body.slice(0, 2500));
    const st = await req('GET', '/api/admin/settings', null, token);
    console.log('== SETTINGS ==', st.status);
    console.log(st.body.slice(0, 1500));
  } else if (cmd === 'preset') {
    // 用法: node admin_probe.js preset <templateId> <width> <height> <fps> <bitrate>
    const id = process.argv[3], w = process.argv[4], h = process.argv[5], fps = process.argv[6], br = process.argv[7];
    const tplR = JSON.parse((await req('GET', '/api/admin/templates', null, token)).body);
    const t = (tplR.templates || []).find((x) => String(x.id) === String(id));
    if (!t) { console.log('template not found:', id, 'have', (tplR.templates || []).map((x) => x.id)); return; }
    const upd = { ...t, width: +w, height: +h, fps: +fps, bitrate_kbps: +br };
    const r = await req('PUT', `/api/admin/templates/${id}`, upd, token);
    console.log('UPDATE', r.status, r.body.slice(0, 500));
  } else if (cmd === 'session') {
    const id = process.argv[3];
    const r = await req('POST', '/api/sessions', { templateId: id });
    console.log('SESSION', r.status, r.body.slice(0, 800));
  } else if (cmd === 'instances') {
    const r = await req('GET', '/api/admin/instances', null, token);
    console.log(r.body.slice(0, 3000));
  } else if (cmd === 'stopall') {
    const r = await req('POST', '/api/admin/instances/stop-all', null, token);
    console.log('STOPALL', r.status, r.body.slice(0, 300));
  }
}
main().catch((e) => console.error('ERR', e.message));
