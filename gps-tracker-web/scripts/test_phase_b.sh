#!/usr/bin/env bash
set -e
EMAIL="phaseB_$(date +%s)@seriallog.test"
PASS="testpass1234"
DEVUID="phaseB-$(date +%s)"

curl -sS -X POST https://gps.serial.kr/api/v1/auth/register \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" >/dev/null
TOKEN=$(curl -sS -X POST https://gps.serial.kr/api/v1/auth/login \
  -H 'Content-Type: application/json' -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

echo "=== 디바이스 페어링 ==="
PAIR=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"display_name\":\"펜스 테스트\"}" \
  https://gps.serial.kr/api/v1/devices/pair)
DID=$(echo "$PAIR" | python3 -c 'import sys,json; print(json.load(sys.stdin)["id"])')
echo "device_id=$DID"

echo
echo "=== 지오펜스 만들기 (서울시청 반경 500m) ==="
GF=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"시청\",\"center_lat\":37.5665,\"center_lng\":126.978,\"radius_m\":500,\"device_id\":$DID}" \
  https://gps.serial.kr/api/v1/geofences)
echo "$GF" | python3 -m json.tool

echo
echo "=== 1) 펜스 안 (37.5665, 126.978) — 첫 측정이라 이벤트 없음 ==="
curl -sS -X POST https://gps.serial.kr/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"l80\":{\"fix\":true,\"lat\":37.5665,\"lng\":126.978,\"sat\":8}}"
echo

sleep 1
echo
echo "=== 2) 펜스 밖 (35.95, 127.0) — geofence_out 이벤트 발생 ==="
curl -sS -X POST https://gps.serial.kr/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"l80\":{\"fix\":true,\"lat\":35.95,\"lng\":127.0,\"sat\":8}}"
echo

sleep 1
echo
echo "=== 3) 다시 펜스 안 — geofence_in 이벤트 ==="
curl -sS -X POST https://gps.serial.kr/ingest \
  -H 'Content-Type: application/json' \
  -d "{\"device_uid\":\"$DEVUID\",\"l80\":{\"fix\":true,\"lat\":37.5670,\"lng\":126.979,\"sat\":8}}"
echo

sleep 2
echo
echo "=== 이벤트 테이블 확인 ==="
psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker -c \
  "SELECT id, device_id, kind, occurred_at, data FROM events WHERE device_id=$DID ORDER BY id;"

echo
echo "=== geofence_states ==="
psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker -c \
  "SELECT geofence_id, device_id, inside, last_transition_at FROM geofence_states WHERE device_id=$DID;"
