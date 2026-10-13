// 配置 ffmpegPath + 创建 FFmpeg 后端测试模板
const http = require('http');
function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (token) headers.Authorization = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: 3100, path, method, headers }, (resp) => {
      let b = ''; resp.on('data', (c) => { b += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, body: b }));
    });
    r.on('error', reject);
    if (data) r.write(data); r.end();
  });
}
(async () => {
  const cmd = process.argv[2] || 'setup';
  const token = JSON.parse((await req('POST', '/api/admin/login', { username: 'admin', password: 'admin123' })).body).token;

  if (cmd === 'setup') {
    // 1. 配 ffmpeg 绝对路径
    const s = await req('PUT', '/api/admin/settings', { ffmpegPath: 'F:\\streamming\\ZS_Live\\ffmpeg\\ffmpeg.exe' }, token);
    console.log('SET_FFMPEG_PATH:', s.status);
    // 2. 列出现有模板（找 UEtest exe 路径参考）
    const tpls = JSON.parse((await req('GET', '/api/admin/templates', null, token)).body).templates;
    tpls.forEach((t) => console.log('TPL', t.id, t.name, t.exe_path, 'backend=' + (t.encoder_backend || 'auto')));
    // 3. 创建 FFmpeg 软编码测试模板（已存在则跳过）
    const exist = tpls.find((t) => t.name === 'UEtest-软编码兜底测试');
    if (exist) { console.log('TEST_TPL_EXISTS id=', exist.id); return; }
    const ueT = tpls.find((t) => /UEtest/i.test(t.exe_path));
    const exePath = ueT ? ueT.exe_path : 'F:\\streamming\\ZS_Live\\UETest\\Package\\Windows\\UEtest.exe';
    const c = await req('POST', '/api/admin/templates', {
      name: 'UEtest-软编码兜底测试',
      description: '编码后端=FFmpeg(libx264 软编码)，验证无 NVENC 也能推流；砺算接入前的兜底链路自证',
      exe_path: exePath,
      width: 1280, height: 720, fps: 30, bitrate_kbps: 4000,
      encoder_backend: 'ffmpeg',
    }, token);
    console.log('CREATE_TPL:', c.status, c.body.slice(0, 300));
  }

  if (cmd === 'start') {
    const tpls = JSON.parse((await req('GET', '/api/admin/templates', null, token)).body).templates;
    const t = tpls.find((x) => x.name === 'UEtest-软编码兜底测试');
    if (!t) { console.log('NO_TEST_TPL'); return; }
    const r = await req('POST', '/api/session', { templateId: t.id });
    console.log('SESSION:', r.status, r.body.slice(0, 200));
  }
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
