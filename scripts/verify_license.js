'use strict';
/**
 * ZS Live 授权校验助手（作者侧自用，仅私有仓库）
 *
 * 在把 key 发给客户之前，用它确认 token 合法、字段正确。
 *
 * 用法:
 *   node scripts/verify_license.js <token文件 或 token字符串>
 *
 * 例:
 *   node scripts/verify_license.js server/keys/customerA.key
 *   node scripts/verify_license.js "eyJ...xZw.abc..."
 *
 * 依赖 server/license.pub.pem（公钥）做验签；依赖 server/src/license.js 的 verifyToken。
 */
const fs = require('fs');
const { verifyToken } = require('../server/src/license');

const arg = process.argv[2];
if (!arg) {
  console.error('用法: node scripts/verify_license.js <token文件 或 token字符串>');
  process.exit(1);
}

let token = arg;
if (fs.existsSync(arg)) {
  token = fs.readFileSync(arg, 'utf8').trim();
}

const r = verifyToken(token);
console.log(JSON.stringify(r, null, 2));
if (!r.valid) {
  console.error('⚠️  该 key 无效，原因: ' + r.reason);
  process.exit(2);
} else {
  console.log('✅ 合法 key，可发给客户。');
}
