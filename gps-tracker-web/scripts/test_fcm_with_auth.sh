#!/usr/bin/env bash
set -e
EMAIL="fcm3_$(date +%s)@seriallog.test"
PASS="testpass1234"

curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null

TOKEN=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

echo "TOKEN: ${TOKEN:0:40}..."

echo "=== direct 3040 with auth ==="
curl -sS -i -X POST http://127.0.0.1:3040/gps-tracker/api/v1/auth/fcm-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"token":"dummy123","platform":"android"}' | head -15

echo
echo "=== via nginx with auth ==="
curl -sS -i -X POST https://seriallog.com/gps-tracker/api/v1/auth/fcm-tokens \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"token":"dummy456","platform":"android"}' | head -15
