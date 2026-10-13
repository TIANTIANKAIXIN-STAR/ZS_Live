// 查看当前实例/会话状态（FFmpeg 后端 e2e 测试收尾用）
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
      resp.on('end', () => resolve({ status: resp.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
(async () => {
  const login = await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' });
  const token = JSON.parse(login.body).token;
  const inst = JSON.parse((await req('GET', '/api/admin/instances', null, token)).body);
  console.log('INSTANCES:');
  for (const it of inst.instances || []) {
    console.log(' ', it.id, 'state=' + it.state, 'agentOk=' + it.agentOk,
      'tpl=' + it.template_id, 'stats=' + JSON.stringify(it.stats || {}));
  }
  if (!(inst.instances || []).length) console.log('  (none)');
  const sess = JSON.parse((await req('GET', '/api/admin/sessions?limit=5', null, token)).body).catch?.(() => ({}));
  const templates = JSON.parse((await req('GET', '/api/admin/templates', null, token)).body);
  console.log('TEMPLATES:');
  for (const t of templates.templates || []) {
    console.log(' ', t.id, t.name, 'backend=' + (t.encoder_backend || 'ave'), 'codec=' + (t.codec || 'h264'), t.width + 'x' + t.height + '@' + t.fps);
  }
  const settings = JSON.parse((await req('GET', '/api/admin/settings', null, token)).body);
  console.log('ffmpegPath=', settings.settings ? settings.settings.ffmpegPath : settings.ffmpegPath);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
