-- 1NCE order 상세 정보를 한 번만 가져와 캐시.
-- order_number, invoice_number, invoice_amount 등은 한 번 발급되면 불변이라
-- admin 이 "1NCE 조회" 누를 때마다 1NCE 호출할 필요 없음.
ALTER TABLE sim_topup_requests
    ADD COLUMN IF NOT EXISTS order_info        JSONB,
    ADD COLUMN IF NOT EXISTS order_fetched_at  TIMESTAMPTZ;
