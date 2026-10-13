'use strict';
/**
 * 配置加载：环境变量 + .env 文件（不引入 dotenv，手工解析）
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// 简易 .env 解析
(function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (/^".*"$/.test(val)) val = val.slice(1, -1);
    if (!(key in process.env)) process.env[key] = val;
  }
})();

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : def;
}

function detectLanIp() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) return it.address;
    }
  }
  return '127.0.0.1';
}

const config = {
  port: intEnv('PORT', 3000),
  publicHost: process.env.PUBLIC_HOST || detectLanIp(),

  mediamtxHost: process.env.MEDIAMTX_HOST || '127.0.0.1',
  mediamtxRtmpPort: intEnv('MEDIAMTX_RTMP_PORT', 1935),
  mediamtxWhepPort: intEnv('MEDIAMTX_WHEP_PORT', 8889),
  mediamtxApiPort: intEnv('MEDIAMTX_API_PORT', 9997),

  maxInstances: intEnv('MAX_INSTANCES', 3),
  warmCount: intEnv('WARM_COUNT', 1),
  idleTimeout: intEnv('IDLE_TIMEOUT', 300),
  queueInterval: intEnv('QUEUE_INTERVAL', 5),

  adminUser: process.env.ADMIN_USER || 'admin',
  adminPass: process.env.ADMIN_PASS || 'admin123',

  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'zslive.db'),

  streamApp: 'zslive', // MediaMTX 路径前缀

  // ---------- 集群 ----------
  // standalone（默认，单机完整功能）/ master（控制面：节点管理+跨节点调度，不本地拉实例）
  // / worker（渲染节点：完整单机功能 + 内部 API 供 master 调用）
  clusterRole: String(process.env.CLUSTER_ROLE || 'standalone').trim().toLowerCase(),
  clusterToken: String(process.env.CLUSTER_TOKEN || '').trim(),
  clusterInternalPort: intEnv('CLUSTER_INTERNAL_PORT', 3120),
  nodeId: String(process.env.NODE_ID || os.hostname()).trim(),
  nodeName: String(process.env.NODE_NAME || '').trim(),
};

// 集群对外地址（worker 的浏览器可达地址，可与 PUBLIC_HOST 不同）
config.nodePublicHost = String(process.env.NODE_PUBLIC_HOST || '').trim() || config.publicHost;
config.nodePublicPort = intEnv('NODE_PUBLIC_PORT', 0) || config.port;

config.isMaster = () => config.clusterRole === 'master';
config.isWorker = () => config.clusterRole === 'worker';
config.isStandalone = () => config.clusterRole !== 'master' && config.clusterRole !== 'worker';

config.rtmpUrlFor = (instanceId) =>
  `rtmp://${config.mediamtxHost}:${config.mediamtxRtmpPort}/${config.streamApp}/${instanceId}`;
config.whepUrlFor = (instanceId) =>
  `http://${config.nodePublicHost}:${config.mediamtxWhepPort}/${config.streamApp}/${instanceId}/whep`;
config.agentUrl = () => `ws://${config.nodePublicHost}:${config.nodePublicPort}/agent`;
config.nodeBaseUrl = () => `http://${config.nodePublicHost}:${config.nodePublicPort}`;

module.exports = config;
