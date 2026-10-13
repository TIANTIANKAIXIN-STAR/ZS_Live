#!/usr/bin/env bash
# ZS Live - Linux 停止所有服务
echo "[INFO] 停止 ZS Live 服务..."
pkill -f "mediamtx/mediamtx" 2>/dev/null || true
pkill -f "node src/index.js" 2>/dev/null || true
echo "[INFO] 已停止（UE 实例由调度服务自动回收）"
