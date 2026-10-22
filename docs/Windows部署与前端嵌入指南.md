# ZS Live 用户部署与前端嵌入指南（Windows）

> 版本：v2.1 ｜ 适用平台：**Windows 10 / 11 / Server 2019+** ｜ 面向：部署运维人员 + 业务前端开发者
> 本文 = 两部分合一：**一、Windows 部署与使用**（最新）；**二、前端嵌入（拉流播放 + UE 通信）**（重点）

---

## 先弄清两个名词（避免混淆）

- **推流（上行）**：UE 程序 → MediaMTX，方向是「服务器内部」。本文不要求部署者手动推流，调度服务会替你做。
- **拉流 / 前端嵌入（下行）**：浏览器 ← MediaMTX（WHEP），即「把 UE 画面嵌进你的网页」。本文第二部分讲的「前端嵌入推流」，指的就是**在网页里嵌入这路画面并和 UE 双向通信**。

一句话：UE 负责算 + 推，浏览器负责看 + 交互，中间由平台自动接好。

---

# 一、Windows 部署与使用（最新）

## 1. 平台是什么 / 架构

ZS Live 把 **UE 打包程序** 的画面实时送到浏览器：

- 服务端一键启动，UE 实例**离屏渲染**（服务器桌面无窗口）
- 浏览器打开网页即可观看，**鼠标键盘操作实时回传 UE**，像操作本地程序
- 低延迟：基于 WebRTC（WHEP），局域网典型延迟 100~300ms
- 支持多程序、多用户排队、会话管理、**嵌入第三方业务系统**

```
┌────────────┐   RTMP(视频上行)   ┌──────────┐   WebRTC/WHEP(视频下行)   ┌─────────┐
│ UE 打包程序 │ ────────────────► │ MediaMTX │ ───────────────────────► │  浏览器  │
│ +StreamForge│                   │ 流媒体    │                         │ 观看/操作│
│   插件      │ ◄──── 控制通道(WS) ┤ (Node)   │ ◄──── 键鼠/指令(WS) ──────│         │
└────────────┘                   └──────────┘                         └─────────┘
```

## 2. 环境要求

| 项目 | 要求 | 说明 |
|---|---|---|
| 操作系统 | Windows 10/11 或 Server 2019+（64 位） | — |
| GPU | **NVIDIA 显卡（推荐）** + 最新驱动 | NVENC 硬编码几乎不占 CPU；无 N 卡也能跑（软编码，性能差） |
| Node.js | 18 或更高（推荐 22 LTS） | 仅「拷贝目录部署」需要；安装包/启动器自带运行时 |
| VC++ 运行库 | Visual C++ 2015-2022 x64 | UE 程序运行需要 |
| 浏览器 | Chrome / Edge 最新版 | 用户侧观看用 |

> 不确定环境是否齐全？打开启动器看「环境检查」区：绿勾=通过，红叉=缺失并附带原因。

## 3. 快速部署（约 5 分钟）

### 方式 A：拷贝目录部署（推荐，直接可控）

把整个 `ZS_Live` 目录拷贝到服务器（如 `D:\ZS_Live`），双击 `launcher/ZSLiveLauncher.exe`：

- 启动器**自动拉起全部服务**（MediaMTX + 调度服务），无需命令行
- 所有服务**后台无窗口运行**，桌面干净
- 「服务状态」区三个电源按钮可单独启停；「环境检查」区有红叉按提示处理
- 启动失败原因直接显示在下方黑色日志区

> 也可用 `start-platform.bat` 双击启动（等价，但日志在命令行窗口）。

### 方式 B：一键安装包（.exe）

拿到 `ZSLive-Setup-x.x.x.exe` 后双击安装（默认 `C:\ZS_Live`），安装程序自动完成 Node 运行时、防火墙规则、MediaMTX 配置、`.env`、演示模板播种。装完勾选「启动 ZS Live 启动器」→ 点「一键启动」。

> - 未做代码签名，首次运行 SmartScreen 可能提示「未知发布者」：点「更多信息 → 仍要运行」
> - 默认管理员 `admin / admin123`，**首次登录后请立即改密码**（管理后台 → 用户管理）

