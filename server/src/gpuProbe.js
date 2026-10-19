'use strict';
/**
 * gpuProbe.js — 多厂商 GPU 探测链（国产化适配的探测入口）
 *
 * 探测顺序（任一成功即返回）：
 *   1) 自定义命令：系统设置 gpuProbeCmd（JSON：{"cmd":"...","args":["..."],"format":"nvidia-csv"}）
 *      —— 砺算等国产卡厂商 CLI 就绪后，后台配一下即可接入，无需改代码
 *   2) nvidia-smi（NVIDIA，现有行为，保持不变）
 *   3) mtt-smi（摩尔线程，CLI 兼容 nvidia-smi 查询参数）
 *   4) vulkaninfo 兜底（只能拿到卡名，无显存/利用率，证明"有卡"）
 *
 * 统一输出结构（gpuMonitor/后台/配额逻辑全部不用感知厂商差异）：
 *   { gpus: [{ index, name, vramTotalMB, vramUsedMB, vramFreeMB, utilPct, tempC, vendor }], source }
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require('./logger');
const store = require('./db');

const TIMEOUT_MS = 5000;

function execFileText(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(String(stdout));
    });
  });
}

/** nvidia-smi 风格 CSV：index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu */
function parseNvidiaCsv(stdout, vendor) {
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
        vendor,
      };
    })
    .filter((g) => g.name && g.name !== 'Unknown');
  return gpus.length ? gpus : null;
}

const NVIDIA_QUERY_ARGS = [
  '--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu',
  '--format=csv,noheader,nounits',
];

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

/** 1) 自定义探测命令（系统设置 gpuProbeCmd） */
async function probeCustom() {
  const raw = store.getSetting('gpuProbeCmd', '');
  if (!raw || !String(raw).trim()) return null;
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    log.warn('[GPU] gpuProbeCmd 不是合法 JSON，已跳过自定义探测');
    return null;
  }
  if (!cfg.cmd) return null;
  const args = Array.isArray(cfg.args) ? cfg.args.map(String) : NVIDIA_QUERY_ARGS;
  const out = await execFileText(cfg.cmd, args);
  if (!out) return null;
  const gpus = parseNvidiaCsv(out, cfg.vendor || 'custom');
  return gpus ? { gpus, source: `custom:${cfg.cmd}` } : null;
}

/** 2) NVIDIA */
async function probeNvidia() {
  const out = await execFileText(resolveNvidiaSmi(), NVIDIA_QUERY_ARGS);
  if (!out) return null;
  const gpus = parseNvidiaCsv(out, 'nvidia');
  return gpus ? { gpus, source: 'nvidia-smi' } : null;
}

/** 3) 摩尔线程（mtt-smi 兼容 nvidia-smi 查询语法） */
async function probeMthreads() {
  const out = await execFileText('mtt-smi', NVIDIA_QUERY_ARGS);
  if (!out) return null;
  const gpus = parseNvidiaCsv(out, 'mthreads');
  return gpus ? { gpus, source: 'mtt-smi' } : null;
}

/** 4) vulkaninfo 兜底：只能列出渲染卡名称 */
async function probeVulkaninfo() {
  const out = await execFileText('vulkaninfo', ['--summary']);
  if (!out) return null;
  const gpus = [];
  const re = /deviceName\s*=\s*(.+)/g;
  let m;
  while ((m = re.exec(out)) !== null) {
    const name = m[1].trim();
    if (name) {
      gpus.push({
        index: gpus.length, name,
        vramTotalMB: 0, vramUsedMB: 0, vramFreeMB: 0, utilPct: 0, tempC: 0,
        vendor: 'unknown',
      });
    }
  }
  return gpus.length ? { gpus, source: 'vulkaninfo' } : null;
}

const CHAIN = [probeCustom, probeNvidia, probeMthreads, probeVulkaninfo];

// 记住上次成功的探测器，下次直接用它（失败再重新走全链）
let lastGood = null;

/** 按探测链查询 GPU；全部失败返回 null */
async function queryGpus() {
  const ordered = lastGood
    ? [lastGood, ...CHAIN.filter((p) => p !== lastGood)]
    : CHAIN;
  for (const probe of ordered) {
    try {
      const r = await probe();
      if (r && r.gpus.length) {
        if (lastGood !== probe) {
          lastGood = probe;
          log.info(`[GPU] 探测器锁定: ${r.source}（${r.gpus.length} 张卡）`);
        }
        return r;
      }
    } catch { /* 尝试下一个 */ }
  }
  if (lastGood) lastGood = null; // 原探测器失效，下轮重新走全链
  return null;
}

module.exports = { queryGpus, parseNvidiaCsv, resolveNvidiaSmi };
