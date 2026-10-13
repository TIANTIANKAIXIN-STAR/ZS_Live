'use strict';
/**
 * 实例池：负责 UE 进程的创建 / 监控 / 回收，以及实例状态跟踪。
 *
 * 实例状态流转：
 *   spawning -> ready(agent hello + rtmp ok) -> assigned(绑定会话) -> spare(会话结束) -> stopped
 *   任意状态 -> dead(进程退出/被杀)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const store = require('./db');
const auth = require('./auth');
const log = require('./logger');
const alloc = require('./gpuAllocator');

/** 强杀进程树（Windows 用 taskkill /T /F，其他平台 SIGKILL） */
function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* ignore */ }
}

class InstancePool {
  constructor() {
    // instanceId -> { id, templateId, templateName, exePath, proc, state, startedAt,
    //                 sessionId, lastActiveAt, stats, agentSeen, lastHeartbeat }
    this.instances = new Map();
    // templateId -> 冷却截止时间戳。
    // 预热实例因空闲被回收后，若 maintainWarm 立刻重建，会形成
    // 「空闲超时回收 → 立刻重建 → 再空闲 → 再回收」的永久循环：
    // 每 idleTimeout 秒一次 UE 冷启动，周期性冲击 GPU，拖垮正在推流的实例，
    // 后台监控里也永远有实例晃着。冷却期默认 180s，真实会话到来时解除。
    this.warmCooldown = new Map();
    this.lastSpawnAt = 0; // 上次 spawn 时间（冷启动串行化节流）
    this.onSessionEnded = null; // (instance) => void  实例会话结束后回调（用于补位/排队）
    this.onInstanceDead = null; // (instance) => void
    this.onAssign = null;       // (instance) => void  会话绑定实例（用于恢复满配推流）
    this.onRelease = null;      // (instance) => void  会话释放实例（用于待命降载）
    this.onReadyFree = null;    // (instance) => void  实例就绪且无会话（用于待命降载）
  }

  get size() { return this.instances.size; }

  get maxInstances() { return parseInt(store.getSetting('maxInstances', config.maxInstances), 10); }

  /** 模板单实例的 GPU 负载权重（%）；未设置用默认 30 */
  static weightOf(template) {
    const w = parseInt(template && template.gpu_weight, 10);
    return Number.isFinite(w) && w > 0 ? w : 30;
  }

  /** 当前 GPU 负载估算：所有存活实例（含 spawning/待命）权重之和。
   *  待命实例实际只占 ~2-3%（5fps），但按满权重保守计——预留安全余量，
   *  保证「已接入的流绝不因新开流而掉帧」优先于「多塞一路」。 */
  gpuLoadPct() {
    let sum = 0;
    for (const it of this.instances.values()) {
      if (it.state === 'dead' || it.state === 'stopping') continue;
      const tpl = store.templates.get(it.templateId);
      sum += InstancePool.weightOf(tpl);
    }
    return sum;
  }

  /** 是否有实例正在冷启动（spawning）：串行化依据 */
  hasSpawning() {
    for (const it of this.instances.values()) {
      if (it.state === 'spawning') return true;
    }
    return false;
  }

  /** 冷启动串行化：有实例在启动、或距上次 spawn 太近（GPU 冷启动尖峰叠加会饿死在跑的流） */
  canSpawnNow() {
    if (this.hasSpawning()) return false;
    const gap = parseInt(store.getSetting('spawnIntervalSec', '6'), 10) * 1000;
    return Date.now() - this.lastSpawnAt >= gap;
  }

  list() {
    const out = [];
    for (const it of this.instances.values()) {
      out.push({
        id: it.id,
        templateId: it.templateId,
        templateName: it.templateName,
        state: it.state,
        sessionId: it.sessionId,
        gpuIndex: it.gpuIndex !== undefined && it.gpuIndex !== null ? it.gpuIndex : null,
        pid: it.proc ? it.proc.pid : null,
        startedAt: it.startedAt,
        uptimeSec: Math.round((Date.now() - it.startedAt) / 1000),
        stats: it.stats || {},
        agentOk: Date.now() - (it.lastHeartbeat || 0) < 15000,
      });
    }
    return out;
  }

