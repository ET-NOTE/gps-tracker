#!/usr/bin/env bash
set -e
export PGPASSWORD=QQopURby3seaZnd4PalqDXPoVv0C7
PSQL="psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker"

UID_TARGET="esp-000000000000"

echo "=== device & owner & tokens ==="
$PSQL -c "
SELECT d.id AS device_id, d.device_uid, d.owner_id, u.email,
       (SELECT COUNT(*) FROM fcm_tokens t WHERE t.user_id=d.owner_id AND t.active) AS active_tokens
FROM devices d LEFT JOIN users u ON u.id=d.owner_id
WHERE d.device_uid='$UID_TARGET';"

DEVICE_ID=$($PSQL -t -A -c "SELECT id FROM devices WHERE device_uid='$UID_TARGET';")
if [ -z "$DEVICE_ID" ]; then
  echo "no such device"; exit 1
fi
echo "device_id=$DEVICE_ID"

echo
echo "=== injecting test low_batt event ==="
$PSQL -c "
INSERT INTO events (device_id, kind, occurred_at, data)
VALUES ($DEVICE_ID, 'low_batt', now(), '{\"vbat_mv\":3200,\"threshold_mv\":3500,\"_test\":true}'::jsonb)
RETURNING id, device_id, kind, occurred_at;"

echo
echo "=== waiting 8s for worker ==="
sleep 8

echo
echo "=== worker log (last 12) ==="
sudo journalctl -u gps-tracker-api -n 12 --no-pager | grep -E "fcm:|fcm worker"
