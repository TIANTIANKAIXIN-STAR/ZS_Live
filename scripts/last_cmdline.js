'use strict';
const fs = require('fs');
const p = 'E:/UPROJECT/J002/Windows/J002/Saved/Logs/J002.log';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('Command Line:')) {
    console.log('LINE ' + (i + 1) + ':');
    console.log(lines[i]);
    break;
  }
}
// 最后一次运行尾部 10 行
console.log('--- TAIL ---');
console.log(lines.slice(-10).join('\n'));
