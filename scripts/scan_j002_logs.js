'use strict';
const fs = require('fs');
const dir = 'E:/UPROJECT/J002/Windows/J002/Saved/Logs';
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.log') || f.startsWith('cef3')) continue;
  const p = dir + '/' + f;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const interesting = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/StreamForge starting|start failed|pipeline failed|Encoder creation failed|No encoders|No H264|Publishing!|Publish rejected|TCP connect failed|Handshake failed|Connection lost|sf_standby|encoder ready|Encoder ready/i.test(l)) {
      interesting.push((i + 1) + ': ' + l.slice(0, 190));
    }
  }
  console.log('===== ' + f + ' (' + interesting.length + ' hits) =====');
  interesting.slice(0, 20).forEach((x) => console.log(x));
}
