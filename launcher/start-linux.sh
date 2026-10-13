#!/usr/bin/env bash
# ============================================================
#  ZS Live - Linux 一键启动
#  启动 MediaMTX + 调度服务
# ============================================================
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR/.."
mkdir -p "$ROOT_DIR/logs"

PORT=3100
if [ -f "$SCRIPT_DIR/launcher.config.sh" ]; then source "$SCRIPT_DIR/launcher.config.sh"; fi

# ---------- Node ----------
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] 未找到 Node.js，请先安装 Node.js 18+"
  exit 1
fi

# ---------- 依赖 ----------
cd "$ROOT_DIR/server"
if [ ! -d node_modules ]; then
  echo "[INFO] 安装调度服务依赖..."
  npm install --no-audit --no-fund
fi
[ -f .env ] || cp .env.example .env

# ---------- MediaMTX ----------
cd "$ROOT_DIR"
if [ ! -f mediamtx/mediamtx ]; then
  echo "[INFO] 首次运行，下载 MediaMTX..."
  bash "$ROOT_DIR/scripts/download-mediamtx.sh"
fi

# ---------- 配置 ----------
LAN_IP=$(node "$ROOT_DIR/scripts/detect-lan-ip.mjs" 2>/dev/null || echo 127.0.0.1)
sed "s/{{LAN_IP}}/$LAN_IP/g" mediamtx/mediamtx.template.yml > mediamtx/mediamtx.yml

# ---------- 启动 ----------
echo "[INFO] 启动 MediaMTX..."
if pgrep -f "mediamtx/mediamtx" >/dev/null 2>&1; then
  echo "[WARN] MediaMTX 已在运行"
else
  nohup mediamtx/mediamtx mediamtx/mediamtx.yml > logs/mediamtx.log 2>&1 &
fi
sleep 2

echo "[INFO] 启动调度服务 (端口 $PORT)..."
if pgrep -f "node src/index.js" >/dev/null 2>&1; then
  echo "[WARN] 调度服务已在运行"
else
  cd "$ROOT_DIR/server"
  PORT=$PORT nohup node src/index.js > "$ROOT_DIR/logs/server.log" 2>&1 &
fi
sleep 2

echo "========================================================"
echo "  ZS Live 已启动"
echo "  观看页:   http://$LAN_IP:$PORT/"
echo "  管理后台: http://$LAN_IP:$PORT/admin  (admin / admin123)"
echo "  日志:     logs/server.log, logs/mediamtx.log"
echo "========================================================"
