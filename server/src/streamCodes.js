'use strict';
/**
 * ZS Live 平台统一消息码（成功 / 提示 / 错误）
 * HTTP API、WebSocket 下行消息、embed postMessage 共用。
 *
 * 码段规划（与 ZS_Streaming 同族，便于业务方迁移）：
 *   ZS_CFG_1xxx  配置/模板错误
 *   ZS_POOL_2xxx 实例池（错误/排队原因）
 *   ZS_WS_3xxx   控制通道（WebSocket）错误
 *   ZS_RTC_4xxx  媒体（WHEP/WebRTC）错误
 *   ZS_UI_5xxx   浏览器/播放错误
 *   ZS_API_6xxx  HTTP API 错误
 *   ZS_INFO_7xxx 流程提示
 *   ZS_OK_8xxx   成功
 */

/** @type {Record<string, {level:string, message:string, detail:string, hint:string, recoverable?:boolean, httpStatus?:number}>} */
const STREAM_CODES = {
  // ── 配置 / 模板 ─────────────────────────────────────────────
  ZS_CFG_1001: {
    level: 'error', message: 'UE 可执行文件路径未配置',
    detail: '实例模板中未填写 UE 可执行文件路径',
    hint: '在管理后台「实例模板」填写 UE 打包后的 .exe / .sh 路径并保存',
    recoverable: false, httpStatus: 503,
  },
  ZS_CFG_1002: {
    level: 'error', message: 'UE 可执行文件不存在',
    detail: '模板中配置的路径在服务器磁盘上找不到',
    hint: '确认 UE 已打包、路径正确，且运行调度服务的账号有读取权限',
    recoverable: false, httpStatus: 503,
  },
  ZS_CFG_1003: {
    level: 'error', message: '实例模板不存在',
    detail: '请求的 template 在数据库中不存在',
    hint: '检查 embed URL / 播放页的 template 参数是否与管理后台模板 ID 一致',
    recoverable: false, httpStatus: 404,
  },
  ZS_CFG_1004: {
    level: 'error', message: '尚未配置任何实例模板',
    detail: '模板表为空，无法分配实例',
    hint: '先在管理后台「实例模板」添加至少一个模板',
    recoverable: false, httpStatus: 503,
  },

  // ── 实例池 ─────────────────────────────────────────────────
  ZS_POOL_2001: {
    level: 'info', message: '当前无可用实例，已进入排队',
    detail: '实例池暂无空闲 READY 实例，可能正在预热或等待其它用户释放',
    hint: '稍候自动补位；若长时间排队请检查管理后台实例列表与预热数配置',
    recoverable: true,
  },
  ZS_POOL_2002: {
    level: 'info', message: '实例正在启动中',
    detail: 'UE 进程已拉起，尚未完成渲染引擎初始化',
    hint: '首次冷启动约需 20~60 秒，属正常现象',
    recoverable: true,
  },
  ZS_POOL_2003: {
    level: 'error', message: 'UE 进程启动失败',
    detail: 'spawn 子进程报错（权限、依赖、路径等）',
    hint: '查看调度服务日志 [Pool] 条目；在服务器上手动运行该 exe 验证',
    recoverable: false, httpStatus: 503,
  },
  ZS_POOL_2004: {
    level: 'error', message: 'UE 进程异常退出',
    detail: '推流过程中 UE 进程退出',
    hint: '系统会自动尝试切换新实例；查看 UE 日志与调度服务 [Pool] 实例退出记录',
    recoverable: true,
  },
  ZS_POOL_2005: {
    level: 'info', message: '已达实例总数上限',
    detail: '活跃实例数已达到 maxInstances 上限',
    hint: '在管理后台「系统设置」调整实例上限，或等待其它用户断开',
    recoverable: true,
  },
  ZS_POOL_2006: {
    level: 'info', message: 'GPU 配额已满',
    detail: '所有 GPU 的实例配额均已占满，暂无法再启动新实例',
    hint: '会话自动转入排队；可在管理后台「GPU 监控」调整每卡配额',
    recoverable: true,
  },
  ZS_POOL_2007: {
    level: 'warn', message: 'GPU 负载过高，已拒绝新流',
    detail: '运行中实例平均帧率 {avgFps}fps 已低于下限 {floor}fps（当前 {count} 路），继续增加会拖垮已运行的流',
    hint: '请先关闭部分推流页面，等帧率回升后再开新流；可在系统设置调整「过载帧率下限」',
    recoverable: true, httpStatus: 409,
  },

  // ── 控制通道（WebSocket）─────────────────────────────────────
  ZS_WS_3001: {
    level: 'error', message: '无法连接调度服务',
    detail: '浏览器无法建立到 /ws 的 WebSocket',
    hint: '确认调度服务已启动、baseUrl 正确、防火墙未拦截服务端口',
    recoverable: false,
  },
  ZS_WS_3002: {
    level: 'error', message: '控制通道已断开',
    detail: 'WebSocket 在推流完成前被关闭',
    hint: '客户端会自动重连；检查服务是否重启、网络是否中断',
    recoverable: true,
  },
  ZS_WS_3003: {
    level: 'error', message: '会话已结束',
    detail: '会话被服务端终止（超时 / 管理员操作 / 实例回收）',
    hint: '刷新页面或重新发起会话',
    recoverable: true,
  },

  // ── 媒体（WHEP / WebRTC）─────────────────────────────────────
  ZS_RTC_4001: {
    level: 'error', message: 'ICE 连接失败',
    detail: 'WebRTC 连通性检查失败',
    hint: '外网访问需配置 TURN 并放行 UDP；局域网检查防火墙与 MediaMTX 端口',
    recoverable: false,
  },
  ZS_RTC_4002: {
    level: 'error', message: 'WHEP 连接失败',
    detail: '向 MediaMTX 发起 WHEP 协商返回非 2xx',
    hint: '确认 MediaMTX 已启动且 WebRTC 端口可达；确认实例 RTMP 推流正常',
    recoverable: false,
  },
  ZS_RTC_4003: {
    level: 'error', message: '媒体连接中断',
    detail: '已建立的 WebRTC 连接进入 failed 状态',
    hint: '客户端会自动重连；若反复出现请检查网络质量',
    recoverable: true,
  },

  // ── 浏览器 / 播放 ────────────────────────────────────────────
  ZS_UI_5001: {
    level: 'error', message: '视频自动播放被阻止',
    detail: '浏览器 Autoplay Policy 阻止了带声播放',
    hint: '提示用户点击「开启声音」按钮（需真实用户手势）',
    recoverable: true,
  },

  // ── HTTP API 错误 ────────────────────────────────────────────
  ZS_API_6001: {
    level: 'error', message: '接口请求失败',
    detail: '服务端处理 API 时发生未预期错误',
    hint: '查看调度服务日志对应条目',
    recoverable: false, httpStatus: 500,
  },

  // ── 流程提示（info）──────────────────────────────────────────
  ZS_INFO_7001: {
    level: 'info', message: '已进入排队',
    detail: '暂无空闲实例，已加入等待队列',
    hint: '排队位置变化时会收到 queue_update；轮到时会收到 assigned',
    recoverable: true,
  },
  ZS_INFO_7002: {
    level: 'info', message: '排队位置已更新',
    detail: '队列排位或预估等待时间发生变化',
    hint: '可在 UI 展示 position / estimatedWait',
    recoverable: true,
  },
  ZS_INFO_7003: {
    level: 'info', message: '正在连接调度服务',
    detail: '浏览器正在申请会话并建立控制通道',
    hint: '正常连接过程，请稍候',
    recoverable: true,
  },
  ZS_INFO_7004: {
    level: 'info', message: '正在连接媒体流',
    detail: '实例已分配，正在与 MediaMTX 进行 WHEP 协商',
    hint: '冷启动或网络较慢时可能需数十秒',
    recoverable: true,
  },

  // ── 成功 ───────────────────────────────────────────────────
  ZS_OK_8001: {
    level: 'success', message: '控制通道已连接',
    detail: 'WebSocket 已建立，会话令牌校验通过',
    hint: '接下来将分配 / 等待实例',
    recoverable: true,
  },
  ZS_OK_8002: {
    level: 'success', message: '实例已分配',
    detail: '已从实例池分配实例，等待 UE agent 就绪',
    hint: '收到 ready 后即可开始 WHEP 拉流',
    recoverable: true,
  },
  ZS_OK_8003: {
    level: 'success', message: 'UE 实例已就绪',
    detail: 'UE agent 已接入（hello），RTMP 推流已建立',
    hint: '即将开始 WHEP 拉流渲染画面',
    recoverable: true,
  },
  ZS_OK_8004: {
    level: 'success', message: '排队完成，实例已分配',
    detail: '排队轮到自己，实例已绑定会话',
    hint: '无需用户操作，客户端会自动继续',
    recoverable: true,
  },
  ZS_OK_8005: {
    level: 'success', message: '视频推流已开始',
    detail: 'WHEP 媒体通道已建立，画面正在播放',
    hint: 'inputready 后可发业务指令',
    recoverable: true,
  },
  ZS_OK_8006: {
    level: 'success', message: '数据通道已就绪',
    detail: '可向 UE 发送 command / input 等指令',
    hint: '请在 inputready 后再调用业务 API',
    recoverable: true,
  },
  ZS_OK_8007: {
    level: 'success', message: '会话已正常结束',
    detail: '用户主动断开或正常释放',
    hint: '可清理 UI 或引导用户重新连接',
    recoverable: true,
  },

  // ── HTTP API 成功 ────────────────────────────────────────────
  ZS_OK_8101: {
    level: 'success', message: '程序列表获取成功',
    detail: '返回实例模板及实时池余量、嵌入信息',
    hint: 'programs[].id 用作播放页 / embed 的 template 参数',
    recoverable: true,
  },
  ZS_OK_8102: {
    level: 'success', message: '嵌入信息获取成功',
    detail: '返回 embedUrl、parentSdkUrl 等集成字段',
    hint: '可直接用于 iframe 或 ZsLive.mount',
    recoverable: true,
  },
  ZS_OK_8103: {
    level: 'success', message: '消息码表获取成功',
    detail: '返回平台全部 stream code 定义',
    hint: '前端可缓存 codes 数组用于文案映射',
    recoverable: true,
  },
};

