// 部署新 exe 到发布包 + 重启调度服务
const { execSync, spawn } = require('child_process');
const fs = require('fs');

// 1. 找 3100 端口的调度服务 PID
const netstat = execSync('netstat -ano -p tcp').toString();
const line = netstat.split(/\r?\n/).find((l) => l.includes(':3100') && l.includes('LISTENING'));
const pid = line ? parseInt(line.trim().split(/\s+/).pop(), 10) : null;
console.log('SCHEDULER_PID:', pid);

// 2. 检查 UE 进程
const tasklist = execSync('tasklist /fo csv').toString();
const ue = tasklist.split(/\r?\n/).filter((l) => /UEtest|J002/i.test(l) && !/CrashReport/i.test(l));
console.log('UE_RUNNING:', ue.length ? ue.join(' | ') : '(none)');
console.log('PID_FILE:' + (pid || 'none'));
