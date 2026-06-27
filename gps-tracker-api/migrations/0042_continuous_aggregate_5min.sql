-- 5분 평균 — DiagnosticPage / SeekerSheet 에서 day 모드 (24h) 의 중간 간격으로 활용.
-- 1m (1440/day) 과 1h (24/day) 사이 5m (288/day) — 너무 dense 도 sparse 도 아닌 sweet spot.

CREATE MATERIALIZED VIEW location_5min
WITH (timescaledb.continuous) AS
SELECT
    device_id,
    time_bucket(INTERVAL '5 minutes', recorded_at) AS bucket,
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

SELECT add_continuous_aggregate_policy('location_5min',
    start_offset      => INTERVAL '14 days',
    end_offset        => INTERVAL '5 minutes',
    schedule_interval => INTERVAL '15 minutes',
    if_not_exists     => TRUE);
