'use strict';
/**
 * SQLite 存储：用户 / 模板 / 会话记录 / 系统设置
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const config = require('./config');
const log = require('./logger');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,
  exe_path TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 1280,
  height INTEGER NOT NULL DEFAULT 720,
  fps INTEGER NOT NULL DEFAULT 30,
  bitrate_kbps INTEGER NOT NULL DEFAULT 8000,
  audio_codec TEXT NOT NULL DEFAULT 'auto',
  enable_input INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  template_id INTEGER,
  template_name TEXT,
  instance_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  started_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE TABLE IF NOT EXISTS cluster_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  internal_port INTEGER NOT NULL DEFAULT 3120,
  enabled INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

// 兼容旧库：templates 增加 description / warm_count 列（程序列表展示 / 按模板预热数）
try {
  const cols = db.prepare("PRAGMA table_info(templates)").all().map((c) => c.name);
  if (!cols.includes('description')) {
    db.exec("ALTER TABLE templates ADD COLUMN description TEXT NOT NULL DEFAULT ''");
    log.info('templates 表已添加 description 列');
  }
  if (!cols.includes('warm_count')) {
    // NULL = 未单独设置，跟随全局「默认预热数」
    db.exec('ALTER TABLE templates ADD COLUMN warm_count INTEGER');
    log.info('templates 表已添加 warm_count 列（按模板预热数）');
  }
  if (!cols.includes('gpu_index')) {
    // NULL = 自动选卡（按 GPU 配额）；-1 = 不绑卡；>=0 = 固定绑定该卡
    db.exec('ALTER TABLE templates ADD COLUMN gpu_index INTEGER');
    log.info('templates 表已添加 gpu_index 列（模板级 GPU 绑定）');
  }
  if (!cols.includes('encoder_backend')) {
    // auto = 硬件优先失败降级 FFmpeg；ave = 仅硬件（NVENC/AMF，旧行为）；ffmpeg = 仅 FFmpeg（软编码/国产卡 VAAPI）
    db.exec("ALTER TABLE templates ADD COLUMN encoder_backend TEXT NOT NULL DEFAULT 'auto'");
    log.info('templates 表已添加 encoder_backend 列（编码后端选择）');
  }
  if (!cols.includes('gpu_weight')) {
    // 该模板单实例的 GPU 负载估算（百分比）。4090 实测 4K30 全程渲染+NVENC ≈ 16%。
    // 池按「所有存活实例权重之和 ≤ gpuBudget」准入，超预算的新会话转排队——
    // 防止 GPU 超卖把老流的帧率拖垮（开新流老流卡死的根因）。
    db.exec('ALTER TABLE templates ADD COLUMN gpu_weight INTEGER NOT NULL DEFAULT 30');
    log.info('templates 表已添加 gpu_weight 列（单实例 GPU 负载权重%）');
  }
} catch (e) {
  log.warn(`templates 表结构检查失败: ${e.message}`);
}

// ---------- settings ----------
const getSetting = (key, def) => {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
  return row ? row.value : def;
};
const setSetting = (key, value) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, String(value));

// 初始化设置
for (const [k, v] of Object.entries({
  maxInstances: config.maxInstances,
  warmCount: config.warmCount,
  idleTimeout: config.idleTimeout,
  renderOffscreen: 1, // 实例默认离屏渲染（-RenderOffScreen），云渲染场景无需本地窗口
  sessionTimeoutMin: 30, // 会话超时强制释放（分钟），0 = 不限制
  standbyFps: 1,         // 待命降载：空闲实例推流帧率（1=几乎不占 GPU，激活时再拉满，避免新流激活尖峰饿死老流）
  standbyBitrateKbps: 500, // 待命降载：空闲实例码率
  envProfile: 'lan',     // 当前环境配置档（本机/局域网/公网/弱网）
  adaptiveEnabled: 0,    // 播放器自适应降档（公网/弱网配置档自动开启）
  gpuQuotas: '',         // GPU 配额，如 "0:3,1:1"；空 = 不启用（实例不绑卡）
  ffmpegPath: 'ffmpeg',  // FFmpeg 可执行文件路径（编码后端为 ffmpeg 时使用；接入国产卡 VAAPI 时指向厂商定制版）
  gpuBindEnvVars: 'CUDA_VISIBLE_DEVICES,NVIDIA_VISIBLE_DEVICES', // Linux 绑卡注入的环境变量（多厂商，逗号分隔）
  gpuProbeCmd: '',       // 自定义 GPU 探测命令（JSON：{"cmd":"...","args":[...],"format":"nvidia-csv"}，砺算等厂商 CLI 用）
  gpuBudget: 90,         // GPU 负载预算（%）：所有存活实例的 gpu_weight 之和超过它，新会话转排队
  spawnIntervalSec: 6,   // 冷启动串行化：两次 spawn 的最小间隔（秒），叠加 spawning 互斥防 GPU 尖峰叠加
  overloadFpsFloor: 25,  // 过载拒绝阈值（fps）：运行中实例平均帧率低于此值，直接拒绝新流（防拖垮已运行流）
})) {
  if (getSetting(k, null) === null) setSetting(k, v);
}

// ---------- users ----------
function hashPassword(pass, salt) {
  return crypto.scryptSync(pass, salt, 32).toString('hex');
}

const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
if (userCount === 0) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)')
    .run(config.adminUser, hashPassword(config.adminPass, salt), salt, 'admin');
  log.info(`已创建管理员账号: ${config.adminUser}（请尽快在后台修改密码）`);
}

module.exports = {
  db,
  getSetting,
  setSetting,

  users: {
    verify(username, password) {
      const u = db.prepare('SELECT * FROM users WHERE username=? AND disabled=0').get(username);
      if (!u) return null;
      if (hashPassword(password, u.salt) !== u.password_hash) return null;
      return { id: u.id, username: u.username, role: u.role };
    },
    list: () => db.prepare('SELECT id,username,role,disabled,created_at FROM users').all(),
    create(username, password, role) {
      const salt = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO users(username,password_hash,salt,role) VALUES(?,?,?,?)')
        .run(username, hashPassword(password, salt), salt, role || 'viewer');
    },
    update(id, { password, role, disabled }) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (!u) return false;
      if (password) {
        const salt = crypto.randomBytes(16).toString('hex');
        db.prepare('UPDATE users SET password_hash=?,salt=? WHERE id=?')
          .run(hashPassword(password, salt), salt, id);
      }
      if (role !== undefined) db.prepare('UPDATE users SET role=? WHERE id=?').run(role, id);
      if (disabled !== undefined) db.prepare('UPDATE users SET disabled=? WHERE id=?').run(disabled ? 1 : 0, id);
      return true;
    },
    remove(id) {
      const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
      if (u && u.username === config.adminUser) return false; // 禁止删除内置管理员
      db.prepare('DELETE FROM users WHERE id=?').run(id);
      return true;
    },
  },

  templates: {
    list: () => db.prepare('SELECT * FROM templates ORDER BY id').all(),
    get: (id) => db.prepare('SELECT * FROM templates WHERE id=?').get(id),
    create(t) {
      const r = db.prepare(`INSERT INTO templates(name,description,exe_path,args,width,height,fps,bitrate_kbps,audio_codec,enable_input,warm_count,gpu_index,encoder_backend,gpu_weight)
        VALUES(@name,@description,@exe_path,@args,@width,@height,@fps,@bitrate_kbps,@audio_codec,@enable_input,@warm_count,@gpu_index,@encoder_backend,@gpu_weight)`)
        .run({ description: '', warm_count: null, gpu_index: null, encoder_backend: 'auto', gpu_weight: 30, ...t });
      return this.get(r.lastInsertRowid);
    },
    update(id, t) {
      db.prepare(`UPDATE templates SET name=@name,description=@description,exe_path=@exe_path,args=@args,width=@width,height=@height,
        fps=@fps,bitrate_kbps=@bitrate_kbps,audio_codec=@audio_codec,enable_input=@enable_input,warm_count=@warm_count,gpu_index=@gpu_index,encoder_backend=@encoder_backend,gpu_weight=@gpu_weight WHERE id=@id`)
        .run({ description: '', warm_count: null, gpu_index: null, encoder_backend: 'auto', gpu_weight: 30, ...t, id });
      return this.get(id);
    },
    remove(id) {
      db.prepare('DELETE FROM templates WHERE id=?').run(id);
    },
  },

  sessions: {
    insert: (id, templateId, templateName, instanceId) =>
      db.prepare('INSERT INTO sessions(id,template_id,template_name,instance_id,state) VALUES(?,?,?,?,?)')
        .run(id, templateId, templateName, instanceId, 'active'),
    end: (id, state) =>
      db.prepare("UPDATE sessions SET ended_at=datetime('now','localtime'),state=? WHERE id=?").run(state || 'ended', id),
    list: (limit = 100) =>
      db.prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?').all(limit),
    listActive: () =>
      db.prepare("SELECT * FROM sessions WHERE state='active'").all(),
    /** 近 24 小时逐小时会话数（趋势图数据源） */
    trend24h: () => {
      const d = new Date(Date.now() - 23 * 3600000);
      const p = (n) => String(n).padStart(2, '0');
      const since = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:00:00`;
      return db.prepare(`
        SELECT substr(started_at,1,13) AS hour, COUNT(*) AS count
        FROM sessions
        WHERE started_at >= ?
        GROUP BY hour ORDER BY hour
      `).all(since);
    },
  },

  // ---------- 集群节点（master 模式使用） ----------
  nodes: {
    list: () => db.prepare('SELECT * FROM cluster_nodes ORDER BY created_at').all(),
    get: (id) => db.prepare('SELECT * FROM cluster_nodes WHERE id=?').get(id),
    create(n) {
      db.prepare('INSERT INTO cluster_nodes(id,name,host,internal_port,enabled,note) VALUES(?,?,?,?,?,?)')
        .run(n.id, n.name || n.id, n.host, parseInt(n.internal_port, 10) || 3120,
          n.enabled === false ? 0 : 1, n.note || '');
      return this.get(n.id);
    },
    update(id, n) {
      db.prepare('UPDATE cluster_nodes SET name=?,host=?,internal_port=?,enabled=?,note=? WHERE id=?')
        .run(n.name || id, n.host, parseInt(n.internal_port, 10) || 3120,
          n.enabled === false ? 0 : 1, n.note || '', id);
      return this.get(id);
    },
    remove(id) {
      db.prepare('DELETE FROM cluster_nodes WHERE id=?').run(id);
    },
  },

  audits: {
    insert: (actor, action, detail, ip) =>
      db.prepare('INSERT INTO audit_logs(actor,action,detail,ip) VALUES(?,?,?,?)')
        .run(String(actor || '-'), String(action || '-'), String(detail || ''), String(ip || '')),
    /** 分页查询审计日志；action 精确过滤（如 login / login_fail / template_update） */
    list: ({ page = 1, pageSize = 20, action = '' } = {}) => {
      const where = action ? 'WHERE action = ?' : '';
      const args = action ? [action] : [];
      const total = db.prepare(`SELECT COUNT(*) AS c FROM audit_logs ${where}`).get(...args).c;
      const rows = db.prepare(`
        SELECT * FROM audit_logs ${where}
        ORDER BY id DESC LIMIT ? OFFSET ?
      `).all(...args, pageSize, (page - 1) * pageSize);
      return { rows, total, page, pageSize };
    },
    /** 清理过期日志（默认保留 90 天） */
    purgeOld: (days = 90) =>
      db.prepare("DELETE FROM audit_logs WHERE created_at < datetime('now','localtime',?)")
        .run(`-${days} days`),
  },
};

// 审计日志保留 90 天，启动时清理过期记录
try { module.exports.audits.purgeOld(90); } catch (e) {
  log.warn(`审计日志清理失败: ${e.message}`);
}
