-- Continuous aggregates — DiagnosticPage / historical chart 가속.
--
-- 1분 평균 + 1시간 평균 두 view. 시간 범위에 따라 raw / 1min / 1hour 선택:
--   - 1일 이하    → raw
--   - 1주일 이하  → location_1min
--   - 1주일 초과  → location_1hour
--
-- Refresh policy: 매 5분/30분 마다 새 데이터 자동 반영.

-- 1분 평균 — fix=true 만 집계 (no-fix POST 는 분석 가치 없음).
CREATE MATERIALIZED VIEW location_1min
WITH (timescaledb.continuous) AS
SELECT
    device_id,
    time_bucket(INTERVAL '1 minute', recorded_at) AS bucket,
    AVG(lat)      AS lat_avg,
    AVG(lng)      AS lng_avg,
    last(lat,  recorded_at) AS lat_last,
    last(lng,  recorded_at) AS lng_last,
    AVG(sat)::real      AS sat_avg,
    AVG(vbat_mv)::int   AS vbat_avg,
    COUNT(*)            AS fix_count
FROM location_records
WHERE fix = true
GROUP BY device_id, bucket
WITH NO DATA;

-- 1시간 평균 — raw 에서 직접 (TimescaleDB 의 hierarchical aggregate 가 time_bucket 인식 제약 있어 raw scan).
CREATE MATERIALIZED VIEW location_1hour
WITH (timescaledb.continuous) AS
SELECT
    device_id,
    time_bucket(INTERVAL '1 hour', recorded_at) AS bucket,
    AVG(lat)      AS lat_avg,
    AVG(lng)      AS lng_avg,
    last(lat,  recorded_at) AS lat_last,
    last(lng,  recorded_at) AS lng_last,
    AVG(sat)::real      AS sat_avg,
    AVG(vbat_mv)::int   AS vbat_avg,
    COUNT(*)            AS fix_count
FROM location_records
WHERE fix = true
GROUP BY device_id, bucket
WITH NO DATA;

-- Refresh policy.
--   start_offset = 어디까지 과거 데이터를 갱신할 것인가
--   end_offset   = 얼마나 최근까지 (1분 = 거의 실시간)
--   schedule_interval = 얼마나 자주 갱신 task 실행
SELECT add_continuous_aggregate_policy('location_1min',
    start_offset      => INTERVAL '7 days',
    end_offset        => INTERVAL '1 minute',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists     => TRUE);

SELECT add_continuous_aggregate_policy('location_1hour',
    start_offset      => INTERVAL '30 days',
    end_offset        => INTERVAL '1 hour',
    schedule_interval => INTERVAL '30 minutes',
    if_not_exists     => TRUE);

-- 초기 데이터 — refresh policy 가 5분 / 30분 주기로 자동 채움. 즉시 채우려면 prod 에서 직접:
--   CALL refresh_continuous_aggregate('location_1min',  NULL, NULL);
--   CALL refresh_continuous_aggregate('location_1hour', NULL, NULL);
-- (refresh_continuous_aggregate 는 transaction 밖에서만 가능 → migration 안에서 못 함)
