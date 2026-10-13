/* ZS Live 管理后台 SPA（零构建，原生 JS） */
'use strict';

const API = {
  token: localStorage.getItem('zsl_token') || '',
  async call(method, path, body) {
    const opt = { method, headers: { 'Authorization': 'Bearer ' + API.token } };
    if (body !== undefined) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
    const res = await fetch(path, opt);
    if (res.status === 401) { logout(); throw new Error('登录已过期'); }
    return res.json();
  },
};

function logout() {
  localStorage.removeItem('zsl_token');
  API.token = '';
  document.getElementById('login').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
}

async function doLogin() {
  const username = document.getElementById('li-user').value.trim();
  const password = document.getElementById('li-pass').value;
  const res = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }).then((r) => r.json());
  if (res.ok) {
    API.token = res.token;
    localStorage.setItem('zsl_token', res.token);
    enter();
  } else {
    alert(res.error || '登录失败');
  }
}
document.getElementById('li-pass').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });

function enter() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  renderNav();
  route(location.hash || '#dashboard');
}

let toastTimer = null;
function toast(msg, type) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (type === 'err' ? ' t-err' : type === 'warn' ? ' t-warn' : '');
  t.style.display = 'block';
  // 重新触发入场动画
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.style.display = 'none'), 2600);
}

/* ---------------- 路由 ---------------- */

const ICON_SVG = (inner) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICONS = {
  dashboard: ICON_SVG('<rect x="3" y="3" width="7" height="9" rx="1.6"/><rect x="14" y="3" width="7" height="5" rx="1.6"/><rect x="14" y="12" width="7" height="9" rx="1.6"/><rect x="3" y="16" width="7" height="5" rx="1.6"/>'),
  instances: ICON_SVG('<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>'),
  gpus:      ICON_SVG('<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="10" y="10" width="4" height="4"/><path d="M9 2.5V6M15 2.5V6M9 18v3.5M15 18v3.5M2.5 9H6M2.5 15H6M18 9h3.5M18 15h3.5"/>'),
  nodes:     ICON_SVG('<circle cx="12" cy="5" r="2.4"/><circle cx="5" cy="19" r="2.4"/><circle cx="19" cy="19" r="2.4"/><path d="M11 7.2 6 16.9M13 7.2l5 9.7M7.4 19h9.2"/>'),
  queue:     ICON_SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  sessions:  ICON_SVG('<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M10.2 8.6l3.8 2.15-3.8 2.15z" fill="currentColor" stroke="none"/><path d="M8.5 20h7"/>'),
  audit:     ICON_SVG('<path d="M7 3h7l4 4v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M9.5 12h5M9.5 15.5h5M9.5 8.5h2"/>'),
  templates: ICON_SVG('<path d="M12 3 3 8l9 5 9-5-9-5z"/><path d="M3 12.5l9 5 9-5M3 17l9 5 9-5" opacity=".55"/>'),
  users:     ICON_SVG('<circle cx="12" cy="8" r="3.4"/><path d="M5.5 20c1.1-3.3 3.7-5 6.5-5s5.4 1.7 6.5 5"/>'),
  settings:  ICON_SVG('<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.7M12 18.5v2.7M2.8 12h2.7M18.5 12h2.7M5.2 5.2l1.9 1.9M16.9 16.9l1.9 1.9M18.8 5.2l-1.9 1.9M7.1 16.9l-1.9 1.9"/>'),
  media:     ICON_SVG('<path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"/>'),
  clock:     ICON_SVG('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
  activity:  ICON_SVG('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
};

const pages = [
  ['dashboard', '仪表盘', renderDashboard],
  ['instances', '实例管理', renderInstances],
  ['gpus', 'GPU 监控', renderGpus],
  ['nodes', '节点管理', renderNodes],
  ['queue', '排队管理', renderQueue],
  ['sessions', '会话记录', renderSessions],
  ['audit', '审计日志', renderAudit],
  ['templates', '实例模板', renderTemplates],
  ['users', '用户管理', renderUsers],
  ['settings', '系统设置', renderSettings],
];

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const [id, label] of pages) {
    const a = document.createElement('a');
    a.innerHTML = (ICONS[id] || '') + '<span>' + label + '</span>';
    a.dataset.page = id;
    a.onclick = () => { location.hash = '#' + id; };
    nav.appendChild(a);
  }
}

window.addEventListener('hashchange', () => route(location.hash));

let routeTimer = null;
function route(hash) {
  const id = (hash || '#dashboard').slice(1);
  const page = pages.find((p) => p[0] === id) || pages[0];
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.page === page[0]));
  clearInterval(routeTimer);
  page[2](); // 立即渲染一次
  routeTimer = setInterval(() => {
    if (isFormEditing()) return; // 表单编辑中：跳过本次自动刷新，避免冲掉未保存的修改
    page[2]();
  }, 5000); // 自动刷新
}

