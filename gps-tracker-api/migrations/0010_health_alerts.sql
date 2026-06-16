-- Round 4: 디바이스 건강 알림 + 무응답 감지

-- 알림 설정에 'device_health_alert' (brownout / gps_anomaly) 와
-- 'lost_alert' (sleep 후 24h+ 무응답) 추가.
ALTER TABLE notification_settings
    ADD COLUMN IF NOT EXISTS device_health_alert BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS lost_alert          BOOLEAN NOT NULL DEFAULT TRUE;

-- 디바이스에 마지막 본 brownouts/no_fix_cycles 카운터를 캐시
-- (이번 페이로드 diag 와 비교해서 증가분만 알림으로 띄우기 위함).
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS rtc_brownouts        INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rtc_no_fix_cycles    INTEGER NOT NULL DEFAULT 0;
