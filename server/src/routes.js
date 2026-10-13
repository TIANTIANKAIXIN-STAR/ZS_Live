'use strict';
/**
 * REST API 路由
 */
const fs = require('fs');
const config = require('./config');
const store = require('./db');
const auth = require('./auth');
const mediamtx = require('./mediamtx');
const os = require('os');
const v8 = require('v8');
const log = require('./logger');
const codes = require('./streamCodes');
const qualityPresets = require('./qualityPresets');
const envProfiles = require('./envProfiles');
const publicNet = require('./publicNet');

/** 对外站点根地址（嵌入/播放/SDK 链接都基于它） */
function publicBaseUrl() {
  return `http://${config.publicHost}:${config.port}`;
}

/** 自适应降档是否开启（公网/弱网环境配置档会自动打开） */
function adaptiveEnabled() {
  return store.getSetting('adaptiveEnabled', '0') === '1';
}

/** 审计日志：记录管理员登录与操作（写入失败不影响主流程） */
function audit(req, actor, action, detail) {
  try {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    store.audits.insert(actor, action, detail, ip);
  } catch (e) {
    log.warn(`[Audit] 写入失败: ${e.message}`);
  }
}

/**
 * 拼出某个模板的嵌入地址集合（对齐 ZS_Streaming /api/embed 的字段形状）
 * @param {string|number} templateId 模板 ID
 * @param {string} [streamId] 业务侧多路流标识（仅用于父页面 postMessage 路由，服务端不消费）
 * @param {string} [nodeId] 集群节点 ID（master 聚合程序列表时标记会话应路由到哪个 worker）
 */