/** 当前页是否有进行中/未保存的表单编辑（有则暂停自动刷新） */
function isFormEditing() {
  const m = document.getElementById('main');
  if (!m) return false;
  if (typeof editingTplId === 'number' && editingTplId) return true; // 模板编辑中
  const el = document.activeElement;
  if (el && m.contains(el) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return true; // 焦点在输入框
  return !!m.querySelector('input[data-dirty="1"], textarea[data-dirty="1"], select[data-dirty="1"]'); // 有已修改未保存的内容
}

// 标记用户修改过的表单控件（保存/重渲染后新元素无标记，保护自动解除）
document.addEventListener('input', markDirty, true);
document.addEventListener('change', markDirty, true);
function markDirty(e) {
  const el = e.target;
  const m = document.getElementById('main');
  if (el && el.tagName && m && m.contains(el)) el.dataset.dirty = '1';
}

/* ---------------- 通用组件 ---------------- */

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function badge(text, cls) { return `<span class="badge b-${cls}">${esc(text)}</span>`; }

function stateBadge(s) {
  if (s === 'assigned') return badge('推流中', 'ok');
  if (s === 'ready') return badge('空闲', 'info');
  if (s === 'spawning') return badge('启动中', 'warn');
  if (s === 'stopping') return badge('停止中', 'warn');
  return badge(s, 'muted');
}

const main = () => document.getElementById('main');

/* ---------------- 仪表盘 ---------------- */

async function renderDashboard() {
  const [d, trend] = await Promise.all([
    API.call('GET', '/api/admin/stats'),
    API.call('GET', '/api/admin/trend').catch(() => null),
  ]);
  const p = d.pool, mtx = d.mediamtx, sv = d.server;
  main().innerHTML = `
  <h2 class="page">仪表盘</h2>
  <div class="row">
    <div class="card stat"><div class="stat-ic">${ICONS.instances}</div><h3>运行实例</h3><div class="big">${p.total}<small> / ${p.max}</small></div>
      <p class="hint">空闲 ${p.ready} · 推流中 ${p.assigned} · 启动中 ${p.spawning}</p></div>
    <div class="card stat"><div class="stat-ic">${ICONS.users}</div><h3>活动会话</h3><div class="big">${d.sessions.active}</div><p class="hint">排队 ${d.queue.length} 人</p></div>
    <div class="card stat"><div class="stat-ic">${ICONS.media}</div><h3>MediaMTX</h3><div class="big">${mtx.ok ? '正常' : '未连接'}</div>
      <p class="hint">${mtx.paths.length} 路流 · ${mtx.sessions.length} 个连接</p></div>
    <div class="card stat"><div class="stat-ic">${ICONS.clock}</div><h3>服务运行</h3><div class="big">${fmtDur(sv.uptimeSec)}</div>
      <p class="hint">内存 ${sv.memoryMb}MB · ${sv.cpuCount} 核 · ${esc(sv.platform)}</p></div>
  </div>
  ${trend ? `<div class="card"><h3>近 24 小时会话趋势 <small class="hint">共 ${trend.total} 次 · 当前活跃 ${trend.active}</small></h3>
    ${trendChart(trend.hours)}</div>` : ''}
  <div class="card"><h3>MediaMTX 路径（推流中的实例）</h3>
    ${mtxTable(mtx)}</div>
  <div class="card"><h3>排队中的用户</h3>${queueTable(d.queue.items)}</div>`;
  document.getElementById('side-info').innerHTML = `服务: ${esc(sv.host)}:${sv.port} <br>运行 ${fmtDur(sv.uptimeSec)}`;
}

/** 24h 趋势柱状图（纯 CSS，零依赖） */
function trendChart(hours) {
  const max = Math.max(1, ...hours.map((h) => h.count));
  return `<div style="display:flex;align-items:flex-end;gap:2px;height:90px;padding:4px 0">
    ${hours.map((h) => {
      const hh = h.hour.slice(11);
      const pct = Math.round(h.count / max * 100);
      return `<div title="${h.hour}:00 · ${h.count} 次会话" style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;height:100%">
        <div style="background:${h.count ? 'var(--accent)' : 'var(--border)'};height:${Math.max(h.count ? 6 : 2, pct)}%;border-radius:2px;transition:height .3s"></div>
        ${hh.endsWith('00') ? `<div class="hint" style="text-align:center;font-size:10px">${parseInt(hh)}时</div>` : '<div style="font-size:10px">&nbsp;</div>'}
      </div>`;
    }).join('')}
  </div>`;
}

function fmtDur(s) {
  s = Math.round(s || 0);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

function mtxTable(mtx) {
  if (!mtx.paths.length) return '<p class="hint">暂无推流路径</p>';
  return `<table><tr><th>路径</th><th>来源</th></tr>
    ${mtx.paths.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(p.source || '-')}</td></tr>`).join('')}</table>`;
}

function queueTable(items) {
  if (!items || !items.length) return '<p class="hint">队列为空</p>';
  return `<table><tr><th>位置</th><th>会话</th><th>已等待</th></tr>
    ${items.map((q) => `<tr><td>${q.position}</td><td>${esc(q.sessionId)}</td><td>${fmtDur(q.waitedSec)}</td></tr>`).join('')}</table>`;
}

/* ---------------- 实例管理 ---------------- */

async function renderInstances() {
  const d = await API.call('GET', '/api/admin/instances');
  main().innerHTML = `
  <h2 class="page">实例管理 <button class="ghost mini" onclick="spawnWarm()">+ 预热一个实例</button></h2>
  <div class="card">
    <table>
      <tr><th>实例 ID</th><th>模板</th><th>状态</th><th>GPU</th><th>会话</th><th>PID</th><th>运行时长</th><th>Agent</th><th>FPS</th><th>码率</th><th>操作</th></tr>
      ${d.instances.map((i) => `
        <tr>
          <td style="font-family:Consolas">${esc(i.id)}</td>
          <td>${esc(i.templateName)}</td>
          <td>${stateBadge(i.state)}</td>
          <td>${i.gpuIndex != null ? badge('GPU ' + i.gpuIndex, 'info') : badge('未绑卡', 'muted')}</td>
          <td style="font-family:Consolas">${esc(i.sessionId || '-')}</td>
          <td>${i.pid || '-'}</td>
          <td>${fmtDur(i.uptimeSec)}</td>
          <td>${i.agentOk ? badge('在线', 'ok') : badge('离线', 'err')}</td>
          <td>${(i.stats && i.stats.fps) || '-'}</td>
          <td>${i.stats && i.stats.rtmpOk ? '正常' : '断开'}</td>
          <td>
            ${i.sessionId ? `<button class="mini ghost" onclick="spareInst('${i.id}')">转为空闲</button> ` : ''}
            <button class="mini danger" onclick="stopInst('${i.id}')">停止</button>
          </td>
        </tr>`).join('') || '<tr><td colspan="11" class="hint">暂无实例。预热池会按模板自动拉起。</td></tr>'}
    </table>
    <p class="hint">预热策略在「系统设置」中调整；实例由 UE 打包程序 + StreamForge 插件组成。</p>
  </div>`;
}

async function stopInst(id) {
  if (!confirm('确定停止该实例？')) return;
  await API.call('POST', `/api/admin/instances/${id}/stop`);
  toast('已停止');
  renderInstances();
}
async function spareInst(id) {
  await API.call('POST', `/api/admin/instances/${id}/spare`);
  toast('已转为空闲');
  renderInstances();
}
async function spawnWarm() {
  // PUT settings 现在会即时触发服务端预热检查（按各模板的预热数）
  await API.call('PUT', '/api/admin/settings', {});
  toast('已触发预热');
}

/* ---------------- GPU 监控 ---------------- */

async function renderGpus() {
  const [g, s] = await Promise.all([
    API.call('GET', '/api/admin/gpus'),
    API.call('GET', '/api/admin/settings'),
  ]);
  const quotaStr = (s.settings && s.settings.gpuQuotas) || '';
  main().innerHTML = `
  <h2 class="page">GPU 监控 <small class="hint">${esc(g.source || '')}${g.monitorOk ? '' : (g.error ? ' · ' + esc(g.error) : '')}</small></h2>
  ${g.gpus.length ? `<div class="row">${g.gpus.map(gpuCard).join('')}</div>` : `
    <div class="card"><p class="hint">未检测到 NVIDIA GPU（${esc(g.error || 'nvidia-smi 不可用')}）。
    安装 NVIDIA 驱动后本页自动显示每卡利用率 / 显存 / 温度。</p></div>`}
  <div class="card"><h3>GPU 配额（每卡最大实例数）</h3>
    <div class="form-grid">
      <div><label>配额写法</label><input id="g-quotas" value="${esc(quotaStr)}" placeholder="如: 0:3,1:1（留空 = 不启用绑卡）"></div>
      <div><label>说明</label>
        <p class="hint" style="margin-top:2px">
          格式 <code>GPU编号:最大实例数</code>，多卡逗号分隔。例：<code>0:3,1:1</code> 表示 GPU0 最多 3 路、GPU1 最多 1 路。<br>
          启用后每个 UE 实例启动时自动绑定到 <code>-graphicsadapter=N</code>，优先填剩余配额最多的卡；<br>
          模板可在「实例模板」里固定绑卡。留空 = 不绑卡（单卡机器无需配置）。
        </p>
      </div>
    </div>
    <div class="actions">
      <button onclick="saveGpuQuotas()">保存配额</button>
      <span class="hint" style="align-self:center">${g.quotaEnabled
        ? `已启用 · 合计配额 ${g.totalQuota} 路 · 当前占用 ${g.totalUsed} 路`
        : '当前未启用（实例不绑卡）'}</span>
    </div>
  </div>`;
}

function gpuCard(g) {
  const util = Math.max(0, Math.min(100, g.utilPct || 0));
  const vram = Math.max(0, Math.min(100, g.vramUsedPct || 0));
  const utilColor = util >= 90 ? 'var(--err)' : util >= 60 ? 'var(--warn)' : 'var(--ok)';
  const vramColor = vram >= 90 ? 'var(--err)' : vram >= 70 ? 'var(--warn)' : 'var(--accent)';
  return `<div class="card" style="min-width:300px">
    <h3>GPU ${g.index} · ${esc(g.name)}</h3>
    <div class="big" style="font-size:20px">${util}%<small> 利用率</small>
      <span style="float:right;font-size:13px">${g.tempC}°C</span></div>
    <div style="height:8px;border-radius:4px;background:var(--panel2);margin:8px 0 4px;overflow:hidden">
      <div style="height:100%;width:${util}%;background:${utilColor};border-radius:4px;transition:width .4s"></div>
    </div>
    <p class="hint">显存 ${(g.vramUsedMB / 1024).toFixed(1)} / ${(g.vramTotalMB / 1024).toFixed(1)} GB（${vram}%）</p>
    <div style="height:8px;border-radius:4px;background:var(--panel2);margin:4px 0 8px;overflow:hidden">
      <div style="height:100%;width:${vram}%;background:${vramColor};border-radius:4px;transition:width .4s"></div>
    </div>
    <p class="hint">实例占用：${g.quota != null ? `${g.used} / ${g.quota} 路` : `${g.used} 路（未设配额）`}</p>
    ${g.instances && g.instances.length ? `<table style="font-size:12px">
      <tr><th>实例</th><th>模板</th><th>状态</th></tr>
      ${g.instances.map((i) => `<tr><td style="font-family:Consolas">${esc(i.id)}</td>
        <td>${esc(i.templateName)}</td><td>${stateBadge(i.state)}</td></tr>`).join('')}
    </table>` : ''}
  </div>`;
}

async function saveGpuQuotas() {
  const v = document.getElementById('g-quotas').value.trim();
  if (v && !/^(\s*\d+\s*:\s*\d+\s*,?\s*)+$/.test(v) && !v.startsWith('[')) {
    toast('格式不正确，示例: 0:3,1:1', 'warn');
    return;
  }
  await API.call('PUT', '/api/admin/settings', { gpuQuotas: v });
  toast(v ? '配额已保存，新实例将按配额绑卡' : '已停用 GPU 配额（实例不再绑卡）');
  renderGpus();
}

/* ---------------- 节点管理（集群 master） ---------------- */

async function renderNodes() {
  const d = await API.call('GET', '/api/admin/nodes');
  if (!d.nodes) {
    main().innerHTML = `
    <h2 class="page">节点管理</h2>
    <div class="card"><p class="hint">当前服务不是集群 master（CLUSTER_ROLE=master 时此页可用）。
    单机/worker 模式下无需节点管理；多机部署请在 master 服务器的 server/.env 配置后重启。</p></div>`;
    return;
  }
  const c = d.cluster || {};
  main().innerHTML = `
  <h2 class="page">节点管理 <small class="hint">集群模式：${esc(c.role)} · 本节点 ${esc(c.nodeId || '-')}</small></h2>
  <div class="card" style="margin-bottom:14px"><h3>接入新 Worker</h3>
    <div class="row">
      <div style="flex:2;min-width:300px">
        <div class="form-grid">
          <div><label>节点 ID（留空自动生成）</label><input id="n-id" placeholder="如 render-02"></div>
          <div><label>显示名称</label><input id="n-name" placeholder="如 渲染节点2（4090）"></div>
          <div><label>节点地址（IP/主机名）</label><input id="n-host" placeholder="如 192.168.1.20"></div>
          <div><label>内部 API 端口</label><input id="n-port" type="number" value="3120"></div>
          <div class="full"><label>备注</label><input id="n-note" placeholder="可选"></div>
        </div>
        <div class="actions"><button onclick="addNode()">添加节点</button></div>
      </div>
      <div style="flex:1;min-width:260px">
        <p class="hint" style="margin-top:0">worker 服务器上设置 <code>server/.env</code>：</p>
        <pre style="background:var(--panel2);padding:10px;border-radius:6px;font-size:12px;overflow:auto">CLUSTER_ROLE=worker
CLUSTER_TOKEN=${esc(c.token || '<master的CLUSTER_TOKEN>')}
CLUSTER_INTERNAL_PORT=3120</pre>
        <p class="hint">Token 必须与本页显示的 master Token 一致。</p>
      </div>
    </div>
  </div>
  <div class="card"><h3>已登记节点（${d.nodes.length}）</h3>
    ${d.nodes.length ? `<table>
      <tr><th>节点</th><th>地址</th><th>状态</th><th>实例池</th><th>GPU</th><th>会话/排队</th><th>最近上报</th><th>操作</th></tr>
      ${d.nodes.map(nodeRow).join('')}
    </table>` : '<p class="hint">尚未登记节点。左上方添加第一台 worker。</p>'}
  </div>`;
}

function nodeRow(n) {
  const cap = n.capacity;
  const gpus = cap && cap.gpu && cap.gpu.gpus ? cap.gpu.gpus : [];
  const gpuStr = gpus.length
    ? gpus.map((g) => `${g.utilPct}% / ${g.vramUsedPct}%${g.quota != null ? `（${g.used}/${g.quota}）` : ''}`).join(' · ')
    : (cap ? '无 NVIDIA 卡' : '-');
  return `<tr>
    <td>${esc(n.name)}<div class="hint" style="font-family:Consolas">${esc(n.id)}${cap && cap.nodeId && cap.nodeId !== n.id ? ' · NODE_ID: ' + esc(cap.nodeId) : ''}</div></td>
    <td style="font-family:Consolas">${esc(n.host)}:${n.internalPort}</td>
    <td>${nodeStatusBadge(n.status)}</td>
    <td>${cap ? `${cap.pool.total}/${cap.pool.max}（空闲 ${cap.pool.ready}）` : '-'}</td>
    <td>${esc(gpuStr)}</td>
    <td>${cap ? `${cap.sessions.active} / ${cap.queue.length}` : '-'}</td>
    <td>${n.lastSeen ? esc(n.lastSeen.replace('T', ' ').slice(0, 19)) : '-'}${n.lastError ? `<div class="hint" style="color:var(--err)">${esc(n.lastError)}</div>` : ''}</td>
    <td>
      <button class="mini ghost" onclick="toggleNode('${esc(n.id)}', ${n.enabled})">${n.enabled ? '停用' : '启用'}</button>
      <button class="mini danger" onclick="delNode('${esc(n.id)}')">删除</button>
    </td>
  </tr>`;
}

function nodeStatusBadge(s) {
  if (s === 'online') return badge('在线', 'ok');
  if (s === 'degraded') return badge('通讯异常', 'warn');
  if (s === 'offline') return badge('离线', 'err');
  if (s === 'disabled') return badge('已停用', 'muted');
  return badge(s || '未知', 'muted');
}

async function addNode() {
  const body = {
    id: document.getElementById('n-id').value.trim(),
    name: document.getElementById('n-name').value.trim(),
    host: document.getElementById('n-host').value.trim(),
    internalPort: +document.getElementById('n-port').value || 3120,
    note: document.getElementById('n-note').value.trim(),
  };
  if (!body.host) { toast('请填写节点地址'); return; }
  try {
    await API.call('POST', '/api/admin/nodes', body);
    toast('已添加，等待节点上线（约 5 秒内轮询）');
    renderNodes();
  } catch (e) { toast('添加失败: ' + e.message); }
}

async function toggleNode(id, enabled) {
  await API.call('PUT', `/api/admin/nodes/${id}`, { enabled: !enabled });
  toast(enabled ? '已停用（不再参与调度）' : '已启用');
  renderNodes();
}

async function delNode(id) {
  if (!confirm(`确定删除节点 ${id}？`)) return;
  await API.call('DELETE', `/api/admin/nodes/${id}`);
  toast('已删除');
  renderNodes();
}

/* ---------------- 排队 / 会话 ---------------- */

async function renderQueue() {
  const d = await API.call('GET', '/api/admin/queue');
  main().innerHTML = `
  <h2 class="page">排队管理</h2>
  <div class="card">
    ${d.queue.length ? `<table><tr><th>位置</th><th>会话</th><th>模板</th><th>已等待</th><th>操作</th></tr>
      ${d.queue.map((q) => `<tr><td>${q.position}</td><td style="font-family:Consolas">${esc(q.sessionId)}</td>
        <td>${q.templateId}</td><td>${fmtDur(q.waitedSec)}</td>
        <td><button class="mini danger" onclick="kickQueue('${q.sessionId}')">移出队列</button></td></tr>`).join('')}</table>`
      : '<p class="hint">当前没有排队用户</p>'}
  </div>`;
}
async function kickQueue(sid) {
  await API.call('DELETE', `/api/admin/queue/${sid}`);
  toast('已移出');
  renderQueue();
}

async function renderSessions() {
  const d = await API.call('GET', '/api/admin/sessions');
  main().innerHTML = `
  <h2 class="page">会话记录</h2>
  <div class="card"><table>
    <tr><th>会话 ID</th><th>模板</th><th>实例</th><th>开始时间</th><th>结束时间</th><th>状态</th></tr>
    ${d.sessions.map((s) => `<tr>
      <td style="font-family:Consolas">${esc(s.id)}</td><td>${esc(s.template_name || '-')}</td>
      <td style="font-family:Consolas">${esc(s.instance_id || '-')}</td>
      <td>${esc(s.started_at)}</td><td>${esc(s.ended_at || '-')}</td>
      <td>${s.state === 'active' ? badge('进行中', 'ok') : badge(s.state, 'muted')}</td></tr>`).join('')
      || '<tr><td colspan="6" class="hint">暂无记录</td></tr>'}
  </table></div>`;
}

/* ---------------- 审计日志 ---------------- */

let auditState = { page: 1, action: '' };

const AUDIT_ACTION_LABELS = {
  login: '登录', login_fail: '登录失败', template_create: '新建模板', template_update: '修改模板',
  template_delete: '删除模板', settings: '系统设置', env_profile: '环境配置档', instance_stop: '停止实例',
  instance_spare: '实例转空闲', user_create: '新增用户', user_update: '修改用户', user_delete: '删除用户',
  queue_kick: '移除排队', node_create: '新增节点', node_update: '修改节点', node_delete: '删除节点',
};

async function renderAudit() {
  const q = new URLSearchParams({ page: auditState.page, pageSize: 15 });
  if (auditState.action) q.set('action', auditState.action);
  const d = await API.call('GET', '/api/admin/audit-logs?' + q.toString());
  const totalPages = Math.max(1, Math.ceil(d.total / d.pageSize));
  if (auditState.page > totalPages) auditState.page = totalPages;
  main().innerHTML = `
  <h2 class="page">审计日志 <small class="hint">共 ${d.total} 条 · 保留 90 天</small></h2>
  <div class="card">
    <div style="margin-bottom:10px">
      <select id="audit-filter" onchange="auditFilter(this.value)">
        <option value="">全部操作</option>
        ${Object.entries(AUDIT_ACTION_LABELS).map(([v, label]) =>
          `<option value="${v}" ${auditState.action === v ? 'selected' : ''}>${label}</option>`).join('')}
      </select>
    </div>
    <table>
      <tr><th>时间</th><th>操作者</th><th>操作</th><th>详情</th><th>来源 IP</th></tr>
      ${d.logs.map((l) => `<tr>
        <td style="white-space:nowrap">${esc(l.created_at)}</td>
        <td>${esc(l.actor)}</td>
        <td>${badge(AUDIT_ACTION_LABELS[l.action] || l.action, l.action === 'login_fail' ? 'err' : 'info')}</td>
        <td style="max-width:420px">${esc(l.detail || '-')}</td>
        <td style="font-family:Consolas">${esc(l.ip || '-')}</td></tr>`).join('')
        || '<tr><td colspan="5" class="hint">暂无记录</td></tr>'}
    </table>
    <div class="actions" style="justify-content:space-between">
      <button class="mini ghost" ${auditState.page <= 1 ? 'disabled' : ''} onclick="auditPage(${auditState.page - 1})">上一页</button>
      <span class="hint">第 ${d.page} / ${totalPages} 页</span>
      <button class="mini ghost" ${auditState.page >= totalPages ? 'disabled' : ''} onclick="auditPage(${auditState.page + 1})">下一页</button>
    </div>
  </div>`;
}

function auditFilter(v) { auditState.action = v; auditState.page = 1; renderAudit(); }
function auditPage(p) { if (p < 1) return; auditState.page = p; renderAudit(); }

/* ---------------- 模板 ---------------- */

let QUALITY_PRESETS_CACHE = [];
let GPU_LIST_CACHE = []; // 检测到的 GPU 数（模板绑卡下拉用）

/** 模板 GPU 绑定下拉选项：自动 / 不绑卡 / GPU 0..N */
function gpuBindOptions(cur) {
  // 配额里引用的卡号也要出现在选项中（即使硬件暂时探测不到）
  let maxIdx = GPU_LIST_CACHE.length ? GPU_LIST_CACHE.length - 1 : -1;
  const q = (window.__gpuQuotaStr || '');
  (q.match(/(\d+)\s*:/g) || []).forEach((m) => {
    const n = parseInt(m, 10);
    if (Number.isFinite(n) && n > maxIdx) maxIdx = n;
  });
  const opts = [
    `<option value="" ${cur == null || cur === '' ? 'selected' : ''}>自动分配（按 GPU 配额选卡）</option>`,
    `<option value="-1" ${String(cur) === '-1' ? 'selected' : ''}>不绑卡</option>`,
  ];
  for (let i = 0; i <= maxIdx; i++) {
    const label = GPU_LIST_CACHE[i] ? `GPU ${i}（${GPU_LIST_CACHE[i].name}）` : `GPU ${i}`;
    opts.push(`<option value="${i}" ${String(cur) === String(i) ? 'selected' : ''}>${esc(label)}</option>`);
  }
  return opts.join('');
}

function tplForm(t = {}) {
  const opts = ['<option value="">自定义参数</option>']
    .concat(QUALITY_PRESETS_CACHE.map((p) => {
      const cur = (p.width === (+t.width || 1280) && p.height === (+t.height || 720) &&
        p.fps === (+t.fps || 30) && p.bitrateKbps === (+t.bitrate_kbps || 8000));
      return `<option value="${p.id}" ${cur ? 'selected' : ''}>${esc(p.label)} — ${esc(p.hint)}</option>`;
    })).join('');
  return `<div class="form-grid">
    <div class="full"><label>画质预设（选择后自动填入分辨率/帧率/码率）</label>
      <select id="t-preset" onchange="applyQualityPreset(this.value)">${opts}</select></div>
    <div><label>模板名称</label><input id="t-name" value="${esc(t.name || '')}" placeholder="如: 水利孪生场景"></div>
    <div><label>UE 可执行文件路径</label><input id="t-exe" value="${esc(t.exe_path || '')}"
      placeholder="D:\\pack\\MyApp\\Binaries\\Win64\\MyApp.exe"></div>
    <div class="full"><label>程序描述（StreamHub 首页展示，可选）</label><input id="t-desc" value="${esc(t.description || '')}"
      placeholder="如: 数字孪生水利场景 · 支持键鼠交互"></div>
    <div class="full"><label>额外启动参数（可选）</label><input id="t-args" value="${esc(t.args || '')}"
      placeholder="一般留空即可；分辨率/帧率由下方画质字段自动注入">
      <span class="hint">勿手写 -ResX/-ResY/-fps/-ForceRes（会被覆盖）。若 4K 仍糊，检查包内 Saved/Config/.../GameUserSettings.ini 是否锁了 720p 或 sg.ResolutionQuality=0。</span></div>
    <div><label>宽度</label><input id="t-width" type="number" value="${t.width || 1280}"></div>
    <div><label>高度</label><input id="t-height" type="number" value="${t.height || 720}"></div>
    <div><label>帧率</label><input id="t-fps" type="number" value="${t.fps || 30}"></div>
    <div><label>码率 (kbps)</label><input id="t-bitrate" type="number" value="${t.bitrate_kbps || 8000}">
      <span class="hint">4K 建议 ≥45000；只改分辨率不改码率会糊成块。</span></div>
    <div><label>音频编码</label><select id="t-audio">
      ${['auto', 'aac', 'pcma', 'none'].map((c) => `<option value="${c}" ${t.audio_codec === c ? 'selected' : ''}>${c}</option>`).join('')}
    </select></div>
    <div><label>预热实例数</label><input id="t-warm" type="number" min="0" max="10" value="${t.warm_count == null ? '' : t.warm_count}"
      placeholder="跟随全局默认">
      <span class="hint">提前启动的空闲实例数；0 = 不预热（进入时才启动，需等待）</span></div>
    <div><label>GPU 绑定</label><select id="t-gpu">${gpuBindOptions(t.gpu_index)}</select>
      <span class="hint">自动 = 按 GPU 配额挑剩余最多的卡；多卡服务器可固定到指定卡</span></div>
    <div><label>GPU 权重 (%)</label><input id="t-gpuweight" type="number" min="1" max="100" value="${t.gpu_weight || 30}">
      <span class="hint">该模板单实例的 GPU 负载估算。4090 实测 4K30≈16。所有实例权重之和超过「GPU 预算」时新会话排队，防止老流卡死</span></div>
    <div><label>编码后端</label><select id="t-encoder">
      <option value="auto" ${!t.encoder_backend || t.encoder_backend === 'auto' ? 'selected' : ''}>自动（硬件优先，失败降级软编码）</option>
      <option value="ave" ${t.encoder_backend === 'ave' ? 'selected' : ''}>仅硬件（NVENC/AMF，原行为）</option>
      <option value="ffmpeg" ${t.encoder_backend === 'ffmpeg' ? 'selected' : ''}>仅 FFmpeg（软编码 / 国产卡 VAAPI）</option>
    </select><span class="hint">默认「自动」即可：NVIDIA 走 NVENC，硬编码挂了自动降级保推流；砺算等国产卡接入后选 FFmpeg 并在系统设置配路径</span></div>
    <div><label>远程交互</label><select id="t-input">
      <option value="1" ${t.enable_input !== 0 ? 'selected' : ''}>开启（键鼠控制）</option>
      <option value="0" ${t.enable_input === 0 ? 'selected' : ''}>关闭（仅观看）</option>
    </select></div>
  </div>`;
}

function applyQualityPreset(id) {
  const p = QUALITY_PRESETS_CACHE.find((x) => x.id === id);
  if (!p) return;
  document.getElementById('t-width').value = p.width;
  document.getElementById('t-height').value = p.height;
  document.getElementById('t-fps').value = p.fps;
  document.getElementById('t-bitrate').value = p.bitrateKbps;
}

function tplRead() {
  return {
    name: document.getElementById('t-name').value.trim(),
    description: (document.getElementById('t-desc') || {}).value || '',
    exe_path: document.getElementById('t-exe').value.trim(),
    args: document.getElementById('t-args').value,
    width: +document.getElementById('t-width').value,
    height: +document.getElementById('t-height').value,
    fps: +document.getElementById('t-fps').value,
    bitrate_kbps: +document.getElementById('t-bitrate').value,
    audio_codec: document.getElementById('t-audio').value,
    enable_input: +document.getElementById('t-input').value,
    warm_count: (() => {
      const v = (document.getElementById('t-warm') || {}).value;
      return v === '' || v === undefined ? null : Math.max(0, Math.min(10, parseInt(v, 10) || 0));
    })(),
    gpu_index: (() => {
      const v = (document.getElementById('t-gpu') || {}).value;
      return v === '' || v === undefined ? null : parseInt(v, 10);
    })(),
    encoder_backend: (document.getElementById('t-encoder') || {}).value || 'auto',
    gpu_weight: (() => {
      const v = parseInt((document.getElementById('t-gpuweight') || {}).value, 10);
      return Number.isFinite(v) && v > 0 ? Math.min(100, v) : 30;
    })(),
  };
}

async function renderTemplates() {
  const d = await API.call('GET', '/api/admin/templates');
  try {
    const qp = await API.call('GET', '/api/admin/quality-presets');
    QUALITY_PRESETS_CACHE = qp.presets || [];
  } catch { QUALITY_PRESETS_CACHE = []; }
  try {
    const g = await API.call('GET', '/api/admin/gpus');
    GPU_LIST_CACHE = g.gpus || [];
    window.__gpuQuotaStr = (g.quotas || []).map((q) => `${q.index}:${q.maxInstances}`).join(',');
  } catch { GPU_LIST_CACHE = []; }
  main().innerHTML = `
  <h2 class="page">实例模板</h2>
  ${d.templates.length === 0 ? await masterHint() : ''}
  <div class="row">
    <div style="flex:2;min-width:340px">
      <div class="card"><h3>已有模板</h3><table>
        <tr><th>名称</th><th>分辨率</th><th>帧率</th><th>码率</th><th>预热</th><th>GPU</th><th>操作</th></tr>
        ${d.templates.map((t) => `<tr>
          <td>${esc(t.name)}</td><td>${t.width}x${t.height}</td><td>${t.fps}</td><td>${t.bitrate_kbps}k</td>
          <td>${t.warm_count == null ? badge('默认', 'muted') : badge(t.warm_count === 0 ? '不预热' : t.warm_count + ' 个', t.warm_count === 0 ? 'err' : 'info')}</td>
          <td>${t.gpu_index == null ? badge('自动', 'muted') : (t.gpu_index === -1 ? badge('不绑卡', 'muted') : badge('GPU ' + t.gpu_index, 'info'))}
            ${t.encoder_backend === 'ffmpeg' ? badge('FFmpeg', 'warn') : (t.encoder_backend === 'ave' ? badge('硬编', 'muted') : badge('自动', 'ok'))}</td>
          <td><button class="mini ghost" onclick="editTpl(${t.id})">编辑</button>
              <button class="mini danger" onclick="delTpl(${t.id})">删除</button></td></tr>`).join('')
          || '<tr><td colspan="7" class="hint">暂无模板，请先在右侧添加</td></tr>'}
      </table></div>
    </div>
    <div style="flex:3;min-width:340px">
      <div class="card"><h3 id="tpl-form-title">添加模板</h3>
        ${tplForm()}
        <div class="actions">
          <button id="tpl-save">保存模板</button>
          <button class="ghost" id="tpl-reset">清空</button>
        </div>
        <p class="hint">UE 打包程序须集成 StreamForge 插件（见项目 docs）。Linux 打包路径请指向 .sh 启动脚本。</p>
      </div>
    </div>
  </div>`;
  document.getElementById('tpl-save').onclick = saveTpl;
  document.getElementById('tpl-reset').onclick = renderTemplates;
}

let editingTplId = null;

/** master 模式下模板为空时提示「模板在各节点配置」 */
async function masterHint() {
  try {
    const d = await API.call('GET', '/api/admin/nodes');
    if (d.nodes) {
      return `<div class="card" style="border-color:var(--warn)"><p class="hint">
        当前为集群 master（控制面），不在本地拉实例——模板与 GPU 配额请在各 worker 节点的管理后台配置。
        节点状态见「节点管理」页。</p></div>`;
    }
  } catch { /* 非 master */ }
  return '';
}

function editTpl(id) {
  API.call('GET', '/api/admin/templates').then((d) => {
    const t = d.templates.find((x) => x.id === id);
    if (!t) return;
    editingTplId = id;
    renderTemplates().then(() => {
      document.getElementById('tpl-form-title').textContent = '编辑模板 #' + id;
      const fill = (id2, v) => { const el = document.getElementById(id2); if (el) el.value = v; };
      fill('t-name', t.name); fill('t-desc', t.description || ''); fill('t-exe', t.exe_path); fill('t-args', t.args);
      fill('t-width', t.width); fill('t-height', t.height); fill('t-fps', t.fps);
      fill('t-bitrate', t.bitrate_kbps); fill('t-audio', t.audio_codec); fill('t-input', t.enable_input);
      fill('t-warm', t.warm_count == null ? '' : t.warm_count);
      fill('t-gpu', t.gpu_index == null ? '' : String(t.gpu_index));
      fill('t-encoder', t.encoder_backend || 'auto');
      fill('t-gpuweight', t.gpu_weight || 30);
    });
  });
}

async function saveTpl() {
  const body = tplRead();
  if (!body.name || !body.exe_path) { toast('请填写名称和 UE 可执行文件路径'); return; }
  try {
    if (editingTplId) await API.call('PUT', `/api/admin/templates/${editingTplId}`, body);
    else await API.call('POST', '/api/admin/templates', body);
    editingTplId = null;
    toast('已保存');
    renderTemplates();
  } catch (e) { toast('保存失败: ' + e.message); }
}

async function delTpl(id) {
  if (!confirm('确定删除该模板？')) return;
  await API.call('DELETE', `/api/admin/templates/${id}`);
  toast('已删除');
  renderTemplates();
}

/* ---------------- 用户 ---------------- */

async function renderUsers() {
  const d = await API.call('GET', '/api/admin/users');
  main().innerHTML = `
  <h2 class="page">用户管理</h2>
  <div class="row">
    <div style="flex:2;min-width:340px"><div class="card"><h3>账号列表</h3><table>
      <tr><th>用户名</th><th>角色</th><th>状态</th><th>创建时间</th><th>操作</th></tr>
      ${d.users.map((u) => `<tr>
        <td>${esc(u.username)}</td><td>${badge(u.role, u.role === 'admin' ? 'info' : 'muted')}</td>
        <td>${u.disabled ? badge('禁用', 'err') : badge('正常', 'ok')}</td><td>${esc(u.created_at)}</td>
        <td><button class="mini ghost" onclick="resetPass(${u.id}, '${esc(u.username)}')">重置密码</button>
            ${u.disabled ? `<button class="mini ghost" onclick="toggleUser(${u.id},0)">启用</button>`
                          : `<button class="mini ghost" onclick="toggleUser(${u.id},1)">禁用</button>`}
            <button class="mini danger" onclick="delUser(${u.id}, '${esc(u.username)}')">删除</button></td>
      </tr>`).join('')}
    </table></div></div>
    <div style="flex:1;min-width:280px"><div class="card"><h3>新增用户</h3>
      <label>用户名</label><input id="u-name">
      <label>密码</label><input id="u-pass" type="password">
      <label>角色</label><select id="u-role"><option value="viewer">viewer</option><option value="admin">admin</option></select>
      <div class="actions"><button onclick="addUser()">添加</button></div>
      <p class="hint">账号仅用于后台登录；观看页默认公开（可通过反向代理加防护）。</p>
    </div></div>
  </div>`;
}

async function addUser() {
  const body = { username: document.getElementById('u-name').value.trim(), password: document.getElementById('u-pass').value, role: document.getElementById('u-role').value };
  if (!body.username || !body.password) { toast('请填写完整'); return; }
  try { await API.call('POST', '/api/admin/users', body); toast('已添加'); renderUsers(); }
  catch (e) { toast('添加失败'); }
}
function resetPass(id, name) {
  const p = prompt(`为用户 ${name} 设置新密码：`);
  if (!p) return;
  API.call('PUT', `/api/admin/users/${id}`, { password: p }).then(() => toast('已重置'));
}
function toggleUser(id, disabled) { API.call('PUT', `/api/admin/users/${id}`, { disabled }).then(() => renderUsers()); }
function delUser(id, name) {
  if (!confirm(`确定删除用户 ${name}？`)) return;
  API.call('DELETE', `/api/admin/users/${id}`).then((r) => toast(r.ok ? '已删除' : r.error)).then(renderUsers);
}

/* ---------------- 设置 ---------------- */

async function renderSettings() {
  const d = await API.call('GET', '/api/admin/settings');
  const s = d.settings, c = d.config;
  let profiles = [], currentProfile = 'lan';
  try {
    const ep = await API.call('GET', '/api/admin/env-profiles');
    profiles = ep.profiles || [];
    currentProfile = ep.current || 'lan';
  } catch { /* 老版本服务端无此接口 */ }
  main().innerHTML = `
  <h2 class="page">系统设置</h2>
  ${publicNetCard()}
  <div class="card" style="margin-bottom:14px"><h3>环境配置档（一键适配，会自动改写下方对应项）</h3>
    <div class="row">
      ${profiles.map((p) => `
        <div style="flex:1;min-width:200px;border:1px solid ${p.active ? 'var(--accent)' : 'var(--border)'};border-radius:8px;padding:12px;${p.active ? 'background:rgba(47,129,247,.15)' : ''}">
          <div style="font-weight:600">${esc(p.label)} ${p.active ? '<span style="color:var(--accent);font-size:12px">● 当前</span>' : ''}</div>
          <div class="hint" style="margin:6px 0 10px">${esc(p.hint)}</div>
          <button class="mini ${p.active ? 'ghost' : ''}" onclick="applyEnvProfile('${p.id}')">${p.active ? '重新应用' : '应用此配置档'}</button>
        </div>`).join('') || '<p class="hint">无可用配置档</p>'}
    </div>
  </div>
  <div class="row">
    <div style="flex:1;min-width:300px"><div class="card"><h3>调度</h3>
      <label>最大并发实例数</label><input id="s-max" type="number" value="${s.maxInstances}">
      <label>GPU 负载预算 (%)</label><input id="s-gpubudget" type="number" min="10" max="100" value="${s.gpuBudget ?? 90}">
      <span class="hint">所有存活实例的「GPU 权重」之和超过此值时，新会话自动排队——防止 GPU 超卖把在播的流拖卡（4090 建议 90）</span>
      <label>冷启动间隔（秒）</label><input id="s-spawngap" type="number" min="0" max="60" value="${s.spawnIntervalSec ?? 6}">
      <span class="hint">两次实例启动的最小间隔，错开 GPU 冷启动尖峰</span>
      <label>过载帧率下限 (fps)</label><input id="s-overloadfloor" type="number" min="0" max="60" value="${s.overloadFpsFloor ?? 25}">
      <span class="hint">运行中实例平均帧率跌破此值即判定 GPU 过载，直接拒绝新流并提示（默认 25），已运行流不受影响；设 0 关闭该保护</span>
      <label>默认预热数（模板未单独设置时）</label><input id="s-warm" type="number" value="${s.warmCount}">
      <label>实例空闲回收（秒）</label><input id="s-idle" type="number" value="${s.idleTimeout}">
      <label style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input id="s-offscreen" type="checkbox" ${String(s.renderOffscreen) === '1' ? 'checked' : ''} style="width:auto">
        实例默认离屏渲染（-RenderOffScreen，云端推荐开启）
      </label>
      <label>会话超时强制释放（分钟，0=不限制）</label><input id="s-sesstimeout" type="number" step="0.5" value="${s.sessionTimeoutMin ?? 30}">
      <label>待命降载帧率（空闲实例 fps）</label><input id="s-stbyfps" type="number" value="${s.standbyFps ?? 5}">
      <label>待命降载码率（kbps）</label><input id="s-stbybr" type="number" value="${s.standbyBitrateKbps ?? 500}">
      <label style="display:flex;align-items:center;gap:8px;margin-top:4px">
        <input id="s-adaptive" type="checkbox" ${String(s.adaptiveEnabled) === '1' ? 'checked' : ''} style="width:auto">
        浏览器自适应降档（丢包/延迟自动降码率，公网/弱网推荐开启）
      </label>
      <div class="actions"><button onclick="saveSettings()">保存</button></div>
    </div></div>
    <div style="flex:1;min-width:300px"><div class="card"><h3>编码与国产化适配（高级）</h3>
      <label>FFmpeg 路径（编码后端 = FFmpeg 时使用）</label>
      <input id="s-ffmpeg" value="${esc(s.ffmpegPath || 'ffmpeg')}" placeholder="ffmpeg 或绝对路径">
      <span class="hint">软编码兜底用系统 ffmpeg 即可；接入砺算/摩尔线程硬编码时换成厂商定制版（VAAPI/DXVA）</span>
      <label>Linux 绑卡环境变量（逗号分隔）</label>
      <input id="s-bindenv" value="${esc(s.gpuBindEnvVars || '')}" placeholder="CUDA_VISIBLE_DEVICES,NVIDIA_VISIBLE_DEVICES">
      <span class="hint">NVIDIA 默认两项；摩尔线程加 MUSA_VISIBLE_DEVICES；砺算变量待厂商确认后追加，无需改代码</span>
      <label>自定义 GPU 探测命令（JSON，可留空）</label>
      <input id="s-probecmd" value="${esc(s.gpuProbeCmd || '')}" placeholder='{"cmd":"厂商CLI","args":["--query-gpu=index,name,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu","--format=csv,noheader,nounits"]}'>
      <span class="hint">砺算等国产卡监控 CLI 就绪后配置此项（CSV 格式兼容 nvidia-smi 即可），后台 GPU 监控页直接生效</span>
      <div class="actions"><button onclick="saveSettings()">保存</button></div>
    </div></div>
    <div style="flex:1;min-width:300px"><div class="card"><h3>当前环境（只读，由 .env 配置）</h3>
      <table>
        <tr><td>服务地址</td><td>${esc(c.publicHost)}:${c.port}</td></tr>
        <tr><td>WHEP 播放</td><td>${esc(c.whepBase)}/zslive/&lt;instanceId&gt;/whep</td></tr>
        <tr><td>RTMP 推流</td><td>${esc(c.rtmpBase)}/zslive/&lt;instanceId&gt;</td></tr>
        <tr><td>MediaMTX API</td><td>${esc(c.mediamtxApi)}</td></tr>
      </table>
      <p class="hint">修改端口/主机请编辑 server/.env 后重启服务。</p>
    </div></div>
  </div>`;
}

async function applyEnvProfile(id) {
  const r = await API.call('POST', '/api/admin/env-profiles/apply', { id });
  if (r && r.ok) {
    toast('已应用配置档：' + Object.entries(r.applied || {}).map(([k, v]) => `${k}=${v}`).join('，'));
    if (r.needTurn && r.turnHint) setTimeout(() => alert(r.turnHint), 300);
    renderSettings();
  }
}

/* 公网接入检测卡片（公网部署 WebRTC 穿透指引） */
function publicNetCard() {
  return `<div class="card" style="margin-bottom:14px"><h3>公网接入检测（公网部署必看）</h3>
    <p class="hint" style="margin-top:0">公网访问需配置 STUN/TURN（WebRTC NAT 穿透）并放行 UDP 端口。
    点击检测自动生成 MediaMTX ICE 配置与 coturn 启动命令。</p>
    <div class="actions" style="margin-top:8px">
      <button onclick="checkPublicNet()">开始检测</button>
    </div>
    <div id="pubnet-result"></div>
  </div>`;
}

async function checkPublicNet() {
  const el = document.getElementById('pubnet-result');
  el.innerHTML = '<p class="hint">探测出口公网 IP 中…</p>';
  const d = await API.call('GET', '/api/admin/public-net?force=1');
  if (!d.publicIp) {
    el.innerHTML = `<p class="hint" style="color:var(--err)">${esc(d.error || '探测失败')}</p>`;
    return;
  }
  el.innerHTML = `
    <div style="margin-top:10px">
      <table style="margin-bottom:10px">
        <tr><td style="width:160px">出口公网 IP</td><td style="font-family:Consolas">${esc(d.publicIp)}</td></tr>
        <tr><td>当前 PUBLIC_HOST</td><td style="font-family:Consolas">${esc(d.currentPublicHost)} ${d.hostMatches
          ? badge('一致', 'ok') : badge('不一致（公网部署需修改 .env 后重启）', 'warn')}</td></tr>
      </table>
      <p class="hint" style="margin:8px 0 4px;font-weight:600">检查清单</p>
      ${d.checklist.map((c) => `<div class="hint" style="margin:2px 0">${c.ok ? '✅' : '⬜'} ${esc(c.text)}</div>`).join('')}
      <p class="hint" style="margin:12px 0 4px;font-weight:600">① 启动 TURN 服务器（复制执行）</p>
      <textarea readonly style="width:100%;min-height:84px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px;font-size:12px;font-family:Consolas">${esc(d.coturnCommand)}</textarea>
      <p class="hint" style="margin:12px 0 4px;font-weight:600">② MediaMTX ICE 配置（追加到 mediamtx/mediamtx.yml 末尾，重启 MediaMTX）</p>
      <textarea readonly style="width:100%;min-height:96px;background:var(--panel2);border:1px solid var(--border);border-radius:6px;color:var(--text);padding:8px;font-size:12px;font-family:Consolas">${esc(d.stunTurnYaml)}</textarea>
      <p class="hint" style="margin-top:10px">${esc(d.vpnHint)}</p>
    </div>`;
}

async function saveSettings() {
  await API.call('PUT', '/api/admin/settings', {
    maxInstances: +document.getElementById('s-max').value,
    gpuBudget: +document.getElementById('s-gpubudget').value,
    spawnIntervalSec: +document.getElementById('s-spawngap').value,
    overloadFpsFloor: +document.getElementById('s-overloadfloor').value,
    warmCount: +document.getElementById('s-warm').value,
    idleTimeout: +document.getElementById('s-idle').value,
    renderOffscreen: document.getElementById('s-offscreen').checked ? 1 : 0,
    sessionTimeoutMin: +document.getElementById('s-sesstimeout').value,
    standbyFps: +document.getElementById('s-stbyfps').value,
    standbyBitrateKbps: +document.getElementById('s-stbybr').value,
    adaptiveEnabled: document.getElementById('s-adaptive').checked ? 1 : 0,
    ffmpegPath: document.getElementById('s-ffmpeg').value.trim() || 'ffmpeg',
    gpuBindEnvVars: document.getElementById('s-bindenv').value.trim(),
    gpuProbeCmd: document.getElementById('s-probecmd').value.trim(),
  });
  toast('已保存');
}

/* ---------------- 启动 ---------------- */
if (API.token) enter();
