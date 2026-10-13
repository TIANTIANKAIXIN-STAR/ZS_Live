'use strict';
// 检查 MediaMTX 流路径状态
const http = require('http');
function get(port, path) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path }, (r) => {
      let b = '';
      r.on('data', (c) => { b += c; });
      r.on('end', () => resolve(r.statusCode + ' ' + b.slice(0, 600)));
    }).on('error', (e) => resolve('ERR ' + e.message));
  });
}
(async () => {
  console.log('paths:', await get(9997, '/v3/paths/list'));
  console.log('sessions:', await get(9997, '/v3/sessions/list'));
})();
