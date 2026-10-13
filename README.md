# ZS_Live

云渲染 / 实时推流平台 —— 基于 **Unreal Engine + WebRTC(WHEP) + MediaMTX** 的低延迟
云游戏 / 云推流解决方案。非 Pixel Streaming 方案，自研调度与控制通道。

核心能力：
- GPU 权重准入调度（防止单卡超卖）
- NVENC 硬编码（4K@30/60 低延迟）
- 按需关键帧（切换前台标签瞬时恢复，无卡顿）
- 过载拒绝闸（平均帧率过低时拒绝新流，不影响已运行流）
- 冷启动串行化 + 实例预热池

## ⚠️ 源代码可见，非开源 (Source-Available, NOT Open Source)

本仓库用于**技术展示与评估**。版权所有 © 2026 **Liu Huaxi (刘华西)**，个人所有。

- 详见 [LICENSE](./LICENSE)
- **禁止**：商用、部署对外提供服务、再分发、去除版权/商标声明
- 你拥有的权利仅限于：查看、学习、内部评估

如果你有商业合作或授权需求，请通过仓库主页联系作者。

## 架构概览

```
浏览器 (WHEP/WebRTC 播放)
        │
        ▼
MediaMTX (RTMP 收流 / WebRTC 分发)
        ▲
        │ RTMP 推流
Unreal Engine 实例 (StreamForge 插件, NVENC 硬编码)
        ▲
        │ 控制通道 (命令透传)
调度服务 (Node.js: 实例池 / GPU 准入 / 过载闸)
```

## 商标

**ZS_Live™** 为 Liu Huaxi 个人所有，未经书面许可不得使用。

## 许可证

见 [LICENSE](./LICENSE)。**本仓库不是开源项目**，仅以源代码可见方式提供。
