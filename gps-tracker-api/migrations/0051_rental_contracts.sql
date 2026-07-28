-- (2026-07-28) Stage-R1: 렌트카 계약 (렌트카 계정 전용).
--
-- 임차인 개인정보 최소화 (PIPA): 이름 + 전화번호 + 신분증 뒤4자리 hash 만.
-- 신분증 원본은 저장 X. renter_id_last4 는 상시 조회용 hash (SHA-256(prefix + last4)).
--
-- status 전이:
--   draft      → active (사용자 확정)
--   active     → returned (반납 처리 시)
--            ↘  overdue  (ends_at <= NOW 이고 status=active 인 채로) — worker 가 자동
--   *          → cancelled (사용자 취소)

CREATE TABLE IF NOT EXISTS rental_contracts (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    device_id           BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,

    -- 임차인 (PIPA 최소화)
    renter_name         TEXT   NOT NULL,
    renter_phone        TEXT,                 -- 010-....
    renter_id_last4     TEXT,                 -- 신분증 뒤 4자리 (해시 X, 후속 결정)

    -- 계약 기간
    starts_at           TIMESTAMPTZ NOT NULL,
    ends_at             TIMESTAMPTZ NOT NULL,

    -- 요금
    rate_type           TEXT NOT NULL DEFAULT 'daily'
                            CHECK (rate_type IN ('hourly','daily','monthly')),
    rate_amount_krw     BIGINT NOT NULL DEFAULT 0,   -- 시간/일/월 당 요금
    included_km_per_day INTEGER,                     -- NULL = 무제한
    over_km_price_krw   INTEGER,                     -- km 당 초과료 (NULL = 미부과)
    deposit_krw         BIGINT NOT NULL DEFAULT 0,   -- 보증금

    -- 반납 정산
    return_odometer_km  INTEGER,                     -- 반납 시 누계 km
    pickup_odometer_km  INTEGER,                     -- 인수 시 누계 km
    settled_amount_krw  BIGINT,                      -- 최종 정산 금액 (반납 시 계산)
    settled_at          TIMESTAMPTZ,

    -- 위치
    pickup_location     TEXT,
    return_location     TEXT,

    -- 상태
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft','active','returned','overdue','cancelled')),

    note                TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT rental_contracts_time_check CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS rental_contracts_device_time_idx
    ON rental_contracts(device_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS rental_contracts_user_time_idx
    ON rental_contracts(user_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS rental_contracts_active_idx
    ON rental_contracts(status) WHERE status IN ('draft','active','overdue');
-- 임차인 전화번호 검색용 (재방문 고객 인식은 R6)
CREATE INDEX IF NOT EXISTS rental_contracts_renter_phone_idx
    ON rental_contracts(user_id, renter_phone) WHERE renter_phone IS NOT NULL;

COMMENT ON TABLE  rental_contracts IS '렌트카 계약. 렌트카 계정 (account_type=rentcar) 전용';
COMMENT ON COLUMN rental_contracts.renter_id_last4 IS '신분증 뒤 4자리 (PIPA 최소화). 원본 신분증 저장 금지';
COMMENT ON COLUMN rental_contracts.status IS 'draft|active|returned|overdue|cancelled';
