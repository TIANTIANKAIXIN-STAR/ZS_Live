// 确定性测试：Backquote 打开 UE 控制台 -> 打字母 s t a t -> 截图
// 验证：1) 键盘注入是否路由到 Slate 游戏 UI（控制台应打开）
//       2) 字符事件是否缺失（控制台输入框应出现 "stat" 文本；若空白则证实 char 事件缺口）
// 用法: node console-type-test.js <outDir>
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
  await shot('T0_base.png');

  // 1. Backquote 打开控制台
  console.log('--- Backquote (open console) ---');
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 });
  await sleep(150);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192 });
  await sleep(1500);
  await shot('T1_console_open.png');

  // 2. 打字母 s t a t（CDP keyDown 带 text 会同时产生 char；但页面只用 e.code 转发 keydown + charCode）
  console.log('--- type "stat" ---');
  for (const [key, code, vk] of [['s','KeyS',83],['t','KeyT',84],['a','KeyA',65],['t','KeyT',84]]) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(120);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await sleep(120);
  }
  await sleep(1200);
  await shot('T2_after_typing.png');

  process.exit(0);
})().catch((e) => { console.error('ERROR', e.message); process.exit(1); });
