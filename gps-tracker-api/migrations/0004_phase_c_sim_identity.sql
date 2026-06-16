-- Phase C: SIM info 기반 페어링
-- ICCID(SIM 카드 일련번호) / IMEI(모뎀 HW ID) / IMSI(가입자 ID) 저장.
-- ingest 시 디바이스가 보내는 값을 갱신하고, pair 시 ICCID 로 조회 가능.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS iccid TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS imei  TEXT;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS imsi  TEXT;

-- ICCID로 페어링 조회 — 자주 쓰일 인덱스
CREATE INDEX IF NOT EXISTS devices_iccid_idx ON devices(iccid) WHERE iccid IS NOT NULL;
-- IMEI 보조 fingerprint
CREATE INDEX IF NOT EXISTS devices_imei_idx  ON devices(imei)  WHERE imei  IS NOT NULL;
