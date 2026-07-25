#!/usr/bin/env bash
# Quick auth+devices smoke test on server
set -e
EMAIL="test_$(date +%s)@seriallog.test"
PASS="testpass1234"

echo "=== 1) register ==="
curl -sS -X POST https://gps.serial.kr/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}"
echo

echo "=== 2) login ==="
LOG=$(curl -sS -X POST https://gps.serial.kr/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}")
echo "$LOG"
TOKEN=$(echo "$LOG" | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "token: ${TOKEN:0:60}..."

echo
echo "=== 3) GET /devices via PUBLIC URL (nginx → 3040) ==="
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  https://gps.serial.kr/api/v1/devices | head -15

echo
echo "=== 4) GET /devices via DIRECT 3040 ==="
curl -sS -i -H "Authorization: Bearer $TOKEN" \
  http://127.0.0.1:3040/api/v1/devices | head -15

echo
echo "=== 5) headers nginx forwards (echo via debug header) ==="
curl -sS -H "Authorization: Bearer DUMMY_TEST" \
  https://gps.serial.kr/api/v1/devices -o /dev/null -w "http=%{http_code}\n"