  get(id) { return this.instances.get(id); }

  /**
   * 找一个可分配的实例（ready 且无会话）。
   * 传入 templateId 时严格匹配模板——不同模板（编辑器模式 / 打包版）不可互换，
   * 否则打包版会话会拿到编辑器 warm 实例（或反之）。
   */
  findFree(templateId) {
    for (const it of this.instances.values()) {
      if (it.state === 'ready' && !it.sessionId) {
        if (templateId != null && String(it.templateId) !== String(templateId)) continue;
        return it;
      }
    }
    return null;
  }

  /** 启动一个新实例；返回实例对象。exceedMax=true 时可超池（排队补位场景不使用）。 */
  spawn(template) {
    if (this.size >= this.maxInstances) {
      throw new Error(`实例数已达上限 ${this.maxInstances}（可在系统设置中调整）`);
    }
    if (!fs.existsSync(template.exe_path)) {
      throw new Error(`UE 可执行文件不存在: ${template.exe_path}`);
    }

    // ---- GPU 负载预算准入：超卖会让在跑的流掉帧（开新流老流卡死的根因）----
    const weight = InstancePool.weightOf(template);
    const budget = parseInt(store.getSetting('gpuBudget', '90'), 10) || 90;
    const current = this.gpuLoadPct();
    if (current + weight > budget) {
      throw new Error(`GPU 负载预算已满：当前 ${current}% + 新实例 ${weight}% 超过预算 ${budget}%`
        + `（可在系统设置调高 gpuBudget，或调低模板的 GPU 权重）`);
    }
    this.lastSpawnAt = Date.now();

    const instanceId = auth.randomId('inst');
    const isWin = process.platform === 'win32';
    // 手写的 -graphicsadapter 由平台按配额自动注入，先剔除避免冲突；
    // -log/-console 会弹出 UE 日志黑窗口（服务器桌面体验差），一律剔除——日志照常写 Saved/Logs；
    // -fps / -ResX / -ResY 由平台按模板帧率与分辨率注入，手写的剔除保持一致——
    // 否则后台改 4K 编码但附加参数仍是 1280x720 时，会先低分辨率渲染再双线性拉伸，画面发糊。
    const tplArgs = alloc.stripGraphicsAdapterArgs((template.args || '').split(/\s+/).filter(Boolean))
      .filter((a) => !/^-(log|console)$/i.test(a)
        && !/^-windowed$/i.test(a)
        && !/^-ForceRes$/i.test(a)
        && !/^-fps=\d+$/i.test(a)
        && !/^-ResX=\d+$/i.test(a)
        && !/^-ResY=\d+$/i.test(a)
        // 分辨率由平台统一 ExecCmds 强制，避免与 Saved/GameUserSettings.ini 的 720p 冲突
        && !/^-ExecCmds=/i.test(a));

    // ---- GPU 选卡（配额 + 模板绑定）----
    // 配额未启用：模板 gpu_index>=0 仍固定绑卡，否则不绑（旧行为）
    // 配额已启用：自动挑剩余配额最多的卡；配额全满时抛错（调用方转排队）
    const quotas = alloc.parseGpuQuotas(store.getSetting('gpuQuotas', ''));
    const pinned = Number.isFinite(parseInt(template.gpu_index, 10)) ? parseInt(template.gpu_index, 10) : null;
    let gpuIndex = null;
    try {
      gpuIndex = alloc.pickGpuForSpawn(quotas, this.instances, pinned === null || pinned < 0 ? null : pinned);
    } catch (e) {
      if (/配额已满/.test(e.message)) {
        log.warn(`[Pool] 实例 ${instanceId} (${template.name}) 启动被拒: ${e.message}`);
        throw e;
      }
      gpuIndex = null; // 其他异常降级为不绑卡，保证可用性
    }
    const gpuProfile = alloc.buildGpuLaunchProfile(gpuIndex, process.platform,
      alloc.parseBindEnvVars(store.getSetting('gpuBindEnvVars', '')));
    if (gpuIndex !== null) {
      log.info(`[Pool] 实例 ${instanceId} 绑定 GPU${gpuIndex}${pinned !== null && pinned >= 0 ? '（模板固定）' : '（自动选卡）'}`);
    }

    // 默认离屏渲染：云端实例无需本地窗口。可在 系统设置->renderOffscreen=0 全局关闭，
    // 或在模板附加参数里显式写 -RenderOffScreen / -NoRenderOffScreen 覆盖。
    const offscreen = String(store.getSetting('renderOffscreen', '1')) === '1';
    const hasOffscreenFlag = tplArgs.some(a => /^-(No)?RenderOffScreen$/i.test(a));
    // GameUserSettings.ini 常会覆盖 -ResX/-ResY（本机实测被锁回 1280x720，
    // 再叠加 sg.ResolutionQuality=0 → 背缓冲约 888x500，拉伸到 4K 必然发糊）。
    // -ForceRes + ExecCmds 强制渲染分辨率与屏幕百分比。
    const w = template.width;
    const h = template.height;
    const forceResCmds = `r.SetRes ${w}x${h},sg.ResolutionQuality 100,r.ScreenPercentage 100`;
    const args = [
      ...tplArgs,
      ...gpuProfile.extraArgs,
      ...(offscreen && !hasOffscreenFlag ? ['-RenderOffScreen'] : []),
      `-windowed`,
      `-ForceRes`,
      `-ResX=${w}`,
      `-ResY=${h}`,
      `-ExecCmds=${forceResCmds}`,
      `-fps=${template.fps}`, // 引擎级限帧：渲染帧率与推流帧率一致，防止 GPU 被无意义打满
      `-SFInstanceId=${instanceId}`,
      `-SFRtmpUrl=${config.rtmpUrlFor(instanceId)}`,
      `-SFAgentUrl=${config.agentUrl()}`,
      `-SFAgentToken=${auth.newAgentToken(instanceId)}`,
      `-SFWidth=${w}`,
      `-SFHeight=${h}`,
      `-SFFps=${template.fps}`,
      `-SFBitrate=${template.bitrate_kbps}`,
      `-SFMaxBitrate=${Math.round(template.bitrate_kbps * 1.5)}`,
      // 稳态 IDR 周期统一 2s（原 4K 为 4s）。切回前台的解码重建卡顿已由按需 IDR
      // 机制[sf_request_keyframe]根治，缩短稳态周期只作兜底：2s GOP 是 WebRTC 直播通用
      // 推荐值，IDR 尖峰在现代 MediaMTX+浏览器下可吸收，且明显优于 4s 的等待窗口。
      `-SFKeyframeInterval=2`,
      `-SFAudio=${template.audio_codec || 'auto'}`,
      `-SFInput=${template.enable_input ? 1 : 0}`,
      // 编码后端：auto=硬件优先失败降级 FFmpeg（默认）；ave=仅 NVENC/AMF；ffmpeg=软编码/国产卡 VAAPI。
      // 旧版插件不认识该参数会自动忽略，行为不变（向后兼容）。
      `-SFEncoder=${template.encoder_backend || 'auto'}`,
      `-SFFFmpegPath=${store.getSetting('ffmpegPath', 'ffmpeg')}`,
    ];

    let exe = template.exe_path;
    let finalArgs = args;
    // Linux 打包程序是 .sh 启动脚本
    if (!isWin && exe.endsWith('.sh')) {
      finalArgs = [exe, ...args];
      exe = 'bash';
    }

    log.info(`[Pool] 启动实例 ${instanceId} (${template.name}): ${exe} ${finalArgs.join(' ')}`);
    let proc;
    try {
      proc = spawn(exe, finalArgs, {
        cwd: path.dirname(template.exe_path),
        windowsHide: true,
        detached: false,
        stdio: 'ignore',
        env: { ...process.env, ...gpuProfile.env },
      });
    } catch (e) {
      throw new Error(`进程启动失败: ${e.message}`);
    }

    const it = {
      id: instanceId,
      templateId: template.id,
      templateName: template.name,
      bitrate_kbps: template.bitrate_kbps, // 模板满配码率（自适应降档基准）
      gpuIndex, // 绑定的物理 GPU 编号（null = 未绑卡）
      proc,
      state: 'spawning',
      startedAt: Date.now(),
      sessionId: null,
      lastActiveAt: Date.now(),
      stats: {},
      lastHeartbeat: 0,
      spawnTimeout: setTimeout(() => {
        if (it.state === 'spawning') {
          log.warn(`[Pool] 实例 ${instanceId} 启动超时（120s 未见 agent），回收`);
          this.stop(instanceId, 'spawn_timeout');
        }
      }, 120000),
    };
    this.instances.set(instanceId, it);

    proc.on('exit', (code) => {
      clearTimeout(it.spawnTimeout);
      clearTimeout(it.stopTimer);
      const wasAssigned = !!it.sessionId;
      const prevState = it.state;
      it.state = 'dead';
      log.info(`[Pool] 实例 ${instanceId} 退出 (code=${code}, state=${prevState})`);
      if (this.onInstanceDead) this.onInstanceDead(it, wasAssigned);
      this.instances.delete(instanceId);
    });
    proc.on('error', (e) => {
      log.error(`[Pool] 实例 ${instanceId} 进程错误: ${e.message}`);
      try { proc.kill(); } catch { /* ignore */ }
    });

    return it;
  }

