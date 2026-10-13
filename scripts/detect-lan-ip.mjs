// 探测本机局域网 IPv4
import os from 'node:os';
for (const ifaces of Object.values(os.networkInterfaces())) {
  for (const it of ifaces || []) {
    if (it.family === 'IPv4' && !it.internal) {
      console.log(it.address);
      process.exit(0);
    }
  }
}
console.log('127.0.0.1');
