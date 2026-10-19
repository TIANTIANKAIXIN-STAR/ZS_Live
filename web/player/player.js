/* ZS Live 播放器：WHEP(WebRTC) 拉流 + WebSocket 控制通道 */
'use strict';

const $ = (id) => document.getElementById(id);
const video = $('video');
const overlay = $('overlay');
const stateTag = $('stateTag');

const state = {
  session: null,
  ws: null,
  pc: null,
  whepUrl: null,
  audioEgress: null,
  keysDown: new Set(),
};

function setState(text, cls) {
  stateTag.textContent = text;
  stateTag.className = 'tag' + (cls ? ' ' + cls : '');
}

function showOverlay(title, sub, isError) {
  overlay.classList.remove('hidden');
  overlay.classList.toggle('err', !!isError);
  $('ovTitle').textContent = title;
  $('ovSub').textContent = sub || '';
}
function hideOverlay() { overlay.classList.add('hidden'); }

/* ---------------- 会话请求 ---------------- */

async function requestSession() {
  setState('请求实例', 'warn');
  showOverlay('正在请求推流实例…', '首次拉起约需 20~60 秒');

  const qs = new URLSearchParams(location.search);
  const templateId = qs.get('template');
  const nodeId = qs.get('node') || undefined; // 集群：指定渲染节点
  const res = await fetch('/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      templateId: templateId ? parseInt(templateId, 10) : undefined,
      nodeId,
    }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || '请求失败');

  state.session = { id: data.sessionId, token: data.token, nodeId: data.nodeId || null };
  state.baseUrl = data.baseUrl || ''; // 集群：会话所在节点地址（释放时回调用）

  if (data.queued) {
    setState('排队中', 'warn');
    showOverlay('当前繁忙，排队等待中…', `第 ${data.position} 位`);
    connectWs(data.wsUrl);
    return;
  }

  state.whepUrl = data.whepUrl;
  adaptiveSetConfig(data.adaptive, data.targetBitrateKbps);
  connectWs(data.wsUrl);
  if (data.state === 'ready') {
    startStream(data.whepUrl);
  } else {
    setState('实例启动中', 'warn');
    showOverlay('UE 实例启动中…', '渲染引擎正在加载，请稍候');
  }
}

/* ---------------- 控制通道 ---------------- */

function connectWs(url) {
  const ws = new WebSocket(url);
  state.ws = ws;

  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }

    switch (msg.t) {
      case 'assigned':
        state.whepUrl = msg.whepUrl;
        adaptiveSetConfig(msg.adaptive, msg.targetBitrateKbps);
        if (msg.state === 'ready') startStream(msg.whepUrl);
        else { setState('实例启动中', 'warn'); showOverlay('UE 实例启动中…', '渲染引擎正在加载，请稍候'); }
        break;
      case 'ready': // 实例就绪（agent hello）：开始拉流
        state.whepUrl = msg.whepUrl;
        adaptiveSetConfig(msg.adaptive, msg.targetBitrateKbps);
        startStream(msg.whepUrl);
        break;
      case 'queue_update':
        setState('排队中', 'warn');
        showOverlay('排队等待中…', `第 ${msg.position} 位 / 共 ${msg.total} 人，预计 ${Math.round(msg.estimatedWait / 60)} 分钟`);
        break;
      case 'queue_cancelled':
        teardown();
        showError('排队已取消', '管理员取消了本次排队');
        $('btnEnd').textContent = '重新连接';
        break;
      case 'session_ended':
        teardown();
        showError('会话已结束', msg.reason === 'timeout' ? '会话超时，系统已自动释放实例' : '原因: ' + msg.reason);
        $('btnEnd').textContent = '重新连接';
        break;
      case 'session_warn':
        setState(`会话将于 ${msg.remainSec} 秒后超时释放`, 'warn');
        break;
      case 'instance_dead':
        setState('实例切换中', 'warn');
        showOverlay('实例异常，正在切换…', '系统正在分配新的渲染实例');
        break;
      case 'error': // 实例上报的致命错误（如编码器初始化失败）
        setState('渲染实例错误', 'err');
        showError('渲染实例发生错误', msg.message || msg.code || '请检查服务器 GPU 状态');
        break;
      case 'ue_event':
        console.log('[UE event]', msg.name, msg.data);
        document.dispatchEvent(new CustomEvent('ue:' + msg.name, { detail: msg.data }));
        break;
      case 'pong':
        break;
    }
  };

  ws.onclose = () => {
    if (state.session) {
      console.warn('[WS] 控制通道断开，3s 后重连');
      setTimeout(() => { if (state.session) connectWs(url); }, 3000);
    }
  };
}

function send(obj) {
  if (state.ws && state.ws.readyState === 1) state.ws.send(JSON.stringify(obj));
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
  video.classList.remove('active');
}

/* ---------------- WHEP 拉流 ---------------- */

let whepLocation = null;

