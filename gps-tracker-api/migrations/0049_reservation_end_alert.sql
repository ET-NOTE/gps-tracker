-- (2026-07-28) Stage-4H-2: 반납 임박 알림 dedup 컬럼.
-- 4H-1 의 alerted_at 은 시작 알림용. 종료 알림은 별도 컬럼.

ALTER TABLE vehicle_reservations
    ADD COLUMN IF NOT EXISTS ended_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN vehicle_reservations.ended_alerted_at
    IS '반납 임박 알림 event 발행 시각. NULL = 미발행.';

CREATE INDEX IF NOT EXISTS vehicle_reservations_end_alerting_idx
    ON vehicle_reservations(ends_at)
    WHERE status IN ('planned','in_progress') AND ended_alerted_at IS NULL;
