'use strict';
/**
 * clusterWorker.js — 渲染节点（worker）集群内部 API
 *
 * 在 CLUSTER_INTERNAL_PORT（默认 3120）上监听，仅供 master 调用（X-Cluster-Token 认证）：
 *   GET  /cluster/health         存活探测
 *   GET  /cluster/capacity       容量快照（池/GPU/模板/队列/会话）——master 调度依据
 *   POST /cluster/session        在本节点创建会话（返回含浏览器直连的 wsUrl/whepUrl）
 *   POST /cluster/release        结束本节点会话
 *   POST /cluster/stop-instance  停止本节点实例（master 管理页操作）
 *
 * worker 同时保留完整单机功能（页面/API 照常对外服务），
 * 集群模式下浏览器从 master 拿到本节点地址后直连 /ws 与 WHEP。
 */
const http = require('http');
const config = require('./config');
const log = require('./logger');
const routes = require('./routes');

function reply(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

class ClusterWorker {
  /** @param ctx { pool, queue, hub, sessions, gpu } */
  constructor(ctx) {
    this.ctx = ctx;
    this.server = null;
  }

  start() {
    if (!config.isWorker()) return;
    if (!config.clusterToken) {
      log.warn('[Cluster] worker 未配置 CLUSTER_TOKEN，内部 API 不启动（无法加入集群）');
      return;
    }
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((e) => {
        log.error(`[Cluster] 内部 API 异常 ${req.method} ${req.url}: ${e.message}`);
        if (!res.headersSent) reply(res, 500, { ok: false, error: e.message });
      });
    });
    this.server.listen(config.clusterInternalPort, '0.0.0.0', () => {
      log.info(`[Cluster] worker 内部 API 已启动: 0.0.0.0:${config.clusterInternalPort}（nodeId=${config.nodeId}）`);
    });
  }

  stop() {
    if (this.server) this.server.close();
    this.server = null;
  }

  auth(req) {
    const header = String(req.headers['x-cluster-token'] || '').trim();
    if (header) return header === config.clusterToken;
    const m = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
    return !!m && m[1].trim() === config.clusterToken;
  }

  async handle(req, res) {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (!this.auth(req)) {
      return reply(res, 403, { ok: false, error: '集群认证失败（CLUSTER_TOKEN 不匹配）' });
    }

    if (pathname === '/cluster/health' && req.method === 'GET') {
      return reply(res, 200, { ok: true, nodeId: config.nodeId, role: 'worker', platform: process.platform });
    }

    if (pathname === '/cluster/capacity' && req.method === 'GET') {
      return reply(res, 200, this.capacity());
    }

    if (pathname === '/cluster/session' && req.method === 'POST') {
      const body = await readBody(req);
      const r = await routes.createSession(this.ctx, body, `${config.nodePublicHost}:${config.nodePublicPort}`);
      // 附上节点标识，master 原样转发给浏览器（release 时路由回本节点）
      r.payload = { ...r.payload, nodeId: config.nodeId, nodeName: config.nodeName || config.nodeId };
      return reply(res, r.status, r.payload);
    }

    if (pathname === '/cluster/release' && req.method === 'POST') {
      const body = await readBody(req);
      const s = this.ctx.sessions.get(body.sessionId);
      if (!s) return reply(res, 404, { ok: false, error: 'session not found' });
      routes.endSession(this.ctx, body.sessionId, body.reason || 'user_release');
      return reply(res, 200, { ok: true });
    }

    if (pathname === '/cluster/stop-instance' && req.method === 'POST') {
      const body = await readBody(req);
      const it = this.ctx.pool.get(body.instanceId);
      if (!it) return reply(res, 404, { ok: false, error: 'instance not found' });
      if (it.sessionId) routes.endSession(this.ctx, it.sessionId, 'admin_kill');
      this.ctx.pool.stop(body.instanceId, 'cluster_admin');
      return reply(res, 200, { ok: true });
    }

    return reply(res, 404, { ok: false, error: `no cluster route: ${req.method} ${pathname}` });
  }

  /** 容量快照：master 调度与节点管理页数据源 */
  capacity() {
    const { pool, queue, gpu, sessions } = this.ctx;
    const list = pool.list();
    const byTpl = {};
    for (const inst of list) {
      const k = String(inst.templateId);
      if (!byTpl[k]) byTpl[k] = { ready: 0, inUse: 0, starting: 0 };
      if (inst.state === 'ready' && !inst.sessionId) byTpl[k].ready++;
      else if (inst.state === 'assigned' || (inst.state === 'ready' && inst.sessionId)) byTpl[k].inUse++;
      else if (inst.state === 'spawning' || inst.state === 'stopping') byTpl[k].starting++;
    }
    const templates = require('./db').templates.list().map((t) => ({
      id: t.id, name: t.name, description: t.description || '',
      width: t.width, height: t.height, fps: t.fps,
      pool: byTpl[String(t.id)] || { ready: 0, inUse: 0, starting: 0 },
    }));
    return {
      ok: true,
      nodeId: config.nodeId,
      nodeName: config.nodeName || config.nodeId,
      publicHost: config.nodePublicHost,
      publicPort: config.nodePublicPort,
      platform: process.platform,
      pool: {
        total: pool.size,
        max: pool.maxInstances,
        ready: list.filter((i) => i.state === 'ready' && !i.sessionId).length,
        assigned: list.filter((i) => i.state === 'assigned').length,
        spawning: list.filter((i) => i.state === 'spawning').length,
      },
      gpu: gpu ? gpu.snapshot() : null,
      templates,
      queue: { length: queue.length },
      sessions: { active: [...sessions.values()].filter((s) => s.state === 'active').length },
    };
  }
}

module.exports = { ClusterWorker };
