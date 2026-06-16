-- Phase A: 사용자 프로필 확장 + 디바이스 메타(color/icon) + 알림 설정 per-user

-- ── users: 보조번호, 권한 ────────────────────────────────────────────
ALTER TABLE users ADD COLUMN IF NOT EXISTS secondary_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
-- role 가능 값: 'user' | 'admin'

-- ── devices: 색상/아이콘 메타 (앱 간 동기화) ────────────────────────
ALTER TABLE devices ADD COLUMN IF NOT EXISTS color TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS icon  TEXT;

-- ── 알림 설정 per-user ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notification_settings (
    user_id                BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    motion_alert           BOOLEAN  NOT NULL DEFAULT TRUE,
    low_batt_alert         BOOLEAN  NOT NULL DEFAULT TRUE,
    offline_alert          BOOLEAN  NOT NULL DEFAULT TRUE,
    geofence_alert         BOOLEAN  NOT NULL DEFAULT TRUE,
    low_batt_threshold_mv  INTEGER  NOT NULL DEFAULT 3500,
    offline_minutes        INTEGER  NOT NULL DEFAULT 30,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