### 第 3 步：浏览器验证

浏览器访问 `http://服务器IP:3100/`：

- 看到程序卡片列表（StreamHub 首页）
- 首次：点「管理后台」登录，在「实例模板」确认/修改 UE 程序路径
- 回首页，点卡片「进入」→ 等几秒 → 画面出现，鼠标键盘即可操作

**日常使用 = 双击启动器 → 浏览器打开首页。**

## 4. 管理后台（首次必配）

`http://服务器IP:3100/admin`，默认 `admin / admin123`。

### 4.1 实例模板（一个模板 = 一个可推流的 UE 程序）

| 字段 | 说明 |
|---|---|
| 模板名称 / 描述 | 首页卡片显示 |
| UE 可执行文件路径 | 打包程序的 exe **完整路径**，如 `D:\MyApp\Binaries\Win64\MyApp.exe` |
| 附加启动参数 | 可留空，如 `-dx12 -ResX=1920 -ResY=1080` |
| 分辨率 / 帧率 / 码率 | 画质预设下拉可选；1080p30 码率建议 8000，局域网可到 20000 |
| 音频 | **推荐选 PCMA**（浏览器兼容性最好；AAC 在 WHEP 播放端无声） |
| 允许输入 | 勾选后浏览器键鼠才能操作 UE |

> - **离屏渲染默认开启**：UE 实例无窗口后台运行；模板附加参数写 `-RenderOffScreen`/`-NoRenderOffScreen` 可覆盖。
> - 模板「附加参数」里的 `-log`/`-console` 会被自动剔除（避免服务器弹黑窗口，日志照常写入 `Saved/Logs/`）。
> - 实例启动自动注入 `-fps=<帧率>`（引擎级限帧），GPU 不被单实例吃满。

### 4.2 系统设置（关键项）

| 设置 | 默认 | 说明 |
|---|---|---|
| 最大并发实例数 | 3 | 受 GPU 编码器数量限制；1080p 消费级 N 卡一般 3~8 路 |
| 默认预热数 | 1 | 模板未单独设预热时生效；0=不预热 |
| 实例空闲回收（秒） | 300 | 空闲超时自动关闭释放资源 |
| 离屏渲染 | 开 | 实例 `-RenderOffScreen` 无窗口 |
| 会话超时强制释放（分钟） | 30 | 超时前 1 分钟页面提示 |
| 待命降载帧率 / 码率 | 5 / 500 | 空闲实例低帧低码省资源，接入瞬间恢复 |
| 浏览器自适应降档 | 关 | 开后在网络恶化时自动降码率（公网/弱网配置档会自动开） |

> **GPU 配额**（多卡）：在「GPU 监控」页填 `GPU编号:最大实例数`，如 `0:3,1:1`，每个实例启动自动绑定到剩余配额最多的卡；配额占满自动排队。单卡机器可不配（与旧版一致）。

## 5. 用户使用（观看 + 操作）

1. 浏览器打开 `http://服务器IP:3100/`
2. 卡片实时状态：**可立即进入** / **启动中** / **需排队**
3. 点「进入」→ 有空闲实例几秒出画，无则自动排队显示位次
4. 画面出现后：鼠标移动/点击/滚轮=操作 UE；键盘直接按键（输入框打字不透传）；右键菜单已屏蔽（透传 UE）
5. 多人进同一程序 = 各自独立实例、互不干扰

## 6. 端口与网络

### 6.1 端口一览（部署包默认）

| 端口 | 协议 | 用途 | 局域网 | 公网 |
|---|---|---|---|---|
| **3100** | TCP | 网页 + API + 控制通道(WS) | 必开 | 必开（建议反代 HTTPS） |
| 1935 | TCP | UE → MediaMTX RTMP 推流（服务器内部） | 不必对外开放 | 不必对外开放 |
| **8890** | TCP | WHEP 播放信令/媒体（下行） | 必开 | 必开 |
| 8189 | UDP | WebRTC 媒体传输 | 必开 | 必开 |

