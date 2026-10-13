'use strict';
const fs = require('fs');
const p = 'E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002-backup-2026.09.29-02.26.43.log';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
// 1) 找命令行（含 SFWidth 等）
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('LogInit: Command Line:')) console.log('CMDLINE(' + (i + 1) + '): ' + lines[i].slice(0, 1200));
}
// 2) 所有 StreamForge 行（完整时间线）
console.log('--- StreamForge timeline ---');
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.includes('LogStreamForge')) console.log((i + 1) + ': ' + l.slice(0, 250));
}
