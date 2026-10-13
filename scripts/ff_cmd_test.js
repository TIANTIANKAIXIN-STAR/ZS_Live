// 离线验证：生成 BGRA 测试帧 → 走平台同款 ffmpeg 命令 → 检查输出是否有 AUD 分隔的完整 AU
const { spawn } = require('child_process');
const fs = require('fs');

const W = 1280, H = 720, FPS = 30, SECONDS = 2, KBPS = 4000;
const GOP = FPS * 2;
const FF = 'F:/streamming/ZS_Live/ffmpeg/ffmpeg.exe';

const encoderSeg = `-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -b:v ${KBPS}k -maxrate ${KBPS}k -bufsize ${KBPS * 2}k -g ${GOP} -bf 0 -sc_threshold 0 -x264-params repeat-headers=1`;
const params = `-hide_banner -loglevel error -f rawvideo -pix_fmt bgra -s ${W}x${H} -r ${FPS} -i pipe:0 -an -sn -dn ${encoderSeg} -bsf:v h264_metadata=aud=insert -f h264 pipe:1`;
console.log('CMD:', FF, params);

const proc = spawn(FF, params.split(' '), { stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
proc.stderr.on('data', (d) => { stderr += d; });

const chunks = [];
proc.stdout.on('data', (d) => chunks.push(d));
proc.on('exit', (code) => {
  const out = Buffer.concat(chunks);
  console.log('EXIT:', code, 'stderr:', stderr.trim() || '(none)');
  console.log('OUTPUT_BYTES:', out.length);
  // 统计 NAL 类型分布
  const nalTypes = {};
  let auCount = 0, idrCount = 0, spsCount = 0;
  for (let i = 0; i < out.length - 4; i++) {
    if (out[i] === 0 && out[i + 1] === 0 && ((out[i + 2] === 1) || (out[i + 2] === 0 && out[i + 3] === 1))) {
      const sc = out[i + 2] === 1 ? 3 : 4;
      const nalType = out[i + sc] & 0x1F;
      nalTypes[nalType] = (nalTypes[nalType] || 0) + 1;
      if (nalType === 9) auCount++;
      if (nalType === 5) idrCount++;
      if (nalType === 7) spsCount++;
      i += sc;
    }
  }
  console.log('NAL_TYPES:', JSON.stringify(nalTypes));
  console.log('AUD(AU边界):', auCount, ' IDR(关键帧):', idrCount, ' SPS:', spsCount);
  const expectFrames = FPS * SECONDS;
  console.log('EXPECT_FRAMES:', expectFrames, '=> AU 数与帧数', auCount >= expectFrames - 1 ? '匹配 OK' : '不匹配 FAIL');
  console.log(auCount >= expectFrames - 1 && idrCount >= 1 && spsCount >= 1 ? 'FFMPEG_CMD_VERIFIED' : 'VERIFY_FAILED');
});

// 生成渐变 BGRA 帧写入 stdin
const frame = Buffer.alloc(W * H * 4);
let n = 0;
const total = FPS * SECONDS;
function writeFrame() {
  if (n >= total) { proc.stdin.end(); return; }
  const v = (n * 4) & 0xFF;
  for (let y = 0; y < H; y += 8) {
    for (let x = 0; x < W; x += 8) {
      const idx = (y * W + x) * 4;
      frame[idx] = (x + v) & 0xFF; frame[idx + 1] = (y + v) & 0xFF; frame[idx + 2] = v; frame[idx + 3] = 255;
    }
  }
  n++;
  if (!proc.stdin.write(frame)) proc.stdin.once('drain', writeFrame);
  else writeFrame();
}
writeFrame();
