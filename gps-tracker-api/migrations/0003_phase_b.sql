-- Phase B: 지오펜스 + 통신 두절 자동 감지

-- 지오펜스 영역 정의
CREATE TABLE IF NOT EXISTS geofences (
    id          BIGSERIAL PRIMARY KEY,
    owner_id    BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    -- device_id NULL = owner의 모든 디바이스에 적용. 특정 디바이스만은 device_id 지정.
    device_id   BIGINT          REFERENCES devices(id) ON DELETE CASCADE,
    name        TEXT   NOT NULL,
    center_lat  DOUBLE PRECISION NOT NULL,
    center_lng  DOUBLE PRECISION NOT NULL,
    radius_m    INTEGER NOT NULL CHECK (radius_m > 0),
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geofences_owner_idx ON geofences(owner_id) WHERE active;

-- (geofence, device) 별 in/out 상태 — enter/exit 트랜지션 감지용
CREATE TABLE IF NOT EXISTS geofence_states (
    geofence_id        BIGINT NOT NULL REFERENCES geofences(id) ON DELETE CASCADE,
    device_id          BIGINT NOT NULL REFERENCES devices(id)   ON DELETE CASCADE,
    inside             BOOLEAN NOT NULL,
    last_transition_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (geofence_id, device_id)
);
