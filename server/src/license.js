'use strict';
/**
 * ZS Live 授权校验（闭源核心组件，不随源码公开）
 *
 * 设计（RSA 非对称，防伪造）：
 *  - 作者持有【私钥】签发授权（见 scripts/gen_license.js），绝不外发。
 *  - 运行时持有【公钥】仅做验签（随部署包分发，公钥无法反推私钥、也无法用来签名）。
 *  - 因此即使客户拿到完整部署代码，也无法伪造合法 License Key。
 *
 * License 格式：`<base64url(payload)>.<base64url(sig)>`
 *   payload = { v, iat, exp, max, edition, to, hwid? }
 *     v       协议版本（当前 2；1 为旧版未绑定机器）
 *     iat     签发时间(ms)
 *     exp     过期时间(ms)，缺失表示永久
 *     max     允许的最大并发实例数（按并发数收费的计费单元）
 *     edition 版本档位（eval / standard / enterprise）
 *     to      授权对象（客户标识，用于泄露溯源）
 *     hwid?   机器指纹（一机一码）：存在时仅允许在指纹匹配的机器上使用
 *
 * 读取顺序：
 *   token  ：环境变量 ZSLIVE_LICENSE → 文件 server/license.key
 *   公钥   ：环境变量 ZSLIVE_LICENSE_PUBKEY → 文件 server/license.pub.pem
 *
 * 校验失败时返回 { valid:false }，调用方应将实例上限压到 1（评估模式）并告警，
 * 从而阻止未授权的大规模商业部署（白嫖），但不影响作者本地开发与演示。
 * 机器绑定（hwid）不匹配时返回 reason='HW_MISMATCH'（同样降级为评估模式）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getFingerprint } = require('./fingerprint');

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}
function b64urlDecode(s) {
  return Buffer.from(s, 'base64url');
}

function readPubKey() {
  if (process.env.ZSLIVE_LICENSE_PUBKEY) return process.env.ZSLIVE_LICENSE_PUBKEY;
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'license.pub.pem'), 'utf8');
  } catch {
    return null;
  }
}

function readToken() {
  if (process.env.ZSLIVE_LICENSE) return process.env.ZSLIVE_LICENSE.trim();
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'license.key'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * 校验一个 token 字符串（供 verify() 与作者侧工具复用）。
 * @returns {{valid:boolean, reason?:string, max:number, edition:string, to?:string, exp?:number, iat?:number}}
 */
function verifyToken(token) {
  if (!token) return { valid: false, reason: 'NO_LICENSE', max: 1, edition: 'eval' };

  const pub = readPubKey();
  if (!pub) {
    // 运行时缺少公钥也视为未授权：部署包必须带公钥，否则无法验签
    return { valid: false, reason: 'NO_PUBKEY', max: 1, edition: 'eval' };
  }

  const parts = String(token).split('.');
  if (parts.length !== 2) {
    return { valid: false, reason: 'BAD_FORMAT', max: 1, edition: 'eval' };
  }
  const [payloadB64, sigB64] = parts;

  let ok = false;
  try {
    ok = crypto
      .createVerify('RSA-SHA256')
      .update(payloadB64)
      .verify(pub, sigB64, 'base64url');
  } catch {
    ok = false;
  }
  if (!ok) {
    return { valid: false, reason: 'BAD_SIGNATURE', max: 1, edition: 'eval' };
  }

  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadB64).toString('utf8'));
  } catch {
    return { valid: false, reason: 'BAD_PAYLOAD', max: 1, edition: 'eval' };
  }

  if (payload.exp && Date.now() > payload.exp) {
    return {
      valid: false,
      reason: 'EXPIRED',
      max: 1,
      edition: payload.edition || 'eval',
      exp: payload.exp,
      to: payload.to,
      hwid: payload.hwid,
    };
  }

  // 机器绑定（一机一码）：仅当 token 显式携带 hwid 时才校验本机指纹。
  // 作者自用未绑定 dev token（不携带 hwid）仍可正常通过，便于本地开发。
  if (payload.hwid) {
    const local = getFingerprint();
    if (local !== payload.hwid) {
      return {
        valid: false,
        reason: 'HW_MISMATCH',
        max: 1,
        edition: payload.edition || 'eval',
        to: payload.to,
        exp: payload.exp,
        hwid: payload.hwid,
      };
    }
  }

  return {
    valid: true,
    reason: 'OK',
    max: Number.isFinite(payload.max) ? payload.max : 1,
    edition: payload.edition || 'standard',
    to: payload.to,
    exp: payload.exp,
    iat: payload.iat,
    hwid: payload.hwid,
  };
}

/**
 * 验证授权（从标准位置读取 token）。
 */
function verify() {
  return verifyToken(readToken());
}

module.exports = { verify, verifyToken, b64urlEncode, b64urlDecode };
