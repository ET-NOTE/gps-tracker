-- 단말기 부저 원격 트리거 — 현장에서 여러 디바이스 동시 휴대 시 식별용.
-- UI 가 POST /devices/:id/beep → beep_pending=true → 다음 ingest 응답에 cmd=beep 실어 보냄.
-- 디바이스가 한 번 받으면 atomic 으로 false 로 클리어.
ALTER TABLE devices
    ADD COLUMN IF NOT EXISTS beep_pending      BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS beep_requested_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS devices_beep_pending_idx
    ON devices(id) WHERE beep_pending;
