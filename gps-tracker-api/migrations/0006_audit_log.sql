-- 디바이스 감사 로그 — 보안/추적용 (도난 SIM 추적, 분쟁 시 이력 확인 등)
-- events 테이블은 사용자 알림 이벤트 (low_batt, geofence 등) 라 별도 테이블.

CREATE TABLE IF NOT EXISTS device_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    device_id   BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    event_type  TEXT   NOT NULL,            -- 'sim_swap' | 'modem_swap' | 'pair' | 'unpair' | 'wipe' | 'owner_change'
    actor       TEXT,                       -- 'system' | 'user:<id>' | 'admin:<id>'
    data        JSONB,                      -- 자유 형식 (이전/이후 값, 사유 등)
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_device_time ON device_audit_log(device_id, occurred_at DESC);
