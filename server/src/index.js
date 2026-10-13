'use strict';
/**
 * ZS Live 调度服务入口
 * 用法: node src/index.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const log = require('./logger');
const store = require('./db');
const { InstancePool } = require('./instancePool');
const { QueueManager } = require('./queue');
const { ControlHub } = require('./controlHub');
const { GpuMonitor } = require('./gpuMonitor');
const { ClusterWorker } = require('./clusterWorker');
const { ClusterMaster } = require('./clusterMaster');
const routes = require('./routes');

// ---------- 组件 ----------
const pool = new InstancePool();
const queue = new QueueManager();
const hub = new ControlHub();
const gpu = new GpuMonitor();

// sessionId -> { id, token, templateId, instanceId, state }
const sessions = new Map();
hub._sessions = sessions;
hub._tokens = new Map(); // sessionId -> token

const ctx = { pool, queue, hub, sessions, gpu };

// ---------- 集群 ----------
// master：纯控制面（节点注册表 + 跨节点调度），不本地拉实例
// worker：完整单机功能 + 内部 API（CLUSTER_INTERNAL_PORT）供 master 调用
let clusterWorker = null;
let clusterMaster = null;
if (config.isWorker()) {
  clusterWorker = new ClusterWorker(ctx);
  clusterWorker.start();
} else if (config.isMaster()) {
  clusterMaster = new ClusterMaster();
  clusterMaster.start();
  ctx.master = clusterMaster;
}

// ---------- 接线 ----------
// 优雅停止：pool.stop 先经 agent WS 发 {t:'stop'}，UE 自行退出；6s 后兜底强杀
pool.sendAgentStop = (instanceId) => hub.sendToAgent(instanceId, { t: 'stop' });

// 待命降载：空闲实例低帧率/低码率推流省 GPU 与带宽；会话接入时恢复满配。
// 协议：{t:'command', name:'sf_standby', payload: JSON}，fps/bitrateKbps 为 0 表示恢复模板满配
const sendStandby = (instanceId, standbyOn) => {
  const payload = standbyOn
    ? JSON.stringify({
        fps: parseInt(store.getSetting('standbyFps', '5'), 10),
        bitrateKbps: parseInt(store.getSetting('standbyBitrateKbps', '500'), 10),
      })
    : JSON.stringify({ fps: 0, bitrateKbps: 0 });
  hub.sendToAgent(instanceId, { t: 'command', name: 'sf_standby', payload });
};
pool.onAssign = (it) => sendStandby(it.id, false);
pool.onRelease = (it) => sendStandby(it.id, true);
pool.onReadyFree = (it) => sendStandby(it.id, true);

pool.onInstanceDead = (instance, wasAssigned) => {
  if (wasAssigned) {
    const sessionId = instance.sessionId;
    hub.sendToBrowser(sessionId, { t: 'instance_dead' });
    const s = sessions.get(sessionId);
    if (s) {
      s.instanceId = null;
      // 尝试为该会话换一个实例（严格匹配同模板）
      let next = pool.findFree(s.templateId);
      if (!next && pool.size < pool.maxInstances) {
        try {
          const tpl = require('./db').templates.get(s.templateId);
          if (tpl) next = pool.spawn(tpl);
        } catch { /* ignore */ }
      }
      if (next) {
        routes.assignInstance(ctx, sessionId, next.id);
      } else {
        routes.endSession(ctx, sessionId, 'instance_dead');
      }
    }
  }
  setTimeout(() => routes.dispatchQueue(ctx), 500);
};

hub.onBrowserClosed = (sessionId) => {
  // 浏览器断开 10 秒后结束会话（给刷新页面留余地）
  setTimeout(() => {
    const s = sessions.get(sessionId);
    if (s && s.state === 'active' && !hub.browsers.has(sessionId)) {
      routes.endSession(ctx, sessionId, 'browser_closed');
    }
  }, 10000);
};

