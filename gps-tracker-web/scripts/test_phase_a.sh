#!/usr/bin/env bash
set -e
EMAIL="phaseA_$(date +%s)@seriallog.test"
PASS="testpass1234"

echo "=== register + login ==="
curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/login \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

echo
echo "=== GET /auth/me ==="
curl -sS -H "Authorization: Bearer $TOKEN" https://seriallog.com/gps-tracker/api/v1/auth/me | python3 -m json.tool

echo
echo "=== PATCH /auth/me (display_name + secondary_phone) ==="
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"display_name":"홍길동","secondary_phone":"010-1234-5678"}' \
  https://seriallog.com/gps-tracker/api/v1/auth/me | python3 -m json.tool

echo
echo "=== POST /auth/me/password (wrong current) ==="
curl -sS -o /dev/null -w "wrong_current_pw → %{http_code}\n" \
  -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"current_password":"WRONG","new_password":"newpass1234"}' \
  https://seriallog.com/gps-tracker/api/v1/auth/me/password

echo
echo "=== POST /auth/me/password (correct) ==="
curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"current_password\":\"$PASS\",\"new_password\":\"newpass1234\"}" \
  https://seriallog.com/gps-tracker/api/v1/auth/me/password

echo
echo "=== GET /notifications/settings (creates default) ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://seriallog.com/gps-tracker/api/v1/notifications/settings | python3 -m json.tool

echo
echo "=== PATCH /notifications/settings ==="
curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"motion_alert":false,"low_batt_threshold_mv":3300,"offline_minutes":15}' \
  https://seriallog.com/gps-tracker/api/v1/notifications/settings | python3 -m json.tool

echo
echo "=== Pair fresh device + PATCH color/icon ==="
TS=$(date +%s)
PAIR=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"phasea-$TS\",\"display_name\":\"테스트 트래커\"}" \
  https://seriallog.com/gps-tracker/api/v1/devices/pair)
echo "$PAIR" | python3 -m json.tool
DID=$(echo "$PAIR" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')

curl -sS -X PATCH -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"color":"#5fc9c9","icon":"car"}' \
  "https://seriallog.com/gps-tracker/api/v1/devices/$DID" | python3 -m json.tool

echo
echo "=== GET /devices (color/icon visible) ==="
curl -sS -H "Authorization: Bearer $TOKEN" https://seriallog.com/gps-tracker/api/v1/devices | python3 -m json.tool
