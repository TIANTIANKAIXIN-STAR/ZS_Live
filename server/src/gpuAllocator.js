'use strict';
/**
 * gpuAllocator.js — 多显卡「配额 + 自动选卡 + 绑卡启动」
 *
 * 配置写法（管理后台「GPU 监控」页或 .env GPU_QUOTAS）：
 *   gpuQuotas = "0:3,1:1"
 *   意思是：物理 GPU 0 最多 3 路实例，GPU 1 最多 1 路（合计 4 路并发）
 *
 * 模板级绑定：templates.gpu_index
 *   null = 自动（按配额挑剩余最多的卡）
 *   >=0  = 固定绑到该卡（优先级高于自动选择，但仍受该卡配额约束）
 *   -1   = 强制不绑卡
 *
 * 绑卡方式：UE 启动参数 -graphicsadapter=N（物理卡号，Windows/Linux 通用）；
 * Linux 额外注入 CUDA_VISIBLE_DEVICES / NVIDIA_VISIBLE_DEVICES 供 NVENC/CUDA 路径生效。
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger');

/** 解析配额字符串为配额数组；null = 未启用（不绑卡，兼容旧行为） */
function parseGpuQuotas(raw) {
  if (raw === undefined || raw === null) return null;
  const s = String(raw).trim();
  // 空串 / 0 / false / off 表示关闭；注意用整串匹配，"0:3,1:1" 以 0 开头不能误判
  if (!s || /^(0|false|off|disabled)$/i.test(s)) return null;

  // JSON 格式：[{"index":0,"maxInstances":3},...]
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return null;
      const out = arr
        .map((x) => ({
          index: parseInt(String(x.index ?? x.gpu ?? x.gpuIndex), 10),
          maxInstances: parseInt(String(x.maxInstances ?? x.max ?? x.limit), 10),
        }))
        .filter((x) => Number.isFinite(x.index) && x.index >= 0 && Number.isFinite(x.maxInstances) && x.maxInstances > 0);
      return out.length ? out.sort((a, b) => a.index - b.index) : null;
    } catch {
      return null;
    }
  }

  // 简写格式：0:3,1:1,2:2
  const out = [];
  for (const part of s.split(',')) {
    const seg = part.trim();
    if (!seg) continue;
    const [idxRaw, maxRaw] = seg.split(':');
    const index = parseInt(String(idxRaw ?? '').trim(), 10);
    const maxInstances = parseInt(String(maxRaw ?? '').trim(), 10);
    if (Number.isFinite(index) && index >= 0 && Number.isFinite(maxInstances) && maxInstances > 0) {
      out.push({ index, maxInstances });
    }
  }
  return out.length ? out.sort((a, b) => a.index - b.index) : null;
}

/** 配额合计（建议 maxInstances 参考值） */
function sumGpuQuotaMax(quotas) {
  return (quotas || []).reduce((s, q) => s + q.maxInstances, 0);
}

/** 配额格式化为人类可读串（日志用） */
function formatGpuQuotas(quotas) {
  if (!quotas || !quotas.length) return '（未启用）';
  return quotas.map((q) => `GPU${q.index}≤${q.maxInstances}`).join(', ');
}

/** 统计每张 GPU 当前实例数（不含 dead/stopping；实例记录需带 gpuIndex） */
function countInstancesByGpu(instances) {
  const counts = {};
  for (const it of instances.values()) {
    if (it.gpuIndex === undefined || it.gpuIndex === null) continue;
    if (it.state === 'dead' || it.state === 'stopping') continue;
    counts[it.gpuIndex] = (counts[it.gpuIndex] || 0) + 1;
  }
  return counts;
}

/**
 * 为新实例选卡。
 * @param {Array|null} quotas 配额数组（null = 未启用配额）
 * @param {Map} instances 实例池 Map
 * @param {number|null} pinned 模板固定绑卡编号（null/-1 = 自动）
 * @returns {number|null} GPU 编号；null = 不绑卡
 * @throws {Error} 配额已满（信息含「GPU 配额」，调用方据此排队）
 */
function pickGpuForSpawn(quotas, instances, pinned) {
  // 未启用配额：模板固定绑卡仍生效，否则不绑（旧行为）
  if (!quotas || !quotas.length) {
    return Number.isFinite(pinned) && pinned >= 0 ? pinned : null;
  }

  const counts = countInstancesByGpu(instances);

  // 模板显式固定绑卡：优先满足；该卡在配额表内则校验余量，不在表内视为不限
  if (Number.isFinite(pinned) && pinned >= 0) {
    const q = quotas.find((x) => x.index === pinned);
    if (q && (counts[pinned] || 0) >= q.maxInstances) {
      throw new Error(`GPU ${pinned} 配额已满（上限 ${q.maxInstances} 路），模板固定绑定了该卡`);
    }
    return pinned;
  }

  // 自动选择：在有余量的卡里挑「剩余配额最多」的（尽量先填满一张卡，减少跨卡带宽）
  let bestIndex = null;
  let bestRemaining = -1;
  for (const q of quotas) {
    const remaining = q.maxInstances - (counts[q.index] || 0);
    if (remaining > 0 && remaining > bestRemaining) {
      bestRemaining = remaining;
      bestIndex = q.index;
    }
  }
  if (bestIndex === null) {
    throw new Error(`所有 GPU 配额已满（${formatGpuQuotas(quotas)}）`);
  }
  return bestIndex;
}