hub.onInstanceReady = (instanceId) => {
  // 新实例就绪：如果有等待的会话则补位
  routes.dispatchQueue(ctx);
};

queue.notify = (entry, position, total) => {
  hub.notifyQueuePosition(entry.sessionId, position, total);
};

// GPU 监控轮询（nvidia-smi，5s 一次；数据供 /api/admin/gpus 与绑卡配额展示）
gpu.start(pool);

// ---------- 静态文件 ----------
const WEB_ROOT = path.join(__dirname, '..', '..', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/') rel = '/index.html'; // StreamHub 程序列表首页
  else if (rel === '/player') rel = '/player/index.html';
  else if (rel === '/embed') rel = '/embed/index.html';
  else if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';

  const file = path.normalize(path.join(WEB_ROOT, rel));
  if (!file.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(file).toLowerCase();
    // HTML/JS 禁用缓存：前端频繁更新，旧缓存会导致后台页面字段/样式滞后（曾出现设置项"消失"）
    const noCache = ext === '.html' || ext === '.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      ...(noCache ? { 'Cache-Control': 'no-cache' } : {}),
    });
    res.end(data);
  });
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  try {
    if (pathname.startsWith('/api/') || pathname === '/health') {
      await routes.handleApi(req, res, pathname, ctx);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    log.error(`请求处理异常 ${req.method} ${pathname}: ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
});

hub.attach(server, pool);

// ---------- 定时任务 ----------
setInterval(() => {
  pool.sweepIdle();
  pool.maintainWarm();
  // agent 掉线检测
  for (const it of pool.list()) {
    if (it.state !== 'spawning' && !it.agentOk) {
      log.warn(`[Sweep] 实例 ${it.id} agent 心跳丢失`);
    }
  }
  // 会话超时强制释放（sessionTimeoutMin 分钟，0 = 不限制；超时前 1 分钟预警）
  const timeoutMin = parseFloat(store.getSetting('sessionTimeoutMin', '30'));
  if (timeoutMin > 0) {
    const now = Date.now();
    for (const [sid, s] of [...sessions]) {
      if (s.state !== 'active' || !s.createdAt) continue;
      const ageMin = (now - s.createdAt) / 60000;
      if (ageMin >= timeoutMin) {
        log.info(`[Session] ${sid} 超过 ${timeoutMin} 分钟，超时强制释放`);
        routes.endSession(ctx, sid, 'timeout');
      } else if (timeoutMin - ageMin <= 1 && !s.timeoutWarned) {
        s.timeoutWarned = true;
        hub.sendToBrowser(sid, { t: 'session_warn', remainSec: Math.round((timeoutMin - ageMin) * 60) });
      }
    }
  }
}, 15000);

setInterval(() => {
  // ping 所有 agent / browser 保活
  for (const ws of hub.agents.values()) {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'ping' }));
  }
}, 30000);

setInterval(() => {
  queue.broadcastPositions();
}, config.queueInterval * 1000);

// ---------- 启动 ----------
server.listen(config.port, () => {
  log.info('========================================================');
  log.info('  ZS Live 调度服务已启动');
  log.info(`  程序首页: http://${config.publicHost}:${config.port}/`);
  log.info(`  观看页:   http://${config.publicHost}:${config.port}/player?template=<id>`);
  log.info(`  嵌入页:   http://${config.publicHost}:${config.port}/embed?template=<id>&streamId=<sid>`);
  log.info(`  管理后台: http://${config.publicHost}:${config.port}/admin`);
  log.info(`  WHEP:     http://${config.publicHost}:${config.mediamtxWhepPort}/zslive/<instanceId>/whep`);
  log.info(`  MediaMTX: rtmp://${config.publicHost}:${config.mediamtxRtmpPort}/${config.streamApp}/<instanceId>`);
  log.info('========================================================');
});

function shutdown() {
  log.info('正在关闭服务...');
  if (clusterWorker) clusterWorker.stop();
  if (clusterMaster) clusterMaster.stop();
  gpu.stop();
  pool.stopAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref?.();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
