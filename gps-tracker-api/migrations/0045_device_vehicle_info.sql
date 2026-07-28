-- (2026-07-28) Stage-4B-1: 국세청 별지 제73호 (업무용승용차 운행기록부) + 우리 전용 양식
-- 헤더 필드 확보. 이전 (0044) 은 연비/연료 종류만.
--
-- 국세청 별지 제73호 헤더:
--   사업자번호 · 상호           (corporate_info)     ✓ 이미 있음
--   차량번호 (license_plate)     (devices)            ← 신규
--   차종/모델 (display_name)     (devices)            ✓ 있음
--   연식 (model_year)            (devices)            ← 신규
--   배기량 (engine_cc)           (devices)            ← 신규
--   취득가액 (purchase_price_krw) (devices)           ← 신규
--   취득일 (acquired_at)         (devices)            ← 신규
--
-- 우리 전용 양식 추가:
--   부서 (department) — Stage-4C-2 에서 group 테이블로 분리 가능. 지금은 문자열.
--   차량 유형 (vehicle_type) — 승용/승합/화물/특수. 세제 혜택 다름.
--
-- 모두 nullable — 기존 device 는 미입력 상태 시작. UI 로 채워나감.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS license_plate      TEXT,
    ADD COLUMN IF NOT EXISTS model_year         INTEGER,
    ADD COLUMN IF NOT EXISTS engine_cc          INTEGER,
    ADD COLUMN IF NOT EXISTS purchase_price_krw BIGINT,
    ADD COLUMN IF NOT EXISTS acquired_at        DATE,
    ADD COLUMN IF NOT EXISTS department         TEXT,
    ADD COLUMN IF NOT EXISTS vehicle_type       TEXT
        CHECK (vehicle_type IN ('sedan','van','truck','special','ev'));

COMMENT ON COLUMN devices.license_plate      IS '차량번호 (예: 12가3456). 국세청 별지 제73호 헤더';
COMMENT ON COLUMN devices.model_year         IS '연식 (예: 2023). 국세청 헤더';
COMMENT ON COLUMN devices.engine_cc          IS '배기량 cc. 국세청 헤더 (승용차 특별세제 적용 기준)';
COMMENT ON COLUMN devices.purchase_price_krw IS '취득가액 원. 감가상각 계산 기초';
COMMENT ON COLUMN devices.acquired_at        IS '취득일 (계약일 아닌 취득일). 감가상각 시작 기준';
COMMENT ON COLUMN devices.department         IS '부서/그룹. 우리 전용 양식용';
COMMENT ON COLUMN devices.vehicle_type       IS 'sedan|van|truck|special|ev';

-- 검색 편의 — 차량번호 로 device 찾기 (동일 owner 내 unique).
-- NULL 은 unique 대상 아니라 여러 device 가 license_plate 미입력 상태 공존 OK.
CREATE UNIQUE INDEX IF NOT EXISTS devices_owner_license_plate_uidx
    ON devices(owner_id, license_plate) WHERE license_plate IS NOT NULL;
