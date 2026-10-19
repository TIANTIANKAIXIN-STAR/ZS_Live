# UE 插件（StreamForge）集成指南

StreamForge 让 UE5 打包程序无需 PixelStreaming 即可：采集画面/声音 → 硬件编码 → RTMP 推流，并接受远程键鼠与自定义指令。

## 1. 放入插件

把 `ZS_Live/ue-plugin/StreamForge` 整个目录复制到你的 UE 工程：

```
YourProject/
└── Plugins/
    └── StreamForge/
        ├── StreamForge.uplugin
        └── Source/StreamForge/...
```

## 2. 启用引擎插件

在 `.uproject` 的 `Plugins` 数组中加入（或编辑器里勾选）：

```json
"Plugins": [
  { "Name": "StreamForge", "Enabled": true },
  { "Name": "HardwareEncoders", "Enabled": true }
]
```

说明：
- `HardwareEncoders` 提供 EncoderNVENC（Win64/Linux，Vulkan 亦可）。必须启用，否则插件找不到编码器。
- WebSockets 是引擎 Runtime 模块（`StreamForge.Build.cs` 已依赖），不是独立插件，勿写进 `.uproject`。
- 兼容 UE 5.4 ~ 5.8+（AVEncoder 在 5.4 起标记弃用，插件内部已做兼容处理，仅编译告警不影响运行）。

## 3. 打包

- Windows：正常 Shipping 打包（D3D11 / D3D12 / Vulkan RHI 均可）。
- Linux：需 Vulkan SM6，产物为 `<Project>.sh` 启动脚本，模板里填 `.sh` 路径即可。
- 无需任何项目设置；插件从命令行参数读取一切配置。

### 打包实操（两步法，实测流程）

> UBA（Unreal Build Accelerator）环境异常时 `RunUAT -NoUBA` 不生效，必须拆成编译 + stage 两步：

```bat
:: ① 编译（约 40 秒，Win64；Linux 交叉编译用 platform=Linux + C:\UnrealToolchains）
"C:\Program Files\Epic Games\UE_5.7\Engine\Build\BatchFiles\Build.bat" ^
  UEtest Win64 Development ^
  -project="F:\streamming\ZS_Live\UETest\UEtest\UEtest.uproject" ^
  -WaitMutex -NoUBA

:: ② Stage + 打包（不带 -build；Linux 首次把 -skipcook 换成 -cook，着色器编译约 40 分钟）
"C:\Program Files\Epic Games\UE_5.7\Engine\Build\BatchFiles\RunUAT.bat" ^
  BuildCookRun ^
  -project="F:\streamming\ZS_Live\UETest\UEtest\UEtest.uproject" ^
  -platform=Win64 -clientconfig=Development ^
  -skipcook -stage -pak -compressed -nocompile ^
  -archive -archivedirectory="F:\streamming\ZS_Live\UETest\Package\Windows"
```