/** 按平台生成绑卡启动参数与子进程环境变量 */
function buildGpuLaunchProfile(gpuIndex, platform = process.platform, bindEnvVars) {
  if (gpuIndex === undefined || gpuIndex === null) return { extraArgs: [], env: {} };
  const n = Number(gpuIndex);
  if (!Number.isFinite(n) || n < 0) return { extraArgs: [], env: {} };
  if (platform === 'win32') {
    return { extraArgs: [`-graphicsadapter=${n}`], env: {} };
  }
  // Linux：-vulkan 枚举以 graphicsadapter 为准；可见设备变量按厂商注入。
  // bindEnvVars 可配（系统设置 gpuBindEnvVars）：NVIDIA 用 CUDA/NVIDIA_VISIBLE_DEVICES，
  // 摩尔线程用 MUSA_VISIBLE_DEVICES，砺算等待厂商确认后加进配置即可，无需改代码。
  const vars = Array.isArray(bindEnvVars) && bindEnvVars.length
    ? bindEnvVars
    : ['CUDA_VISIBLE_DEVICES', 'NVIDIA_VISIBLE_DEVICES'];
  const env = {};
  for (const v of vars) env[v] = String(n);
  return { extraArgs: [`-graphicsadapter=${n}`], env };
}

/** 解析系统设置里的绑卡环境变量列表（逗号分隔） */
function parseBindEnvVars(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[A-Z][A-Z0-9_]*$/i.test(s));
}

/** 删除模板参数里手写的 -graphicsadapter=*（平台自动注入，避免冲突） */
function stripGraphicsAdapterArgs(tokens) {
  return (tokens || []).filter((a) => !/^-graphicsadapter=/i.test(a));
}

/** 管理后台快照：每卡配额/占用/剩余 */
function getGpuUsageSnapshot(quotas, instances) {
  if (!quotas || !quotas.length) {
    return { enabled: false, quotas: [], usage: [], totalQuota: 0, totalUsed: 0 };
  }
  const counts = countInstancesByGpu(instances);
  const usage = quotas.map((q) => {
    const used = counts[q.index] || 0;
    return { index: q.index, maxInstances: q.maxInstances, used, remaining: Math.max(0, q.maxInstances - used) };
  });
  return {
    enabled: true,
    quotas,
    usage,
    totalQuota: sumGpuQuotaMax(quotas),
    totalUsed: usage.reduce((s, u) => s + u.used, 0),
  };
}

// ---------- nvidia-smi 探测 ----------

function resolveNvidiaSmi() {
  const fromEnv = process.env.NVIDIA_SMI_PATH;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'nvidia-smi.exe') : null,
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return 'nvidia-smi'; // 交给 PATH（Linux 常见）
}

/**
 * 单次查询 nvidia-smi（异步，超时 5s）。
 * @returns {Promise<{gpus:Array,source:string}|null>} 查询失败返回 null
 */
function queryNvidiaSmiOnce() {
  const bin = resolveNvidiaSmi();
  return new Promise((resolve) => {
    execFile(bin, [
      '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
      '--format=csv,noheader,nounits',
    ], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const gpus = String(stdout).trim().split('\n')
          .map((l) => l.trim()).filter(Boolean)
          .map((line) => {
            const p = line.split(',').map((s) => s.trim());
            return {
              index: parseInt(p[0], 10) || 0,
              name: p[1] || 'Unknown',
              vramTotalMB: parseInt(p[2], 10) || 0,
              vramUsedMB: parseInt(p[3], 10) || 0,
              vramFreeMB: parseInt(p[4], 10) || 0,
              utilPct: parseInt(p[5], 10) || 0,
              tempC: parseInt(p[6], 10) || 0,
            };
          })
          .filter((g) => g.name && g.name !== 'Unknown');
        resolve(gpus.length ? { gpus, source: 'nvidia-smi' } : null);
      } catch {
        resolve(null);
      }
    });
  });
}

module.exports = {
  parseGpuQuotas,
  sumGpuQuotaMax,
  formatGpuQuotas,
  countInstancesByGpu,
  pickGpuForSpawn,
  buildGpuLaunchProfile,
  parseBindEnvVars,
  stripGraphicsAdapterArgs,
  getGpuUsageSnapshot,
  resolveNvidiaSmi,
  queryNvidiaSmiOnce,
};
