-- 데이터 격리 방어선 — device-bound 테이블에 created_by_user_id (생성 시점 소유자)
-- 추가. 새 owner 가 페어링해도 이전 user_id 의 행은 안 보임. 본인 재페어링 시 자동 복구.
--
-- 영향 받는 테이블:
--   location_records  : 위치 raw — 이전 owner 의 이동 이력 노출 차단
--   events            : sleep/wake/지오펜스/저전압 등 — 이전 owner 의 운영 패턴 차단
--   daily_stats       : 운행 통계 집계 — 동일
--   geofences         : 사용자 정의 펜스 (이름·위치) — PII 노출 차단
--   trip_annotations  : 운전자 이름·유류·메모 — PII 노출 차단
--
-- backfill: 기존 row 는 현재 devices.owner_id 로 초기 셋. 배포 후 재페어링부터 깨끗.

-- ─── 1) 컬럼 추가 ────────────────────────────────────────
ALTER TABLE location_records  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE events            ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE daily_stats       ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE geofences         ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE trip_annotations  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

-- ─── 2) backfill ─────────────────────────────────────────
UPDATE location_records lr SET user_id = d.owner_id
  FROM devices d
 WHERE lr.device_id = d.id AND lr.user_id IS NULL AND d.owner_id IS NOT NULL;

UPDATE events e SET user_id = d.owner_id
  FROM devices d
 WHERE e.device_id = d.id AND e.user_id IS NULL AND d.owner_id IS NOT NULL;

UPDATE daily_stats s SET user_id = d.owner_id
  FROM devices d
 WHERE s.device_id = d.id AND s.user_id IS NULL AND d.owner_id IS NOT NULL;

UPDATE geofences g SET user_id = d.owner_id
  FROM devices d
 WHERE g.device_id = d.id AND g.user_id IS NULL AND d.owner_id IS NOT NULL;

UPDATE trip_annotations a SET user_id = d.owner_id
  FROM devices d
 WHERE a.device_id = d.id AND a.user_id IS NULL AND d.owner_id IS NOT NULL;

-- ─── 3) trip_annotations UNIQUE 키 재구성 ───────────────
-- 기존: (device_id, trip_started_at) → 동일 디바이스에 다른 owner 가 같은
-- 타임스탬프로 INSERT 시도 시 ON CONFLICT 가 다른 사용자 row 를 덮어씀.
-- 신규: (device_id, user_id, trip_started_at) — 사용자별 독립 row.
ALTER TABLE trip_annotations
    DROP CONSTRAINT IF EXISTS trip_annotations_device_id_trip_started_at_key;
ALTER TABLE trip_annotations
    ADD CONSTRAINT trip_annotations_device_user_time_key
        UNIQUE (device_id, user_id, trip_started_at);

-- ─── 4) 조회 인덱스 (user_id + 시간순) ───────────────────
CREATE INDEX IF NOT EXISTS idx_location_records_user_time
    ON location_records(user_id, recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_time
    ON events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_daily_stats_user_date
    ON daily_stats(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_geofences_user
    ON geofences(user_id);
CREATE INDEX IF NOT EXISTS idx_trip_anno_user_time
    ON trip_annotations(user_id, trip_started_at DESC);
