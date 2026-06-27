-- "사이클 내 첫 fix" 알림 (외출 → motion wake → 첫 좌표 잡힘 시점).
-- 매 wake 후 GPS fix 가 처음 도달한 1회만 FCM 발송.
--
-- 트리거 흐름:
--   1. lifecycle wake event → devices.cycle_first_fix_pending = TRUE 마킹
--   2. 다음 POST 중 fix=true 도착 → events(kind='cycle_first_fix') insert + pending=FALSE atomic 토글
--   3. fcm worker 가 ns.cycle_first_fix_alert 체크 후 발송

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS cycle_first_fix_pending BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE notification_settings
    ADD COLUMN IF NOT EXISTS cycle_first_fix_alert BOOLEAN NOT NULL DEFAULT FALSE;
