'use strict';
/**
 * 安装包首次初始化脚本（由安装器在安装完成后自动调用，工作目录 = <安装根>\server）
 * 1. 从模板生成 mediamtx/mediamtx.yml（替换 {{LAN_IP}} 为本机局域网 IP）
 * 2. 若 Windows 演示程序已安装且模板表为空，插入演示模板（幂等，可重复执行）
 * 用法: node install-init.js ["C:\...\UETest\Package\Windows\UEtest.exe"]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');

// ---------- 1. 生成 mediamtx.yml ----------
function detectLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

try {
  const tplPath = path.join(root, 'mediamtx', 'mediamtx.template.yml');
  const ymlPath = path.join(root, 'mediamtx', 'mediamtx.yml');
  const lanIp = detectLanIp();
  const yml = fs.readFileSync(tplPath, 'utf8').replace(/\{\{LAN_IP\}\}/g, lanIp);
  if (!fs.existsSync(ymlPath)) {
    fs.writeFileSync(ymlPath, yml, 'utf8');
    console.log(`[init] mediamtx.yml 已生成（局域网 IP: ${lanIp}）`);
  } else {
    console.log('[init] mediamtx.yml 已存在，跳过生成');
  }
} catch (e) {
  console.error(`[init][警告] mediamtx.yml 生成失败: ${e.message}`);
}

// ---------- 2. 播种演示模板 ----------
const demoExe = process.argv[2];
if (!demoExe || !fs.existsSync(demoExe)) {
  console.log('[init] 未安装 Windows 演示程序或路径无效，跳过模板播种');
  process.exit(0);
}

try {
  const { db } = require('./src/db'); // 触发建库/建表/默认管理员/默认设置
  const n = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
  if (n > 0) {
    console.log(`[init] 已有 ${n} 个模板，跳过播种`);
    process.exit(0);
  }
  db.prepare(`INSERT INTO templates
    (name, exe_path, args, width, height, fps, bitrate_kbps, audio_codec, enable_input, description, warm_count, gpu_index)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('UE 演示程序', demoExe, '', 1280, 720, 30, 8000, 'auto', 1,
      '安装包自带的 UE 演示场景（UETest）', 0, null);
  console.log(`[init] 已创建演示模板: ${demoExe}`);
} catch (e) {
  console.error(`[init][警告] 模板播种失败: ${e.message}`);
}
process.exit(0);
