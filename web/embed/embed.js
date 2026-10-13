/* ZS Live 嵌入页：WHEP 拉流 + 控制通道 + 父页面 postMessage 桥接
 *
 * URL 参数：template（模板ID）、streamId（多路标识）、autoconnect=1、muted=1
 *
 * 父页面 -> 嵌入页（source: 'zslive-parent'）：
 *   {type:'invoke', module, action, params}   -> UE 指令 <module>.<action>
 *   {type:'camera', action, params}           -> UE 指令 camera.<action>
 *   {type:'command', name, payload}           -> UE 自定义指令
 *   {type:'sendRaw', descriptor}              -> JSON 字符串指令（自动解析）
 *   {type:'keyboard', phase, code, key, ...}  -> 父页面转发的按键
 *   {type:'focus'} / {type:'disconnect'}
 *
 * 嵌入页 -> 父页面（source: 'zslive-embed'）：
 *   {type:'event', event, data, streamId}
 *   event: ready / assigned / streaming / inputready / platform / error / ue
 *          / pointerover / pointerout / disconnected / adaptive / session_warn
 */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');

const qs = new URLSearchParams(location.search);
const CFG = {
  template: qs.get('template') || '',
  node: qs.get('node') || '', // 集群：指定渲染节点
  streamId: (qs.get('streamId') || '').trim(),
  autoconnect: qs.get('autoconnect') !== '0',
};

const state = {
  session: null, ws: null, pc: null, whepUrl: null,
  keysDown: new Set(), started: false,
};

/* ---------------- 父页面通信 ---------------- */

const inIframe = window.parent && window.parent !== window;

function toParent(event, data) {
  if (!inIframe) return;
  window.parent.postMessage({
    source: 'zslive-embed', streamId: CFG.streamId || undefined,
    type: 'event', event, data,
  }, '*');
}

function platform(code, extra) {
  toParent('platform', { code, ...(extra || {}) });
}

/* ---------------- UI ---------------- */

function showOverlay(title, sub, isError) {
  overlay.classList.remove('hidden');
  overlay.classList.toggle('err', !!isError);
  $('ovTitle').textContent = title;
  $('ovSub').textContent = sub || '';
  $('btnRetry').style.display = isError ? '' : 'none';
}
function hideOverlay() { overlay.classList.add('hidden'); }
function showError(title, sub, code) {
  showOverlay(title, sub, true);
  toParent('error', { code: code || 'ZS_UNKNOWN', message: title, detail: sub || '' });
}

/* ---------------- 会话 ---------------- */

async function requestSession() {
  showOverlay('正在请求推流实例…', '首次拉起约需 20~60 秒');
  platform('ZS_INFO_7003');

  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: CFG.template ? parseInt(CFG.template, 10) : undefined,
      nodeId: CFG.node || undefined, // 集群：路由到指定渲染节点
    }),
  });
  const data = await res.json();
  if (!data.ok) {
    showError(data.message || '会话请求失败', data.hint || data.detail || data.error || '', data.code);
    return;
  }

  state.session = { id: data.sessionId, token: data.token, nodeId: data.nodeId || null };
  state.baseUrl = data.baseUrl || ''; // 集群：会话所在节点地址（释放时回调用）
  adaptiveSetConfig(data.adaptive, data.targetBitrateKbps);
  connectWs(data.wsUrl);

  if (data.queued) {
    showOverlay('当前繁忙，排队等待中…', `第 ${data.position} 位`);
    platform('ZS_POOL_2001');
    platform('ZS_INFO_7001');
    return;
  }

  state.whepUrl = data.whepUrl;
  platform('ZS_OK_8002');
  if (data.state === 'ready') startStream(data.whepUrl);
  else { showOverlay('UE 实例启动中…', '渲染引擎正在加载，请稍候'); platform('ZS_POOL_2002'); }
}

/* ---------------- 控制通道 ---------------- */

