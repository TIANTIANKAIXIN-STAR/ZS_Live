// 实证：4K x264 zerolatency 下一个 AU 的 NALU 数量（MediaMTX 上限 25）
const { spawn } = require('child_process');

const W = 3840, H = 2160, FPS = 30;
const frameBytes = W * H * 4;

function makeFrame(seed) {
  const buf = Buffer.alloc(frameBytes);
  for (let i = 0; i < frameBytes; i += 4) {
    buf[i] = (i / 4 + seed) % 256;
    buf[i + 1] = (i / 4096 + seed * 3) % 256;
    buf[i + 2] = 128;
    buf[i + 3] = 255;
  }
  return buf;
}

const encoderSegIdx = process.argv.indexOf('--seg');
const seg = encoderSegIdx > 0
  ? process.argv[encoderSegIdx + 1]
  : '-c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p -profile:v baseline -b:v 28000k -maxrate 28000k -bufsize 56000k -g 120 -bf 0 -sc_threshold 0 -x264-params repeat-headers=1';

const args = [
  '-hide_banner', '-loglevel', 'error',
  '-f', 'rawvideo', '-pix_fmt', 'bgra', '-s', `${W}x${H}`, '-r', String(FPS), '-i', 'pipe:0',
  '-an', '-sn', '-dn', ...seg.split(' '),
  '-bsf:v', 'h264_metadata=aud=insert', '-f', 'h264', 'pipe:1',
];
console.log('CMD: ffmpeg', args.join(' '));

const ff = spawn('F:/streamming/ZS_Live/ffmpeg/ffmpeg.exe', args);
const t0 = Date.now();
let out = [];
ff.stdout.on('data', (c) => {
  out.push(c);
  const total = out.reduce((s, b) => s + b.length, 0);
  if (total > 4 * 1024 * 1024) ff.stdin.end(); // 够分析了
});
ff.stderr.on('data', (c) => process.stderr.write(c));
ff.on('exit', () => {
  const buf = Buffer.concat(out);
  console.log('elapsed', Date.now() - t0, 'ms, out bytes', buf.length);
  // 切 NAL
  const nalus = [];
  let i = 0;
  const scLen = (p) => (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 0 && buf[p + 3] === 1) ? 4
    : (buf[p] === 0 && buf[p + 1] === 0 && buf[p + 2] === 1) ? 3 : 0;
  while (i < buf.length - 4 && nalus.length < 400) {
    const sc = scLen(i);
    if (!sc) { i++; continue; }
    let next = i + sc;
    while (next < buf.length - 4 && !scLen(next)) next++;
    nalus.push({ type: buf[i + sc] & 0x1f, len: next - i - sc });
    i = next;
  }
  // 按 AUD 分 AU
  let au = [], aus = [];
  for (const n of nalus) {
    if (n.type === 9) { if (au.length) aus.push(au); au = []; }
    else au.push(n);
  }
  if (au.length) aus.push(au);
  console.log('AU count:', aus.length);
  aus.slice(0, 4).forEach((a, idx) => {
    console.log(`AU#${idx}: ${a.length} NALUs ->`, a.map((n) => `t${n.type}(${n.len})`).slice(0, 32).join(' '));
  });
  process.exit(0);
});

// 喂 50 帧（4K 编码慢，喂够出前几个 AU 就行）
let sent = 0;
const frame = makeFrame(1);
const frame2 = makeFrame(77);
function feed() {
  while (sent < 50) {
    const ok = ff.stdin.write(sent % 2 ? frame : frame2);
    sent++;
    if (!ok) { ff.stdin.once('drain', feed); return; }
  }
}
feed();
setTimeout(() => { try { ff.stdin.end(); } catch (e) {} }, 30000);
