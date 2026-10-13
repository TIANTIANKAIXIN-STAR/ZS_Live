@echo off
REM ZS Live - Windows 停止所有服务
echo [INFO] 停止 ZS Live 服务...
taskkill /F /IM mediamtx.exe >nul 2>&1
wmic process where "CommandLine like '%%node src\\index.js%%'" delete >nul 2>&1
taskkill /F /FI "WindowTitle eq ZSL-Server*" >nul 2>&1
taskkill /F /FI "WindowTitle eq ZSL-MediaMTX*" >nul 2>&1
echo [INFO] 已停止（UE 实例由调度服务自动回收，或用任务管理器结束 UE 进程）
pause
