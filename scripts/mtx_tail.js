'use strict';
const fs = require('fs');
const dir = 'F:/streamming/ZS_Live/mediamtx';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.log')).map((f) => ({ f, m: fs.statSync(dir + '/' + f).mtime })).sort((a, b) => b.m - a.m);
console.log('newest logs:', files.slice(0, 5).map((x) => x.f + ' @ ' + x.m.toISOString().slice(11, 19)));
const newest = files[0];
const lines = fs.readFileSync(dir + '/' + newest.f, 'utf8').split(/\r?\n/);
console.log('--- ' + newest.f + ' last 60 lines ---');
console.log(lines.slice(-60).join('\n'));