> 这些端口在 `server/.env`（`PORT` / `MEDIAMTX_WHEP_PORT`）和 `mediamtx/mediamtx.yml`（`rtmpAddress` / `webrtcAddress`）里配置，改了要同步并重启。单机部署时 1935 只在服务器内部，无需对外开放。

### 6.2 局域网部署（最常见）

启动器点「添加防火墙规则」（**右键以管理员身份运行**启动器），用户访问 `http://服务器IP:3100/`，完成。

### 6.3 公网部署（强烈建议 HTTPS）

1. 管理后台 →「系统设置」→「公网接入检测」→「开始检测」，平台自动探测公网 IP 并生成 TURN 启动命令 + MediaMTX ICE 片段。
2. 防火墙/安全组放行：TCP `3100 / 8890 / 3478`，UDP `8189 / 49160-49200`。
3. `server/.env` 设 `PUBLIC_HOST=公网IP` 重启；`mediamtx.yml` 设 `webrtcAdditionalHosts: [公网IP]`。
4. 在 3100 前加 Nginx/Caddy 反代 **HTTPS**（WebRTC 在非 localhost 的 HTTP 页面上能力受限）。Caddy 示例：

```
your.domain.com {
  reverse_proxy 127.0.0.1:3100
  reverse_proxy /zslive/* 127.0.0.1:8890
}
```

> **何时必须 TURN？** 服务器有公网 IP 且放开 UDP 时 STUN 够用；服务器在 NAT 后（家庭宽带/内网机房）或 UDP 被限速时，必须 TURN 中继。不确定就都配上——TURN 只在直连失败才启用。

### 6.4 集群（master/worker，一句话）

多台渲染服务器时：`master` 设 `CLUSTER_ROLE=master` + `CLUSTER_TOKEN`；每台 `worker` 设 `CLUSTER_ROLE=worker` + 同 token + `NODE_PUBLIC_HOST`。master 后台「节点管理」添加节点即可统一入口调度。详见 `README.md` 架构图。

## 7. 安全清单（必做）

- [ ] 改 admin 默认密码（管理后台 → 用户管理）
- [ ] 仅开放必要端口（3100/8890/8189 UDP；公网再加 3478）
- [ ] 公网部署务必上 HTTPS 反代
- [ ] 定期备份 `server/data/zslive.db`（模板/用户/会话全在这一个文件）

## 8. 常见故障（FAQ）

| 现象 | 处理 |
|---|---|
| 黑屏/一直转圈 | 启动器「实例监控」看是否「✔推流」；确认浏览器能访问 8890 端口 |
| 有画面没声音 | 模板音频选 **PCMA**；点页面「开启声音」（浏览器策略需手势） |
| 键鼠没反应 | 模板勾选「允许输入」；确认用最新版 StreamForge 打包 |
| 调度服务起不来（`NODE_MODULE_VERSION`） | better-sqlite3 与 Node 版本不匹配：在 `server` 执行 `npm rebuild better-sqlite3 --build-from-source` |
| 端口被占 | 3100 改 `server/.env` 的 `PORT` + 同步 `launcher.config.json`；8890/1935 改 `mediamtx.yml` |

---

# 二、前端嵌入：拉流播放 + UE 通信（重点）

平台提供 **两种前端接入方式**，按需求选择：

| 方式 | 适合 | 能力 |
|---|---|---|
| **A. iframe 直嵌** | 只想把画面嵌进网页，能看 + 能键鼠操作 | 最简单，一行 `<iframe>`，无需任何 JS |
| **B. 父页面 SDK**（`/sdk/zslive-parent.js`） | 要发指令给 UE、收 UE 事件、同页多路画面、深度集成 | 双向通信 + 事件回调 + 多路管理 |

> 两种方式底层都是：浏览器 `POST /api/session` 拿 `wsUrl`（控制通道）+ `whepUrl`（视频），嵌入页用 WHEP 拉流、用 WS 收发指令。SDK 只是在 iframe 之上包了一层 `postMessage` 桥 + 生命周期管理。

