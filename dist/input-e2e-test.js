// CDP 实证测试：浏览器注入 W 键（飞行前进）与鼠标拖拽（视角旋转），截图对比画面是否变化
// 判定键盘/鼠标注入是否真正到达 UE 游戏输入
// 用法: node input-e2e-test.js <outDir>
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const outDir = process.argv[2] || '.';
const DBG_PORT = 9223;
const PLAYER_URL = 'http://127.0.0.1:3100/player?template=2';

function getJson(p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: DBG_PORT, path: p }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  let targets = null;
  for (let i = 0; i < 30; i++) {
    try { targets = await getJson('/json/list'); break; } catch { await sleep(500); }
  }
  if (!targets) throw new Error('edge debug port not ready');
  const page = targets.find((t) => t.type === 'page' && /\/player/.test(t.url)) || targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  let id = 0;
  const pending = new Map();
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
    setTimeout(() => { if (pending.has(mid)) { pending.get(mid).reject(new Error('timeout ' + method)); pending.delete(mid); } }, 20000);
  });
  const evals = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
    if (m.method === 'Runtime.consoleAPICalled') {
      evals.push(`[console.${m.params.type}] ${(m.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || '')).join(' ')}`);
    }
  });
  await new Promise((r) => ws.on('open', r));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 810, deviceScaleFactor: 1, mobile: false });

  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(outDir, name);
    fs.writeFileSync(f, Buffer.from(r.data, 'base64'));
    console.log('saved', f);
    return f;
  };
  const frames = async () => {
    const expr = '(function(){const v=document.querySelector("video"); if(!v) return -2; if(v.getVideoPlaybackQuality) return v.getVideoPlaybackQuality().totalVideoFrames; return v.readyState;})()';
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: false, returnByValue: true });
    return r.result ? r.result.value : -3;
  };

  // 等视频开始解码
  let vf = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try { vf = await frames(); } catch { vf = -1; }
    if (vf > 30) break;
    console.log('waiting video frames... current:', vf);
  }
  console.log('video frames:', vf);
  if (vf <= 30) { console.log('FAIL: video not playing'); console.log(evals.join('\n')); process.exit(2); }

  await sleep(3000); // 画面稳定
  await shot('A_static.png');
  await sleep(2000);
  await shot('B_static2.png'); // 无输入基线（视频编码噪声）

  // 键盘测试：按住 W 2.5 秒（DefaultPawn 前进）
  console.log('--- keydown W (hold 2.5s) ---');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await sleep(2500);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87 });
  await sleep(1500);
  await shot('C_after_W.png');

  // 鼠标测试：按住左键从中心拖到右侧（DefaultPawn 视角旋转）
  console.log('--- mouse look (LMB drag right) ---');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 400, button: 'none', pointerType: 'mouse' });
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 720, y: 400, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  for (let i = 1; i <= 12; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720 + i * 30, y: 400, button: 'left', buttons: 1, pointerType: 'mouse' });
    await sleep(80);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 1080, y: 400, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1500);
  await shot('D_after_look.png');

  console.log('=== console log ===');
  console.log(evals.slice(-30).join('\n'));
  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
