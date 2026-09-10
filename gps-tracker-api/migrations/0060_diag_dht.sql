-- DHT11 온습도 진단 타임시리즈 (2026-09-10 UNO+SIM7080G 쉴드 야간 시험).
-- 임시 계측 테이블 — 위치/개인정보 없음, 익명 ingest.
CREATE TABLE IF NOT EXISTS diag_dht (
    id          BIGSERIAL PRIMARY KEY,
    device_uid  TEXT NOT NULL,
    temp_c      REAL,
    hum_pct     REAL,
    up_ms       BIGINT,
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_diag_dht_recorded ON diag_dht (recorded_at DESC);
