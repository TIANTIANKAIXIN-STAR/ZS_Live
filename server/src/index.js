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

// ---------- 授权校验（可选模块：源码版删除 license.js 后自动降级为无校验） ----------
// 部署包内置授权模块 + 后台「授权管理」开关；源码版不含此文件，自动放行。
// 三种客户形态：
//   1) 应用购买（部署包）：licenseVerificationEnabled=1，需作者签发的 token 才放开实例数
//   2) 源码购买（源码版）：无 license.js → 不限制（仅含推流 + UE 插件，无密钥核对）
//   3) 试用：部署包但无 token → 评估模式（最多 1 实例），购买后作者签发 token 解除
let licenseMod = null;
try { licenseMod = require('./license'); } catch (e) {
  log.warn('授权模块未加载（源码版：无授权校验，实例上限由系统设置决定）');
}
function readFileSafe(p) { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; } }

function computeLicense() {
  const enabled = store.getSetting('licenseVerificationEnabled', '1') === '1';
  let lic;
  if (!licenseMod) {
    lic = { available: false, enabled, valid: true, max: Infinity, edition: 'source', reason: 'NO_MODULE' };
  } else if (!enabled) {
    lic = { available: true, enabled: false, valid: true, max: Infinity, edition: 'unlocked', reason: 'DISABLED' };
  } else {
    const tok = process.env.ZSLIVE_LICENSE
      || readFileSafe(path.join(__dirname, '..', 'license.key'))
      || store.getSetting('licenseToken', '');
    const v = licenseMod.verifyToken(tok);
    lic = { available: true, enabled: true, ...v, max: v.valid ? v.max : 1 };
  }
  config._licMax = Number.isFinite(lic.max) ? lic.max : Infinity;
  config._licStatus = lic;
  return lic;
}
config.licenseStatus = computeLicense;
const lic = computeLicense();
if (lic.available && lic.enabled && !lic.valid) {
  log.warn(`⚠️ 授权未通过(${lic.reason})：进入评估模式，最多 1 个并发实例。商业部署请联系作者获取授权。`);
} else if (lic.available && lic.enabled && lic.valid) {
  log.info(`✔ 授权有效：档位=${lic.edition} 实例上限=${lic.max}${lic.exp ? ' 到期=' + new Date(lic.exp).toISOString() : ''}${lic.to ? ' 授权对象=' + lic.to : ''}`);
} else if (!lic.available) {
  log.info('ℹ️ 未内置授权模块（源码版）：不限制实例数');
}
config.maxInstances = Math.min(config.maxInstances, config._licMax);

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
