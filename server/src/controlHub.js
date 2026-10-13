'use strict';
/**
 * 控制中心：WS 消息路由。
 *
 *  - /agent?instanceId=xxx  UE 实例接入（Bearer AgentToken）
 *  - /ws?token=xxx          浏览器接入（会话令牌）
 *
 * 消息流：
 *  浏览器 -> server -> UE:   {t:"control", e:{...}, mods:{...}}   键鼠
 *                           {t:"command", name, payload}          自定义指令
 *  UE -> server -> 浏览器:   {t:"ue_event", name, data}
 *  UE -> server:            hello / heartbeat / pong
 *  server -> UE:            ping / control / command / stop
 */
const { WebSocketServer } = require('ws');
const auth = require('./auth');
const config = require('./config');
const log = require('./logger');
const store = require('./db');

class ControlHub {
  constructor() {
    this.agents = new Map();   // instanceId -> ws
    this.browsers = new Map(); // sessionId -> ws
    this.pendingBrowser = new Map(); // sessionId -> [] queue of messages before agent
    this.instancePool = null;
  }

  attach(httpServer, instancePool) {
    this.instancePool = instancePool;
    this.wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req, socket, head) => {
      const { pathname, searchParams } = new URL(req.url, 'http://localhost');
      const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

      if (pathname === '/agent') {
        const instanceId = searchParams.get('instanceId');
        const it = instancePool.get(instanceId);
        if (!it || !auth.verifyAgentToken(instanceId, authHeader)) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onAgent(ws, instanceId));
      } else if (pathname === '/ws') {
        const token = searchParams.get('token');
        const sessionId = this.sessionOfToken(token);
        if (!sessionId) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.onBrowser(ws, sessionId, token));
      } else {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
      }
    });
  }

  setSessionTokens(tokens) { this._tokens = tokens; } // sessionId -> token
  sessionOfToken(token) {
    if (!this._tokens) return null;
    for (const [sid, t] of this._tokens) {
      if (t === token) return sid;
    }
    return null;
  }

  // ---------------- Agent (UE) ----------------

  onAgent(ws, instanceId) {
    log.info(`[Hub] UE 实例 ${instanceId} agent 接入`);
    this.agents.set(instanceId, ws);

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      const { t } = msg;

      if (t === 'hello') {
        // 新版插件：视频管线未就绪的 hello（如 NVENC 未注册）。
        // 旧版插件无该字段，视为就绪（保持向后兼容）。
        if (msg.videoReady === false) {
          const err = msg.error || {};
          log.error(`[Hub] 实例 ${instanceId} agent 已接入但视频管线失败: ${err.code || 'unknown'} ${err.detail || ''}`);
          this.instancePool.agentError(instanceId, {
            code: err.code || 'video_not_ready',
            detail: err.detail || '',
          });
          // 不标记 ready / 不清 spawn 超时 / 不通知浏览器——
          // 插件会按 SFExitOnFailure 快速退出，或由 spawn 超时兜底回收
          return;
        }
        this.instancePool.agentHello(instanceId, {
          pid: msg.pid, platform: msg.platform,
          width: msg.width, height: msg.height, fps: msg.fps,
          bitrateKbps: msg.bitrateKbps, audioCodec: msg.audioCodec,
        });
        // 实例就绪：通知已绑定会话的浏览器开始 WHEP 拉流
        const it = this.instancePool.get(instanceId);
        if (it && it.sessionId) {
          this.sendToBrowser(it.sessionId, {
            t: 'ready', instanceId, whepUrl: config.whepUrlFor(instanceId),
            width: msg.width, height: msg.height,
            adaptive: store.getSetting('adaptiveEnabled', '0') === '1',
            targetBitrateKbps: it.bitrate_kbps || null,
          });
        }
        this.tryDispatchQueued(instanceId);
      } else if (t === 'agent_error') {
        // 运行期致命错误上报（视频管线重试耗尽等）
        log.error(`[Hub] 实例 ${instanceId} 上报错误: ${msg.code || 'unknown'} ${msg.detail || ''}`);
        this.instancePool.agentError(instanceId, { code: msg.code, detail: msg.detail });
        const it = this.instancePool.get(instanceId);
        if (it && it.sessionId) {
          this.sendToBrowser(it.sessionId, {
            t: 'error', code: msg.code || 'instance_error',
            message: msg.detail || '渲染实例发生错误',
          });
        }
      } else if (t === 'heartbeat') {
        this.instancePool.agentHeartbeat(instanceId, msg.stats || {});
      } else if (t === 'event') {
        // 转发给绑定会话的浏览器
        const it = this.instancePool.get(instanceId);
        const sessionId = it && it.sessionId;
        const browser = sessionId && this.browsers.get(sessionId);
        if (browser && browser.readyState === 1) {
          browser.send(JSON.stringify({ t: 'ue_event', name: msg.name, data: msg.data }));
        }
      }
    });

    ws.on('close', () => {
      log.info(`[Hub] UE 实例 ${instanceId} agent 断开`);
      if (this.agents.get(instanceId) === ws) this.agents.delete(instanceId);
    });
    ws.on('error', () => { /* handled by close */ });
  }

  /** hello 后如果实例是 free 状态，触发排队补位 */
  tryDispatchQueued(instanceId) {
    if (this.onInstanceReady) this.onInstanceReady(instanceId);
  }

  // ---------------- Browser ----------------

  onBrowser(ws, sessionId, token) {
    log.info(`[Hub] 浏览器会话 ${sessionId} 接入`);
    this.browsers.set(sessionId, ws);

    // 状态快照：assigned 消息可能在浏览器连上之前就已发出（会丢失），
    // 浏览器接入时补发一次当前状态，保证其拿到 whepUrl / 就绪标志
    const session = this._sessions && this._sessions.get(sessionId);
    if (session && session.instanceId && this.instancePool) {
      const it = this.instancePool.get(session.instanceId);
      if (it) {
        ws.send(JSON.stringify({
          t: 'assigned',
          instanceId: it.id,
          whepUrl: config.whepUrlFor(it.id),
          state: (it.lastHeartbeat > 0) ? 'ready' : 'starting',
          adaptive: store.getSetting('adaptiveEnabled', '0') === '1',
          targetBitrateKbps: it.bitrate_kbps || null,
        }));
      }
    }

    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      const { t } = msg;
      const session = this._sessions && this._sessions.get(sessionId);
      const instanceId = session && session.instanceId;
      const agent = instanceId && this.agents.get(instanceId);
      if (!agent || agent.readyState !== 1) return;

      if (t === 'input' || t === 'control') {
        // {t:"input", e:{...}, mods:{...}}
        agent.send(JSON.stringify({ t: 'control', e: msg.e || msg.event, mods: msg.mods }));
      } else if (t === 'command') {
        // 自适应降档指令服务端统一把关：adaptiveEnabled 关闭时丢弃
        if (msg.name === 'sf_set_bitrate' && store.getSetting('adaptiveEnabled', '0') !== '1') return;
        agent.send(JSON.stringify({ t: 'command', name: msg.name, payload: msg.payload || '' }));
      }
    });

    ws.on('close', () => {
      log.info(`[Hub] 浏览器会话 ${sessionId} 断开`);
      if (this.browsers.get(sessionId) === ws) this.browsers.delete(sessionId);
      if (this.onBrowserClosed) this.onBrowserClosed(sessionId);
    });
    ws.on('error', () => { /* handled by close */ });
  }

  sendToBrowser(sessionId, obj) {
    const ws = this.browsers.get(sessionId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  sendToAgent(instanceId, obj) {
    const ws = this.agents.get(instanceId);
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(obj));
      return true;
    }
    return false;
  }

  notifyQueuePosition(sessionId, position, total, etaSec) {
    this.sendToBrowser(sessionId, {
      t: 'queue_update', position, total,
      estimatedWait: etaSec || position * 60,
    });
  }
}

module.exports = { ControlHub };
