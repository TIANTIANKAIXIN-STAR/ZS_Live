'use strict';
/**
 * 生成「源码购买」交付包（类型②）：仅含推流 + UE 插件，删除授权体系。
 *
 * 运行: node scripts/build_source_edition.js
 * 产物: dist/source-edition/ （可整体打包发给源码客户）
 *
 * 删除项（作者内部 / 授权相关，绝不进源码交付）—— 仅从产物副本中删除，不碰源仓库：
 *   - server/src/license.js            授权校验模块
 *   - server/license.*.pem             密钥对（私钥绝不能外发）
 *   - server/license.key / license.secret / server/keys/  已签发的 token
 *   - scripts/gen_license.js           签发器
 *   - scripts/verify_license.js        校验器
 *   - tools/LicenseTool/               C# 签发工具（含源码）
 *   - docs/internal/                   作者内部文档
 *   - _tmp_probe / .git / node_modules / dist / 各引擎 Binaries 与 Intermediate / *.exe / *.dll 等构建产物
 *
 * 因为 license.js 被删除，server/src/index.js 的 require 会走 try/catch 降级分支，
 * 运行时自动表现为「不限制实例数」——源码客户拿到的是纯净推流 + UE 插件代码。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'dist', 'source-edition');
const LOG = path.join(ROOT, '_tmp_probe', 'se_log.txt');
function log(msg) {
  const line = msg;
  try { fs.appendFileSync(LOG, line + '\n', 'utf8'); } catch (_) {}
  console.log(msg);
}

// 相对 OUT 的删除清单（文件与目录）—— 仅作用于产物副本
const REMOVE = [
  'server/src/license.js',
  'server/license.priv.pem',
  'server/license.pub.pem',
  'server/license.key',
  'server/license.secret',
  'server/keys',
  'scripts/gen_license.js',
  'scripts/verify_license.js',
  'tools/LicenseTool',
  'docs/internal',
  '_tmp_probe',
];

// 跳过复制的目录（版本控制 / 构建产物 / 运行时二进制 / 测试工程 / 临时）。
// 源码交付只包含「推流 + UE 插件」的工程源码，下列均为二进制或本地产物，绝不外发。
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist',
  'Binaries', 'Intermediate', 'Package', 'Windows',
  'UETest',          // 17GB+ 本地 UE 测试工程
  'ffmpeg',          // 运行时二进制
  'launcher',        // 启动器构建产物
  'mediamtx',        // 运行时二进制
  'installer',       // 安装包构建产物
  '_tmp_probe',      // 本地临时/探针
  'tools',           // 仅含作者签名工具 LicenseTool（步骤2整体删除，这里直接跳过以免复制数百MB发布产物）
  '.workbuddy',      // 本地工具配置与记忆，非产品源码
]);
const SKIP_FILE_EXT = new Set(['.exe', '.dll', '.zip', '.pdb', '.obj', '.lib', '.exp', '.ilk', '.7z', '.tar', '.gz']);

function walk(src, dst) {
  let st;
  try { st = fs.statSync(src); } catch (e) {
    log('  [skip-stat] ' + src + ' :: ' + e.message);
    return;
  }
  if (st.isDirectory()) {
    const base = path.basename(src);
    if (SKIP_DIRS.has(base)) return;
    try { fs.mkdirSync(dst, { recursive: true }); } catch (e) {
      log('  [skip-mkdir] ' + dst + ' :: ' + e.message);
      return;
    }
    let entries;
    try { entries = fs.readdirSync(src); } catch (e) {
      log('  [skip-readdir] ' + src + ' :: ' + e.message);
      return;
    }
    for (const entry of entries) {
      walk(path.join(src, entry), path.join(dst, entry));
    }
  } else {
    const ext = path.extname(src).toLowerCase();
    if (SKIP_FILE_EXT.has(ext)) return;
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
    } catch (e) {
      log('  [skip-copy] ' + src + ' :: ' + e.message);
    }
  }
}

function rmRel(rel) {
  const p = path.join(OUT, rel);
  if (fs.existsSync(p)) {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  }
  return false;
}

function countFiles(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countFiles(p);
    else n++;
  }
  return n;
}

try {
  try { fs.writeFileSync(LOG, '', 'utf8'); } catch (_) {}
  log('[1/3] 清理旧产物并复制工程源码（排除构建产物/版本控制）...');
  fs.rmSync(OUT, { recursive: true, force: true });
  walk(ROOT, OUT);

  log('[2/3] 从产物中删除授权体系与作者内部文件...');
  let removed = 0;
  for (const rel of REMOVE) {
    if (rmRel(rel)) removed++;
  }

  const total = countFiles(OUT);
  log('[3/3] 完成。');
  log('OUTPUT_DIR=' + OUT);
  log('FILE_COUNT=' + total);
  log('REMOVED_ITEMS=' + removed);
  log('HAS_LICENSE_JS=' + (fs.existsSync(path.join(OUT, 'server/src/license.js')) ? 'YES(BAD)' : 'no(ok)'));
  log('HAS_PRIVKEY=' + (fs.existsSync(path.join(OUT, 'server/license.priv.pem')) ? 'YES(BAD)' : 'no(ok)'));
  log('HAS_TOOL=' + (fs.existsSync(path.join(OUT, 'tools/LicenseTool')) ? 'YES(BAD)' : 'no(ok)'));
} catch (e) {
  log('BUILD_SOURCE_EDITION_FAILED');
  log(String(e && e.stack || e));
  process.exit(1);
}
