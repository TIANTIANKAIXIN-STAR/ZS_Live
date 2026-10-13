'use strict';
/**
 * clusterMaster.js — 管理节点（master）集群协调器
 *
 * 职责：
 *  - 节点注册表（cluster_nodes 表 + 内存运行态），每 5s 轮询各 worker /cluster/capacity
 *  - 跨节点调度：为 /api/session 挑选节点并转发（浏览器后续直连 worker 的 WS/WHEP）
 *  - 节点管理 API 数据源（在线状态/容量/GPU/模板）
 *
 * master 不在本地拉 UE 实例（纯控制面）；模板与 GPU 配额在各 worker 上配置。
 */
const http = require('http');
const config = require('./config');
const store = require('./db');
const log = require('./logger');

const POLL_MS = 5000;
const OFFLINE_MS = 15000;
const REQUEST_TIMEOUT = 10000;

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
  constructor() {
    // nodeId -> { ...dbRow, status, lastSeen, capacity, lastError }
    this.nodes = new Map();
    this.timer = null;
    this.onNodesChanged = null;
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
    log.info(`[Cluster] master 已启动（已登记 ${this.nodes.size} 个节点，${POLL_MS / 1000}s 轮询）`);
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
  }

  /** 节点列表（管理页/调度共用） */
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
    return out;
  }

  onlineNodes() {
    return [...this.nodes.values()].filter((n) => n.enabled && n.status === 'online' && n.capacity);
  }

  /**
   * 挑选承载会话的节点。
   * 策略：指定 nodeId 则直取；否则在拥有该模板的在线节点里——
   *   1) 有 READY 空闲实例的优先（余量多者优先）
   *   2) 其次池未满的（空闲比率高者优先）
   *   3) 都满则挑队列最短的（由 worker 转入排队）
   * @param {string|number} templateId 模板 ID
   * @param {string} [nodeId] 指定节点
   * @param {string[]} [excludeIds] 排除的节点（故障切换时跳过已失败节点）
   */
  pickNode(templateId, nodeId, excludeIds = []) {
    const online = this.onlineNodes();
    if (nodeId) {
      // 兼容两种标识：master 登记的节点 ID、worker 自报的 NODE_ID
      const n = online.find((x) => x.id === nodeId || (x.capacity && x.capacity.nodeId === nodeId));
      if (!n) {
        const known = this.nodes.get(nodeId)
          || [...this.nodes.values()].find((x) => x.capacity && x.capacity.nodeId === nodeId);
        return { node: null, error: known && known.enabled !== false ? `节点 ${nodeId} 不在线` : `节点 ${nodeId} 不存在或已停用` };
      }
      if (excludeIds.includes(n.id)) return { node: null, error: `节点 ${nodeId} 已失败` };
      return { node: n };
    }
    const candidates = online.filter((n) => !excludeIds.includes(n.id)
      && n.capacity.templates.some((t) => String(t.id) === String(templateId)));
    if (candidates.length === 0) {
      return { node: null, error: online.length ? '所有在线节点都没有该模板' : '没有在线的渲染节点' };
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
