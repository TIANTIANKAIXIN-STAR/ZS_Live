'use strict';
/**
 * 集群设置：读写 server/.env 中的集群相关配置段。
 *
 * 设计要点：
 *  - 仅 touching 白名单内的 key，绝不改动 ADMIN_PASS / DB_PATH / ADMIN_USER 等其他配置。
 *  - 角色(CLUSTER_ROLE)与共享密钥(CLUSTER_TOKEN)是【启动期】环境变量，
 *    config.js 的手工解析只认 `KEY=VALUE` 行（注释态 `# KEY=` 不进 process.env）。
 *    因此"激活注释行"即为配置生效，"注释回去"即为恢复默认未配置。
 *  - 本模块只负责"把值写回 .env"，进程需重启才生效——前端会显式提示用户重启。
 */

const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '..', '.env');

// 仅此白名单内的 key 会被本模块读写
const CLUSTER_KEYS = [
  'CLUSTER_ROLE',
  'CLUSTER_TOKEN',
  'CLUSTER_INTERNAL_PORT',
  'NODE_ID',
  'NODE_NAME',
  'NODE_PUBLIC_HOST',
  'NODE_PUBLIC_PORT',
  'MASTER_RENDER',
  'MASTER_MAX_INSTANCES',
];

function readRaw() {
  try { return fs.readFileSync(ENV_PATH, 'utf8'); } catch (e) { return ''; }
}

/**
 * 返回 .env 中"已激活"(非注释)的集群配置；未配置(注释态)返回空串。
 * 这是"下次启动将生效"的值，而非当前进程已加载的值。
 */
function getClusterConfig() {
  const raw = readRaw();
  const out = {};
  for (const k of CLUSTER_KEYS) out[k] = '';
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && CLUSTER_KEYS.indexOf(m[1]) >= 0) {
      let v = m[2];
      if (/^".*"$/.test(v)) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  }
  return out;
}

/**
 * 写回集群配置。
 * @param {Object} values 形如 { CLUSTER_ROLE:'master', CLUSTER_TOKEN:'...', ... }
 *   - 值非空 → 激活该行（去掉前导 #）并写入值
 *   - 值为空/未提供 → 该行回到注释态（# KEY=），即"恢复默认未配置"
 */
function saveClusterConfig(values) {
  const lines = readRaw().split(/\r?\n/);
  const present = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const k of CLUSTER_KEYS) {
      // 已激活行： KEY=value（行首）
      if (line.indexOf(k + '=') === 0) {
        const val = (values[k] != null && String(values[k]) !== '') ? String(values[k]) : '';
        lines[i] = val === '' ? `# ${k}=` : `${k}=${val}`;
        present.add(k);
        break;
      }
      // 注释激活行： # KEY= 或 #  KEY=（去 # 与空格后以 KEY= 开头）
      if (/^#\s*/.test(line) && line.replace(/^#\s*/, '').indexOf(k + '=') === 0) {
        const val = (values[k] != null && String(values[k]) !== '') ? String(values[k]) : '';
        lines[i] = val === '' ? `# ${k}=` : `${k}=${val}`;
        present.add(k);
        break;
      }
    }
  }
  // 文件里完全没有（连注释都没有）的 key，且本次给了值 → 追加到末尾
  for (const k of CLUSTER_KEYS) {
    if (!present.has(k) && values[k] != null && String(values[k]) !== '') {
      lines.push(`${k}=${String(values[k])}`);
    }
  }
  fs.writeFileSync(ENV_PATH, lines.join('\n'));
  return true;
}

module.exports = { ENV_PATH, CLUSTER_KEYS, getClusterConfig, saveClusterConfig };
