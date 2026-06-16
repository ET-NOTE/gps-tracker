#!/usr/bin/env bash
set -e
EMAIL="apiscope_$(date +%s)@seriallog.test"
PASS="testpass1234"
DEVUID="apiscope-$(date +%s)"

# fresh user
curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

# ingest a fix point so the device appears with data
echo "=== ingest fix point ==="
curl -sS -X POST https://seriallog.com/gps-tracker/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"ts\":1,\"vbat_mv\":3800,\"l80\":{\"fix\":true,\"lat\":37.5,\"lng\":127.0,\"sat\":8,\"ttff_s\":30}}"
echo

# pair it
echo "=== pair ==="
PAIR=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/devices/pair \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"label\":\"scope test\"}")
echo "$PAIR" | python3 -m json.tool
DEVICE_ID=$(echo "$PAIR" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")

echo
echo "=== GET /devices ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  https://seriallog.com/gps-tracker/api/v1/devices | python3 -m json.tool

echo
echo "=== GET /devices/$DEVICE_ID/locations?limit=3 ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://seriallog.com/gps-tracker/api/v1/devices/$DEVICE_ID/locations?limit=3" | python3 -m json.tool

echo
echo "=== GET /devices/$DEVICE_ID/locations?limit=3&fix_only=true ==="
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://seriallog.com/gps-tracker/api/v1/devices/$DEVICE_ID/locations?limit=3&fix_only=true" | python3 -m json.tool