## 方式 A：iframe 直嵌（最简）

```html
<iframe src="http://服务器IP:3100/embed?template=1&streamId=view-a"
        style="width:100%;height:100%;border:0"
        allow="autoplay;fullscreen;encrypted-media"></iframe>
```

- `template` = 后台「实例模板」ID（必填）；`streamId` = 同页多路时的唯一标识（可选）。
- 默认 `autoconnect=1`（打开即连）。要父页面控制连接时机，加 `autoconnect=0`，父页面 `postMessage` 发 `{source:'zslive-parent',type:'connect'}` 触发（高级用法）。
- 嵌入页自带：连接状态遮罩、排队提示、「开启声音」按钮、重连逻辑——**零 JS 即可用**。

## 方式 B：父页面 SDK（双向通信）

引入 SDK，用 `ZsLive.mount()` 挂载一路，用 `ZsLiveHub` 管理多路。

### B.1 引入与挂载

```html
<div id="view" style="width:800px;height:450px"></div>
<script src="http://服务器IP:3100/sdk/zslive-parent.js"></script>
<script>
  const stream = ZsLive.mount({
    container: '#view',                 // 挂载容器（必填）
    baseUrl: 'http://服务器IP:3100',     // 平台地址；不传=同源
    template: 1,                        // 模板 ID
    streamId: 'view-a',                 // 多路时必填唯一标识
    // forwardKeys: true  ← 默认开启：鼠标悬停推流区时自动把父页按键转发进 UE
  });
  stream.on('streaming', () => console.log('画面已出'));
  stream.on('inputready', () => {
    stream.camera('config', { fov: 90 });        // 画面就绪后发指令
  });
</script>
```

### B.2 事件（`.on(event, cb)`）

| 事件 | data | 含义 |
|---|---|---|
| `ready` | — | 控制通道 WS 已连接 |
| `assigned` | `{instanceId}` | 会话已分配到 UE 实例 |
| `streaming` | — | 视频推流已开始（画面出来） |
| `inputready` | — | 数据通道就绪，可发指令 |
| `ue` | `{name, data}` | **UE 上报的事件**（你 `SendEventToBrowser` 的内容） |
| `platform` | `{code, message}` | 平台状态/错误码（如排队、断线） |
| `error` | `{code, message}` | 错误（连接失败/会话结束） |
| `disconnected` | `{reason}` | 会话断开 |
| `pointerover` / `pointerout` | — | 鼠标进入/离开推流区（键盘转发依据） |

### B.3 给 UE 发指令（API）

| 方法 | 转成 UE 指令 | 说明 |
|---|---|---|
| `stream.camera(action, params)` | `camera.<action>` | 相机类指令（gameAPI 风格） |
| `stream.invoke(module, action, params)` | `<module>.<action>` | 通用模块指令 |
| `stream.sendCommand(name, payload)` | `<name>` | 自定义业务指令 |
| `stream.sendRaw(jsonString)` | 自动解析 `module.action` 或 `name` 形态 | 原始 JSON 指令 |
| `stream.focus()` | — | 让嵌入 iframe 抢焦点（触发键盘转发） |
| `stream.disconnect()` | — | 主动断开并释放实例 |
| `stream.destroy()` | — | 销毁整个挂载（含移除 iframe） |

```js
stream.camera('config', { fov: 90, speed: 1.2 });
stream.invoke('game', 'start', { level: 3 });
stream.sendCommand('load_level', JSON.stringify({ map: '/Game/Maps/Demo.umap' }));
stream.sendRaw('{"api":"camera","action":"orbit","params":{"speed":1}}');
```

### B.4 多路同屏（Hub）

```js
const hub = new ZsLiveHub();
const a = hub.mount({ container:'#paneA', template:1, streamId:'view-a' });
const b = hub.mount({ container:'#paneB', template:2, streamId:'view-b' });
a.camera('config', { fov: 75 });
b.sendCommand('reset', '{}');
hub.get('view-a').disconnect();   // 断开某路
hub.destroyAll();                 // 全部销毁
```

