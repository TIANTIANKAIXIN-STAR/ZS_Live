'use strict';
/**
 * 排队管理：容量不足时挂起请求，容量释放后依次放行。
 */
const log = require('./logger');

class QueueManager {
  constructor() {
    // { id, sessionId, templateId, resolve, enqueuedAt, lastNotify }
    this.waiting = [];
    this.onAssigned = null; // (entry) => Promise<boolean> 分配成功回调
    this.notify = null;     // (entry, position, total) => void 位置通知
  }

  get length() { return this.waiting.length; }

  list() {
    return this.waiting.map((w, i) => ({
      position: i + 1,
      id: w.id,
      sessionId: w.sessionId,
      templateId: w.templateId,
      waitedSec: Math.round((Date.now() - w.enqueuedAt) / 1000),
    }));
  }

  enqueue(sessionId, templateId, resolve) {
    const entry = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      sessionId,
      templateId,
      resolve,
      enqueuedAt: Date.now(),
    };
    this.waiting.push(entry);
    log.info(`[Queue] 会话 ${sessionId} 进入排队 (position=${this.waiting.length})`);
    return entry;
  }

  removeBySession(sessionId) {
    const idx = this.waiting.findIndex((w) => w.sessionId === sessionId);
    if (idx >= 0) {
      const [entry] = this.waiting.splice(idx, 1);
      entry.resolve({ queued: false, cancelled: true });
      return true;
    }
    return false;
  }

  /** 容量释放时调用：尝试让队首获得实例 */
  async tryDispatch() {
    while (this.waiting.length > 0) {
      const entry = this.waiting[0];
      let ok = false;
      try {
        ok = this.onAssigned ? await this.onAssigned(entry) : false;
      } catch (e) {
        log.error(`[Queue] 分配异常: ${e.message}`);
        ok = false;
      }
      if (!ok) break;
      this.waiting.shift();
      entry.resolve({ queued: false, dispatched: true });
    }
    this.broadcastPositions();
  }

  broadcastPositions() {
    this.waiting.forEach((w, i) => {
      if (this.notify) this.notify(w, i + 1, this.waiting.length);
    });
  }
}

module.exports = { QueueManager };
