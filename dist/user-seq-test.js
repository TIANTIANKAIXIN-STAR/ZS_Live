// 复刻用户操作序列：点击视频 -> S 短按(250ms) -> S 长按(2.5s) -> E 键(对照,预期无变化)
// 判定：用户报告的"字母键没反应"是注入 bug 还是感知问题
// 用法: node user-seq-test.js <outDir>
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
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) { pending.get(m.id).resolve(m.result); pending.delete(m.id); }
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

  let vf = -1;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try { vf = await frames(); } catch { vf = -1; }
    if (vf > 30) break;
    console.log('waiting video frames... current:', vf);
  }
  console.log('video frames:', vf);
  if (vf <= 30) { console.log('FAIL: video not playing'); process.exit(2); }

  await sleep(3000);
  await shot('U0_base.png');

  // 1. 复刻用户第一动作：点击视频中心（触发鼠标捕获）
  console.log('--- click video center (replicate user) ---');
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 720, y: 400, button: 'none', pointerType: 'mouse' });
  await sleep(200);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 720, y: 400, button: 'left', buttons: 1, clickCount: 1, pointerType: 'mouse' });
  await sleep(100);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 720, y: 400, button: 'left', buttons: 0, clickCount: 1, pointerType: 'mouse' });
  await sleep(1200);
  await shot('U1_after_click.png');

  // 2. 复刻 S 短按 250ms
  console.log('--- S tap 250ms ---');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await sleep(250);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await sleep(1500);
  await shot('U2_after_S_tap.png');

  // 3. S 长按 2.5 秒
  console.log('--- S hold 2.5s ---');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await sleep(2500);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, nativeVirtualKeyCode: 83 });
  await sleep(1500);
  await shot('U3_after_S_hold.png');

  // 4. E 键（对照：OpenWorld 模板无绑定，预期无变化）
  console.log('--- E press (control, expect no change) ---');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await sleep(500);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69 });
  await sleep(1500);
  await shot('U4_after_E.png');

  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
