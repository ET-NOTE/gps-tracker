#!/usr/bin/env bash
: ${PGPASSWORD:?PGPASSWORD required — see docs/local-dev-setup.md}
PSQL="psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker"

echo "=== admin@admin.com user/devices/tokens ==="
$PSQL -c "
SELECT u.id AS uid, u.email,
       (SELECT COUNT(*) FROM devices d WHERE d.owner_id=u.id) AS devices,
       (SELECT COUNT(*) FROM fcm_tokens t WHERE t.user_id=u.id AND t.active) AS active_tokens,
       (SELECT MAX(created_at) FROM fcm_tokens t WHERE t.user_id=u.id) AS last_token_at
FROM users u WHERE u.email='admin@admin.com';"

echo
echo "=== latest events for admin's devices ==="
$PSQL -c "
SELECT e.id, e.device_id, e.kind, e.occurred_at, e.notified_at, e.data->>'_test' AS test
FROM events e
JOIN devices d ON d.id=e.device_id
JOIN users u ON u.id=d.owner_id
WHERE u.email='admin@admin.com'
ORDER BY e.id DESC LIMIT 5;"

echo
echo "=== latest 'fcm:' worker logs ==="
sudo journalctl -u gps-tracker-api -n 200 --no-pager | grep -E "fcm:|fcm worker" | tail -10