  agentHello(instanceId, info) {
    const it = this.instances.get(instanceId);
    if (!it) return false;
    clearTimeout(it.spawnTimeout);
    it.state = it.sessionId ? 'assigned' : 'ready';
    it.lastHeartbeat = Date.now();
    it.stats = { ...it.stats, ...info };
    log.info(`[Pool] 实例 ${instanceId} 就绪 (pid=${info.pid} platform=${info.platform})`);
    if (!it.sessionId && this.onReadyFree) this.onReadyFree(it);
    return true;
  }

  agentHeartbeat(instanceId, stats) {
    const it = this.instances.get(instanceId);
    if (!it) return false;
    it.lastHeartbeat = Date.now();
    it.stats = { ...it.stats, ...stats };
    return true;
  }

  /**
   * 实例上报启动/运行期错误（如 NVENC 未注册导致视频管线初始化失败）。
   * 记录到实例 stats（管理后台/启动器可见），供排查"推流一直连不上"类问题。
   */
  agentError(instanceId, info) {
    const it = this.instances.get(instanceId);
    if (!it) return false;
    it.stats = {
      ...it.stats,
      lastError: {
        code: (info && info.code) || 'unknown',
        detail: (info && info.detail) || '',
        at: new Date().toISOString(),
      },
    };
    return true;
  }

