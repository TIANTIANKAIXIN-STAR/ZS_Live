# ZS Live 启动器（ZSLiveLauncher.exe）

双击 `launcher\ZSLiveLauncher.exe` 即可管理整套 ZS Live 服务，无需命令行。
所有子进程（MediaMTX / Node / UE 实例）全部无窗口后台运行，桌面不出现任何控制台窗口。

## 界面与功能

- **服务状态区**：MediaMTX / 调度服务 / UE 实例池 三行，每行独立电源按钮（⏻ 绿=启动，红=停止），状态文字实时着色（绿=运行中，红=已停止）
- **环境检查区**：Node.js 版本 / MediaMTX / 调度服务文件 / 端口 / NVIDIA GPU / 防火墙规则 / VC++ 运行库，绿勾红叉一目了然，红叉附原因
- **实例监控区**（每 2 秒刷新）：实例 / 模板 / 状态（启动中→就绪→使用中）/ FPS / 推流 / 浏览器连接数
- **日志区**：MediaMTX 与调度服务输出实时回显，启动失败原因直接可见
- **底部操作栏**：一键启动 / 一键停止 / 管理后台 / 打开首页 / 添加防火墙规则（TCP 3100+1935+8890、UDP 8189，需管理员）/ 开机自启（当前用户注册表 Run 键）
- 打开启动器即自动拉起全部服务；退出时可选择「停止全部服务并退出」或「保持服务后台运行」

## Node 版本自适应

调度服务依赖 better-sqlite3 原生模块，必须用与编译时一致的 Node 版本运行。
启动器会依次尝试所有可用的 Node（PATH 顺序 → Program Files），某个 Node 启动失败
（如 ABI 不匹配秒退）会自动切换下一个，失败原因会打印在日志页。

如需强制指定 Node，在 `launcher\launcher.config.json` 里写：

```json
{ "nodePath": "C:/Program Files/nodejs/node.exe" }
```

## 配置来源（优先级从高到低）

1. `launcher\launcher.config.json`（可选）：`port` / `mtxApiPort` / `nodePath` / `mediamtxPath`
2. `server\.env`：PORT、MEDIAMTX_API_PORT、ADMIN_USER、ADMIN_PASS
3. 默认值：3100 / 9997 / admin / admin123

## 运行要求

- .NET 9 Desktop Runtime（本机已装；部署到其他机器时从 https://dotnet.microsoft.com 下载）
- 源码在 `launcher\src\ZSLiveLauncher\`，重新发布：

```bat
cd launcher\src\ZSLiveLauncher
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -o ..\..
```
