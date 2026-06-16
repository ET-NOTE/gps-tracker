#!/usr/bin/env bash
# DB inspect helper
set -e
export PGPASSWORD=QQopURby3seaZnd4PalqDXPoVv0C7
PSQL="psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker -A -F | "

echo "=== device row ==="
$PSQL -c "SELECT id, device_uid, owner_id, display_name, last_lat, last_lng, last_fix_at FROM devices WHERE device_uid='legacy-l80-import';"

echo
echo "=== users ==="
$PSQL -c "SELECT id, email FROM users ORDER BY id;"

echo
echo "=== devices for each user ==="
$PSQL -c "SELECT u.id AS uid, u.email, d.id AS did, d.device_uid, d.display_name, d.last_lat, d.last_lng FROM users u LEFT JOIN devices d ON d.owner_id=u.id ORDER BY u.id, d.id;"
