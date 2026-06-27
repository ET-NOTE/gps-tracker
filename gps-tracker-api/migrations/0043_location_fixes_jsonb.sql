-- Phase 6A: 1 POST = 1 row + fixes_jsonb 로 storage 전환을 위한 column 추가.
--
-- 현재 (1 POST = N fix → N row) 와 병행 가능하도록 NULL 허용.
--   - Phase 6B: ingest dual-write (column + jsonb 둘 다 채움)
--   - Phase 6C: query 시 jsonb 있으면 우선 사용
--   - Phase 6D: ingest single-write (batch 면 1 row + jsonb 만)
--
-- compression 14.1× 위에 INSERT 횟수 1/30 절감 효과. raw 컬럼 (lat/lng/sat/recorded_at)
-- 도 마지막 fix 만 채워서 devices.last_lat 등 trigger 호환 유지.

-- jsonb array 형식 (예):
--   [
--     {"at_ms": 0,     "lat": 36.123, "lng": 127.456, "sat": 9},
--     {"at_ms": 1023,  "lat": 36.124, "lng": 127.457, "sat": 9},
--     ...
--   ]
-- at_ms 는 recorded_at 으로부터의 음의 offset (가장 오래된 fix 가 최대값).
ALTER TABLE location_records
    ADD COLUMN IF NOT EXISTS fixes_jsonb jsonb NULL;

-- 진단/디버깅 — fixes_jsonb 가 채워진 row 의 비율 추적 가능.
COMMENT ON COLUMN location_records.fixes_jsonb IS
    'Phase 6: 1 POST 의 모든 fix array. NULL = legacy (1 fix = 1 row) path. '
    '6B (dual-write) 진행 후 점차 NOT NULL 증가, 6D 진행 후 batch row 는 항상 NOT NULL.';