function buildEmbedInfo(templateId, streamId, nodeId) {
  const baseUrl = publicBaseUrl();
  const wsProto = baseUrl.startsWith('https') ? 'wss' : 'ws';
  const wsHost = baseUrl.replace(/^https?:\/\//, '');
  const q = new URLSearchParams({ template: String(templateId), autoconnect: '1' });
  if (streamId) q.set('streamId', String(streamId).trim());
  if (nodeId) q.set('node', String(nodeId));
  const embedPath = `/embed?${q.toString()}`;
  const embedUrl = `${baseUrl}${embedPath}`;
  return {
    templateId: String(templateId),
    streamId: streamId ? String(streamId).trim() : null,
    nodeId: nodeId ? String(nodeId) : null,
    baseUrl,
    wsUrl: `${wsProto}://${wsHost}/ws`,
    embedPath,
    embedUrl,
    playUrl: `${baseUrl}/player?template=${encodeURIComponent(String(templateId))}${nodeId ? `&node=${encodeURIComponent(String(nodeId))}` : ''}`,
    parentSdkUrl: `${baseUrl}/sdk/zslive-parent.js`,
    integrationDemoUrl: `${baseUrl}/integration-demo.html`,
    iframe: {
      src: embedUrl,
      allow: 'autoplay; fullscreen; encrypted-media',
      html: `<iframe src="${embedUrl}" style="width:100%;height:100%;border:0" allow="autoplay; fullscreen; encrypted-media" title="ZS Live"></iframe>`,
    },
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param ctx { pool, queue, hub, sessions, gpu }
 */
async function handleApi(req, res, pathname, ctx) {
  const { pool, queue, hub, sessions } = ctx;
  const master = ctx.master; // 集群 master 模式时非空（跨节点代理）

  // ---------- 公开接口 ----------
  if (pathname === '/health') {
    return json(res, 200, { ok: true, ts: Date.now() });
  }

  // ---------- 集群 master：程序列表/会话/释放 走跨节点代理 ----------
  if (master) {
    if (req.method === 'GET' && pathname === '/api/programs') {
      return clusterPrograms(res, ctx);
    }
    if (req.method === 'POST' && pathname === '/api/session') {
      return clusterSessionProxy(req, res, ctx);
    }
    if (req.method === 'POST' && pathname === '/api/session/release') {
      const body = await readBody(req).catch(() => ({}));
      if (!body.nodeId) return json(res, 400, { ok: false, error: '集群模式释放会话需携带 nodeId' });
      const node = master.nodes.get(body.nodeId);
      if (!node) return json(res, 404, { ok: false, error: `节点 ${body.nodeId} 不存在` });
      try {
        await master.releaseRemoteSession(node, body.sessionId);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 502, { ok: false, error: e.message });
      }
    }
  }

  // 程序列表：模板 + 实时池余量 + 嵌入地址（StreamHub 首页数据源）
  if (req.method === 'GET' && pathname === '/api/programs') {
    const rows = store.templates.list();
    const byTpl = {};
    for (const inst of pool.list()) {
      const k = String(inst.templateId);
      if (!byTpl[k]) byTpl[k] = { ready: 0, inUse: 0, starting: 0 };
      const b = byTpl[k];
      if (inst.state === 'ready' && !inst.sessionId) b.ready++;
      else if (inst.state === 'assigned' || (inst.state === 'ready' && inst.sessionId)) b.inUse++;
      else if (inst.state === 'spawning' || inst.state === 'stopping') b.starting++;
    }
    const programs = rows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description || '',
      width: t.width,
      height: t.height,
      fps: t.fps,
      pool: byTpl[String(t.id)] || { ready: 0, inUse: 0, starting: 0 },
      embed: buildEmbedInfo(t.id),
    }));
    return json(res, 200, codes.formatApiSuccess('ZS_OK_8101', {
      programs,
      embedBase: buildEmbedInfo('<templateId>'),
    }));
  }

  // 嵌入信息：iframe 地址 + 父页面 SDK + postMessage 协议说明
  if (req.method === 'GET' && pathname === '/api/embed') {
    const url = new URL(req.url, 'http://localhost');
    const templateId = (url.searchParams.get('template') || '').trim();
    const streamId = (url.searchParams.get('streamId') || '').trim() || undefined;
    const nodeId = (url.searchParams.get('node') || '').trim() || undefined;
    if (master) {
      // master：模板在各 worker 上，直接按参数生成嵌入信息
      if (!templateId) {
        const body = codes.formatApiError('ZS_CFG_1003', { detail: 'template=(空)' });
        return json(res, body.httpStatus || 404, body);
      }
      const embed = buildEmbedInfo(templateId, streamId, nodeId);
      return json(res, 200, codes.formatApiSuccess('ZS_OK_8102', {
        program: { id: templateId, nodeId: nodeId || null, name: `template ${templateId}` },
        ...embed,
      }));
    }
    const tpl = store.templates.get(parseInt(templateId, 10));
    if (!tpl) {
      const body = codes.formatApiError('ZS_CFG_1003', { detail: `template=${templateId || '(空)'}` });
      return json(res, body.httpStatus || 404, body);
    }
    const embed = buildEmbedInfo(tpl.id, streamId);
    const exampleStreamId = streamId || 'view-a';
    return json(res, 200, codes.formatApiSuccess('ZS_OK_8102', {
      program: { id: tpl.id, name: tpl.name, description: tpl.description || '' },
      ...embed,
      examples: {
        streamId: exampleStreamId,
        embedUrlWithStreamId: buildEmbedInfo(tpl.id, exampleStreamId).embedUrl,
        multiStreamNote: '同页多路时每个 iframe 使用不同 streamId，父页面用 zslive-parent.js 按 streamId 路由指令',
      },
      integration: {
        parentSdk: embed.parentSdkUrl,
        demoPage: embed.integrationDemoUrl,
        iframe: embed.iframe.html,
        postMessage: {
          parentToEmbed: [
            { source: 'zslive-parent', streamId: exampleStreamId, type: 'invoke', module: 'camera', action: 'config', params: {} },
            { source: 'zslive-parent', streamId: exampleStreamId, type: 'command', name: 'custom.action', payload: {} },
            { source: 'zslive-parent', streamId: exampleStreamId, type: 'keyboard', phase: 'down', code: 'KeyW', key: 'w' },
          ],
          embedToParent: [
            { source: 'zslive-embed', streamId: exampleStreamId, type: 'event', event: 'inputready', data: { code: 'ZS_OK_8006', level: 'success', message: '数据通道已就绪' } },
          ],
        },
      },
    }));
  }

  // 消息码表（兼容别名 /api/error-codes）
  if (req.method === 'GET' && (pathname === '/api/stream-codes' || pathname === '/api/error-codes')) {
    return json(res, 200, codes.formatApiSuccess('ZS_OK_8103', {
      codes: codes.listStreamCodes(),
      errors: codes.listErrorCodes(),
    }));
  }

  if (req.method === 'POST' && pathname === '/api/session') {
    const body = await readBody(req).catch(() => ({}));
    const r = await createSession(ctx, body, req.headers.host);
    return json(res, r.status, r.payload);
  }

  if (req.method === 'POST' && pathname === '/api/session/release') {
    const body = await readBody(req);
    const s = sessions.get(body.sessionId);
    if (!s) return json(res, 404, { ok: false, error: 'session not found' });
    endSession(ctx, s.id, 'user_release');
    return json(res, 200, { ok: true });
  }

  // ---------- 管理员登录 ----------
  if (req.method === 'POST' && pathname === '/api/admin/login') {
    const body = await readBody(req);
    const user = store.users.verify(body.username, body.password);
    if (!user) {
      audit(req, body.username || '?', 'login_fail', '登录失败（用户名或密码错误）');
      return json(res, 401, { ok: false, error: '用户名或密码错误' });
    }
    audit(req, user.username, 'login', '登录成功');
    return json(res, 200, { ok: true, token: auth.signAdmin(user), user: { username: user.username, role: user.role } });
  }

  // ---------- 管理员接口 ----------
  const authHeader = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const admin = auth.verifyAdmin(authHeader);
  if (pathname.startsWith('/api/admin/') && pathname !== '/api/admin/login') {
    if (!admin) return json(res, 401, { ok: false, error: 'unauthorized' });
  }

  if (pathname === '/api/admin/stats' && req.method === 'GET') {
    const [paths, mtxSessions] = await Promise.all([mediamtx.paths(), mediamtx.sessions()]);
    const activeSessions = [...sessions.values()].filter((s) => s.state === 'active');
    return json(res, 200, {
      ok: true,
      pool: {
        total: pool.size,
        max: pool.maxInstances,
        ready: pool.list().filter((i) => i.state === 'ready' && !i.sessionId).length,
        assigned: pool.list().filter((i) => i.state === 'assigned').length,
        spawning: pool.list().filter((i) => i.state === 'spawning').length,
      },
      queue: { length: queue.length, items: queue.list() },
      sessions: { active: activeSessions.length },
      mediamtx: {
        ok: paths !== null,
        paths: (paths || []).map((p) => ({ name: p.name, source: p.source ? p.source.type : null })),
        sessions: (mtxSessions || []).map((s) => ({ id: s.id, type: s.type, remoteAddr: s.remoteAddr })),
      },
      server: {
        uptimeSec: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        heapMb: Math.round(v8.getHeapStatistics().used_heap_size / 1048576),
        cpuCount: os.cpus().length,
        platform: os.platform(),
        host: config.publicHost,
        port: config.port,
      },
      cluster: {
        role: config.clusterRole,
        nodeId: config.nodeId,
        ...(master ? {
          nodes: master.listNodes().map((n) => ({
            id: n.id, name: n.name, status: n.status,
            pool: n.capacity ? n.capacity.pool : null,
            sessions: n.capacity ? n.capacity.sessions : null,
          })),
        } : {}),
      },
    });
  }

  if (pathname === '/api/admin/instances' && req.method === 'GET') {
    return json(res, 200, { ok: true, instances: pool.list() });
  }

  if (pathname.startsWith('/api/admin/instances/') && req.method === 'POST') {
    const [, , , , id, action] = pathname.split('/');
    const it = pool.get(id);
    if (!it) return json(res, 404, { ok: false, error: 'instance not found' });
    if (action === 'stop') {
      if (it.sessionId) endSession(ctx, it.sessionId, 'admin_kill');
      pool.stop(id, 'admin');
      audit(req, admin.u || 'admin', 'instance_stop', `停止实例 ${id}（${it.templateName || ''}）`);
      return json(res, 200, { ok: true });
    }
    if (action === 'spare') {
      if (it.sessionId) endSession(ctx, it.sessionId, 'admin_spare');
      pool.release(id);
      audit(req, admin.u || 'admin', 'instance_spare', `实例 ${id} 转空闲`);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false, error: 'unknown action' });
  }

  if (pathname === '/api/admin/templates') {
    if (req.method === 'GET') return json(res, 200, { ok: true, templates: store.templates.list() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        const t = store.templates.create(normalizeTemplate(body));
        try { ctx.pool && ctx.pool.maintainWarm(); } catch { /* ignore */ }
        audit(req, admin.u || 'admin', 'template_create', `新建模板「${t.name}」(#${t.id})`);
        return json(res, 200, { ok: true, template: t });
      } catch (e) {
        return json(res, 400, { ok: false, error: e.message });
      }
    }
  }

  if (pathname.startsWith('/api/admin/templates/') && req.method === 'PUT') {
    const id = parseInt(pathname.split('/')[4], 10);
    const body = await readBody(req);
    try {
      const t = store.templates.update(id, normalizeTemplate(body));
      try { ctx.pool && ctx.pool.maintainWarm(); } catch { /* ignore */ }
      audit(req, admin.u || 'admin', 'template_update', `修改模板「${t.name}」(#${id})`);
      return json(res, 200, { ok: true, template: t });
    } catch (e) {
      return json(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname.startsWith('/api/admin/templates/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/')[4], 10);
    const old = store.templates.get(id);
    store.templates.remove(id);
    audit(req, admin.u || 'admin', 'template_delete', `删除模板「${old ? old.name : id}」(#${id})`);
    return json(res, 200, { ok: true });
  }

  // ---------- 画质预设 / 环境配置档 ----------
  if (pathname === '/api/admin/quality-presets' && req.method === 'GET') {
    return json(res, 200, { ok: true, presets: qualityPresets.listQualityPresets() });
  }

  if (pathname === '/api/admin/env-profiles' && req.method === 'GET') {
    const current = store.getSetting('envProfile', 'lan');
    return json(res, 200, { ok: true, current, profiles: envProfiles.listEnvProfiles(current) });
  }

  if (pathname === '/api/admin/env-profiles/apply' && req.method === 'POST') {
    const body = await readBody(req);
    const profile = envProfiles.getEnvProfile(body.id);
    if (!profile) {
      return json(res, 400, { ok: false, error: `未知环境配置档: ${body.id}` });
    }
    for (const [k, v] of Object.entries(profile.settings)) store.setSetting(k, v);
    store.setSetting('envProfile', profile.id);
    log.info(`[Settings] 应用环境配置档 ${profile.id}（${profile.label}）: ${JSON.stringify(profile.settings)}`);
    audit(req, admin.u || 'admin', 'env_profile', `应用环境配置档「${profile.label}」(${profile.id})`);
    return json(res, 200, {
      ok: true,
      applied: profile.settings,
      needTurn: Boolean(profile.needTurn),
      turnHint: profile.needTurn
        ? '公网/弱网环境需要在 mediamtx/mediamtx.yml 配置 webrtcICEServers2（TURN 服务器），详见部署手册 8.3'
        : undefined,
    });
  }

  if (pathname === '/api/admin/sessions' && req.method === 'GET') {
    return json(res, 200, { ok: true, sessions: store.sessions.list() });
  }

  if (pathname === '/api/admin/users') {
    if (req.method === 'GET') return json(res, 200, { ok: true, users: store.users.list() });
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.username || !body.password) return json(res, 400, { ok: false, error: '缺少用户名或密码' });
      try {
        store.users.create(body.username, body.password, body.role);
        audit(req, admin.u || 'admin', 'user_create', `新增用户「${body.username}」(${body.role || 'viewer'})`);
        return json(res, 200, { ok: true });
      } catch (e) {
        return json(res, 400, { ok: false, error: '用户已存在' });
      }
    }
  }

  if (pathname.startsWith('/api/admin/users/') && req.method === 'PUT') {
    const id = parseInt(pathname.split('/')[4], 10);
    const body = await readBody(req);
    store.users.update(id, body);
    audit(req, admin.u || 'admin', 'user_update', `修改用户 #${id}: ${JSON.stringify(body)}`);
    return json(res, 200, { ok: true });
  }

  if (pathname.startsWith('/api/admin/users/') && req.method === 'DELETE') {
    const id = parseInt(pathname.split('/')[4], 10);
    const u = store.users.list().find((x) => x.id === id);
    if (!store.users.remove(id)) return json(res, 400, { ok: false, error: '内置管理员不可删除' });
    audit(req, admin.u || 'admin', 'user_delete', `删除用户「${u ? u.username : id}」(#${id})`);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/queue' && req.method === 'GET') {
    return json(res, 200, { ok: true, queue: queue.list() });
  }

  if (pathname.startsWith('/api/admin/queue/') && req.method === 'DELETE') {
    const [, , , , sessionId] = pathname.split('/');
    queue.removeBySession(sessionId);
    hub.sendToBrowser(sessionId, { t: 'queue_cancelled' });
    audit(req, admin.u || 'admin', 'queue_kick', `移除排队会话 ${sessionId}`);
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/admin/settings') {
    if (req.method === 'GET') {
      const g = (k, def) => store.getSetting(k, def);
      return json(res, 200, {
        ok: true,
        license: config.licenseStatus(),
        settings: {
          maxInstances: parseInt(g('maxInstances', 3), 10),
          warmCount: parseInt(g('warmCount', 1), 10),
          idleTimeout: parseInt(g('idleTimeout', 300), 10),
          renderOffscreen: g('renderOffscreen', '1'),
          sessionTimeoutMin: parseFloat(g('sessionTimeoutMin', '30')),
          standbyFps: parseInt(g('standbyFps', '5'), 10),
          standbyBitrateKbps: parseInt(g('standbyBitrateKbps', '500'), 10),
          envProfile: g('envProfile', 'lan'),
          adaptiveEnabled: g('adaptiveEnabled', '0'),
          gpuQuotas: g('gpuQuotas', ''),
          ffmpegPath: g('ffmpegPath', 'ffmpeg'),
          gpuBindEnvVars: g('gpuBindEnvVars', 'CUDA_VISIBLE_DEVICES,NVIDIA_VISIBLE_DEVICES'),
          gpuProbeCmd: g('gpuProbeCmd', ''),
          gpuBudget: parseInt(g('gpuBudget', '90'), 10),
          spawnIntervalSec: parseInt(g('spawnIntervalSec', '6'), 10),
          overloadFpsFloor: parseInt(g('overloadFpsFloor', '25'), 10),
        },
        config: {
          publicHost: config.publicHost,
          port: config.port,
          whepBase: `http://${config.publicHost}:${config.mediamtxWhepPort}`,
          rtmpBase: `rtmp://${config.publicHost}:${config.mediamtxRtmpPort}`,
          mediamtxApi: `http://${config.mediamtxHost}:${config.mediamtxApiPort}`,
        },
      });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      const changed = [];
      for (const key of ['maxInstances', 'warmCount', 'idleTimeout', 'renderOffscreen',
        'sessionTimeoutMin', 'standbyFps', 'standbyBitrateKbps', 'adaptiveEnabled', 'envProfile', 'gpuQuotas',
        'ffmpegPath', 'gpuBindEnvVars', 'gpuProbeCmd', 'gpuBudget', 'spawnIntervalSec', 'overloadFpsFloor']) {
        if (body[key] !== undefined) {
          store.setSetting(key, body[key]);
          changed.push(`${key}=${body[key]}`);
        }
      }
      audit(req, admin.u || 'admin', 'settings', `修改系统设置: ${changed.join(', ') || '(仅触发预热)'}`);
      // 设置变更后即时触发预热检查（不等 15s 巡检）
      try { ctx.pool && ctx.pool.maintainWarm(); } catch { /* ignore */ }
      return json(res, 200, { ok: true });
    }
  }

  // ---------- 集群节点管理（master 模式） ----------
  if (master && pathname === '/api/admin/nodes') {
    if (req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        nodes: master.listNodes(),
        cluster: { role: config.clusterRole, nodeId: config.nodeId, token: config.clusterToken || '（未配置，请在 server/.env 设置 CLUSTER_TOKEN）' },
      });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const id = String(body.id || '').trim() || `node-${Date.now().toString(36)}`;
      if (!body.host) return json(res, 400, { ok: false, error: '缺少节点地址 host' });
      if (store.nodes.get(id)) return json(res, 400, { ok: false, error: `节点 ${id} 已存在` });
      store.nodes.create({ id, name: body.name, host: String(body.host).trim(), internal_port: body.internalPort, note: body.note });
      master.reload();
      audit(req, admin.u || 'admin', 'node_create', `新增集群节点「${body.name || id}」@${body.host}:${body.internalPort || 3120}`);
      return json(res, 200, { ok: true });
    }
  }

  if (master && pathname.startsWith('/api/admin/nodes/') && req.method === 'PUT') {
    const id = pathname.split('/')[4];
    const body = await readBody(req);
    if (!store.nodes.get(id)) return json(res, 404, { ok: false, error: '节点不存在' });
    const cur = store.nodes.get(id);
    store.nodes.update(id, { name: body.name ?? cur.name, host: body.host ?? cur.host, internal_port: body.internalPort ?? cur.internal_port, enabled: body.enabled ?? !!cur.enabled, note: body.note ?? cur.note });
    master.reload();
    audit(req, admin.u || 'admin', 'node_update', `修改集群节点「${id}」: ${JSON.stringify(body)}`);
    return json(res, 200, { ok: true });
  }

  if (master && pathname.startsWith('/api/admin/nodes/') && req.method === 'DELETE') {
    const id = pathname.split('/')[4];
    if (!store.nodes.get(id)) return json(res, 404, { ok: false, error: '节点不存在' });
    store.nodes.remove(id);
    master.reload();
    audit(req, admin.u || 'admin', 'node_delete', `删除集群节点「${id}」`);
    return json(res, 200, { ok: true });
  }

  // master：跨节点停止实例（节点管理页操作）
  if (master && pathname.startsWith('/api/admin/nodes/') && pathname.endsWith('/stop-instance') && req.method === 'POST') {
    const parts = pathname.split('/');
    const id = parts[4];
    const node = master.nodes.get(id);
    if (!node) return json(res, 404, { ok: false, error: '节点不存在' });
    const body = await readBody(req);
    try {
      await master.stopRemoteInstance(node, body.instanceId);
      audit(req, admin.u || 'admin', 'instance_stop', `停止节点 ${id} 实例 ${body.instanceId}`);
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 502, { ok: false, error: e.message });
    }
  }

  // ---------- 公网接入检测 ----------
  if (pathname === '/api/admin/public-net' && req.method === 'GET') {
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1';
    const { ip, error, cached } = await publicNet.detectPublicIp(force);
    return json(res, 200, { ok: true, ...(ip ? publicNet.buildNetGuide(ip) : { error }), cached });
  }

  // ---------- GPU 监控 / 配额 ----------
  if (pathname === '/api/admin/gpus' && req.method === 'GET') {
    const snap = ctx.gpu ? ctx.gpu.snapshot() : { ok: false, gpus: [], error: 'GPU 监控未启动' };
    return json(res, 200, { ok: true, ...snap });
  }

  if (pathname === '/api/admin/audit-logs' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams;
    const page = Math.max(1, parseInt(q.get('page'), 10) || 1);
    const pageSize = Math.min(100, Math.max(5, parseInt(q.get('pageSize'), 10) || 20));
    const action = (q.get('action') || '').trim();
    const r = store.audits.list({ page, pageSize, action });
    return json(res, 200, { ok: true, logs: r.rows, total: r.total, page, pageSize });
  }

  if (pathname === '/api/admin/trend' && req.method === 'GET') {
    const rows = store.sessions.trend24h();
    // 补齐空档小时，输出最近 24 个整点桶
    const now = new Date();
    const hours = [];
    for (let i = 23; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 3600000);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}`;
      hours.push({ hour: key, count: 0 });
    }
    const map = new Map(rows.map((r2) => [r2.hour, r2.count]));
    for (const h of hours) if (map.has(h.hour)) h.count = map.get(h.hour);
    const total = hours.reduce((a, b) => a + b.count, 0);
    return json(res, 200, { ok: true, hours, total, active: store.sessions.listActive().length });
  }

  // ---------- 授权管理（部署包内置；源码版 license.available=false 时前端自动隐藏） ----------
  if (pathname === '/api/admin/license') {
    if (req.method === 'GET') {
      const st = config.licenseStatus();
      return json(res, 200, {
        ok: true,
        license: { ...st, token: st.available && st.enabled ? store.getSetting('licenseToken', '') : '' },
      });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      if (body.enabled !== undefined) store.setSetting('licenseVerificationEnabled', body.enabled ? '1' : '0');
      if (body.token !== undefined) store.setSetting('licenseToken', String(body.token || '').trim());
      const st = config.licenseStatus();
      audit(req, admin.u || 'admin', 'license', `授权设置: enabled=${st.enabled} valid=${st.valid} reason=${st.reason}`);
      return json(res, 200, {
        ok: true,
        license: { ...st, token: st.available && st.enabled ? store.getSetting('licenseToken', '') : '' },
      });
    }
  }

  return json(res, 404, { ok: false, error: `no route: ${req.method} ${pathname}` });
}

/** master：聚合所有在线节点的程序列表（每个节点的模板独立编号，带 nodeId） */
function clusterPrograms(res, ctx) {
  const master = ctx.master;
  const nodes = master.listNodes();
  const programs = [];
  for (const n of nodes) {
    if (n.status !== 'online' || !n.capacity) continue;
    for (const t of n.capacity.templates) {
      programs.push({
        id: t.id, nodeId: n.id, nodeName: n.name,
        name: t.name, description: t.description || '',
        width: t.width, height: t.height, fps: t.fps,
        pool: t.pool,
        embed: buildEmbedInfo(t.id, undefined, n.id),
      });
    }
  }
  return json(res, 200, codes.formatApiSuccess('ZS_OK_8101', {
    programs,
    programsEmptyHint: programs.length ? undefined
      : (nodes.some((n) => n.enabled)
        ? '集群暂无在线渲染节点。请在各节点服务器启动调度服务，并在后台「节点管理」确认状态。'
        : '尚未登记任何渲染节点。请到 <a href="/admin">管理后台</a> →「节点管理」添加 worker 节点。'),
    cluster: { enabled: true, role: 'master', nodes: nodes.map((n) => ({ id: n.id, name: n.name, status: n.status })) },
    embedBase: buildEmbedInfo('<templateId>', undefined, '<nodeId>'),
  }));
}

/** master：跨节点会话代理——挑节点 → worker 创建 → 原样转发响应（含 worker 直连地址） */
async function clusterSessionProxy(req, res, ctx) {
  const master = ctx.master;
  const body = await readBody(req).catch(() => ({}));
  const templateId = body.templateId;

  // 依次尝试候选节点（首选节点故障时自动切换）
  const exclude = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { node, error } = master.pickNode(templateId, attempt === 0 ? body.nodeId : null, exclude);
    if (!node) {
      const b = codes.formatApiError('ZS_POOL_2005', { detail: error });
      return json(res, b.httpStatus || 503, { ...b, error });
    }
    try {
      const r = await master.createRemoteSession(node, templateId);
      // nodeId 统一改写为 master 登记的节点 ID（释放/管理操作按登记 ID 路由；
      // worker 自报的 NODE_ID 在 nodeName/节点管理页展示）
      r.data.nodeId = node.id;
      r.data.nodeName = (node.capacity && node.capacity.nodeName) || node.name;
      log.info(`[Cluster] 会话 ${r.data.sessionId} → 节点 ${node.id}（${node.name}）`);
      return json(res, r.status, r.data);
    } catch (e) {
      log.warn(`[Cluster] 节点 ${node.id} 创建会话失败: ${e.message}`);
      exclude.push(node.id);
    }
  }
  const b = codes.formatApiError('ZS_POOL_2003', { detail: '所有候选节点均创建失败' });
  return json(res, b.httpStatus || 502, { ...b, error: '所有候选节点均创建失败' });
}

function normalizeTemplate(b) {
  const rawWarm = b.warm_count === undefined ? b.warmCount : b.warm_count;
  const rawGpu = b.gpu_index === undefined ? b.gpuIndex : b.gpu_index;
  return {
    name: String(b.name || '').trim(),
    description: String(b.description || '').trim(),
    exe_path: String(b.exe_path || '').trim(),
    args: String(b.args || ''),
    width: Math.max(320, Math.min(3840, parseInt(b.width, 10) || 1280)),
    height: Math.max(240, Math.min(2160, parseInt(b.height, 10) || 720)),
    fps: Math.max(5, Math.min(120, parseInt(b.fps, 10) || 30)),
    bitrate_kbps: Math.max(500, Math.min(100000, parseInt(b.bitrate_kbps, 10) || 8000)),
    audio_codec: ['auto', 'aac', 'pcma', 'none'].includes(b.audio_codec) ? b.audio_codec : 'auto',
    enable_input: b.enable_input === 0 || b.enable_input === false ? 0 : 1,
    // 按模板预热实例数：0 = 不预热（用户进入才启动），null = 跟随全局默认
    warm_count: rawWarm === null || rawWarm === '' || rawWarm === undefined ? null : Math.max(0, Math.min(10, parseInt(rawWarm, 10) || 0)),
    // GPU 绑定：null = 自动（按配额选卡），-1 = 不绑卡，>=0 = 固定绑定该卡
    gpu_index: rawGpu === null || rawGpu === '' || rawGpu === undefined ? null
      : Math.max(-1, parseInt(rawGpu, 10)),
    // 编码后端：auto = 硬件优先失败自动降级 FFmpeg（默认）；ave = 仅 NVENC/AMF（旧行为）；ffmpeg = 仅 FFmpeg（软编码/国产卡 VAAPI）
    encoder_backend: ['auto', 'ave', 'ffmpeg'].includes(b.encoder_backend) ? b.encoder_backend : 'auto',
    // 单实例 GPU 负载权重（%）：池按「权重和 ≤ gpuBudget」准入，超预算新会话排队（防超卖卡死老流）
    gpu_weight: Math.max(1, Math.min(100, parseInt(b.gpu_weight, 10) || 30)),
  };
}

/**
 * 会话创建核心逻辑（本机 HTTP / 集群 worker 内部 API 共用）。
 * @param {object} ctx pool/queue/hub/sessions
 * @param {object} body {templateId}
 * @param {string} [hostOverride] 会话响应里 wsUrl 的 host（集群模式下用 worker 公网地址）
 * @returns {Promise<{status:number, payload:object}>}
 */
async function createSession(ctx, body, hostOverride) {
  const { pool, queue, sessions } = ctx;
  const templates = store.templates.list();
  if (templates.length === 0) {
    const b = codes.formatApiError('ZS_CFG_1004');
    return { status: b.httpStatus || 503, payload: { ...b, error: b.message } };
  }
  const template = templates.find((t) => String(t.id) === String(body.templateId)) || templates[0];

  // 过载保护（用户设定）：运行中(assigned)实例平均帧率 < 下限 → 直接拒绝新流并提示，已运行流不受影响。
  // 仅统计已分配且运行稳定(>8s)、心跳新鲜(<8s)的实例，排除冷启动/掉线实例，避免误杀。
  const overloadFpsFloor = parseInt(store.getSetting('overloadFpsFloor', '25'), 10);
  if (overloadFpsFloor > 0) {
    const now = Date.now();
    const actives = [...pool.instances.values()].filter((it) =>
      it.state === 'assigned' &&
      it.startedAt && (now - it.startedAt) > 8000 &&
      it.lastHeartbeat && (now - it.lastHeartbeat) < 8000 &&
      it.stats && it.stats.fps > 0
    );
    if (actives.length > 0) {
      const avg = actives.reduce((s, it) => s + (it.stats.fps || 0), 0) / actives.length;
      if (avg < overloadFpsFloor) {
        const b = codes.formatApiError('ZS_POOL_2007', { avgFps: avg.toFixed(0), floor: overloadFpsFloor, count: actives.length });
        log.info(`[Session] 过载拒绝新流：平均帧率 ${avg.toFixed(0)}fps < 下限 ${overloadFpsFloor}（${actives.length} 路）`);
        return { status: b.httpStatus || 409, payload: { ...b, error: b.message, queued: false } };
      }
    }
  }

  const sessionId = auth.randomId('sess');
  const token = auth.randomId('tok');
  sessions.set(sessionId, { id: sessionId, token, templateId: template.id, instanceId: null, state: 'active', createdAt: Date.now() });
  ctx.hub._tokens.set(sessionId, token);
  store.sessions.insert(sessionId, template.id, template.name, null);

  const hostPart = hostOverride || `${config.publicHost}:${config.port}`;

  // 1) 已就绪的空闲实例（严格匹配模板，避免编辑器/打包版实例错配）
  let instance = pool.findFree(template.id);

  // 2) 池未满则新拉一个；有实例正在冷启动时也排队（串行化，防 GPU 尖峰叠加饿死老流）
  if (!instance && pool.size < pool.maxInstances && pool.canSpawnNow()) {
    try {
      instance = pool.spawn(template);
    } catch (e) {
      // GPU 配额/负载预算满：与池满同待遇——转入排队，等其它会话释放
      if (/配额已满|负载预算已满/.test(e.message)) {
        log.info(`[Session] ${/负载预算/.test(e.message) ? 'GPU 负载预算满' : 'GPU 配额满'}，会话 ${sessionId} 转入排队: ${e.message}`);
      } else {
        const isMissing = /不存在|ENOENT/.test(e.message);
        const b = codes.formatApiError(isMissing ? 'ZS_CFG_1002' : 'ZS_POOL_2003', { detail: e.message });
        return { status: b.httpStatus || 500, payload: { ...b, error: e.message } };
      }
    }
  }

  if (instance) {
    assignInstance(ctx, sessionId, instance.id);
    return {
      status: 200,
      payload: {
        ok: true, sessionId, token,
        state: isAgentReady(instance) ? 'ready' : 'starting',
        instanceId: instance.id,
        whepUrl: config.whepUrlFor(instance.id),
        wsUrl: `ws://${hostPart}/ws?token=${token}`,
        baseUrl: `http://${hostPart}`,
        template: { name: template.name, width: template.width, height: template.height },
        adaptive: adaptiveEnabled(),
        targetBitrateKbps: instance.bitrate_kbps || template.bitrate_kbps || null,
      },
    };
  }

  // 3) 排队
  queue.enqueue(sessionId, template.id, () => {});
  return {
    status: 202,
    payload: {
      ok: true, queued: true, sessionId, token,
      position: queue.length,
      code: 'ZS_POOL_2001',
      wsUrl: `ws://${hostPart}/ws?token=${token}`,
      baseUrl: `http://${hostPart}`,
    },
  };
}