> 多路时**必须给每路不同的 `streamId`**，否则父页面↔iframe 的消息会串台。SDK 默认自动生成随机 `streamId`，但你显式传更可控。

### B.5 键盘转发机制（重要）

默认 `forwardKeys=true`：当鼠标**悬停**在推流区（收到 `pointerover`）且通道就绪时，SDK 自动把父页面的按键 `postMessage` 进 iframe → 转发给 UE；鼠标移出（`pointerout`）自动释放所有按住键。规则：

- 仅转发方向键 / 字母 / 数字 / Space / Ctrl / Shift / Alt（不抢业务页的输入框）。
- 输入框（INPUT/TEXTAREA/SELECT）内的按键**不透传**，避免打字冲突。
- 若你的业务页自己接管键盘，可 `mount({..., forwardKeys:false})` 关闭，再手动 `stream.focus()` 触发转发。

## 控制通道协议（浏览器 ↔ UE 消息格式）

所有消息 UTF-8 JSON，含顶层字段 `t`（前端代码）或 `type`（协议文档）。路由：**浏览器 → 调度服务 `/ws` → UE `/agent`**，原样转发。

### 浏览器 → UE

```jsonc
// 自定义业务指令（sendCommand / camera / invoke 底层都走这个）
{ "t": "command", "name": "load_level", "payload": "{\"map\":\"/Game/Maps/Demo.umap\"}" }
// 原始键鼠（播放器自动发，无需手写）
{ "t": "input", "e": { "type": "mousemove", "x": 0.52, "y": 0.41 }, "mods": {"ctrl":false} }
```

| `command` 的 `name` | 含义 |
|---|---|
| 任意自定义 | 你的业务指令，UE 端 `OnCommand` 订阅消费 |
| `sf_set_bitrate` | 动态调码率（kbps），自适应降档内部用 |
| `sf_request_keyframe` | 请求强制 IDR 关键帧（切回前台/花屏自救） |

### UE → 浏览器

```jsonc
{ "t": "ue_event", "name": "level_loaded", "data": { "map": "Demo" } }  // 你在 UE 里 SendEventToBrowser 的内容
```

### 会话生命周期（服务 → 浏览器）

| 消息 | 含义 |
|---|---|
| `assigned` | 已分配实例，附 `whepUrl`/`instanceId` → 播放器立即 WHEP 拉流 |
| `queue_update` | 排队中，附 `position`/`total`/`estimatedWait` |
| `session_ended` | 会话结束（reason: `released`/`idle_timeout`/`instance_dead`/`timeout`） |

## UE 侧对接（蓝图 API）

平台用 `UStreamForgeSubsystem`（GameInstance 子系统，任意蓝图可用）对接前端：

| 成员 | 类型 | 说明 |
|---|---|---|
| `OnCommand` | 事件（委托） | 收到浏览器 `command` 时触发，参数 `Name`(action) + `Payload`(JSON 字符串) |
| `OnControlEvent` | 事件（委托） | 控制通道原始事件（Connected / Disconnected / Reconnected） |
| `SendEventToBrowser(Name, Data)` | 函数 | 向当前观看者推送事件 → 前端 `ue` 事件 |
| `SetBitrate(Kbps)` | 函数 | 运行中动态调码率 |
| `RequestKeyFrame()` | 函数 | 立即请求关键帧 |
| `IsStreaming()` / `GetStatsJson()` | 函数 | 状态 / 统计（fps/encodeMs/rtmpQueue/bitrate） |

### 示例：前端按钮「开始游戏」→ UE 切换关卡

**前端：**

```js
stream.sendCommand('load_level', JSON.stringify({ map: '/Game/Maps/Game.umap' }));
```

**UE 蓝图（订阅 `OnCommand`）：**

```
Event OnCommand (Name Action, String Payload)
├─ Branch (Action == "load_level")
│   ├─ Get JSON String Field (Payload, "map") → LevelName
│   └─ Open Level (by Name) (LevelName)
└─ (default) Print String (Payload)
```

**UE 完成后回报：**