async function startStream(whepUrl, attempt = 1) {
  setState('连接媒体', 'warn');
  showOverlay('正在建立低延迟视频连接…', '');

  const pc = new RTCPeerConnection();
  state.pc = pc;
  pc.addTransceiver('video', { direction: 'recvonly' });
  pc.addTransceiver('audio', { direction: 'recvonly' });

  pc.ontrack = (ev) => {
    if (ev.streams[0]) video.srcObject = ev.streams[0];
    // 注意：不要在音轨到达时取消静音。浏览器自动播放策略只允许静音自动播放；
    // 音/视轨到达顺序不固定，若音轨先到就 unmute，视频轨到达后的自动播放
    // 会被策略拒绝（流在解码但画面永远停在首帧、video.paused=true）。
    // 保持 muted 自动播放，声音由「开启声音」按钮的真实用户手势开启。
    video.play().catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      setState('运行中', 'ok');
      hideOverlay();
      video.classList.add('active');
      video.play().catch(() => {}); // 兜底：个别时序下 ontrack 的 play 可能被拒
    } else if (pc.connectionState === 'failed') {
      setState('重连中', 'warn');
      retryStream();
    }
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // 等待 ICE 收集完成
  await new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') return resolve();
    const check = () => { if (pc.iceGatheringState === 'complete') { pc.removeEventListener('icegatheringstatechange', check); resolve(); } };
    pc.addEventListener('icegatheringstatechange', check);
    setTimeout(resolve, 2000);
  });

  let res;
  try {
    res = await fetch(whepUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: pc.localDescription.sdp,
    });
  } catch (e) {
    res = { ok: false, status: 0 };
  }
  if (!res.ok) {
    // 竞态容错：服务端 ready（agent hello）通常早于 UE 的 RTMP publish 1~3 秒，
    // 此时 WHEP 返回 404 "no stream is available"。旧行为直接报错死屏；
    // 现在自动重试（最多 12 次 × 1.5s ≈ 18s），覆盖实例启动窗口。
    try { pc.close(); } catch { /* ignore */ }
    if (attempt < 12 && state.session) {
      setState('等待推流', 'warn');
      showOverlay('推流尚未就绪，正在等待…', `实例正在启动编码器，第 ${attempt} 次重试`);
      await new Promise((r) => setTimeout(r, 1500));
      return startStream(whepUrl, attempt + 1);
    }
    throw new Error('WHEP 连接失败: HTTP ' + res.status);
  }
  whepLocation = res.headers.get('Location');
  const answer = await res.text();
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });

  // 周期性 DELETE 保活查询（媒体 MTX WHEP 会话由服务器管理，无需额外操作）
  attachInput();
}

async function retryStream() {
  if (!state.session || !state.whepUrl) return; // 会话已结束/主动断开：不再重试
  try { if (state.pc) state.pc.close(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 1500));
  startStream(state.whepUrl).catch((e) => showError('媒体连接失败', e.message));
}

/* ---------------- 输入控制 ---------------- */

const SEND_MOUSE = true;
let inputAttached = false; // 原地重连（不再整页刷新）时防止重复挂载输入监听

function attachInput() {
  if (inputAttached) return;
  inputAttached = true;
  // 键盘
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
    e.preventDefault();
  });

  if (!SEND_MOUSE) return;

  // 鼠标（归一化坐标，节流 30Hz）
  let lastMouseMove = 0;
  video.addEventListener('mousemove', (e) => {
    const now = performance.now();
    if (now - lastMouseMove < 33) return;
    lastMouseMove = now;
    const r = video.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    send({ t: 'input', e: { type: 'mousemove', x: clamp01(x), y: clamp01(y) }, mods: modOf(e) });
  });
  video.addEventListener('mousedown', (e) => {
    send({ t: 'input', e: { type: 'mousedown', button: String(e.button) }, mods: modOf(e) });
    e.preventDefault();
  });
  video.addEventListener('mouseup', (e) => {
    send({ t: 'input', e: { type: 'mouseup', button: String(e.button) }, mods: modOf(e) });
  });
  video.addEventListener('contextmenu', (e) => e.preventDefault());
  // delta = 浏览器 deltaY（正=向下）；UE 插件内会翻成 Windows WheelDelta（正=向上）并归一化为 ±1
  video.addEventListener('wheel', (e) => {
    send({ t: 'input', e: { type: 'wheel', delta: e.deltaY }, mods: modOf(e) });
    e.preventDefault();
  }, { passive: false });
}

