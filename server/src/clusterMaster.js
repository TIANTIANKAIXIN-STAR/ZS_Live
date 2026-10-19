'use strict';
/**
 * clusterMaster.js — 管理节点（master）集群协调器 + 全局授权闸门
 *
 * 职责：
 *  - 节点注册表（cluster_nodes 表 + 内存运行态），每 5s 轮询各 worker /cluster/capacity
 *  - 跨节点调度：为 /api/session 挑选节点并转发（浏览器后续直连 worker 的 WS/WHEP）
 *  - 节点管理 API 数据源（在线状态/容量/GPU/模板）
 *
 * 授权模型（一机一码 + 主节点统管）：
 *  - 仅主节点(10.3.18.1)持有一张机器绑定授权（hwid 绑定），其 max = 整个集群的总并发上限。
 *  - 所有客户端会话都经由 master 创建，master 用 owned 台账权威记录"自己创建过哪些会话"，
 *    新建前先过全局并发闸门：owned.size + 1 > 授权 max 则拒绝（503）。
 *  - worker 本地不校验授权（index.js 已将它标记为 delegated），master 是集群唯一授权入口。
 *  - 每轮轮询附带对账：worker/本地已结束、但台账仍残留的会话（>8s）会被清理，保证闸门计数不漂移。
 *
 * 主节点渲染（可选，MASTER_RENDER=1）：
 *  - 纯控制面（默认）：master 不本地拉实例，只调度 worker。
 *  - 开启后：master 把"自己"注册成 LOCAL_NODE_ID 本地节点，复用其本地 pool/queue/hub/gpu，
 *    与其它 worker 一起参与调度（全局 max 同时约束 本地 + 各 worker 实例之和）。
 */
const http = require('http');
const config = require('./config');
const store = require('./db');
const log = require('./logger');
const routes = require('./routes');
const codes = require('./streamCodes');

const POLL_MS = 5000;
const OFFLINE_MS = 15000;
const REQUEST_TIMEOUT = 10000;
// 新建会话后，worker 的下一轮轮询（5s）才会把它计入 capacity.sessions.ids；
// 对账时跳过创建未满该时长的会话，避免误删刚刚建好、但尚未被 worker 上报的会话。
const RECONCILE_GRACE_MS = 8000;