/** 打包平台消息（仅 code / level / message，供 WS 与 embed postMessage） */
function packPlatformMessage(meta) {
  const code = String(meta.code || 'ZS_UNKNOWN');
  const def = STREAM_CODES[code] || {};
  return {
    code,
    level: meta.level || def.level || 'error',
    message: String(meta.message || def.message || code),
  };
}

/** 生成完整码对象（含 detail / hint / recoverable） */
function makeStreamCode(code, extra = {}) {
  const def = STREAM_CODES[code] || { level: 'error', message: '未知消息', recoverable: false };
  return {
    ...packPlatformMessage({ code, level: extra.level ?? def.level, message: extra.message ?? def.message }),
    detail: extra.detail ?? def.detail ?? '',
    hint: extra.hint ?? def.hint ?? '',
    recoverable: extra.recoverable ?? def.recoverable ?? false,
  };
}

/** HTTP API 成功响应 */
function formatApiSuccess(code, data = {}, extra = {}) {
  const { recoverable, ...platform } = makeStreamCode(code, extra);
  return { ok: true, success: true, ...platform, ...data };
}

/** HTTP API 错误响应（附带 httpStatus 供路由层取用） */
function formatApiError(code, extra = {}) {
  const meta = makeStreamCode(code, extra);
  const { recoverable, ...platform } = meta;
  const def = STREAM_CODES[code];
  return { ok: false, success: false, ...platform, httpStatus: def && def.httpStatus };
}

function mapCodeEntry([code, v]) {
  return {
    code, level: v.level, message: v.message,
    detail: v.detail, hint: v.hint,
    recoverable: v.recoverable ?? null,
    httpStatus: v.httpStatus ?? null,
  };
}

const listStreamCodes = () => Object.entries(STREAM_CODES).map(mapCodeEntry);
const listErrorCodes = () => listStreamCodes().filter((c) => c.level === 'error');

module.exports = {
  STREAM_CODES,
  packPlatformMessage,
  makeStreamCode,
  formatApiSuccess,
  formatApiError,
  listStreamCodes,
  listErrorCodes,
};
