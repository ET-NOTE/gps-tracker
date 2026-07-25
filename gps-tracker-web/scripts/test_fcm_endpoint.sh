#!/usr/bin/env bash
set -e
EMAIL="fcm_$(date +%s)@seriallog.test"
PASS="testpass1234"
DUMMY_TOKEN="dummy-fcm-token-$(date +%s)"

echo "=== register + login ==="
curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

echo "=== POST /auth/fcm-tokens ==="
curl -sS -i -X POST https://seriallog.com/gps-tracker/api/v1/auth/fcm-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$DUMMY_TOKEN\",\"platform\":\"android\"}" | head -10

echo
echo "=== POST again (idempotent / upsert) ==="
curl -sS -i -X POST https://seriallog.com/gps-tracker/api/v1/auth/fcm-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$DUMMY_TOKEN\",\"platform\":\"android\",\"app_version\":\"1.0.0+1\"}" | head -10

echo
echo "=== DB row ==="
psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker -c \
  "SELECT user_id, token, platform, app_version, active FROM fcm_tokens WHERE token='$DUMMY_TOKEN';"

echo
echo "=== DELETE /auth/fcm-tokens ==="
curl -sS -i -X DELETE https://seriallog.com/gps-tracker/api/v1/auth/fcm-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"token\":\"$DUMMY_TOKEN\"}" | head -10
