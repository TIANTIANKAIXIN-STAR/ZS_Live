@echo off
rem ============================================================
rem  ZS Live 一键启动（独立于 WorkBuddy 会话常驻）
rem  双击后两个服务以独立进程运行，关闭本窗口不影响服务。
rem  停止：任务管理器结束 mediamtx.exe 和 node.exe(src\index.js)，
rem        或使用启动器 ZSLiveLauncher.exe 管理。
rem ============================================================
cd /d "%~dp0"

rem MediaMTX（RTMP/WebRTC 流媒体网关）
start "ZS-MediaMTX" /min /d "%~dp0mediamtx" "%~dp0mediamtx\mediamtx.exe" mediamtx.yml

rem 调度服务（Node，端口 3100）
start "ZS-Scheduler" /min /d "%~dp0server" "C:\Program Files\nodejs\node.exe" src\index.js

echo.
echo   ZS Live 已启动：
echo     管理后台  http://localhost:3100/admin
echo     程序首页  http://localhost:3100/
echo.
echo   两个服务已在后台独立运行，可以直接关闭本窗口。
echo.
pause
