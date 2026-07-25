#!/usr/bin/env bash
# 1NCE 자격증명 + 서버 sim_info 엔드포인트 검증
set -e
EMAIL="ncetest_$(date +%s)@seriallog.test"
PASS="testpass1234"

# 새 유저 + 디바이스 페어링 (SIM 끝번호로)
curl -sS -X POST https://gps.serial.kr/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sS -X POST https://gps.serial.kr/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# 페어링 (id=2995 — 우리 ICCID 8988228066614752020 의 device)
PAIR=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"iccid":"8988228066614752020","display_name":"NCE 테스트"}' \
  https://gps.serial.kr/api/v1/devices/pair)
echo "=== pair ==="; echo "$PAIR" | python3 -m json.tool
DID=$(echo "$PAIR" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

echo
echo "=== GET /devices/$DID/sim ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://gps.serial.kr/api/v1/devices/$DID/sim" | python3 -m json.tool

echo
echo "=== unpair (다른 사용자가 다시 테스트할 수 있게) ==="
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://gps.serial.kr/api/v1/devices/$DID" | python3 -m json.tool