/** agent 是否已 hello（实例真正就绪，可以开始 WHEP 拉流） */
function isAgentReady(it) { return it && it.lastHeartbeat > 0; }

/** 把实例绑定到会话（含补位） */
function assignInstance(ctx, sessionId, instanceId) {
  const { pool, hub, sessions } = ctx;
  const it = pool.get(instanceId);
  const s = sessions.get(sessionId);
  if (!it || !s) return;
  pool.assign(it, sessionId);
  s.instanceId = instanceId;
  store.db.prepare('UPDATE sessions SET instance_id=? WHERE id=?').run(instanceId, sessionId);
  hub.sendToBrowser(sessionId, {
    t: 'assigned',
    instanceId,
    whepUrl: config.whepUrlFor(instanceId),
    state: isAgentReady(it) ? 'ready' : 'starting',
    adaptive: adaptiveEnabled(),
    targetBitrateKbps: it.bitrate_kbps || null,
  });
}

/** 模板的有效预热数：模板显式设置优先，未设置跟随全局默认 */
function effectiveWarmCount(templateId) {
  const tpl = store.templates.get(templateId);
  if (!tpl) return 0;
  if (tpl.warm_count !== null && tpl.warm_count !== undefined) return parseInt(tpl.warm_count, 10) || 0;
  return parseInt(store.getSetting('warmCount', 1), 10) || 0;
}

