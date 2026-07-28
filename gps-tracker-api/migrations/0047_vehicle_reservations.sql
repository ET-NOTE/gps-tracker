-- (2026-07-28) Stage-4F-1: 차량 예약 시스템 (cartax.biz 참조).
--
-- 목적: 법인차 여러 명이 공유할 때 "누가 언제 사용" 사전 예약.
-- overlap 검사는 API 층에서 (같은 device 의 status='planned'|'in_progress' 겹침).
--
-- status 흐름:
--   planned → in_progress (사용 시작, 수동 or 자동 wake 감지)
--            ↘ cancelled  (사용자 취소)
--   in_progress → completed (수동 종료 or sleep_enter 감지)

CREATE TABLE IF NOT EXISTS vehicle_reservations (
    id              BIGSERIAL PRIMARY KEY,
    -- 예약 생성한 사용자 (=차량 owner). owner 만 예약 관리.
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id       BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    -- 실제 운전자 (staff 등록). NULL = 미지정.
    driver_staff_id BIGINT REFERENCES staff(id) ON DELETE SET NULL,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    purpose         TEXT,       -- 자유 텍스트 (거래처 방문, 외근 등)
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','in_progress','completed','cancelled')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT vehicle_reservations_time_check CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS vehicle_reservations_device_time_idx
    ON vehicle_reservations(device_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_reservations_user_time_idx
    ON vehicle_reservations(user_id, starts_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_reservations_status_idx
    ON vehicle_reservations(status) WHERE status IN ('planned','in_progress');

COMMENT ON TABLE  vehicle_reservations IS '차량 사전 예약 (누가 언제 사용) — cartax 스타일';
COMMENT ON COLUMN vehicle_reservations.status IS 'planned|in_progress|completed|cancelled';
