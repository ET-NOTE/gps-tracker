#!/usr/bin/env bash
set -e
EMAIL="fcmt_$(date +%s)@seriallog.test"
PASS=testpass1234

curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null

TOKEN=$(curl -sS -X POST https://seriallog.com/gps-tracker/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')

echo "POST /auth/fcm-token        : $(curl -sS -o /dev/null -w '%{http_code}' -X POST https://seriallog.com/gps-tracker/api/v1/auth/fcm-token -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"token":"d1","platform":"android"}')"
echo "POST /auth/fcm-token/revoke : $(curl -sS -o /dev/null -w '%{http_code}' -X POST https://seriallog.com/gps-tracker/api/v1/auth/fcm-token/revoke -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"token":"d1"}')"

echo "DB row:"
PGPASSWORD=QQopURby3seaZnd4PalqDXPoVv0C7 psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker -c "SELECT user_id, token, platform, active FROM fcm_tokens WHERE token='d1';"
