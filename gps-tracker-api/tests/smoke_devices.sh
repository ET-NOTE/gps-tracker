#!/usr/bin/env bash
# devices API end-to-end (HTTPS only).
set -euo pipefail
BASE="https://seriallog.com/gps-tracker/api/v1"
EMAIL="dev-test-$(date +%s)@seriallog.test"
PW="hunter2hunter"

field() { python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))"; }

echo "=== register $EMAIL ==="
REG=$(curl -sS -X POST "$BASE/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
echo "$REG" | python3 -m json.tool
AT=$(echo "$REG" | field access_token)
H="Authorization: Bearer $AT"

echo
echo "=== list before pair (expect []) ==="
curl -sS "$BASE/devices" -H "$H"; echo

echo
echo "=== pair NEW device-uid (expect 200) ==="
UID_NEW="dev-smoke-$(date +%s)"
PAIR=$(curl -sS -X POST "$BASE/devices/pair" -H "$H" -H "Content-Type: application/json" \
    -d "{\"device_uid\":\"$UID_NEW\",\"display_name\":\"smoke device\"}")
echo "$PAIR" | python3 -m json.tool
DID=$(echo "$PAIR" | field id)
echo "device_id=$DID"

echo
echo "=== pair ANONYMOUS-existing uid (test claim) ==="
# anon-unknown 익명 행이 이전 테스트로 존재함
ANON_PAIR=$(curl -sS -X POST "$BASE/devices/pair" -H "$H" -H "Content-Type: application/json" \
    -d "{\"device_uid\":\"anon-unknown\",\"display_name\":\"claimed anon\"}")
echo "$ANON_PAIR" | python3 -m json.tool

echo
echo "=== list (expect 2 devices) ==="
curl -sS "$BASE/devices" -H "$H" | python3 -m json.tool

echo
echo "=== detail $DID ==="
curl -sS "$BASE/devices/$DID" -H "$H" | python3 -m json.tool

echo
echo "=== patch display_name ==="
curl -sS -X PATCH "$BASE/devices/$DID" -H "$H" -H "Content-Type: application/json" \
    -d "{\"display_name\":\"renamed device\"}" | python3 -m json.tool

echo
echo "=== unauth detail (no header) → 401 ==="
curl -sS -o /tmp/x -w "http_%{http_code}\n" "$BASE/devices/$DID"

echo
echo "=== other-user pair conflict (expect 409) ==="
EMAIL2="dev-test2-$(date +%s)@seriallog.test"
REG2=$(curl -sS -X POST "$BASE/auth/register" -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL2\",\"password\":\"$PW\"}")
AT2=$(echo "$REG2" | field access_token)
curl -sS -o /tmp/x -w "http_%{http_code}\n" -X POST "$BASE/devices/pair" \
    -H "Authorization: Bearer $AT2" -H "Content-Type: application/json" \
    -d "{\"device_uid\":\"$UID_NEW\"}"

echo
echo "=== other-user detail of stranger device (expect 404) ==="
curl -sS -o /tmp/x -w "http_%{http_code}\n" "$BASE/devices/$DID" \
    -H "Authorization: Bearer $AT2"

echo
echo "=== unpair $DID (expect 200) ==="
curl -sS -X DELETE "$BASE/devices/$DID" -H "$H" | python3 -m json.tool

echo
echo "=== detail after unpair (expect 404) ==="
curl -sS -o /tmp/x -w "http_%{http_code}\n" "$BASE/devices/$DID" -H "$H"
