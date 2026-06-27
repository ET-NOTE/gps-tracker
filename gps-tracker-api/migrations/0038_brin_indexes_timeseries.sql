-- 시계열 쿼리 가속 — BRIN index.
-- BRIN (Block Range INdex) 은 row 가 시간순으로 insert 되는 시계열 데이터에 최적.
-- B-Tree 대비 ~1/100 크기 + range scan 빠름. SELECT WHERE recorded_at > $1 패턴에 효과 큼.
--
-- 영향: 디스크 부담 미미 (BRIN 자체가 매우 작음), VACUUM/INSERT 속도 거의 변화 없음.
-- DiagnosticPage 의 batch_stats, Dashboard 의 today carry-over, listLocations(since=...) 등에 효과.

CREATE INDEX IF NOT EXISTS location_records_recorded_at_brin
    ON location_records USING BRIN (recorded_at);

CREATE INDEX IF NOT EXISTS events_occurred_at_brin
    ON events USING BRIN (occurred_at);

-- 통계 갱신 — query planner 가 새 index 활용하도록.
ANALYZE location_records;
ANALYZE events;
