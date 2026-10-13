'use strict';
const fs = require('fs');
const files = [
  'F:/streamming/ZS_Live/server/src/instancePool.js',
  'F:/streamming/ZS_Live/server/src/qualityPresets.js',
  'F:/streamming/ZS_Live/server/src/routes.js',
  'F:/streamming/ZS_Live/server/src/index.js',
  'F:/streamming/ZS_Live/mediamtx/mediamtx.yml',
];
for (const f of files) {
  try {
    const st = fs.statSync(f);
    console.log(st.mtime.toISOString().replace('T', ' ').slice(0, 19), ' ', f);
  } catch (e) { console.log('MISSING', f, e.message); }
}
// 找 3100 端口的进程启动时间
const { execSync } = require('child_process');
try {
  const out = execSync('netstat -ano | findstr :3100 | findstr LISTENING', { shell: 'cmd.exe', encoding: 'utf8' });
  console.log('NETSTAT:', out.trim());
  const pid = (out.trim().match(/(\d+)\s*$/) || [])[1];
  if (pid) {
    const out2 = execSync('wmic process where ProcessId=' + pid + ' get CreationDate,CommandLine /format:list', { shell: 'cmd.exe', encoding: 'utf8' });
    console.log('PROC:', out2.trim().slice(0, 800));
  }
} catch (e) { console.log('netstat err', e.message); }
