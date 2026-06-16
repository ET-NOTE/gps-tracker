-- 결제 주문 (Toss Payments).
-- init 시 row 생성 → 사용자가 Toss UI 에서 결제 → 우리 successUrl 콜백 → confirm 호출 → 크레딧 적립.
-- 실패/이탈 시 status='failed'/'cancelled', 환불 없음 (애초에 차감도 없으므로).
CREATE TABLE IF NOT EXISTS payment_orders (
    id           BIGSERIAL PRIMARY KEY,
    order_id     TEXT UNIQUE NOT NULL,         -- 우리가 생성한 외부 노출 ID (ord_abc123...)
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount       BIGINT NOT NULL CHECK (amount > 0),
    currency     TEXT   NOT NULL DEFAULT 'KRW',
    provider     TEXT   NOT NULL DEFAULT 'toss',
    status       TEXT   NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','confirmed','failed','cancelled')),
    payment_key  TEXT,                          -- Toss paymentKey (confirm 후 채움)
    method       TEXT,                          -- '카드' / '간편결제' 등
    receipt_url  TEXT,
    raw_response JSONB,                         -- Toss API 응답 원본 (디버그/감사)
    fail_reason  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_payment_orders_user
    ON payment_orders(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_orders_status
    ON payment_orders(status, created_at DESC);
