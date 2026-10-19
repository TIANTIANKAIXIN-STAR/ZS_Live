# StreamForge — UE 推流与控制插件

`StreamForge` 是 ZS_Live 直播平台的 Unreal Engine 端推流与控制插件。它把 UE 渲染画面以**低延迟**方式推到流媒体服务器，并提供一个浏览器 ↔ UE 的**双向控制通道**。

本目录包含**完整源码**（接口 + 实现），不再区分授权版。

## 功能

- UE 画面 **NVENC 硬编码**低延迟 RTMP 推流（实测 4K@30/60，RTX 4090 单卡约 16% 权重/路）
- 浏览器 ↔ UE 的**双向控制通道**（命令透传，如按需关键帧 `sf_request_keyframe`）
- 待命降载：空闲实例自动低帧率/低码率省 GPU，会话接入瞬时恢复满配
- 支持平台：**Win64 / Linux**（UE 5.7）

## 依赖与前置

- Unreal Engine **5.7**（插件 `SupportedTargetPlatforms` 为 Win64 / Linux）
- 编码端需要 NVIDIA GPU（NVENC）。无 NVENC 的机器仍可编译，但推流会用软件回退或不可用
- 服务端配套：MediaMTX（接收 RTMP）+ ZS_Live 服务端（信令/鉴权）。本仓库不含服务端
- 依赖引擎插件 `HardwareEncoders`（已在 `.uplugin` 中声明启用）

## 目录结构

```
ue-plugin/StreamForge/
├── StreamForge.uplugin           # 插件描述
├── Config/FilterPlugin.ini       # 模块符号导出过滤（编辑器热重载用）
├── Source/StreamForge/
│   ├── Public/                   # 对外接口（USubsystem / 模块 / 类型）
│   │   ├── StreamForgeSubsystem.h
│   │   ├── StreamForgeModule.h
│   │   └── StreamForgeTypes.h
│   └── Private/                  # 完整实现（采集 / 编码 / 推流 / 控制通道）
│       ├── SFVideoPipeline.*     # 背缓冲采集 + 编码调度
│       ├── SFFmpegEncoder.*      # x264 / NVENC 封装
│       ├── SFRtmpPusher.*        # RTMP 推送（含音视频交织）
│       ├── SFControlChannel.*    # WebSocket 控制通道
│       ├── SFAudioPipeline.*     # 音频捕获与重采样
│       ├── SFMediaFormat.*       # 媒体格式协商
│       ├── SFAmf0.*              # RTMP AMF0 编解码
│       ├── SFLog.h
│       ├── StreamForgeModule.cpp
│       └── StreamForgeSubsystem.cpp
└── README.md
```

## 集成方式

两种挂法，二选一：

1. **项目插件**（推荐评估用）：把 `StreamForge/` 整个目录复制到你的项目
   `YourProject/Plugins/StreamForge/`，重启编辑器，在 `.uproject` 的
   `Plugins` 列表里启用（或编辑器 Plugins 面板搜索 `StreamForge` 勾选）。
2. **引擎插件**：复制到 `Engine/Plugins/StreamForge/`，对所有项目生效。

编译即用，无需额外生成步骤（UBT 会按 `.Build.cs` 正常构建）。

## 基本调用（蓝图 / C++）

```cpp
// 取得子系统
if (UStreamForgeSubsystem* SF = GetWorld()->GetSubsystem<UStreamForgeSubsystem>())
{
    FStreamForgeConfig Cfg;
    Cfg.Url         = TEXT("rtmp://127.0.0.1:1935/live/j002");
    Cfg.EnableVideo = true;
    Cfg.EnableAudio = true;
    Cfg.bHardwareEnc = true;          // 优先 NVENC
    Cfg.Fps         = 30;
    Cfg.BitrateKbps = 8000;
    SF->StartStream(Cfg);
}
```

控制通道：浏览器侧通过 WebSocket 连接到服务端转发通道，发送 JSON 命令
（如 `{"cmd":"sf_request_keyframe"}`）即可触发 UE 侧关键帧。

更完整的部署、服务端联动与排障见 [../docs/UE插件集成指南.md](../docs/UE插件集成指南.md)。

## 授权（重要）

本插件以**源代码可见（Source-Available）**方式发布，**不是** OSI 意义上的开源软件。
其使用受本仓库根目录 `LICENSE` 约束，核心限制：

- **禁止商用**
- **禁止将本插件 / 衍生作品部署为对外提供服务的产品**
- **禁止再分发**

如需商业授权，请联系作者（刘华西）。在遵守上述 `LICENSE` 的前提下，你可以
自由地阅读、编译、评估与自用修改。
