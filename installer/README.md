# ZS Live 一键安装包

## 产物

`dist/ZSLive-Setup-1.0.0.exe` —— 单文件安装包（约 1.x GB，含双平台 UE 演示程序时）。

## 安装包内容

| 组件 | 内容 | 说明 |
|---|---|---|
| core（必装） | 调度服务（server/）、Web 前端（web/）、MediaMTX、启动器、Node 24 运行时（runtime/node.exe）、docs、ue-plugin | 约 190 MB |
| winpkg（可选） | UE 演示程序 Windows 版 → `{app}\UETest\Package\Windows` | 约 1 GB |
| linuxpkg（可选） | UE 演示程序 Linux 版 → `{app}\UETest\Package\Linux` | 约 1.2 GB，供拷贝到 Linux 渲染节点部署 |

默认安装目录 `C:\ZS_Live`（不用 Program Files，避免服务子进程写 DB/日志的权限问题）。

## 安装后自动完成的初始化

1. `.env` 从 `.env.example` 生成（升级安装不覆盖已有配置）
2. Users 组写权限（icacls）——非管理员也能跑服务
3. `launcher/launcher.config.json` —— 指向随包 `runtime\node.exe`，无需系统安装 Node
4. 防火墙入站规则：TCP 3100（调度服务）、TCP 1935+8890（RTMP/WHEP）、UDP 8189（WebRTC），重装自动去重
5. `install-init.js`：从模板生成 `mediamtx/mediamtx.yml`（替换本机局域网 IP）+ 播种「UE 演示程序」模板（幂等）

安装完成后启动 ZSLiveLauncher → 一键启动 → 浏览器访问 `http://<本机IP>:3100/`。
默认管理员：`admin / admin123`（首次登录后请修改）。

## 重新构建（一键）

前置条件：Inno Setup 7（ISCC.exe）已安装（本机已装于 `C:\Program Files\Inno Setup 7`）。

```bat
:: 双击 installer\repack.bat，或命令行：
repack.bat                  REM 用当前版本号重打包
repack.bat 1.1.0            REM 升版本号到 1.1.0 并重打包
repack.bat 1.1.0 /skipue    REM UE 包没变时跳过 2GB 拷贝（编译仍全量）
```

脚本自动完成：刷新 `dist/stage/` 暂存（robocopy 增量，只拷变化文件）→ 编译 → 输出到 `dist/`。
- 改了 `server/`、`web/`、`docs/`、`ue-plugin/`、`scripts/`、启动器 → 直接重跑即可
- UE 包更新（build32+）后：不要带 `/skipue`，脚本会把 `UETest/Package/*` 重新镜像进暂存
- 启动器优先取 `launcher/publish-selfcontained/ZSLiveLauncher.exe`（自包含版）；重发启动器后直接重跑脚本即可

发版建议流程：`repack.bat <新版本号>` → 跑一遍 `dist/e2e-installed.sh` 回归（安装→推流→卸载全链路）→ 分发。

## 注意事项

- UE 包更新（重打包 build32+）后必须重新拷贝 winpkg/linuxpkg 并重跑 ISCC
- `server/install-init.js` 是安装器调用的初始化脚本，改动后同步进暂存目录
- 卸载会自动停止 UEtest / MediaMTX / 本平台 node 进程；用户数据（`server/data/` 数据库、`logs/`）不会被删除
- 未做代码签名，分发时 Windows SmartScreen 可能告警（更多信息 → 仍要运行）
