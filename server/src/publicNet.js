'use strict';
/**
 * publicNet.js — 公网接入辅助：公网 IP 检测 + STUN/TURN 配置指引
 *
 * 公网部署 WebRTC（WHEP）必须解决 NAT 穿透：
 *  - 局域网：浏览器与 MediaMTX 同网，ICE host 候选直连即可
 *  - 公网：服务器有公网 IP 时通常只需 STUN；服务器在 NAT 后（如家庭宽带/机房内网）必须 TURN 中继
 *
 * 本模块提供：
 *  - detectPublicIp()：多源探测出口公网 IPv4（缓存 60s）
 *  - buildNetGuide()：生成 mediamtx.yml ICE 配置片段 + coturn 启动命令 + 检查清单
 */
const https = require('https');
const crypto = require('crypto');
const config = require('./config');
const store = require('./db');

let cache = { ip: null, at: 0, error: '' };
const CACHE_MS = 60000;

/** 单个探测源：返回文本 body */
function fetchText(host, path, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host, path, timeout: timeoutMs, headers: { 'User-Agent': 'curl/8.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => (res.statusCode === 200 ? resolve(data.trim()) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function isIpv4(s) { return /^\d{1,3}(\.\d{1,3}){3}$/.test(s); }

/** 探测出口公网 IPv4（多源依次尝试，4s 超时/源；60s 缓存） */
async function detectPublicIp(force = false) {
  if (!force && cache.ip && Date.now() - cache.at < CACHE_MS) {
    return { ip: cache.ip, cached: true, error: '' };
  }
  const sources = [
    () => fetchText('api.ipify.org', '/', 4000),
    () => fetchText('ifconfig.me', '/ip', 4000),
    () => fetchText('api-ipv4.ip.sb', '/ip', 4000),
  ];
  for (const src of sources) {
    try {
      const text = await src();
      const ip = text.split(/\s+/)[0];
      if (isIpv4(ip)) {
        cache = { ip, at: Date.now(), error: '' };
        return { ip, cached: false, error: '' };
      }
    } catch { /* 下一个源 */ }
  }
  cache = { ip: cache.ip, at: Date.now(), error: '公网探测失败（无外网访问或被防火墙拦截）' };
  return { ip: cache.ip, cached: false, error: cache.error };
}

/** 生成 TURN 凭据（每次调用生成一次，管理页展示后由管理员复制使用） */
function newTurnCredential() {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * 公网接入指引（管理页「公网接入检测」卡片数据源）
 * @param {string|null} publicIp 探测到的公网 IP
 */
function buildNetGuide(publicIp) {
  const envProfile = store.getSetting('envProfile', 'lan');
  const adaptive = store.getSetting('adaptiveEnabled', '0') === '1';
  const publicHostMatches = publicIp && publicIp === config.publicHost;
  const turnUser = 'zslive';
  const turnPass = newTurnCredential();
  const turnHost = publicIp || '<公网IP>';
  const relayStart = 49160;
  const relayEnd = 49200;

  const mediamtxYaml = [
    '# mediamtx.yml 末尾追加（路径：mediamtx/mediamtx.yml，改完重启 MediaMTX）',
    'webrtcICEServers2:',
    '  - url: stun:stun.l.google.com:19302',
    `  - url: turn:${turnHost}:3478?transport=udp`,
    '    username: ' + turnUser,
    '    credential: ' + turnPass,
    `  - url: turn:${turnHost}:3478?transport=tcp`,
    '    username: ' + turnUser,
    '    credential: ' + turnPass,
  ].join('\n');

  const coturnDocker = [
    '# 方式一：Docker 一键启动 TURN 服务器（推荐，与 MediaMTX 同机或独立机均可）',
    `docker run -d --name zslive-turn --network host coturn/coturn \\`,
    `  -n --realm=zslive --listening-port=3478 --fingerprint --lt-cred-mech \\`,
    `  --user=${turnUser}:${turnPass} \\`,
    `  --min-port=${relayStart} --max-port=${relayEnd} --no-cli --log-file=stdout`,
  ].join('\n');

  const checklist = [
    { ok: !!publicIp, text: publicIp ? `出口公网 IP：${publicIp}` : '公网 IP 探测失败（无外网访问）' },
    { ok: !!publicHostMatches, text: publicHostMatches
      ? `PUBLIC_HOST 已指向公网 IP（${config.publicHost}）`
      : `PUBLIC_HOST 当前为 ${config.publicHost}，公网部署请改为 ${publicIp || '公网IP'} 后重启` },
    { ok: envProfile === 'public' || envProfile === 'weak_net', text: `环境配置档：${envProfile}（公网部署建议应用 public 档）` },
    { ok: adaptive, text: adaptive ? '浏览器自适应降档已开启' : '建议开启自适应降档（public 档会自动开启）' },
    { ok: false, text: `防火墙放行：TCP 3100/1935/8890/3478，UDP 8189/${relayStart}-${relayEnd}` },
    { ok: false, text: 'HTTPS：公网建议用 Nginx/Caddy 反代 + 证书（wss/https），否则混布页面可能拦截摄像头/自动播放' },
  ];

  return {
    publicIp,
    currentPublicHost: config.publicHost,
    hostMatches: !!publicHostMatches,
    stunTurnYaml: mediamtxYaml,
    coturnCommand: coturnDocker,
    turn: { user: turnUser, port: 3478, relayPortRange: `${relayStart}-${relayEnd}` },
    checklist,
    vpnHint: '若服务器无公网 IP（家庭宽带/内网机房）：可选 ① 云服务器跑 frp/WireGuard 网关转发 ② 直接用 Tailscale/ZeroTier 组网（浏览器与服务器都装）③ 云主机部署（最简单）。详见部署手册 8.4/8.6。',
  };
}

module.exports = { detectPublicIp, buildNetGuide, newTurnCredential };
