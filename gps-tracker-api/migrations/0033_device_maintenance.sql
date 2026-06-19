-- 차량 정비 및 서류 만료일 추적
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS next_service_date  DATE,
  ADD COLUMN IF NOT EXISTS next_service_km    INT,
  ADD COLUMN IF NOT EXISTS insurance_expiry   DATE,
  ADD COLUMN IF NOT EXISTS inspection_expiry  DATE;
