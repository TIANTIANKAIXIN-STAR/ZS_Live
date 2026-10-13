#!/bin/bash
# ZS Live 安装包 E2E 冒烟：安装副本起服务 → 会话推流 → 验证 → 清场（单命令内完成，防沙箱回收）
set -u
SRV_DIR=/c/ZSLive-Test/server
ROOT=/c/ZSLive-Test
LOG=$ROOT/logs

cd "$ROOT" || exit 1
./mediamtx/mediamtx.exe ./mediamtx/mediamtx.yml > "$LOG/mtx-e2e.log" 2>&1 &
MTX=$!
sleep 2
cd "$SRV_DIR" || exit 1
../runtime/node.exe src/index.js > "$LOG/server-e2e4.log" 2>&1 &
SRV=$!
sleep 4

echo "== health =="
curl -s --noproxy "*" http://127.0.0.1:3199/health; echo

echo "== create session =="
RESP=$(curl -s --noproxy "*" -X POST http://127.0.0.1:3199/api/session -H "Content-Type: application/json" -d '{"templateId":1}')
echo "$RESP" | head -c 300; echo
SID=$(echo "$RESP" | python -c "import sys,json;print(json.load(sys.stdin).get('sessionId',''))" 2>/dev/null)
echo "sessionId=$SID"

TOKEN=$(curl -s --noproxy "*" -X POST http://127.0.0.1:3199/api/admin/login -H "Content-Type: application/json" -d '{"username":"admin","password":"admin123"}' | python -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "adminToken=${TOKEN:0:12}..."

echo "== poll instances (max 90s) =="
RTMPOK=False
for i in $(seq 1 22); do
  sleep 4
  ST=$(curl -s --noproxy "*" -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3199/api/admin/instances)
  LINE=$(echo "$ST" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    arr = d.get('instances', d) if isinstance(d, dict) else d
    for it in (arr or []):
        st = it.get('stats') or {}
        print(str(it.get('id','?')) + ' state=' + str(it.get('state','?')) + ' agentOk=' + str(it.get('agentOk')) + ' rtmpOk=' + str(st.get('rtmpOk')) + ' fps=' + str(st.get('fps')))
except Exception as e:
    print('parse_err ' + str(e))
")
  echo "[$((i*4))s] $LINE"
  echo "$ST" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    arr = d.get('instances', d) if isinstance(d, dict) else d
    sys.exit(0 if any((it.get('stats') or {}).get('rtmpOk') for it in (arr or [])) else 1)
except Exception:
    sys.exit(1)
" && { RTMPOK=True; break; }
done

echo "== result: rtmpOk=$RTMPOK =="

if [ "$RTMPOK" = "True" ]; then
  echo "== mediamtx paths =="
  curl -s --noproxy "*" "http://127.0.0.1:9997/v3/paths/list" | python -c "
import sys, json
try:
    d = json.load(sys.stdin)
    items = d.get('items', [])
    print('mtx paths: ' + str([it.get('name') for it in items]))
except Exception as e:
    print('mtx api parse err: ' + str(e))
"
fi

echo "== release =="
[ -n "$SID" ] && curl -s --noproxy "*" -X POST http://127.0.0.1:3199/api/session/release -H "Content-Type: application/json" -d "{\"sessionId\":\"$SID\"}"; echo
sleep 6

echo "== teardown =="
kill $SRV 2>/dev/null
taskkill //F //IM UEtest.exe 2>/dev/null | head -2
taskkill //F //IM mediamtx.exe 2>/dev/null | head -1
sleep 2
echo "E2E_DONE rtmpOk=$RTMPOK"
