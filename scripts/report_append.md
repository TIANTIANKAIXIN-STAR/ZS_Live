
---

## 七、阶段①实施完成记录（2026-10-12，已上线并通过 e2e）

目标卡已定为**砺算 LX 系列**。在卡未到货前，所有「不依赖卡」的准备已完成：

### 已完成（服务端）
- **gpuProbe.js（新）**：多厂商 GPU 探测链 nvidia-smi → 自定义厂商命令 → vulkaninfo 兜底；探测顺序可在系统设置 `gpuProbeOrder` 配置（砺算卡到货后填其 CLI 即可接入）
- **绑卡环境变量多厂商化**：`gpuBindEnvVars` 设置项可改（默认 CUDA_VISIBLE_DEVICES,NVIDIA_VISIBLE_DEVICES），按厂商适配
- **模板新增两列**：`encoder_backend`（ave/ffmpeg/auto，默认 ave=行为不变）+ `codec`（h264/hevc 预留）
- **系统设置新增「编码与国产化适配」卡片**：ffmpegPath、gpuProbeOrder、gpuBindEnvVars

### 已完成（UE 插件 StreamForge）
- **编码后端抽象** + 新命令行 `-SFEncoder=ave|ffmpeg|auto`、`-SFCodec`、`-SFFFmpegPath`
- **SFFmpegEncoder（新）**：GPU readback → ffmpeg stdin 裸流 → libx264 软编码 → Annex-B 分包 → 复用现有 RTMP 推送。改编码参数即接砺算 VAAPI/DXVA
- **auto 模式**：优先 NVENC/AMF 硬编码，失败自动降级 FFmpeg 软编码（9-29 那种「15 连跪全灭」不会再发生）
- ave 默认路径**一行未动**，NVIDIA 现状完全保留

### e2e 验证结果（本机 4090）
| 模板 | 后端 | 结果 |
|------|------|------|
| 模板3 720p30 | ffmpeg（libx264 软编码） | ✅ 10s 推流成功，码率正常 |
| 模板2 4K30 | auto → NVENC 硬编码 | ✅ 15s 推流成功，4K 码率正常 |

### 砺算卡到货后只剩三件事（阶段②）
1. 向砺算确认：H.264 硬编码有无、Linux VAAPI/Windows DXVA 接口、编码并发路数
2. SFFmpegEncoder 增加砺算编码参数分支（h264_vaapi / 厂商 SDK），约 1~2 周
3. 系统设置 `gpuProbeOrder` 填入砺算管理 CLI，监控/调度即接入

### 注意事项
- 新插件已编译并部署到 **UEtest 包**（Package/Windows/UEtest/Binaries/Win64/UEtest.exe）
- **J002 模板（E:\UPROJECT\J002）仍是旧插件**：要用软编码兜底/砺算后端，需对 J002 工程重新打包
- 软编码性能边界：libx264 720p30 轻松；1080p60 单实例约占 4~6 核；4K 软编码不现实（4K 场景必须硬编码，这正是砺算卡的价值）