function connectWs(url) {
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onopen = () => { toParent('ready', {}); platform('ZS_OK_8001'); };

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case 'assigned':
        state.whepUrl = msg.whepUrl;
        adaptiveSetConfig(msg.adaptive, msg.targetBitrateKbps);
        platform('ZS_OK_8002');
        toParent('assigned', { instanceId: msg.instanceId });
        if (msg.state === 'ready') startStream(msg.whepUrl);
        else showOverlay('UE 实例启动中…', '渲染引擎正在加载，请稍候');
        break;
      case 'ready':
        state.whepUrl = msg.whepUrl;
        adaptiveSetConfig(msg.adaptive, msg.targetBitrateKbps);
        platform('ZS_OK_8003');
        startStream(msg.whepUrl);
        break;
      case 'queue_update':
        showOverlay('排队等待中…', `第 ${msg.position} 位 / 共 ${msg.total} 人，预计 ${Math.round(msg.estimatedWait / 60)} 分钟`);
        platform('ZS_INFO_7002', { position: msg.position, total: msg.total, estimatedWait: msg.estimatedWait });
        break;
      case 'queue_cancelled':
        teardown();
        showError('排队已取消', '管理员取消了本次排队', 'ZS_WS_3003');
        break;
      case 'session_ended':
        teardown();
        showError('会话已结束', msg.reason === 'timeout' ? '会话超时，系统已自动释放实例' : '原因: ' + msg.reason, 'ZS_WS_3003');
        toParent('disconnected', { reason: msg.reason });
        break;
      case 'session_warn':
        toParent('session_warn', { remainSec: msg.remainSec });
        break;
      case 'instance_dead':
        showOverlay('实例异常，正在切换…', '系统正在分配新的渲染实例');
        platform('ZS_POOL_2004');
        break;
      case 'ue_event':
        toParent('ue', { name: msg.name, data: msg.data });
        break;
    }
  };

  ws.onclose = () => {
    platform('ZS_WS_3002');
    if (state.session) setTimeout(() => { if (state.session) connectWs(url); }, 3000);
  };
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
}

/** 向 UE 发送业务指令 */
function sendCommand(name, payload) {
  send({ t: 'command', name: String(name), payload: payload == null ? '' : payload });
}

/** 彻底断开：停 WS 重连、关媒体连接、释放按键。主动断开/会话结束后调用，不再自动重连 */
function teardown() {
  state.session = null;
  state.whepUrl = null;
  for (const code of [...state.keysDown]) {
    send({ t: 'input', e: { type: 'keyup', key: code } });
  }
  state.keysDown.clear();
  try { if (state.ws) state.ws.close(); } catch { /* ignore */ }
  state.ws = null;
  try { if (state.pc) state.pc.close(); } catch { /* ignore */ }
  state.pc = null;
  video.srcObject = null;
  $('btnSound').style.display = 'none';
}

/* ---------------- WHEP 拉流 ---------------- */

async function startStream(whepUrl) {
  showOverlay('正在建立低延迟视频连接…', '');
  platform('ZS_INFO_7004');

  const pc = new RTCPeerConnection();
  state.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (ev) => {
    if (ev.streams[0]) video.srcObject = ev.streams[0];
    // 保持 muted 自动播放（浏览器策略），声音由用户手势开启
    video.play().catch(() => {});
    if (!state.started) {
      state.started = true;
      toParent('streaming', {});
      platform('ZS_OK_8005');
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      hideOverlay();
      $('btnSound').style.display = '';
      video.play().catch(() => {});
      toParent('inputready', {});
      platform('ZS_OK_8006');
    } else if (pc.connectionState === 'failed') {
      platform('ZS_RTC_4003');
      retryStream();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 2000);
  });

  try {
    const res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const answer = await res.text();
    await pc.setRemoteDescription({ type: 'answer', sdp: answer });
  } catch (e) {
    showError('媒体连接失败', 'WHEP 协商失败: ' + e.message, 'ZS_RTC_4002');
    return;
  }

  attachInput();
}

