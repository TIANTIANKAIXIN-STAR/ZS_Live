'use strict';
/**
 * gpuMonitor.js — 本机 GPU 状态轮询（多厂商探测链，见 gpuProbe.js）
 *
 * 每 5 秒查询一次每张卡的利用率/显存/温度，内存缓存最新快照；
 * 查询失败时保留上次成功数据（标记 staleSec），连续失败超 60s 标记离线。
 * 管理后台「GPU 监控」页与 /api/admin/gpus 的数据源。
 */
const store = require('./db');
const log = require('./logger');
const alloc = require('./gpuAllocator');
const probe = require('./gpuProbe');

const POLL_MS = 5000;
const STALE_LIMIT_SEC = 60;

class GpuMonitor {
  constructor() {
    this.last = null;          // { gpus, source, at }
    this.lastOkAt = 0;
    this.lastError = '';
    this.failCount = 0;
    this.timer = null;
    this.inflight = false;
    this.pool = null;          // InstancePool 引用（统计每卡绑定实例）
  }

  /** 启动轮询；pool 用于把实例绑定数合并进快照 */
  start(pool) {
    this.pool = pool;
    if (this.timer) return;
    this.poll(); // 立即查一次
    this.timer = setInterval(() => this.poll(), POLL_MS);
    log.info(`[GPU] 监控已启动（${POLL_MS / 1000}s 轮询，多厂商探测链）`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll() {
    if (this.inflight) return;
    this.inflight = true;
    try {
      const r = await probe.queryGpus();
      if (r && r.gpus.length) {
        this.last = { gpus: r.gpus, source: r.source, at: Date.now() };
        this.lastOkAt = Date.now();
        this.failCount = 0;
        this.lastError = '';
      } else {
        this.failCount++;
        this.lastError = '未检测到 GPU（nvidia-smi / mtt-smi / 自定义探测 / vulkaninfo 均不可用）';
      }
    } catch (e) {
      this.failCount++;
      this.lastError = e.message;
    } finally {
      this.inflight = false;
    }
  }

  /**
   * 当前快照：硬件状态 + 配额占用 + 每卡绑定的实例列表。
   * 硬件不可用时 gpus 为空数组（后台页显示提示而不是报错）。
   */
  snapshot() {
    const quotas = alloc.parseGpuQuotas(store.getSetting('gpuQuotas', ''));
    const instances = this.pool ? this.pool.instances : new Map();
    const snap = alloc.getGpuUsageSnapshot(quotas, instances);

    // 每卡实例明细（编号 + 模板名）
    const byGpu = {};
    for (const it of instances.values()) {
      if (it.gpuIndex === undefined || it.gpuIndex === null) continue;
      if (it.state === 'dead' || it.state === 'stopping') continue;
      (byGpu[it.gpuIndex] = byGpu[it.gpuIndex] || []).push({
        id: it.id,
        templateName: it.templateName || '',
        state: it.state,
        sessionId: it.sessionId || null,
      });
    }

    // 未启用配额时，也把检测到的卡列出来（便于配置配额）
    const usageMap = new Map((snap.usage || []).map((u) => [u.index, u]));
    const hw = this.last ? this.last.gpus : [];
    const gpus = hw.map((g) => {
      const u = usageMap.get(g.index);
      const bound = byGpu[g.index] || [];
      return {
        ...g,
        vramUsedPct: g.vramTotalMB > 0 ? Math.round((g.vramUsedMB / g.vramTotalMB) * 100) : 0,
        quota: u ? u.maxInstances : null,
        used: u ? u.used : bound.length,
        remaining: u ? u.remaining : null,
        instances: bound,
      };
    });

    const ageSec = this.lastOkAt ? Math.round((Date.now() - this.lastOkAt) / 1000) : null;
    return {
      ok: gpus.length > 0,
      gpus,
      quotaEnabled: snap.enabled,
      quotas: snap.quotas || [],
      totalQuota: snap.totalQuota,
      totalUsed: snap.totalUsed,
      source: this.last ? this.last.source : null,
      staleSec: ageSec,
      // 硬件查询连续失败超过阈值：监控视为不可用，但绑定/配额逻辑不受影响
      monitorOk: gpus.length > 0 && ageSec !== null && ageSec <= STALE_LIMIT_SEC,
      error: gpus.length === 0 ? (this.lastError || '尚未完成首次 GPU 查询') : null,
    };
  }
}

module.exports = { GpuMonitor };
