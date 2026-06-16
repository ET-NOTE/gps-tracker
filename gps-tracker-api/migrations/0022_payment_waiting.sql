-- 가상계좌 발급-후-입금 흐름을 위해 'waiting' 상태 추가.
-- 흐름:
--   pending  → user 가 결제 시도 중 (init 직후)
--   waiting  → 가상계좌 발급 완료, 사용자가 아직 입금 안 함
--   confirmed → 결제·입금 완료, 크레딧 적립
--   failed   / cancelled → 그대로
ALTER TABLE payment_orders DROP CONSTRAINT IF EXISTS payment_orders_status_check;
ALTER TABLE payment_orders ADD CONSTRAINT payment_orders_status_check
    CHECK (status IN ('pending','waiting','confirmed','failed','cancelled'));

-- 가상계좌 발급 정보 — confirmed_at 와 별도로 발급 시점 보관 (UI 에서 만료시각 안내 위함)
ALTER TABLE payment_orders
    ADD COLUMN IF NOT EXISTS virtual_account_info JSONB,
    ADD COLUMN IF NOT EXISTS issued_at            TIMESTAMPTZ;