function modOf(e) {
  return { ctrl: !!e.ctrlKey, shift: !!e.shiftKey, alt: !!e.altKey };
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
function isTypingTarget(e) {
  return e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName);
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
  setState(adaptive.tier === 0 ? '运行中' : `自适应降档中 ${kbps}kbps`, adaptive.tier === 0 ? 'ok' : 'warn');
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
    if (dRecv < 20) return; // 样本不足，跳过本轮
    const lossRate = dLost > 0 ? dLost / (dLost + dRecv) : 0;
    if (lossRate > 0.05 || rtt > 250) { adaptive.badStreak++; adaptive.goodStreak = 0; }
    else if (lossRate < 0.005 && rtt > 0 && rtt < 100) { adaptive.goodStreak++; adaptive.badStreak = 0; }
    else { adaptive.badStreak = 0; adaptive.goodStreak = 0; }
    // 恶化 3 轮(≈6s)降一档；恢复 10 轮(≈20s)升一档（迟滞防抖）
    if (adaptive.badStreak >= 3 && adaptive.tier < 2) { adaptive.tier++; adaptiveApply(); }
    else if (adaptive.goodStreak >= 10 && adaptive.tier > 0) { adaptive.tier--; adaptiveApply(); }
  }).catch(() => { /* ignore */ });
}

/* ---------------- 统计 ---------------- */

// 仅在前台且用户打开了「统计」面板时才拉取并显示，避免每 2 秒的 getStats + 重写
// DOM 在已满载解码的机器上造成周期性主线程抖动（表现为短暂卡顿）。后台标签完全跳过。
setInterval(() => {
  if (document.visibilityState !== 'visible') return;
  if (adaptive.enabled) adaptiveTick();
  if ($('stage').classList.contains('showstats')) {
    pc_getStats().then((s) => {
      const el = $('stats');
      if (el) el.textContent = s; // textContent 不触发 HTML 解析/重排
    }).catch(() => { /* ignore */ });
  }
}, 2000);

async function pc_getStats() {
  const stats = await state.pc.getStats();
  let bits = 0, rtt = 0, fps = 0, w = 0, h = 0, lost = 0;
  stats.forEach((r) => {
    if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
      bits = r.bytesReceived * 8; fps = r.framesPerSecond || 0;
      if (r.frameWidth) { w = r.frameWidth; h = r.frameHeight; }
      lost = r.packetsLost || 0;
    }
    if (r.type === 'candidate-pair' && r.state === 'succeeded') rtt = Math.round(r.currentRoundTripTime * 1000);
  });
  return `${w}x${h} @ ${fps}fps · ${(bits / 1000000).toFixed(1)}Mbps · RTT ${rtt}ms · 丢包 ${lost}`;
}

/* ---------------- 按钮 ---------------- */

$('btnFull').onclick = () => document.documentElement.requestFullscreen();
$('btnStats').onclick = () => $('stage').classList.toggle('showstats');
$('btnSound').onclick = () => { video.muted = false; $('btnSound').style.display = 'none'; };
$('btnEnd').onclick = async () => {
  if (!state.session) {
    // 已断开状态：按钮变为「重新连接」，由用户主动发起
    $('btnEnd').textContent = '结束会话';
    $('btnEnd').disabled = true;
    try {
      await requestSession();
    } catch (e) {
      showError('无法启动会话', e.message);
    } finally {
      $('btnEnd').disabled = false;
    }
    return;
  }
  const sid = state.session.id;
  const nodeId = state.session.nodeId;
  const baseUrl = state.baseUrl || '';
  teardown();
  $('btnEnd').textContent = '重新连接';
  setState('已断开', 'warn');
  showOverlay('已断开连接', '实例已释放回资源池，点击「重新连接」可再次进入');
  await fetch(`${baseUrl}/api/session/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, nodeId }),
  }).catch(() => {});
};

function showError(title, sub) {
  setState('错误', 'warn');
  showOverlay(title, sub, true);
}

/* ---------------- 后台标签页：暂停解码，释放 GPU ---------------- */

// 多流同开时，每个后台标签页若持续解码会把 GPU 解码单元占满，导致切回前台或
// 拖动窗口时前台视频合成卡顿。标签隐藏时把入站轨道 enabled=false，解码器直接
// 丢帧不解码，释放 GPU；标签回到前台再开启轨道、恢复播放并请求强制关键帧。
// RTMP→MediaMTX→WHEP 链路上 RTCP 的 PLI 反馈到不了 UE 编码器（RTMP 入流单向），
// 主动请求 IDR 让恢复 <300ms（否则要干等一个强制 IDR 周期，4K 模板约 4s）。
function setReceiversEnabled(enabled) {
  if (!state.pc) return;
  for (const r of state.pc.getReceivers()) {
    if (r.track) r.track.enabled = enabled;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    // 切回前台：恢复解码 + 播放 + 强制关键帧
    setReceiversEnabled(true);
    if (state.pc) video.play().catch(() => {});
    if (state.session && state.ws && state.ws.readyState === 1) {
      send({ t: 'command', name: 'sf_request_keyframe', payload: '' });
      console.log('[keyframe] 标签页切回前台，已请求强制 IDR');
    }
  } else {
    // 切到后台：停下解码，释放 GPU（画面冻结在最后一帧即可，无需解码）
    setReceiversEnabled(false);
    try { video.pause(); } catch { /* ignore */ }
    console.log('[perf] 标签页切到后台，已暂停解码，释放 GPU');
  }
});

/* ---------------- 启动 ---------------- */

requestSession().catch((e) => showError('无法启动会话', e.message));