  assign(it, sessionId) {
    it.sessionId = sessionId;
    it.state = 'assigned';
    it.lastActiveAt = Date.now();
    // 真实会话绑定 = 需求信号：解除该模板的预热冷却，恢复预热补位
    this.warmCooldown.delete(String(it.templateId));
    if (this.onAssign) this.onAssign(it);
  }

  /** 会话结束：实例转入 spare，等待复用或空闲回收 */
  release(instanceId) {
    const it = this.instances.get(instanceId);
    if (!it) return;
    it.sessionId = null;
    it.state = 'ready';
    it.lastActiveAt = Date.now();
    if (this.onRelease) this.onRelease(it);
  }

  stop(instanceId, reason) {
    const it = this.instances.get(instanceId);
    if (!it) return false;
    log.info(`[Pool] 停止实例 ${instanceId} (${reason})`);
    // 空闲回收的预热实例：模板进入预热冷却期，maintainWarm 冷却期内不重建
    if (reason === 'idle_timeout') {
      const cooldownSec = parseInt(store.getSetting('warmRespawnDelay', '180'), 10);
      if (cooldownSec > 0) {
        this.warmCooldown.set(String(it.templateId), Date.now() + cooldownSec * 1000);
        log.info(`[Pool] 模板 ${it.templateName} 预热冷却 ${cooldownSec}s（防止空闲回收-重建死循环）`);
      }
    }
    it.state = 'stopping';

    // 1) 优雅停止：向 agent 发送 {t:'stop'}，UE 端 OnStopRequest 会
    //    正常销毁 NVENC/RTMP/WS 后自行退出（避免硬杀导致的资源残留）
    const graceful = this.sendAgentStop && this.sendAgentStop(instanceId);
    if (graceful) {
      it.stopTimer = setTimeout(() => {
        try { if (it.proc.exitCode === null) killTree(it.proc.pid); } catch { /* ignore */ }
      }, 6000).unref?.();
      return true;
    }

    // 2) agent 不可达（未接入/已掉线）：直接强杀
    killTree(it.proc.pid);
    setTimeout(() => {
      try { if (it.proc.exitCode === null) it.proc.kill('SIGKILL'); } catch { /* ignore */ }
    }, 8000).unref?.();
    return true;
  }

