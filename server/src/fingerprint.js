'use strict';
/**
 * ZS Live 机器指纹（一机一码授权的基础）
 *
 * 目标：在一台机器上稳定、可复现地生成同一个指纹，且难以在另一台机器上伪造。
 * 选取「主板 UUID + CPU ID + 系统盘序列号」三者组合哈希，跨重启稳定。
 *
 * 用法:
 *   const { getFingerprint } = require('./fingerprint');
 *   const hwid = getFingerprint();           // 运行时校验用（进程内缓存，只算一次）
 *   node server/src/fingerprint.js           // 作为脚本打印本机指纹（供客户报机器码）
 *
 * 降级策略：若上述硬件信息全部取不到（极端环境），回退到 hostname + 平台 +
 * 首个非回环 MAC，并在指纹前加前缀 'weak:' 以区分（签发时不应接受 weak 指纹）。
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

// 进程内缓存：机器指纹跨重启稳定，整个进程生命周期只需计算一次（避免每次请求都启动 powershell）
let _cache = null;

function tryExec(cmd, args, timeoutMs = 5000) {
  try {
    return execFileSync(cmd, args, { timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8').trim();
  } catch {
    return '';
  }
}

function tryRead(p) {
  try { return fs.readFileSync(p, 'utf8').trim(); } catch { return ''; }
}

// 一次 powershell 调用取齐所有 Windows 硬件信息 + 虚拟化标识（避免顺序启动 6 个进程）
function collectWindows() {
  const out = tryExec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    '$e=@{};' +
    'try{$e.MB=((Get-CimInstance Win32_ComputerSystemProduct).UUID)}catch{};' +
    'try{$e.CPU=((Get-CimInstance Win32_Processor|Select-Object -First 1).ProcessorId)}catch{};' +
    'try{$e.DISK=((Get-CimInstance Win32_DiskDrive|Select-Object -First 1).SerialNumber)}catch{};' +
    'try{$e.MODEL=((Get-CimInstance Win32_ComputerSystem).Model)}catch{};' +
    'try{$e.MF=((Get-CimInstance Win32_ComputerSystem).Manufacturer)}catch{};' +
    'try{$e.BIOS=((Get-CimInstance Win32_Bios).SerialNumber)}catch{};' +
    '($e|ConvertTo-Json -Compress)'],
    8000);
  let mb = '', cpu = '', disk = '', hay = '';
  if (out) {
    try {
      const o = JSON.parse(out);
      mb = o.MB || ''; cpu = o.CPU || ''; disk = o.DISK || '';
      hay = [o.MODEL, o.MF, o.BIOS].filter(Boolean).join(' ').toLowerCase();
    } catch { /* ignore */ }
  }
  return { mb, cpu, disk, hay };
}

function detectVirtualLinux() {
  const v = tryExec('systemd-detect-virt', []).toLowerCase();
  if (v && v !== 'none' && v !== '') return true;
  const hay = (tryRead('/sys/class/dmi/id/product_name') + ' ' + tryRead('/sys/class/dmi/id/sys_vendor')).toLowerCase();
  return /vmware|virtualbox|virtual machine|kvm|qemu|xen|hyper-?v|parallels|bochs|openstack|cloud/.test(hay);
}

function collectMacFallback() {
  const macs = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal && it.mac && it.mac !== '00:00:00:00:00:00') macs.push(it.mac);
    }
  }
  return macs.sort().join('|');
}

function computeFingerprint() {
  const platform = process.platform;
  let parts = [];
  let weak = false;

  if (platform === 'win32') {
    const w = collectWindows();
    const mb = (w.mb || '').replace(/\s+/g, '');
    const cpu = (w.cpu || '').replace(/\s+/g, '');
    const disk = (w.disk || '').replace(/\s+/g, '');
    parts = [mb, cpu, disk].filter(Boolean);
    if (parts.length < 2) {
      weak = true;
      parts = [platform, os.hostname(), collectMacFallback()].filter(Boolean);
    }
    const virtual = /vmware|virtualbox|virtual machine|microsoft corporation|kvm|qemu|xen|hyper-?v|parallels|bochs/.test(w.hay);
    const raw = parts.join('#');
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
    const prefix = weak ? 'weak:' : (virtual ? 'vm:' : '');
    return prefix + hash;
  }

  if (platform === 'linux') {
    const id = tryRead('/etc/machine-id').replace(/\s+/g, '');
    const mb = tryRead('/sys/class/dmi/id/product_uuid').replace(/\s+/g, '');
    const cpu = (tryRead('/proc/cpuinfo').match(/serial\s*:\s*(\S+)/i) || [])[1] || '';
    parts = [id, mb, cpu].filter(Boolean);
    if (parts.length < 2) {
      weak = true;
      parts = [platform, os.hostname(), collectMacFallback()].filter(Boolean);
    }
    const virtual = detectVirtualLinux();
    const raw = parts.join('#');
    const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
    const prefix = weak ? 'weak:' : (virtual ? 'vm:' : '');
    return prefix + hash;
  }

  // 其他平台：弱指纹
  weak = true;
  const raw = [platform, os.hostname(), collectMacFallback()].filter(Boolean).join('#');
  const hash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
  return 'weak:' + hash;
}

function getFingerprint() {
  if (_cache === null) _cache = computeFingerprint();
  return _cache;
}

module.exports = { getFingerprint };

// 作为脚本直接运行时打印本机指纹
if (require.main === module) {
  const fp = getFingerprint();
  const weak = fp.startsWith('weak:');
  const vm = fp.startsWith('vm:');
  console.log('本机指纹(HWID):', fp);
  if (weak) console.log('⚠️  弱指纹（硬件信息不足，回退到 hostname+MAC），不建议用于正式授权');
  else if (vm) console.log('⚠️  虚拟机指纹（VM 克隆会导致 HWID 撞车，一套授权可跑多集群），签发会被拒绝');
  else console.log('✅ 强指纹（主板UUID+CPU ID+磁盘序列号，物理机）');
  console.log('把上面这串发给作者即可签发机器绑定授权。');
}
