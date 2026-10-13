'use strict';
/**
 * 认证：管理员 JWT 风格令牌（HMAC 签名，无外部依赖）+ 会话令牌
 */
const crypto = require('crypto');
const config = require('./config');

const SECRET = crypto.randomBytes(32).toString('hex'); // 每次启动随机，重启后需重新登录

function hmac(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** 管理员登录令牌 */
function signAdmin(user) {
  const payload = Buffer.from(JSON.stringify({ u: user.username, r: user.role, t: Date.now() }))
    .toString('base64url');
  return `${payload}.${hmac(payload)}`;
}

function verifyAdmin(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (hmac(payload) !== sig) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (Date.now() - data.t > 7 * 24 * 3600 * 1000) return null; // 7 天有效
    return data;
  } catch {
    return null;
  }
}

/** 浏览器会话令牌（分配实例时签发） */
function newSessionToken(sessionId) {
  return { token: crypto.randomBytes(24).toString('hex'), sessionId };
}

function newAgentToken(instanceId) {
  return crypto.createHmac('sha256', SECRET).update(`agent:${instanceId}`).digest('hex');
}

function verifyAgentToken(instanceId, token) {
  return token === newAgentToken(instanceId);
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

module.exports = { signAdmin, verifyAdmin, newSessionToken, newAgentToken, verifyAgentToken, randomId };
