#!/usr/bin/env bash
# Inspect what the API actually returns for devices and locations
# (so we can compare against the frontend's expected field names)
set -e

EMAIL="inspect_$(date +%s)@seriallog.test"
PASS="testpass1234"

# 1. fresh user
echo "=== register ==="
curl -sS -X POST https://gps.serial.kr/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null

echo "=== login ==="
TOKEN=$(curl -sS -X POST https://gps.serial.kr/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# 2. pair legacy device (claims the anon device)
echo "=== pair legacy-l80-import ==="
PAIR=$(curl -sS -X POST https://gps.serial.kr/api/v1/devices/pair \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"device_uid":"legacy-l80-import","label":"레거시 L80"}')
echo "$PAIR" | python3 -m json.tool
DEVICE_ID=$(echo "$PAIR" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

# 3. list devices — check what fields are returned
echo
echo "=== GET /devices ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://gps.serial.kr/api/v1/devices | python3 -m json.tool

# 4. list locations — main thing: do lat/lng come through?
echo
echo "=== GET /devices/$DEVICE_ID/locations?limit=5 ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://gps.serial.kr/api/v1/devices/$DEVICE_ID/locations?limit=5" \
  | python3 -m json.tool

echo
echo "=== same with fix_only=true ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://gps.serial.kr/api/v1/devices/$DEVICE_ID/locations?limit=5&fix_only=true" \
  | python3 -m json.tool

# cleanup test user — leave it; harmless
