-- (2026-07-29) 스마트폰을 tracker device 로 사용하는 기능 준비.
-- device_kind = 'hardware' (기존 ESP32-C3 등) | 'phone' (사용자 스마트폰 앱)
--
-- 왜 컬럼 추가:
--   FE 가 device 상세 렌더 시 phone 은 배터리 mV / 안테나 / 부저 트리거 등
--   무의미한 하드웨어 필드 숨김 필요. source 필드로 매 fix 판별하기보단 device 단위로
--   1회 flag 하는 게 UI 로직 단순.
--
-- 기능은 PHONE_TRACKER_ENABLED env 로 runtime toggle 가능. 나중에 비활성화하면
-- 새 phone 페어링만 차단, 이미 등록된 phone device 는 계속 동작.

ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS device_kind TEXT NOT NULL DEFAULT 'hardware'
    CHECK (device_kind IN ('hardware', 'phone'));

CREATE INDEX IF NOT EXISTS idx_devices_kind ON devices(device_kind) WHERE device_kind <> 'hardware';
