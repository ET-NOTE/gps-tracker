-- gps_tracker 초기 스키마
-- PostgreSQL 14+ 가정. CITEXT 확장 활성화 (대소문자 무시 이메일).
-- 실행: psql -d gps_tracker -f 0001_init.sql

CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────────────────────────────────────────────────────
-- users : 앱 사용자
-- ───────────────────────────────────────────────────────────
CREATE TABLE users (
    id            BIGSERIAL    PRIMARY KEY,
    email         CITEXT       UNIQUE NOT NULL,
    password_hash TEXT         NOT NULL,                -- argon2id
    display_name  TEXT,
    role          TEXT         NOT NULL DEFAULT 'user', -- user | admin
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX users_role_idx ON users(role);

-- ───────────────────────────────────────────────────────────
-- devices : ESP32 트래커 (사용자가 paired)
-- ───────────────────────────────────────────────────────────
CREATE TABLE devices (
    id            BIGSERIAL    PRIMARY KEY,
    device_uid    TEXT         UNIQUE NOT NULL,         -- ESP MAC 또는 자체 ID
    owner_id      BIGINT       REFERENCES users(id) ON DELETE SET NULL,
    api_key_hash  TEXT         NOT NULL,                -- bcrypt/argon2 해시 (ESP 인증)
    display_name  TEXT,
    hw_version    TEXT,
    fw_version    TEXT,
    last_seen_at  TIMESTAMPTZ,
    last_lat      DOUBLE PRECISION,
    last_lng      DOUBLE PRECISION,
    last_fix_at   TIMESTAMPTZ,
    paired_at     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX devices_owner_idx     ON devices(owner_id);
CREATE INDEX devices_last_seen_idx ON devices(last_seen_at DESC);

-- ───────────────────────────────────────────────────────────
-- location_records : 시계열 위치 데이터
-- 핵심 쿼리: "device X의 최근 N건"
-- ───────────────────────────────────────────────────────────
CREATE TABLE location_records (
    device_id        BIGINT       NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    recorded_at      TIMESTAMPTZ  NOT NULL,             -- 서버 수신 시각 (UTC)
    device_uptime_s  INT,                               -- ESP boot 후 초
    source           TEXT         NOT NULL,             -- 'l80' | 'lte_gnss'
    fix              BOOLEAN      NOT NULL,
    lat              DOUBLE PRECISION,
    lng              DOUBLE PRECISION,
    sat              SMALLINT,
    ttff_s           INT,                               -- time to first fix
    csq              SMALLINT,
    reg              SMALLINT,
    vbat_mv          INT,
    raw              JSONB,                             -- 원본 payload (디버그용)
    PRIMARY KEY (device_id, recorded_at, source)
);

-- 가장 빈번한 쿼리: "최근 위치"
CREATE INDEX location_device_recent_idx
    ON location_records (device_id, recorded_at DESC);

-- (선택) 옵션: PostGIS 활성 시 공간 인덱스. 처음에는 생략, 필요해지면 추가.
-- CREATE EXTENSION IF NOT EXISTS postgis;
-- ALTER TABLE location_records
--     ADD COLUMN geom GEOGRAPHY(POINT, 4326)
--     GENERATED ALWAYS AS (ST_MakePoint(lng, lat)::geography) STORED;
-- CREATE INDEX location_geom_idx ON location_records USING GIST(geom);

-- ───────────────────────────────────────────────────────────
-- fcm_tokens : 푸시 알림 토큰
-- ───────────────────────────────────────────────────────────
CREATE TABLE fcm_tokens (
    id           BIGSERIAL    PRIMARY KEY,
    user_id      BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token        TEXT         UNIQUE NOT NULL,
    platform     TEXT         NOT NULL,                 -- 'android' | 'ios'
    app_version  TEXT,
    active       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_used_at TIMESTAMPTZ,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX fcm_user_active_idx ON fcm_tokens(user_id) WHERE active;

-- ───────────────────────────────────────────────────────────
-- events : 디바이스 이벤트 (모션 wake, 알림 트리거)
-- ───────────────────────────────────────────────────────────
CREATE TABLE events (
    id           BIGSERIAL    PRIMARY KEY,
    device_id    BIGINT       NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    occurred_at  TIMESTAMPTZ  NOT NULL,
    kind         TEXT         NOT NULL,                 -- 'motion','wake','sleep','low_batt','fix_lost'
    data         JSONB,
    notified_at  TIMESTAMPTZ,                           -- FCM 발송 완료 시각
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX events_device_idx       ON events(device_id, occurred_at DESC);
CREATE INDEX events_unnotified_idx   ON events(kind, occurred_at) WHERE notified_at IS NULL;

-- ───────────────────────────────────────────────────────────
-- refresh_tokens : JWT refresh 토큰 (revoke 가능하게 DB 저장)
-- ───────────────────────────────────────────────────────────
CREATE TABLE refresh_tokens (
    id          BIGSERIAL    PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash  TEXT         UNIQUE NOT NULL,           -- 해시만 저장 (raw 토큰은 노출 X)
    user_agent  TEXT,
    issued_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ  NOT NULL,
    revoked_at  TIMESTAMPTZ
);
CREATE INDEX refresh_user_idx ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX refresh_expires_idx ON refresh_tokens(expires_at);

-- ───────────────────────────────────────────────────────────
-- updated_at 자동 갱신 트리거
-- ───────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION trg_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION trg_updated_at();