注意：
- **打包前停掉全部 UE 实例**（启动器「停止全部」即可），否则可执行文件被锁导致 stage 失败
- stage 后核对产物 exe 的时间戳 = ①的编译时间（防止 staged 旧二进制）
- Linux 交叉编译工具链放 `C:\UnrealToolchains\`（UE 5.7 对应 v26_clang-20.1.8-rockylinux8），UBT 会自动发现

## 4. 命令行参数

手动测试（不经调度服务）：

```
YourApp.exe -SFRtmpUrl=rtmp://127.0.0.1:1935/zslive/test01 -SFInstanceId=test01 -SFWidth=1280 -SFHeight=720 -SFFps=30 -SFBitrate=8000 -SFAudio=pcma
```

参数表：

| 参数 | 说明 | 默认 |
|---|---|---|
| `-SFRtmpUrl=` | RTMP 推流地址 | 必填（无则插件休眠） |
| `-SFInstanceId=` | 实例 ID（决定流路径 zslive/<id>） | - |
| `-SFWidth/Height/Fps=` | 分辨率/帧率 | 1280x720@30 |
| `-SFKeyframeInterval=` | 强制 IDR 周期（秒），0=仅首帧 | 2 |
| `-SFBitrate=` `-SFMaxBitrate=` | 码率 kbps | 8000 |
| `-SFAudio=` | `auto`/`aac`/`pcma`/`none` | auto |
| `-SFInput=` | 是否接受远程键鼠 | 1 |

> ⚠️ `-SFKeyframeInterval` 很重要：UE 硬编码器的 ultra-low-latency 调优是无限 GOP（零 IDR），
> 不强制周期关键帧的话，**中途接入的观看者会一直黑屏**。默认 2 秒已适配 WebRTC 场景。

此时用 `ffplay`/VLC/浏览器(WHEP) 拉流验证：

```
# WHEP 播放地址（MediaMTX，本机配置端口 8890）
http://<host>:8890/zslive/test01/whep
```

## 5. 蓝图 API

`UStreamForgeSubsystem`（GameInstance 子系统，任意蓝图可用）：

| 成员 | 说明 |
|---|---|
| `OnCommand` (委托) | 浏览器发来的自定义指令：`Name` + `Payload`(JSON 字符串) |
| `OnControlEvent` (委托) | 原始控制事件（键鼠等，JSON 字符串） |
| `SendEventToBrowser(Name, Data)` | 向当前观看者推送事件 |
| `SetBitrate(Kbps)` | 运行中调整码率 |
| `RequestKeyFrame()` | 立即请求关键帧 |
| `IsStreaming()` / `GetStatsJson()` | 状态/统计 |

浏览器端接收 UE 事件：

```js
document.addEventListener('ue:MyEventName', (e) => console.log(e.detail));
// 或者监听控制通道消息 { t:'ue_event', name, data }
```

## 6. 输入注入说明

浏览器键鼠事件经调度服务转发到插件后，通过 **FSlateApplication** 注入，效果等同本地玩家输入：

- `keydown/keyup`：JS `event.code`（KeyA/Digit1/ArrowLeft/Space…）自动映射到 FKey
- `mousemove`：归一化坐标 → 视口像素坐标
- `mousedown/up`：左/中/右/侧键
- `wheel`：滚轮
- 支持 Ctrl/Shift/Alt 组合键

项目里无需写任何输入处理代码；如需更细粒度控制，直接监听 `OnControlEvent` 自己解析。

## 7. 音频

- 采集主 Submix（游戏全部声音）。要排除某些声音，把它们的 SoundClass 路由到非主 Submix。
- **推荐双平台统一 `-SFAudio=pcma`**（G.711 PCMA 8kHz 单声道）：MediaMTX 的 WHEP 播放不支持 AAC，
  Windows 用 AAC 时浏览器播放无声；PCMA 是 RTMP↔WebRTC 协议交集，实测可播。
- AAC 仅在 RTMP 侧直接消费（录制/转推 CDN）时有意义。
- `-SFAudio=none` 关闭音频

## 8. 常见问题

| 现象 | 处理 |
|---|---|
| 日志 `No video encoders found` | 检查 HardwareEncoders 插件是否启用 |
| 日志 `No H264 video encoder found` | NVIDIA 驱动太旧，升级驱动 |
| 打包版第 0 帧编码失败 | 已知时序问题，插件 1 秒后自动重试（日志可见 retry→Encoder ready），无需处理 |
| 画面黑屏但连接正常 | ① 中途接入黑屏 → 确认 `-SFKeyframeInterval` 非 0（默认 2）；② getStats 有帧但画面冻结 → 浏览器 autoplay 策略，点页面「开启声音」或任意交互即可（播放器已按 muted 自动播放设计） |
| 播放页一直「正在建立连接」 | 查启动器「MediaMTX 流」页该实例路径是否 ready、readers 是否有连接；无路径=UE 没推上来，有路径无 reader=WHEP 被代理拦（浏览器关代理或加白名单） |
| 延迟大 | 降低 `bitrate`、`fps`；确认浏览器与服务器同局域网 |
| Linux 上插件日志 `Unsupported RHI` | 必须用 Vulkan RHI 打包 |
| MediaMTX 收不到流 | 防火墙放行 1935；确认 mediamtx.yml 端口与 .env 一致 |
| 调度服务启动即退出（ABI 错误） | better-sqlite3 与当前 Node 版本不匹配，在 server 目录重新 `npm install`；或用启动器自动切换兼容的 Node |
