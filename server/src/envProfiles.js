'use strict';
/**
 * 环境配置档：本机 / 局域网 / 公网 / 弱网 —— 一键把全局设置调到该环境推荐值。
 * 只改 settings 表里的行为键，不动模板（模板是程序级配置）。
 * adaptiveEnabled 由播放器自适应降档（B组3）消费；公网/弱网额外返回 TURN 配置提示。
 */

const ENV_PROFILES = [
  {
    id: 'local',
    label: '本机直连',
    hint: '开发调试：不限会话时长，待命少降载，画质优先',
    settings: {
      sessionTimeoutMin: 0,
      standbyFps: 2,
      standbyBitrateKbps: 1000,
      adaptiveEnabled: 0,
    },
  },
  {
    id: 'lan',
    label: '局域网（推荐）',
    hint: '内网用户：30 分钟会话超时，待命 5fps/500kbps',
    recommended: true,
    settings: {
      sessionTimeoutMin: 30,
      standbyFps: 1,
      standbyBitrateKbps: 500,
      adaptiveEnabled: 0,
    },
  },
  {
    id: 'public',
    label: '公网访问',
    hint: '20 分钟超时 + 开启浏览器自适应降档；需在 mediamtx.yml 配置 TURN',
    settings: {
      sessionTimeoutMin: 20,
      standbyFps: 1,
      standbyBitrateKbps: 300,
      adaptiveEnabled: 1,
    },
    needTurn: true,
  },
  {
    id: 'weak_net',
    label: '弱网 / 高延迟',
    hint: '15 分钟超时 + 激进自适应降档，保流畅不卡死',
    settings: {
      sessionTimeoutMin: 15,
      standbyFps: 1,
      standbyBitrateKbps: 300,
      adaptiveEnabled: 1,
    },
    needTurn: true,
  },
];

const BY_ID = new Map(ENV_PROFILES.map((p) => [p.id, p]));

function getEnvProfile(id) {
  return BY_ID.get(String(id || '').trim()) || null;
}

function listEnvProfiles(currentId) {
  return ENV_PROFILES.map(({ id, label, hint, recommended, settings, needTurn }) => ({
    id, label, hint,
    recommended: Boolean(recommended),
    settings,
    needTurn: Boolean(needTurn),
    active: id === currentId,
  }));
}

module.exports = { ENV_PROFILES, getEnvProfile, listEnvProfiles };
