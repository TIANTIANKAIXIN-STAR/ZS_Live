@echo off
setlocal EnableDelayedExpansion
chcp 65001 >nul

REM ============================================================
REM  ZS Live - Windows 一键启动
REM  启动 MediaMTX + 调度服务，并打开观看页
REM ============================================================

set "SCRIPT_DIR=%~dp0"
set "ROOT_DIR=%SCRIPT_DIR%.."

REM ---------- 读取配置 ----------
set "PORT=3100"
if exist "%SCRIPT_DIR%launcher.config.bat" call "%SCRIPT_DIR%launcher.config.bat"

REM ---------- 检查 Node ----------
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] 未找到 Node.js，请先安装 Node.js 18+
    pause
    exit /b 1
)

REM ---------- 安装服务依赖 ----------
cd /d "%ROOT_DIR%\server"
if not exist "node_modules" (
    echo [INFO] 安装调度服务依赖...
    call npm install --no-audit --no-fund
    if %errorlevel% neq 0 (
        echo [ERROR] 依赖安装失败
        pause
        exit /b 1
    )
)
if not exist ".env" copy /y ".env.example" ".env" >nul

REM ---------- 下载 MediaMTX ----------
cd /d "%ROOT_DIR%"
if not exist "mediamtx\mediamtx.exe" (
    echo [INFO] 首次运行，下载 MediaMTX...
    powershell -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%..\scripts\download-mediamtx.ps1"
    if not exist "mediamtx\mediamtx.exe" (
        echo [ERROR] MediaMTX 下载失败，请手动下载放到 mediamtx\ 目录
        pause
        exit /b 1
    )
)

REM ---------- 生成 MediaMTX 配置 ----------
set "LAN_IP=127.0.0.1"
for /f "usebackq delims=" %%a in (`node "%ROOT_DIR%\scripts\detect-lan-ip.mjs" 2^>nul`) do set "LAN_IP=%%a"

powershell -NoProfile -Command "(Get-Content '%ROOT_DIR%\mediamtx\mediamtx.template.yml') -replace '{{LAN_IP}}','%LAN_IP%' | Set-Content '%ROOT_DIR%\mediamtx\mediamtx.yml' -Encoding UTF8"

REM ---------- 启动 MediaMTX ----------
if not exist "%ROOT_DIR%\logs" mkdir "%ROOT_DIR%\logs"
echo [INFO] 启动 MediaMTX (RTMP:1935 / WHEP:8890)...
start "ZSL-MediaMTX" /MIN cmd /c "cd /d %ROOT_DIR% && mediamtx\mediamtx.exe mediamtx\mediamtx.yml > logs\mediamtx.log 2>&1"

timeout /t 2 /nobreak >nul

REM ---------- 启动调度服务 ----------
echo [INFO] 启动调度服务 (端口 %PORT%)...
cd /d "%ROOT_DIR%\server"
start "ZSL-Server" /MIN cmd /c "set PORT=%PORT%&& node src\index.js > ..\logs\server.log 2>&1"

timeout /t 3 /nobreak >nul

curl -s "http://localhost:%PORT%/health" >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] 服务健康检查失败，请查看 logs\server.log
) else (
    echo [OK] 服务正常
)

echo.
echo ========================================================
echo   ZS Live 已启动
echo   观看页:   http://%LAN_IP%:%PORT%/
echo   管理后台: http://%LAN_IP%:%PORT%/admin   (admin / admin123)
echo   日志:     logs\server.log, logs\mediamtx.log
echo ========================================================
echo.

set /p "OPEN=打开浏览器？(y/n): "
if /i "%OPEN%"=="y" start "" "http://localhost:%PORT%/admin"

echo 按任意键最小化窗口（服务继续后台运行）...
pause >nul
exit /b 0
