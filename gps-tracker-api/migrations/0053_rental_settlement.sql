-- (2026-07-28) Stage-R4: 반납 정산 breakdown 세분화.
--
-- 반납 시 계산되는 라인 아이템을 개별 컬럼 + JSONB (settlement_json) 로 저장.
-- 청구서 (invoice.xlsx) 재발행·수정 시 재계산 없이 그대로 사용.
--
-- 컬럼 의미:
--   base_fee_krw      기본 요금 (rate_amount × units)
--   late_hours        반납 지연 시간 (계약 ends_at 대비, floor)
--   late_fee_krw      지연 요금 (hourly rate 로 환산 · 할증)
--   over_km           초과 주행 km
--   over_km_fee_krw   초과 주행 요금
--   extra_fee_krw     기타 (파손·연료 부족·주말 할증 등, 수동)
--   refund_krw        환급액 (deposit - settled 가 양수일 때). 음수는 청구 금액.
--   returned_at       실제 반납 시각 (ends_at 과 별도 — 조기·지연 반납 구분)
--   settlement_json   line item detail (invoice 재현용)
--
-- settlement_json 예시:
-- {
--   "lines": [
--     { "kind": "base",    "label": "기본 요금 (3일 × 50,000원)", "amount": 150000 },
--     { "kind": "over_km", "label": "초과 주행 (30km × 200원)",    "amount":   6000 },
--     { "kind": "late",    "label": "지연 반납 (2시간 × 6,250원 × 1.5)", "amount": 18750 },
--     { "kind": "extra",   "label": "세차비",                    "amount":  10000 }
--   ],
--   "subtotal": 184750,
--   "deposit": 100000,
--   "balance": 84750
-- }

ALTER TABLE rental_contracts
    ADD COLUMN IF NOT EXISTS base_fee_krw    BIGINT,
    ADD COLUMN IF NOT EXISTS late_hours      INTEGER,
    ADD COLUMN IF NOT EXISTS late_fee_krw    BIGINT,
    ADD COLUMN IF NOT EXISTS over_km         INTEGER,
    ADD COLUMN IF NOT EXISTS over_km_fee_krw BIGINT,
    ADD COLUMN IF NOT EXISTS extra_fee_krw   BIGINT,
    ADD COLUMN IF NOT EXISTS refund_krw      BIGINT,
    ADD COLUMN IF NOT EXISTS returned_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS settlement_json JSONB;

COMMENT ON COLUMN rental_contracts.base_fee_krw    IS '기본 요금 (rate × units)';
COMMENT ON COLUMN rental_contracts.late_hours      IS '지연 반납 시간 (floor hours)';
COMMENT ON COLUMN rental_contracts.late_fee_krw    IS '지연 반납 요금 (hourly × 1.5 할증)';
COMMENT ON COLUMN rental_contracts.over_km         IS '초과 주행 km';
COMMENT ON COLUMN rental_contracts.over_km_fee_krw IS '초과 km 요금';
COMMENT ON COLUMN rental_contracts.extra_fee_krw   IS '기타 (세차·파손·연료·주말 등, 수동)';
COMMENT ON COLUMN rental_contracts.refund_krw      IS '환급액 (양수) 또는 추가 청구 (음수). deposit - settled.';
COMMENT ON COLUMN rental_contracts.returned_at     IS '실제 반납 시각 (조기·지연 반납 구분)';
COMMENT ON COLUMN rental_contracts.settlement_json IS '청구서 line item detail (invoice.xlsx 재현용)';
