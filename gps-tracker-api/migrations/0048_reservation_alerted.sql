-- (2026-07-28) Stage-4H-1: 예약 임박 알림 워커용 중복 방지 컬럼.
-- alerted_at IS NULL 이 대상. worker 가 event 발생 후 NOW() 로 set → 재알림 skip.

ALTER TABLE vehicle_reservations
    ADD COLUMN IF NOT EXISTS alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN vehicle_reservations.alerted_at
    IS '임박 알림 event 발행 시각. NULL = 미발행. 중복 방지용.';

-- 워커 hot path 인덱스: NULL + planned status + 시간 범위 스캔.
CREATE INDEX IF NOT EXISTS vehicle_reservations_alerting_idx
    ON vehicle_reservations(starts_at)
    WHERE status = 'planned' AND alerted_at IS NULL;
