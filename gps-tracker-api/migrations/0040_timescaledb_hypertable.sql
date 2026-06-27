-- TimescaleDB migration — partitioned table → hypertable.
--
-- 효과:
--   1. Native column-store compression (10~20x) — 7일 이전 chunk 자동 compress.
--   2. Retention policy — 1년 이전 chunk 자동 drop.
--   3. Continuous aggregates 가능 (별도 migration).
--
-- 사전 조건 (VPS 에 이미 확인됨):
--   - shared_preload_libraries = timescaledb 설정됨 (PG restart 불필요)
--   - timescaledb 2.19.3 extension 시스템에 install 됨
--   - 같은 instance 의 다른 DB 에서 production 사용 중 — 검증된 상태
--
-- 마이그레이션 흐름 (atomic, DDL transaction):
--   1. CREATE EXTENSION
--   2. 새 hypertable 만들기 (7일 chunk).
--   3. partitioned table → hypertable data copy.
--   4. swap (RENAME).
--   5. 옛 partitioned + 13 monthly partitions + legacy 모두 DROP CASCADE.
--   6. Indexes / FK 재생성.
--   7. Compression policy (7일).
--   8. Retention policy (1년).

-- 1. Extension.
CREATE EXTENSION IF NOT EXISTS timescaledb;

-- 2. 새 hypertable.
CREATE TABLE location_records_ts (
    device_id        BIGINT             NOT NULL,
    recorded_at      TIMESTAMPTZ        NOT NULL,
    device_uptime_s  INTEGER,
    source           TEXT               NOT NULL,
    fix              BOOLEAN            NOT NULL,
    lat              DOUBLE PRECISION,
    lng              DOUBLE PRECISION,
    sat              SMALLINT,
    ttff_s           INTEGER,
    csq              SMALLINT,
    reg              SMALLINT,
    vbat_mv          INTEGER,
    raw              JSONB,
    user_id          BIGINT,
    heading          REAL,
    PRIMARY KEY (device_id, recorded_at, source)
);

-- 2-1. hypertable 변환 — 7일 chunk (TimescaleDB best practice).
--      partition column 은 PK 에 포함되어야 함 (이미 OK).
SELECT create_hypertable('location_records_ts', 'recorded_at',
    chunk_time_interval => INTERVAL '7 days',
    if_not_exists => TRUE);

-- 3. data copy — partitioned table 의 모든 row.
INSERT INTO location_records_ts (
    device_id, recorded_at, device_uptime_s, source, fix, lat, lng, sat,
    ttff_s, csq, reg, vbat_mv, raw, user_id, heading
)
SELECT device_id, recorded_at, device_uptime_s, source, fix, lat, lng, sat,
       ttff_s, csq, reg, vbat_mv, raw, user_id, heading
  FROM location_records;

-- 4. swap.
ALTER TABLE location_records         RENAME TO location_records_partitioned_old;
ALTER TABLE location_records_ts      RENAME TO location_records;

-- 5. 옛 정리 — partitioned_old (13 monthly partition + default 포함) + legacy 모두 DROP.
DROP TABLE IF EXISTS location_records_partitioned_old CASCADE;
DROP TABLE IF EXISTS location_records_legacy           CASCADE;

-- 6. FK + 추가 indexes 재생성 (PK 는 hypertable 안에서 이미 존재).
ALTER TABLE location_records
    ADD CONSTRAINT location_records_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE CASCADE;
ALTER TABLE location_records
    ADD CONSTRAINT location_records_user_id_fkey
    FOREIGN KEY (user_id)   REFERENCES users(id)   ON DELETE SET NULL;

CREATE INDEX idx_location_records_user_time
    ON location_records (user_id, recorded_at DESC);
CREATE INDEX location_device_recent_idx
    ON location_records (device_id, recorded_at DESC);
CREATE INDEX location_fix_recent
    ON location_records (device_id, recorded_at DESC) WHERE fix = true;

-- 7. Compression policy — 7일 이전 chunk 자동 compress.
--    segmentby = device_id 로 device 별 contiguous column-store. 시계열 압축 최적.
--    expected ratio 10~20x.
ALTER TABLE location_records SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'device_id',
    timescaledb.compress_orderby   = 'recorded_at DESC'
);
SELECT add_compression_policy('location_records', INTERVAL '7 days', if_not_exists => TRUE);

-- 8. Retention policy — 1년 이전 chunk 자동 drop.
--    조정 방법: SELECT remove_retention_policy('location_records');
--              SELECT add_retention_policy('location_records', INTERVAL '6 months');
SELECT add_retention_policy('location_records', INTERVAL '1 year', if_not_exists => TRUE);

ANALYZE location_records;
