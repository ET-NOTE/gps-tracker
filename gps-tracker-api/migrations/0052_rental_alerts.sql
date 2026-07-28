-- (2026-07-28) Stage-R3: 렌트카 반납 임박 · 연체 알림 dedup 컬럼.
--
-- 두 종류 알림:
--   ending_alerted_at   반납 24시간 전 임박 알림 (1회)
--   overdue_alerted_at  연체 발생 첫 알림 (1회)

ALTER TABLE rental_contracts
    ADD COLUMN IF NOT EXISTS ending_alerted_at  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS overdue_alerted_at TIMESTAMPTZ;

COMMENT ON COLUMN rental_contracts.ending_alerted_at  IS '반납 24h 전 알림 event 발행 시각';
COMMENT ON COLUMN rental_contracts.overdue_alerted_at IS '연체 첫 알림 event 발행 시각';

CREATE INDEX IF NOT EXISTS rental_contracts_ending_alerting_idx
    ON rental_contracts(ends_at)
    WHERE status IN ('draft','active') AND ending_alerted_at IS NULL;
CREATE INDEX IF NOT EXISTS rental_contracts_overdue_alerting_idx
    ON rental_contracts(ends_at)
    WHERE status = 'overdue' AND overdue_alerted_at IS NULL;
