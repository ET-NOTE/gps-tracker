-- Monthly partitioning — location_records 를 RANGE (recorded_at) 로 분할.
-- 효과:
--   1. drop partition 으로 옛 데이터 즉시 디스크 회수 (lock-free, ms 단위).
--   2. partition pruning 으로 쿼리 가속 (시간 범위 검색 시 관련 partition 만 scan).
--   3. autovacuum 부담 분산 (partition 별로).
--
-- 마이그레이션 흐름 (atomic, DDL transaction 안):
--   1. 새 partitioned table 만들기.
--   2. 월별 partition (지난 6개월 + 현재 + 미래 6개월) 미리 생성.
--   3. 기존 데이터 copy (INSERT INTO ... SELECT *).
--   4. swap (RENAME).
--   5. indexes / PK / FK 재생성 (partition 마다 자동 inherit).
--
-- 향후 partition 자동 생성: services/partition_worker.rs 가 매일 다음 월 partition 미리 만듦.

-- 1. 새 partitioned table (PK 의 partition column 포함 필수: recorded_at).
CREATE TABLE location_records_new (
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
    heading          REAL
) PARTITION BY RANGE (recorded_at);

-- 2. 월별 partition 미리 생성 (지난 6개월 + 현재 + 미래 6개월).
DO $$
DECLARE
  m_start DATE;
  m_end   DATE;
  pname   TEXT;
BEGIN
  FOR i IN -6..6 LOOP
    m_start := date_trunc('month', CURRENT_DATE + (i || ' month')::interval);
    m_end   := m_start + INTERVAL '1 month';
    pname   := format('location_records_y%sm%s',
                       to_char(m_start, 'YYYY'),
                       to_char(m_start, 'MM'));
    EXECUTE format(
      'CREATE TABLE IF NOT EXISTS %I PARTITION OF location_records_new FOR VALUES FROM (%L) TO (%L)',
      pname, m_start, m_end
    );
  END LOOP;
END $$;

-- 2-1. default partition — partition worker 가 새 partition 못 만들었을 때 fallback.
--      장기 운영 안전망. retention 정책상 default 가 채워지면 alert.
CREATE TABLE IF NOT EXISTS location_records_default
    PARTITION OF location_records_new DEFAULT;

-- 3. 기존 데이터 copy.
INSERT INTO location_records_new
    SELECT device_id, recorded_at, device_uptime_s, source, fix, lat, lng, sat,
           ttff_s, csq, reg, vbat_mv, raw, user_id, heading
      FROM location_records;

-- 4. swap.
ALTER TABLE location_records         RENAME TO location_records_legacy;
ALTER TABLE location_records_new     RENAME TO location_records;

-- 4-1. legacy 의 indexes / constraints 정리 — 이름이 schema-wide unique 라 새 table 의 같은 이름 충돌 방지.
--      legacy 데이터 자체는 보존 (검증 후 별도 migration 에서 DROP TABLE).
ALTER TABLE location_records_legacy DROP CONSTRAINT IF EXISTS location_records_pkey;
ALTER TABLE location_records_legacy DROP CONSTRAINT IF EXISTS location_records_device_id_fkey;
ALTER TABLE location_records_legacy DROP CONSTRAINT IF EXISTS location_records_user_id_fkey;
DROP INDEX IF EXISTS idx_location_records_user_time;
DROP INDEX IF EXISTS location_device_recent_idx;
DROP INDEX IF EXISTS location_fix_recent;
DROP INDEX IF EXISTS location_records_recorded_at_brin;

-- 5. PK + indexes + FK 재생성. partition table 의 PK 는 partition column 포함 필수.
ALTER TABLE location_records
    ADD PRIMARY KEY (device_id, recorded_at, source);
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
CREATE INDEX location_records_recorded_at_brin
    ON location_records USING BRIN (recorded_at);

ANALYZE location_records;

-- 6. legacy 보존 — 검증 후 별도 migration 에서 DROP TABLE location_records_legacy.
--    혹시 마이그레이션 후 데이터 누락 발견 시 복구 가능.
