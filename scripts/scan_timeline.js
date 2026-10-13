'use strict';
const fs = require('fs');
// 看几个关键日志的首行时间戳，理清进程启动顺序
const files = [
  'E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002-backup-2026.09.29-02.57.21.log',
  'E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002_2.log',
  'E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002-backup-2026.09.29-02.58.37.log',
];
for (const p of files) {
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  console.log('===== ' + p.split('/').pop() + ' =====');
  for (const l of lines.slice(0, 40)) {
    if (l.startsWith('[')) { console.log('FIRST-TS: ' + l.slice(0, 120)); break; }
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Command Line:')) { console.log('CMD: ' + lines[i].slice(0, 900)); break; }
  }
}
// 再看失败那次 log 的结尾（give up 之后发生了什么）
const fail = fs.readFileSync('E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002-backup-2026.09.29-02.26.43.log', 'utf8').split(/\r?\n/);
console.log('===== failing log TAIL (last 25 lines) =====');
console.log(fail.slice(-25).join('\n'));