/** 对 worker 内部 API 的 HTTP 请求（Promise 化，带超时） */
function nodeRequest(node, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: node.host,
      port: node.internal_port,
      method,
      path,
      headers: {
        'X-Cluster-Token': config.clusterToken,
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: REQUEST_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch { /* ignore */ }
        if (res.statusCode >= 200 && res.statusCode < 300 && parsed) resolve({ status: res.statusCode, data: parsed });
        else reject(new Error((parsed && parsed.error) || `节点 ${node.id} HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`节点 ${node.id} 请求超时`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

class ClusterMaster {
  constructor(ctx) {
    // nodeId -> { ...dbRow, status, lastSeen, capacity, lastError }
    this.nodes = new Map();
    this.timer = null;
    this.onNodesChanged = null;
    // 会话台账：sessionId -> { nodeId, local, createdAt }。master 创建过的会话权威记录，
    // 用于全局并发闸门计数 + 对账（worker/本地结束但客户端未显式释放的会话）。
    this.owned = new Map();
    // 本地渲染所需上下文（master 渲染时由 index.js 传入，含本地 pool/queue/hub/sessions/gpu）
    this.ctx = ctx || null;
  }

  start() {
    if (!config.isMaster()) return;
    if (!config.clusterToken) {
      // master 无 Token 时自动生成一次并提示（写入 .env 的工作交给管理员，这里只提示）
      log.warn('[Cluster] master 未配置 CLUSTER_TOKEN，请在 server/.env 设置后重启（worker 须使用同一 Token）');
    }
    this.reload();
    this.poll(); // 立即轮询一次
    this.timer = setInterval(() => this.poll(), POLL_MS);
    log.info(`[Cluster] master 已启动（已登记 ${this.nodes.size} 个节点，${POLL_MS / 1000}s 轮询）`
      + (config.masterRenders() ? '；主节点同时作为渲染节点（MASTER_RENDER=1）' : '；纯控制面（不本地渲染）'));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 从 DB 重载节点配置（保留内存运行态） */
  reload() {
    const rows = store.nodes.list();
    for (const row of rows) {
      const prev = this.nodes.get(row.id);
      this.nodes.set(row.id, {
        ...row,
        status: prev ? prev.status : 'unknown',
        lastSeen: prev ? prev.lastSeen : 0,
        capacity: prev ? prev.capacity : null,
        lastError: prev ? prev.lastError : '',
      });
    }
    // 删除 DB 中已移除的节点
    for (const id of [...this.nodes.keys()]) {
      if (!rows.find((r) => r.id === id)) this.nodes.delete(id);
    }
  }

  async poll() {
    const jobs = [];
    for (const node of this.nodes.values()) {
      if (!node.enabled) continue;
      jobs.push(nodeRequest(node, 'GET', '/cluster/capacity')
        .then((r) => {
          node.capacity = r.data;
          node.status = 'online';
          node.lastSeen = Date.now();
          node.lastError = '';
        })
        .catch((e) => {
          node.lastError = e.message;
          if (Date.now() - node.lastSeen > OFFLINE_MS) node.status = 'offline';
          else if (node.status === 'online') node.status = 'degraded';
        }));
    }
    await Promise.allSettled(jobs);
    this.reconcileOwned();
  }

  /**
   * 对账：清理已被 worker/本地结束、但台账仍残留的会话（>8s 才对账，避免误删刚创建的）。
   * 保证全局并发闸门计数不随时间漂移（否则会因"已结束但未释放"的幽灵会话而越来越严）。
   */
  reconcileOwned() {
    const now = Date.now();
    for (const [sid, rec] of [...this.owned]) {
      if (now - rec.createdAt < RECONCILE_GRACE_MS) continue; // 给 worker 一轮上报的时间
      if (rec.local) {
        const s = this.ctx && this.ctx.sessions.get(sid);
        if (!s || s.state !== 'active') this.owned.delete(sid);
      } else {
        const node = this.nodes.get(rec.nodeId);
        if (!node || node.status === 'offline') { this.owned.delete(sid); continue; }
        if (!node.capacity || !node.capacity.sessions) continue;
        const ids = node.capacity.sessions.ids || [];
        if (!ids.includes(sid)) this.owned.delete(sid);
      }
    }
  }

  /** 节点列表（管理页/调度共用）；主节点渲染时追加本地节点 */
  listNodes() {
    const out = [];
    for (const node of this.nodes.values()) {
      out.push({
        id: node.id,
        name: node.name,
        host: node.host,
        internalPort: node.internal_port,
        enabled: !!node.enabled,
        note: node.note,
        status: node.enabled ? node.status : 'disabled',
        lastSeen: node.lastSeen ? new Date(node.lastSeen).toISOString() : null,
        lastError: node.lastError || '',
        capacity: node.capacity,
      });
    }
    if (config.masterRenders()) {
      out.push({
        id: config.LOCAL_NODE_ID,
        name: '主节点(本地渲染)',
        host: config.publicHost,
        internalPort: config.port,
        enabled: true,
        note: '主节点自身也参与渲染（MASTER_RENDER=1）',
        status: 'online',
        lastSeen: new Date().toISOString(),
        lastError: '',
        capacity: this.localCapacity(),
      });
    }
    return out;
  }

  onlineNodes() {
    return [...this.nodes.values()].filter((n) => n.enabled && n.status === 'online' && n.capacity);
  }

  /**
   * 候选节点（含主节点本地）：拥有该模板、在线、未被排除。
   * 纯控制面模式下只返回 worker；主节点渲染模式下额外追加 LOCAL_NODE_ID。
   */
  candidateNodes(templateId, excludeIds = []) {
    const workers = this.onlineNodes().filter((n) =>
      !excludeIds.includes(n.id)
      && n.capacity.templates.some((t) => String(t.id) === String(templateId)));
    const out = workers.slice();
    if (config.masterRenders()) {
      const lc = this.localCapacity();
      if (!excludeIds.includes(config.LOCAL_NODE_ID)
        && lc.templates.some((t) => String(t.id) === String(templateId))) {
        out.push({
          id: config.LOCAL_NODE_ID,
          name: '主节点(本地渲染)',
          host: config.publicHost,
          internal_port: config.port,
          enabled: true,
          status: 'online',
          capacity: lc,
          local: true,
        });
      }
    }
    return out;
  }

  /**
   * 全局并发闸门：基于 master 的授权 max（即集群总并发上限）。
   * owned.size 是 master 创建过的会话权威计数（worker 委托后本地不设上限，master 才是唯一闸门）。
   * 返回 { ok, max, active }。
   */
  gateCheck() {
    const lic = config._licStatus;
    const max = (lic && Number.isFinite(lic.max)) ? lic.max : Infinity;
    const active = this.owned.size;
    if (max === Infinity) return { ok: true, max: null, active };
    return { ok: (active + 1) <= max, max, active };
  }

  /**
   * 主节点本地容量快照（与 worker capacity() 同形，供调度/对账/管理页复用）。
   * 仅在主节点渲染或 listNodes 时调用；纯控制面返回兜底结构。
   */
  localCapacity() {
    const ctx = this.ctx;
    if (!ctx) return { ok: true, nodeId: config.nodeId, nodeName: '主节点', platform: process.platform, pool: { total: 0, max: 0, ready: 0, assigned: 0, spawning: 0 }, templates: [], queue: { length: 0 }, sessions: { active: 0, ids: [] } };
    const { pool, queue, sessions } = ctx;
    const list = pool.list();
    const byTpl = {};
    for (const inst of list) {
      const k = String(inst.templateId);
      if (!byTpl[k]) byTpl[k] = { ready: 0, inUse: 0, starting: 0 };
      if (inst.state === 'ready' && !inst.sessionId) byTpl[k].ready++;
      else if (inst.state === 'assigned' || (inst.state === 'ready' && inst.sessionId)) byTpl[k].inUse++;
      else if (inst.state === 'spawning' || inst.state === 'stopping') byTpl[k].starting++;
    }
    const templates = store.templates.list().map((t) => ({
      id: t.id, name: t.name, description: t.description || '',
      width: t.width, height: t.height, fps: t.fps,
      pool: byTpl[String(t.id)] || { ready: 0, inUse: 0, starting: 0 },
    }));
    const activeSessions = [...sessions.values()].filter((s) => s.state === 'active');
    return {
      ok: true,
      nodeId: config.nodeId,
      nodeName: config.nodeName || '主节点',
      publicHost: config.publicHost,
      publicPort: config.port,
      platform: process.platform,
      pool: {
        total: pool.size,
        max: pool.maxInstances,
        ready: list.filter((i) => i.state === 'ready' && !i.sessionId).length,
        assigned: list.filter((i) => i.state === 'assigned').length,
        spawning: list.filter((i) => i.state === 'spawning').length,
      },
      gpu: ctx.gpu ? ctx.gpu.snapshot() : null,
      templates,
      queue: { length: queue.length },
      sessions: { active: activeSessions.length, ids: activeSessions.map((s) => s.id) },
    };
  }

  /**
   * 挑选承载会话的节点。
   * 策略：指定 nodeId 则直取；否则在拥有该模板的候选节点里——
   *   1) 有 READY 空闲实例的优先（余量多者优先）
   *   2) 其次池未满的（空闲比率高者优先）
   *   3) 都满则挑队列最短的（由节点转入排队）
   * 候选 = 在线 worker + 主节点本地（若 MASTER_RENDER）。
   * @param {string|number} templateId 模板 ID
   * @param {string} [nodeId] 指定节点（master 登记 ID 或 LOCAL_NODE_ID）
   * @param {string[]} [excludeIds] 排除的节点（故障切换时跳过已失败节点）
   */
  pickNode(templateId, nodeId, excludeIds = []) {
    const candidates = this.candidateNodes(templateId, excludeIds);
    if (nodeId) {
      const n = candidates.find((x) => x.id === nodeId || (x.capacity && x.capacity.nodeId === nodeId));
      if (!n) {
        const known = this.nodes.get(nodeId)
          || [...this.nodes.values()].find((x) => x.capacity && x.capacity.nodeId === nodeId);
        return { node: null, error: known && known.enabled !== false ? `节点 ${nodeId} 不在线` : `节点 ${nodeId} 不存在或已停用` };
      }
      if (excludeIds.includes(n.id)) return { node: null, error: `节点 ${nodeId} 已失败` };
      return { node: n };
    }
    if (candidates.length === 0) {
      const anyOnline = this.onlineNodes().length > 0 || config.masterRenders();
      return { node: null, error: anyOnline ? '所有在线节点都没有该模板' : '没有在线的渲染节点' };
    }
    const score = (n) => {
      const t = n.capacity.templates.find((x) => String(x.id) === String(templateId));
      if (t && t.pool.ready > 0) return { rank: 0, v: t.pool.ready };
      const free = n.capacity.pool.max - n.capacity.pool.total;
      if (free > 0) return { rank: 1, v: free };
      return { rank: 2, v: -n.capacity.queue.length };
    };
    candidates.sort((a, b) => {
      const sa = score(a), sb = score(b);
      return sa.rank - sb.rank || sb.v - sa.v;
    });
    return { node: candidates[0] };
  }

  /**
   * 统一建会话入口（master 代理层）：
   *   1) 过全局并发闸门（授权 max）
   *   2) 选节点（含本地），本地节点改调 routes.createSession，远程走 createRemoteSession
   *   3) 成功后写入 owned 台账（供闸门计数 + 对账）
   *   4) 首选节点失败时自动切换候选（最多 3 次）
   * @returns {Promise<{status:number, payload:object}>}
   */
  async createSession(body) {
    const gate = this.gateCheck();
    if (!gate.ok) {
      const b = codes.formatApiError('ZS_WS_3004', { max: gate.max, active: gate.active });
      return { status: b.httpStatus || 503, payload: { ...b, error: b.message } };
    }
    const exclude = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const { node, error } = this.pickNode(body.templateId, attempt === 0 ? body.nodeId : null, exclude);
      if (!node) {
        const b = codes.formatApiError('ZS_POOL_2005', { detail: error });
        return { status: b.httpStatus || 503, payload: { ...b, error } };
      }
      try {
        let r;
        if (node.local) {
          // 主节点本地渲染：复用本地 ctx 直接建会话（浏览器仍连主节点，WS/WHEP 由主节点服务）
          r = await routes.createSession(this.ctx, body, `${config.publicHost}:${config.port}`);
          r.payload = { ...r.payload, nodeId: config.LOCAL_NODE_ID, nodeName: '主节点(本地)' };
        } else {
          r = await this.createRemoteSession(node, body.templateId);
          r.data.nodeId = node.id;
          r.data.nodeName = (node.capacity && node.capacity.nodeName) || node.name;
          r.payload = r.data;
        }
        if (r.status === 200 || r.status === 202) {
          const sid = r.payload && r.payload.sessionId;
          if (sid) this.owned.set(sid, { nodeId: node.local ? config.LOCAL_NODE_ID : node.id, local: !!node.local, createdAt: Date.now() });
          log.info(`[Cluster] 会话 ${sid} → ${node.local ? '主节点本地渲染' : `节点 ${node.id}（${node.name}）`}`);
        }
        return r;
      } catch (e) {
        log.warn(`[Cluster] 节点 ${node.id} 创建会话失败: ${e.message}`);
        exclude.push(node.id);
      }
    }
    const b = codes.formatApiError('ZS_POOL_2003', { detail: '所有候选节点均创建失败' });
    return { status: b.httpStatus || 502, payload: { ...b, error: '所有候选节点均创建失败' } };
  }

  /** 客户端释放会话后，从台账移除（本地或远程） */
  releaseOwned(sessionId) {
    this.owned.delete(sessionId);
  }

  /** 在指定节点创建会话（/cluster/session 透传） */
  createRemoteSession(node, templateId) {
    return nodeRequest(node, 'POST', '/cluster/session', { templateId });
  }

  /** 结束指定节点上的会话 */
  releaseRemoteSession(node, sessionId) {
    return nodeRequest(node, 'POST', '/cluster/release', { sessionId, reason: 'user_release' });
  }

  /** 停止指定节点上的实例 */
  stopRemoteInstance(node, instanceId) {
    return nodeRequest(node, 'POST', '/cluster/stop-instance', { instanceId });
  }
}

module.exports = { ClusterMaster };