async function retryStream() {
  if (!state.session || !state.whepUrl) return; // 会话已结束/主动断开：不再重试
  try { if (state.pc) state.pc.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1500));
  startStream(state.whepUrl).catch((e) => showError('媒体连接失败', e.message, 'ZS_RTC_4002'));
}

/* ---------------- 自适应降档（adaptiveEnabled 开启时） ---------------- */

const adaptive = {
  enabled: false, targetKbps: 0,
  tier: 0, // 0 = 满配；1 = 降 40%；2 = 降 65%
  badStreak: 0, goodStreak: 0, lastLost: 0, lastRecv: 0,
};

function adaptiveSetConfig(enabled, targetKbps) {
  adaptive.enabled = !!enabled && targetKbps > 0;
  adaptive.targetKbps = targetKbps || 0;
  adaptive.tier = 0;
  adaptive.badStreak = adaptive.goodStreak = 0;
  adaptive.lastLost = adaptive.lastRecv = 0;
}

function adaptiveApply() {
  if (!adaptive.enabled) return;
  const factor = [1, 0.6, 0.35][adaptive.tier];
  const kbps = Math.max(800, Math.round(adaptive.targetKbps * factor));
  send({ t: 'command', name: 'sf_set_bitrate', payload: String(kbps) });
  toParent('adaptive', { tier: adaptive.tier, kbps, targetKbps: adaptive.targetKbps });
}

function adaptiveTick() {
  if (!adaptive.enabled || !state.pc) return;
  state.pc.getStats().then((stats) => {
    let lost = 0, recv = 0, rtt = 0;
    stats.forEach((r) => {
      if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
        lost = r.packetsLost || 0; recv = r.packetsReceived || 0;
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded') rtt = Math.round(r.currentRoundTripTime * 1000);
    });
    const dLost = lost - adaptive.lastLost, dRecv = recv - adaptive.lastRecv;
    adaptive.lastLost = lost; adaptive.lastRecv = recv;
    if (dRecv < 20) return;
    const lossRate = dLost > 0 ? dLost / (dLost + dRecv) : 0;
    if (lossRate > 0.05 || rtt > 250) { adaptive.badStreak++; adaptive.goodStreak = 0; }
    else if (lossRate < 0.005 && rtt > 0 && rtt < 100) { adaptive.goodStreak++; adaptive.badStreak = 0; }
    else { adaptive.badStreak = 0; adaptive.goodStreak = 0; }
    if (adaptive.badStreak >= 3 && adaptive.tier < 2) { adaptive.tier++; adaptiveApply(); }
    else if (adaptive.goodStreak >= 10 && adaptive.tier > 0) { adaptive.tier--; adaptiveApply(); }
  }).catch(() => { /* ignore */ });
}

setInterval(adaptiveTick, 2000);

/* ---------------- 输入 ---------------- */

let inputAttached = false; // 原地重连（btnRetry）时防止重复挂载输入监听

function attachInput() {
  if (inputAttached) return;
  inputAttached = true;
  window.addEventListener('keydown', (e) => {
    if (isTypingTarget(e)) return;
    if (!state.keysDown.has(e.code)) {
      state.keysDown.add(e.code);
      send({ t: 'input', e: { type: 'keydown', key: e.code, charCode: e.key.length === 1 ? e.key.charCodeAt(0) : 0 }, mods: modOf(e) });
    }
    if (['F11', 'F5', 'F12'].indexOf(e.code) < 0) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (isTypingTarget(e)) return;
    state.keysDown.delete(e.code);
    send({ t: 'input', e: { type: 'keyup', key: e.code }, mods: modOf(e) });
  });

  let lastMove = 0;
  video.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMove < 33) return;
    lastMove = now;
    const r = video.getBoundingClientRect();
    send({ t: 'input', e: { type: 'mousemove', x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }, mods: modOf(e) });
  });
  video.addEventListener('mousedown', (e) => { send({ t: 'input', e: { type: 'mousedown', button: String(e.button) }, mods: modOf(e) }); e.preventDefault(); });
  video.addEventListener('mouseup', (e) => send({ t: 'input', e: { type: 'mouseup', button: String(e.button) }, mods: modOf(e) }));
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  // delta = 浏览器 deltaY（正=向下）；UE 侧翻转为 WheelDelta 并归一化为 ±1
  video.addEventListener('wheel', (e) => { send({ t: 'input', e: { type: 'wheel', delta: e.deltaY }, mods: modOf(e) }); e.preventDefault(); }, { passive: false });

  // 悬停状态上报父页面（父页面据此转发按键，解决业务页抢焦点）
  video.addEventListener('pointerenter', () => toParent('pointerover', {}));
  video.addEventListener('pointerleave', () => { toParent('pointerout', {}); releaseAllKeys(); });
}

