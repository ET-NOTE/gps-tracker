#!/usr/bin/env bash
set -euo pipefail
BASE="https://seriallog.com/gps-tracker/api/v1"
EMAIL="rust-test-$(date +%s)@seriallog.test"
PW="hunter2hunter"

echo "EMAIL=$EMAIL"

extract_field() {
    python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$1',''))"
}

echo "--- register ---"
REG=$(curl -sS -X POST "$BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\",\"display_name\":\"rust test\"}")
echo "$REG"
USER_ID=$(echo "$REG" | extract_field user_id)
echo "user_id=$USER_ID"

echo "--- login ---"
LOGIN=$(curl -sS -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}")
echo "$LOGIN"
RT=$(echo "$LOGIN" | extract_field refresh_token)
AT=$(echo "$LOGIN" | extract_field access_token)

echo "--- refresh (1st use → 200 expected) ---"
REF1=$(curl -sS -X POST "$BASE/auth/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$RT\"}")
echo "$REF1"

echo "--- refresh (2nd use of rotated token → 401 expected) ---"
curl -sS -o /tmp/x -w "http_%{http_code}\n" -X POST "$BASE/auth/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$RT\"}"

echo "--- bad password → 401 ---"
curl -sS -o /tmp/x -w "http_%{http_code}\n" -X POST "$BASE/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"WRONG\"}"

echo "--- short password → 400 ---"
curl -sS -o /tmp/x -w "http_%{http_code}\n" -X POST "$BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"x@seriallog.test\",\"password\":\"short\"}"

echo "--- duplicate email → 409 ---"
curl -sS -o /tmp/x -w "http_%{http_code}\n" -X POST "$BASE/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PW\"}"

echo "--- access token sanity (decode payload sub) ---"
echo "$AT" | awk -F. '{print $2}' | tr '_-' '/+' | base64 -d 2>/dev/null || true
echo
