// 检查 UE 进程与最新日志中的 FFmpeg 后端痕迹
const fs = require('fs');
const { execSync } = require('child_process');

// 1. UE 进程
try {
  const out = execSync('tasklist /FI "IMAGENAME eq UEtest.exe" /FO CSV', { encoding: 'utf8' });
  console.log('UE_PROCS:', out.replace(/\r?\n/g, ' | ').slice(0, 400));
} catch (e) { console.log('tasklist fail', e.message); }

// 2. 最新 UEtest 日志里的关键行
const logDir = 'F:/streamming/ZS_Live/UETest/Package/Windows/UEtest/Saved/Logs';
const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.log') && !f.startsWith('cef3'))
  .map((f) => ({ f, m: fs.statSync(logDir + '/' + f).mtimeMs })).sort((a, b) => b.m - a.m);
console.log('LOG_FILES:', files.slice(0, 3).map((x) => x.f + ' @' + new Date(x.m).toISOString().slice(11, 19)).join(' , '));
const newest = logDir + '/' + files[0].f;
const lines = fs.readFileSync(newest, 'utf8').split(/\r?\n/);
console.log('===== newest log:', files[0].f, 'lines:', lines.length, '=====');
const hits = [];
for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (/StreamForge|FFmpeg|SFEncoder|encoder|Encoder|Command Line|Fatal|Crash|Assertion/i.test(l)) {
    hits.push((i + 1) + ': ' + l.slice(0, 220));
  }
}
hits.slice(-60).forEach((h) => console.log(h));
