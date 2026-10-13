'use strict';
/**
 * MediaMTX REST 对接（可选增强：状态监控）
 */
const http = require('http');
const config = require('./config');

function api(pathName, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: config.mediamtxHost, port: config.mediamtxApiPort, path: pathName, timeout: timeoutMs },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { resolve(null); }
        });
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function paths() {
  const r = await api('/v3/paths/list');
  return r && r.items ? r.items : [];
}

async function sessions() {
  const r = await api('/v3/sessions/list');
  return r && r.items ? r.items : [];
}

async function healthy() {
  return (await api('/v3/config/global/get', 1500)) !== null;
}

module.exports = { paths, sessions, healthy };