/** 结束会话并释放实例 */
function endSession(ctx, sessionId, reason) {
  const { pool, queue, hub, sessions } = ctx;
  const s = sessions.get(sessionId);
  if (!s) return;
  s.state = 'ended';
  queue.removeBySession(sessionId);
  if (s.instanceId && pool.get(s.instanceId)) {
    const it = pool.get(s.instanceId);
    pool.release(s.instanceId); // 转 ready + 待命降载
    // 回收策略：模板（或全局默认）不预热 且 无排队者 → 会话结束即停实例，不留在资源池
    if (effectiveWarmCount(it.templateId) <= 0 && queue.length === 0) {
      log.info(`[Session] ${sessionId} 模板无预热需求，实例 ${it.id} 直接回收`);
      pool.stop(it.id, 'no_warm_release');
    }
  }
  hub.sendToBrowser(sessionId, { t: 'session_ended', reason });
  sessions.delete(sessionId);
  store.sessions.end(sessionId, reason);
  log.info(`[Session] ${sessionId} 结束 (${reason})`);
  // 容量释放，尝试补位
  setTimeout(() => dispatchQueue(ctx), 500);
}

/** 排队补位 */
async function dispatchQueue(ctx) {
  const { pool, queue, sessions } = ctx;
  while (queue.length > 0) {
    const entry = queue.waiting[0];
    const s = sessions.get(entry.sessionId);
    if (!s) { queue.waiting.shift(); continue; }
    let instance = pool.findFree(s.templateId);
    // 冷启动串行化：有实例在启动/间隔未到，本轮不 spawn（等 ready 事件或兜底定时器再试）
    if (!instance && pool.size < pool.maxInstances && pool.canSpawnNow()) {
      const tpl = store.templates.get(s.templateId) || store.templates.list()[0];
      try { instance = pool.spawn(tpl); } catch { instance = null; }
    }
    if (!instance) break;
    queue.waiting.shift();
    assignInstance(ctx, entry.sessionId, instance.id);
  }
  queue.broadcastPositions();
  // 兜底：仍有排队者（串行化等待 / 预算满）时定时重试，避免只靠 ready 事件导致滞留
  if (queue.length > 0 && pool.size < pool.maxInstances) {
    setTimeout(() => dispatchQueue(ctx), 3000).unref?.();
  }
}

module.exports = { handleApi, endSession, assignInstance, dispatchQueue, createSession, readBody, json };
