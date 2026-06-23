-- 단말기 원격 reset 트리거 — LTE stale registration / SHCONN 누락 등 stuck 상태 회복용.
-- UI 가 POST /devices/:id/reset → reset_pending=true → 다음 ingest 응답에 cmd=reset 실어 보냄.
-- 디바이스가 받으면 atomic 으로 false 로 클리어하면서 hardPowerCycle() 호출.
--
-- 한계: 디바이스의 POST 자체가 안 닿는 totally-stuck 상태에선 효과 없음 (firmware-side watchdog 가 cover).
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS reset_pending      BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS reset_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_reset_pending_idx
    ON devices(id) WHERE reset_pending;
