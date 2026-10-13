// 模拟播放器前端的控制通道流程：创建会话 → 连 WS → 监听 assigned/ready
// 验证 controlHub 新增的 ready 推送与整体会话分配逻辑
// 用法: node player-flow-test.js [templateId]
'use strict';
const WebSocket = require('ws');

async function main() {
  const templateId = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  const res = await fetch('http://127.0.0.1:3100/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(templateId ? { templateId } : {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error('session failed: ' + JSON.stringify(data));
  console.log('[flow] session created:', data.sessionId, 'state:', data.state, 'queued:', !!data.queued);

  const ws = new WebSocket(data.wsUrl);
  ws.on('open', () => console.log('[flow] ws connected'));
  ws.on('message', (m) => {
    const s = m.toString();
    console.log('[flow] recv:', s.length < 400 ? s : s.slice(0, 400) + '...');
  });
  ws.on('error', (e) => { console.error('[flow] ws error:', e.message); process.exit(1); });

  // 运行 150s：足够覆盖 starting → ready 流转
  setTimeout(() => { console.log('[flow] done'); ws.close(); process.exit(0); }, 150000);
}

main().catch((e) => { console.error('[flow]', e.message); process.exit(1); });
