#!/usr/bin/env bash
# 下载 MediaMTX（Linux/macOS）
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MTX_DIR="$ROOT/mediamtx"
EXE="$MTX_DIR/mediamtx"

if [ -f "$EXE" ]; then echo "[OK] mediamtx 已存在"; exit 0; fi
mkdir -p "$MTX_DIR"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64v8" ;;
  *) echo "不支持的架构: $ARCH"; exit 1 ;;
esac

TAG=$(curl -fsSL --max-time 15 https://api.github.com/repos/bluenviron/mediamtx/releases/latest 2>/dev/null | grep -oP '"tag_name":\s*"\K[^"]+' || true)
[ -z "$TAG" ] && TAG="v1.12.0"  # 兜底版本

URL="https://github.com/bluenviron/mediamtx/releases/download/$TAG/mediamtx_${TAG}_linux_${ARCH}.tar.gz"
echo "[INFO] 下载 $URL"
curl -fL --retry 3 -o /tmp/mediamtx.tgz "$URL"
tar -xzf /tmp/mediamtx.tgz -C "$MTX_DIR" mediamtx
rm -f /tmp/mediamtx.tgz
chmod +x "$EXE"
echo "[OK] 已安装 $EXE ($TAG)"
