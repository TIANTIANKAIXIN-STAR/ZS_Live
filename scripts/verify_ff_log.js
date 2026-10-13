// 确认 FFmpeg 后端痕迹 + MediaMTX 流状态
const fs = require('fs');
const http = require('http');

// 1. UEtest 最新日志
const logDir = 'F:/streamming/ZS_Live/UETest/Package/Windows/UEtest/Saved/Logs';
const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log') && !f.startsWith('cef3'))
  .map((f) => ({ f, m: fs.statSync(logDir + '/' + f).mtimeMs })).sort((a, b) => b.m - a.m);
const lines = fs.readFileSync(logDir + '/' + files[0].f, 'utf8').split(/\r?\n/);
console.log('=== ' + files[0].f + ' ===');
for (const l of lines) {
  if (/StreamForge|FFmpeg|x264|Command Line/i.test(l) && !/Input (key|mouse|wheel)/.test(l)) {
    console.log(l.slice(0, 200));
  }
}