  stopAll() {
    for (const id of this.instances.keys()) this.stop(id, 'server_shutdown');
  }

  /** 空闲回收（定时调用） */
  sweepIdle() {
    const idleTimeout = parseInt(store.getSetting('idleTimeout', config.idleTimeout), 10) * 1000;
    for (const it of this.instances.values()) {
      if (!it.sessionId && it.state === 'ready' && Date.now() - it.lastActiveAt > idleTimeout) {
        log.info(`[Pool] 实例 ${it.id} 空闲超时回收`);
        this.stop(it.id, 'idle_timeout');
      }
    }
  }

  /** 维持预热池：每个模板按自身 warm_count 预热（未设置则用全局默认预热数），总量受 maxInstances 约束 */
  maintainWarm() {
    const defaultWarm = parseInt(store.getSetting('warmCount', config.warmCount), 10);
    const templates = store.templates.list();
    if (templates.length === 0) return;
    for (const tpl of templates) {
      if (this.size >= this.maxInstances) return;
      // 冷启动串行化：有实例正在启动 / 距上次 spawn 太近，本轮跳过（下轮 sweep 再试）
      if (!this.canSpawnNow()) return;
      // 冷却期内不重建（见 constructor 注释：防空闲回收-重建死循环）
      const cooldownUntil = this.warmCooldown.get(String(tpl.id)) || 0;
      if (Date.now() < cooldownUntil) continue;
      const warm = tpl.warm_count === null || tpl.warm_count === undefined
        ? defaultWarm : parseInt(tpl.warm_count, 10);
      if (!(warm > 0)) continue; // 0 = 该模板不预热
      const freeCount = [...this.instances.values()].filter(
        (i) => !i.sessionId && i.state !== 'dead' && i.state !== 'stopping' && String(i.templateId) === String(tpl.id)
      ).length;
      const need = warm - freeCount;
      if (need > 0) {
        try {
          this.spawn(tpl);
          log.info(`[Pool] 预热新实例 (template=${tpl.name}, free=${freeCount}, warm=${warm}${tpl.warm_count == null ? '(全局默认)' : ''})`);
        } catch (e) {
          log.warn(`[Pool] 预热失败 (template=${tpl.name}): ${e.message}`);
        }
      }
    }
  }
}

module.exports = { InstancePool };
