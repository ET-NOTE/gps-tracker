-- Phase D Round 1: 운행 통계 일별 집계
-- 매 시간 워커가 location_records 의 fix=true 점들을 디바이스/날짜별로 집계.

CREATE TABLE IF NOT EXISTS daily_stats (
    device_id        BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    date             DATE   NOT NULL,                  -- KST 기준 날짜
    fix_count        INTEGER NOT NULL DEFAULT 0,
    distance_m       DOUBLE PRECISION NOT NULL DEFAULT 0,    -- 누적 이동거리 (haversine)
    duration_s       INTEGER NOT NULL DEFAULT 0,        -- 첫 fix ~ 마지막 fix 경과
    moving_s         INTEGER NOT NULL DEFAULT 0,        -- 이동(stop 제외) 시간 추정
    stop_count       INTEGER NOT NULL DEFAULT 0,        -- 정지 구간 수 (5분+ 머무름)
    max_speed_kmh    REAL NOT NULL DEFAULT 0,
    avg_speed_kmh    REAL NOT NULL DEFAULT 0,
    first_fix_at     TIMESTAMPTZ,
    last_fix_at      TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (device_id, date)
);
CREATE INDEX IF NOT EXISTS daily_stats_date_idx ON daily_stats(date DESC);