function releaseAllKeys() {
  for (const code of [...state.keysDown]) {
    send({ t: 'input', e: { type: 'keyup', key: code } });
  }
  state.keysDown.clear();
}

function modOf(e) { return { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey }; }
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function isTypingTarget(e) { return e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName); }

/* ---------------- 父页面指令 ---------------- */

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || msg.source !== 'zslive-parent') return;
  // 多路场景：streamId 不匹配的消息不处理（未设置 streamId 时全部接受）
  if (CFG.streamId && msg.streamId && msg.streamId !== CFG.streamId) return;

  switch (msg.type) {
    case 'invoke':
      sendCommand(`${msg.module}.${msg.action}`, msg.params || {});
      break;
    case 'camera':
      sendCommand(`camera.${msg.action}`, msg.params || {});
      break;
    case 'command':
      sendCommand(msg.name, msg.payload);
      break;
    case 'sendRaw': {
      let desc = msg.descriptor;
      try {
        const obj = JSON.parse(desc);
        if (obj && (obj.module || obj.api) && obj.action) {
          sendCommand(`${obj.module || obj.api}.${obj.action}`, obj.params || obj.payload || {});
        } else if (obj && obj.name) {
          sendCommand(obj.name, obj.payload);
        } else {
          sendCommand('raw', desc);
        }
      } catch {
        sendCommand('raw', String(desc));
      }
      break;
    }
    case 'keyboard': {
      const down = msg.phase === 'down' || msg.phase === 'press';
      if (down) {
        if (state.keysDown.has(msg.code) && msg.phase === 'down') break;
        state.keysDown.add(msg.code);
        send({ t: 'input', e: { type: 'keydown', key: msg.code, charCode: msg.charCode || (msg.key && msg.key.length === 1 ? msg.key.charCodeAt(0) : 0) } });
      } else {
        state.keysDown.delete(msg.code);
        send({ t: 'input', e: { type: 'keyup', key: msg.code } });
      }
      break;
    }
    case 'focus':
      try { window.focus(); video.focus(); } catch { /* ignore */ }
      break;
    case 'disconnect':
      releaseSession().finally(() => {
        showOverlay('已断开', '父页面请求断开连接');
        toParent('disconnected', { reason: 'parent_disconnect' });
        platform('ZS_OK_8007');
      });
      break;
  }
});

async function releaseSession() {
  if (!state.session) return;
  const id = state.session.id;
  const nodeId = state.session.nodeId || null;
  const baseUrl = state.baseUrl || '';
  teardown();
  await fetch(`${baseUrl}/api/session/release`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: id, nodeId }),
  }).catch(() => {});
}

/* ---------------- 按钮 / 启动 ---------------- */

$('btnSound').onclick = () => { video.muted = false; $('btnSound').style.display = 'none'; };
$('btnRetry').onclick = () => { state.started = false; requestSession().catch((e) => showError('无法启动会话', e.message, 'ZS_API_6001')); };

if (CFG.autoconnect) {
  requestSession().catch((e) => showError('无法启动会话', e.message, 'ZS_API_6001'));
} else {
  showOverlay('等待连接指令', '父页面发送 connect 后开始');
}
