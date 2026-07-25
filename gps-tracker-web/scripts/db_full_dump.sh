#!/usr/bin/env bash
: ${PGPASSWORD:?PGPASSWORD required — see docs/local-dev-setup.md}
PSQL="psql -U gps_tracker_app -h 127.0.0.1 -d gps_tracker"

echo "=================================================="
echo "  ALL USERS"
echo "=================================================="
$PSQL -c "SELECT id, email, display_name, secondary_phone, role, created_at FROM users ORDER BY id;"

echo
echo "=================================================="
echo "  admin@admin.com 상세"
echo "=================================================="
$PSQL -c "SELECT * FROM users WHERE email='admin@admin.com';"

echo
echo "=================================================="
echo "  admin@admin.com 의 디바이스"
echo "=================================================="
$PSQL -c "SELECT id, device_uid, display_name, color, last_seen_at, last_lat, last_lng FROM devices WHERE owner_id=(SELECT id FROM users WHERE email='admin@admin.com');"

echo
echo "=================================================="
echo "  ALL FCM TOKENS (전체)"
echo "=================================================="
$PSQL -c "SELECT id, user_id, platform, length(token) AS tlen, active, created_at FROM fcm_tokens ORDER BY created_at DESC;"

echo
echo "=================================================="
echo "  admin@admin.com 의 FCM 토큰만"
echo "=================================================="
$PSQL -c "SELECT id, user_id, platform, length(token) AS tlen, active, created_at FROM fcm_tokens WHERE user_id=(SELECT id FROM users WHERE email='admin@admin.com');"

echo
echo "=================================================="
echo "  refresh_tokens for admin@admin.com (활성 세션 갯수)"
echo "=================================================="
$PSQL -c "SELECT COUNT(*) AS active_sessions FROM refresh_tokens WHERE user_id=(SELECT id FROM users WHERE email='admin@admin.com') AND revoked_at IS NULL AND expires_at > now();"

echo
echo "=================================================="
echo "  최근 events (admin 디바이스만)"
echo "=================================================="
$PSQL -c "SELECT e.id, e.device_id, e.kind, e.occurred_at, e.notified_at FROM events e JOIN devices d ON d.id=e.device_id JOIN users u ON u.id=d.owner_id WHERE u.email='admin@admin.com' ORDER BY e.id DESC LIMIT 5;"

echo
echo "=================================================="
echo "  notification_settings (admin)"
echo "=================================================="
$PSQL -c "SELECT * FROM notification_settings WHERE user_id=(SELECT id FROM users WHERE email='admin@admin.com');"
