'use strict';
/**
 * ZS Live 授权签发器（作者自用，仅放私有仓库，绝不公开）
 *
 * 采用 RSA 非对称签名：本机持有【私钥】server/license.priv.pem 才能签发；
 * 客户拿到的部署包只含【公钥】，无法伪造。
 *
 * 用法:
 *   node scripts/gen_license.js <天数> <maxInstances> <edition> <to> [outfile]
 *   例: node scripts/gen_license.js 365 6 standard "客户A-专业版" server/keys/customerA.key
 *
 * 参数:
 *   days        有效期天数；0 表示永久
 *   maxInstances 允许的最大并发实例数
 *   edition     版本档位：eval(评估) / standard(专业) / enterprise(企业)
 *   to          授权对象（客户名/标识，泄露时可溯源）
 *   outfile     输出文件，默认 server/license.key
 *
 * 私钥来源: 环境变量 ZSLIVE_LICENSE_PRIVKEY 或 server/license.priv.pem
 * 输出: 打印 license token；若给 outfile 则写入该文件
 *
 * token 格式: <base64url(payload)>.<base64url(RSA-SHA256签名)>
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  const d = path.dirname(p);
  if (d && !fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

function readPrivKey() {
  if (process.env.ZSLIVE_LICENSE_PRIVKEY) return process.env.ZSLIVE_LICENSE_PRIVKEY;
  try {
    return fs.readFileSync(path.join(__dirname, '..', 'server', 'license.priv.pem'), 'utf8');
  } catch {
    console.error('缺少私钥：设置 ZSLIVE_LICENSE_PRIVKEY 或确保 server/license.priv.pem 存在');
    process.exit(1);
  }
}

const priv = readPrivKey();

const days = parseInt(process.argv[2] || '365', 10);
const max = parseInt(process.argv[3] || '1', 10);
const edition = process.argv[4] || 'standard';
const to = process.argv[5] || '';
const outfile = process.argv[6] || path.join(__dirname, '..', 'server', 'license.key');

const payload = {
  v: 1,
  iat: Date.now(),
  exp: days > 0 ? Date.now() + days * 86400000 : 0,
  max,
  edition,
  to,
};
if (!payload.exp) delete payload.exp;

const payloadB64 = b64urlEncode(Buffer.from(JSON.stringify(payload)));
const sig = b64urlEncode(crypto.createSign('RSA-SHA256').update(payloadB64).sign(priv));
const token = `${payloadB64}.${sig}`;

ensureDir(outfile);
fs.writeFileSync(outfile, token);
console.log('已签发授权并写入:', outfile);
console.log('  有效期(天):', days, days > 0 ? '(过期=' + new Date(payload.exp).toISOString() + ')' : '(永久)');
console.log('  实例上限 :', max);
console.log('  版本档位 :', edition);
console.log('  授权对象 :', to || '(空)');
console.log('  TOKEN    :', token);
