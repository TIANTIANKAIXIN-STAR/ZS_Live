'use strict';
/** 极简日志器 */
const ts = () => new Date().toISOString().replace('T', ' ').replace('Z', '');
module.exports = {
  info: (...a) => console.log(`[${ts()}] [INFO ]`, ...a),
  warn: (...a) => console.warn(`[${ts()}] [WARN ]`, ...a),
  error: (...a) => console.error(`[${ts()}] [ERROR]`, ...a),
};