```
SendEventToBrowser("level_loaded", "{\"map\":\"Game\"}")
// 前端 stream.on('ue', e => { if (e.name==='level_loaded') ... })
```

> 浏览器键鼠事件经调度服务转发到插件后通过 **FSlateApplication** 注入，效果等同本地玩家输入，**项目里无需写任何输入处理代码**。

## 关键技术点 / 避坑

1. **必须 HTTPS（公网）**：WebRTC 在非 localhost 的 HTTP 页面上能力受限；公网务必反代 HTTPS。局域网 `http://IP` 可用。
2. **声音自动播放策略**：嵌入页 `<video>` 默认 `muted` 才能自动播放；声音需用户手势开启（页面「开启声音」按钮）。模板音频务必选 **PCMA**（AAC 在 WHEP 端无声）。
3. **后台标签页暂停解码**：页面切后台时嵌入页自动把入站轨道 `enabled=false`（解码器丢帧不解码，释放 GPU），切回前台再恢复 + 请求强制关键帧（恢复 <300ms）。多流网格同开时这是避免卡顿的核心机制。
4. **关键帧（IDR）**：UE→MediaMTX→WHEP 是单向链路，PLI 到不了 UE 编码器。中途接入 / 切回前台时由前端主动 `sf_request_keyframe` 请求 IDR，否则要干等一个 IDR 周期（4K 模板约 4s 黑屏）。插件默认已按 2s 周期强制关键帧。
5. **自适应降档**：后台「浏览器自适应降档」开启后，播放器监测丢包/RTT 自动降码率（满配→60%→35%），网络恢复自动升回。
6. **CORS / 跨域**：SDK 用 `postMessage`（不受 CORS 限制）；但 WHEP 拉流与 `/api/session` 需平台允许跨域——部署在同一域名（反代后）最省事；跨域时确保平台 CORS 头放行你的前端域。
7. **多路 streamId 必唯一**：同页多路必须显式不同 `streamId`，否则消息串台。
8. **先 `inputready` 再发指令**：指令在控制通道就绪后才送达 UE，监听 `inputready` 事件后再 `camera`/`sendCommand` 最稳妥。

## 完整示例：同页双路 + 指令 + 收事件

```html
<!doctype html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<style>body{font-family:sans-serif}.pane{width:48%;height:360px;display:inline-block;background:#000}</style>
</head><body>
  <div class="pane" id="paneA"></div>
  <div class="pane" id="paneB"></div>
  <button onclick="a.camera('config',{fov:90})">A 设 FOV=90</button>
  <button onclick="b.sendCommand('reset','{}')">B 重置</button>

  <script src="http://服务器IP:3100/sdk/zslive-parent.js"></script>
  <script>
    const hub = new ZsLiveHub();
    const a = hub.mount({ container:'#paneA', template:1, streamId:'view-a' });
    const b = hub.mount({ container:'#paneB', template:2, streamId:'view-b' });
    a.on('streaming', () => console.log('A 出画'));
    a.on('ue', e => console.log('A 事件:', e.name, e.data));   // 收 UE 回报
    b.on('error', e => console.log('B 错误:', e.code));
  </script>
</body></html>
```

> 在线演示：`http://服务器IP:3100/integration-demo.html`（同页双路 + 指令 + 事件日志，开箱可跑）。
> 接口参考：`GET /api/programs`（模板列表）、`GET /api/stream-codes`（错误码全集）、`GET /api/embed?template=1`（嵌入协议说明）。

---

## 附：文档清单（本仓库）

| 文档 | 内容 |
|---|---|
| 本文（Windows 部署与前端嵌入指南） | 部署 + 前端嵌入（拉流 + UE 通信） |
| `docs/部署与使用手册.md` | 完整部署手册（含集群/Linux 附录） |
| `docs/控制通道协议.md` | 浏览器↔调度↔UE 的 WS 消息格式全集 |
| `docs/UE插件集成指南.md` | UE 侧插件集成、命令行参数、打包 |
| `docs/compare-pixelstreaming.md` | 与 Unreal 像素流送的技术对比 |
