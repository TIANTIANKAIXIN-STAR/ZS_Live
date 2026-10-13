// 模拟浏览器观看端：连接会话 WS 并发送输入事件，验证 控制通道端到端
// 用法: node browser-sim.js <wsUrl>
const WebSocket = require('ws');
const url = process.argv[2];
const ws = new WebSocket(url);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

ws.on('open', async () => {
  console.log('[sim] connected');
  await wait(500);

  // 键盘：W 按下/抬起（移动）
  ws.send(JSON.stringify({ t: 'input', e: { type: 'keydown', key: 'KeyW', charCode: 0 }, mods: {} }));
  console.log('[sim] sent keydown KeyW');
  await wait(800);
  ws.send(JSON.stringify({ t: 'input', e: { type: 'keyup', key: 'KeyW' }, mods: {} }));
  console.log('[sim] sent keyup KeyW');

  // 组合键：Ctrl+K
  ws.send(JSON.stringify({ t: 'input', e: { type: 'keydown', key: 'KeyK', charCode: 107 }, mods: { ctrl: true } }));
  await wait(300);
  ws.send(JSON.stringify({ t: 'input', e: { type: 'keyup', key: 'KeyK' }, mods: {} }));

  // 鼠标：移动 + 左键按下/抬起
  ws.send(JSON.stringify({ t: 'input', e: { type: 'mousemove', x: 0.5, y: 0.5 }, mods: {} }));
  await wait(200);
  ws.send(JSON.stringify({ t: 'input', e: { type: 'mousedown', button: 'left' }, mods: {} }));
  await wait(200);
  ws.send(JSON.stringify({ t: 'input', e: { type: 'mouseup', button: 'left' }, mods: {} }));

  // 滚轮
  ws.send(JSON.stringify({ t: 'input', e: { type: 'wheel', delta: -120 }, mods: {} }));
  console.log('[sim] sent mouse + wheel events');

  await wait(1000);
  // 收一下服务端可能推送的消息
  ws.close();
  console.log('[sim] done');
});

ws.on('message', (m) => {
  const s = m.toString();
  if (s.length < 300) console.log('[sim] recv:', s);
});

ws.on('error', (e) => { console.error('[sim] error:', e.message); process.exit(1); });
ws.on('close', () => process.exit(0));
