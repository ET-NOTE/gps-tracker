-- 크레딧 충전 요청 (사용자 → 관리자 수락 → 사용자 잔액 +amount)
-- 추후 PG 연동 시 payment_method='pg_toss' 등으로 자동화 가능, 그 경우 status 가
-- 결제 webhook 에서 'approved' 로 자동 변경. 현재는 관리자 수동 수락만.
CREATE TABLE IF NOT EXISTS credit_topup_requests (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount          BIGINT NOT NULL CHECK (amount > 0),
    status          TEXT   NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','approved','rejected','cancelled')),
    payment_method  TEXT,                              -- 'manual_admin' (현행) | 'pg_toss' | 'pg_kakao' (TODO)
    payment_ref     TEXT,                              -- PG 거래번호 등 외부 식별자 (TODO)
    note            TEXT,                              -- 사용자 메모 또는 관리자 메모
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    processed_by    BIGINT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_credit_topup_user
    ON credit_topup_requests(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_topup_status
    ON credit_topup_requests(status, requested_at DESC);
