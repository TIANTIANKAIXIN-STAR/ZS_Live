'use strict';
/**
 * 推流画质预设：分辨率 + 帧率 + 码率建议值（H264/NVENC）
 * 管理后台模板表单快捷填充用；用户改成非预设组合即视为"自定义"
 */

const QUALITY_PRESETS = [
  {
    id: '720p30',
    label: '720p · 30fps · 4Mbps',
    hint: '轻量场景 / 多路并发，最省资源',
    width: 1280, height: 720, fps: 30, bitrateKbps: 4000,
  },
  {
    id: '1080p30',
    label: '1080p · 30fps · 8Mbps',
    hint: '省带宽，复杂场景更稳',
    width: 1920, height: 1080, fps: 30, bitrateKbps: 8000,
  },
  {
    id: '1080p60',
    label: '1080p · 60fps · 16Mbps',
    hint: '推荐默认，流畅与画质平衡',
    width: 1920, height: 1080, fps: 60, bitrateKbps: 16000,
  },
  {
    id: '2k60',
    label: '2K · 60fps · 28Mbps',
    hint: '2K 高刷，需较强 GPU',
    width: 2560, height: 1440, fps: 60, bitrateKbps: 28000,
  },
  {
    id: '4k30',
    label: '4K · 30fps · 28Mbps',
    hint: '推荐 4K：清晰且更稳（60fps 易卡顿）',
    width: 3840, height: 2160, fps: 30, bitrateKbps: 28000,
  },
  {
    id: '4k60',
    label: '4K · 60fps · 35Mbps',
    hint: '旗舰高刷，仅强局域网；卡顿请改用 4K30',
    width: 3840, height: 2160, fps: 60, bitrateKbps: 35000,
  },
];

const BY_ID = new Map(QUALITY_PRESETS.map((p) => [p.id, p]));

function getQualityPreset(id) {
  return BY_ID.get(String(id || '').trim()) || null;
}

/** 根据模板参数反推匹配的预设 id；无匹配返回 'custom' */
function detectQualityPresetId(t) {
  for (const p of QUALITY_PRESETS) {
    if (p.width === +t.width && p.height === +t.height &&
        p.fps === +t.fps && p.bitrateKbps === +t.bitrate_kbps) {
      return p.id;
    }
  }
  return 'custom';
}

function listQualityPresets() {
  return QUALITY_PRESETS.map((p) => ({ ...p, bitrateMbps: Math.round(p.bitrateKbps / 100) / 10 }));
}

module.exports = { QUALITY_PRESETS, getQualityPreset, detectQualityPresetId, listQualityPresets };
