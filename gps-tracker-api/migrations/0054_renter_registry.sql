-- (2026-07-28) Stage-R6: 임차인 (renter) registry — 블랙리스트 + PIPA 자동 파기 근거.
--
-- 재방문 인식은 rental_contracts(renter_phone) 를 phone 기준으로 aggregate → view/query.
-- 별도 renters 테이블은 두지 않음 (진실 원천은 계약 그 자체, 통계는 파생).
--
-- Blacklist: user_id 별로 phone 을 등록 (한 owner 안에서만 유효). owner 가 사유 관리.
--
-- PIPA 정책 (housekeeping worker 가 적용):
--   status='returned' AND settled_at < NOW-6mo   → renter_id_last4 NULL
--   status='returned' AND settled_at < NOW-3yr   → renter_phone   NULL (조회 불가)
-- 데이터 자체는 유지 (매출/통계 집계용). PII 최소화만 강행.

CREATE TABLE IF NOT EXISTS renter_blacklist (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    renter_phone    TEXT   NOT NULL,
    renter_name     TEXT,                        -- 등록 시점 이름 (참고용)
    reason          TEXT NOT NULL,
    severity        TEXT NOT NULL DEFAULT 'warn'
                        CHECK (severity IN ('warn','block')),  -- warn=경고, block=신규 계약 차단
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
    UNIQUE (user_id, renter_phone)
);

CREATE INDEX IF NOT EXISTS renter_blacklist_user_idx ON renter_blacklist(user_id);
CREATE INDEX IF NOT EXISTS renter_blacklist_phone_idx ON renter_blacklist(user_id, renter_phone);

COMMENT ON TABLE  renter_blacklist IS '렌트카 owner 별 임차인 블랙리스트';
COMMENT ON COLUMN renter_blacklist.severity IS 'warn=신규 계약 시 경고 / block=차단';

-- (선택) 임차인 통계 조회 가속용 partial index — user + phone
CREATE INDEX IF NOT EXISTS rental_contracts_user_phone_time_idx
    ON rental_contracts(user_id, renter_phone, starts_at DESC)
    WHERE renter_phone IS NOT NULL;
