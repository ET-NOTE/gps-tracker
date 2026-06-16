#!/usr/bin/env bash
# locations API: ingest로 데이터 넣고 → 페어링 → 조회.
set -euo pipefail
BASE="https://seriallog.com/gps-tracker"
EMAIL="loc-test-$(date +%s)@seriallog.test"
PW="hunter2hunter"
DEVUID="loc-smoke-$(date +%s)"

field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))"; }

echo "=== ingest 3 fixes (anonymous, l80) ==="
for i in 1 2 3; do
    curl -sS -X POST "$BASE/ingest" -H "Content-Type: application/json" \
        -d "{\"ts\":$((100+i)),\"csq\":24,\"reg\":5,\"vbat_mv\":3970,\"device_uid\":\"$DEVUID\",\"l80\":{\"fix\":true,\"lat\":35.949205,\"lng\":127.009053,\"sat\":8,\"ttff_s\":15}}" > /dev/null
    sleep 0.05
done
echo "ingested"

echo
echo "=== register + pair $DEVUID ==="
REG=$(curl -sS -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
AT=$(echo "$REG" | field access_token)
H="Authorization: Bearer $AT"
PAIR=$(curl -sS -X POST "$BASE/api/v1/devices/pair" -H "$H" -H "Content-Type: application/json" \
    -d "{\"device_uid\":\"$DEVUID\"}")
DID=$(echo "$PAIR" | field id)
echo "device_id=$DID"

echo
echo "=== latest ==="
curl -sS "$BASE/api/v1/devices/$DID/locations/latest" -H "$H" | python3 -m json.tool

echo
echo "=== history (limit=10) ==="
curl -sS "$BASE/api/v1/devices/$DID/locations?limit=10" -H "$H" | python3 -m json.tool | head -40

echo
echo "=== history fix_only=true&source=l80 ==="
curl -sS "$BASE/api/v1/devices/$DID/locations?fix_only=true&source=l80" -H "$H" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'count={len(d)}, all_fix={all(r[\"fix\"] for r in d)}, all_l80={all(r[\"source\"]==\"l80\" for r in d)}')"

echo
echo "=== history since/until 미래 → 0건 ==="
curl -sS "$BASE/api/v1/devices/$DID/locations?since=2099-01-01T00:00:00Z" -H "$H" \
    | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'count={len(d)}')"

echo
echo "=== unauth → 401 ==="
curl -sS -o /tmp/x -w "http_%{http_code}\n" "$BASE/api/v1/devices/$DID/locations/latest"

echo
echo "=== other-user → 404 ==="
EMAIL2="loc-test2-$(date +%s)@seriallog.test"
REG2=$(curl -sS -X POST "$BASE/api/v1/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL2\",\"password\":\"$PW\"}")
AT2=$(echo "$REG2" | field access_token)
curl -sS -o /tmp/x -w "http_%{http_code}\n" "$BASE/api/v1/devices/$DID/locations/latest" \
    -H "Authorization: Bearer $AT2"
