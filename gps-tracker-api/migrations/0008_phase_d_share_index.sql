-- Phase D Round 2: 공유 링크 + fix 부분 인덱스

-- fix=true 시간범위 조회 가속 (경로 재생, 통계 워커, fix_only 파라미터)
CREATE INDEX IF NOT EXISTS location_fix_recent
    ON location_records(device_id, recorded_at DESC)
    WHERE fix = TRUE;

-- 공유 토큰 (1회용 read-only 링크)
CREATE TABLE IF NOT EXISTS share_tokens (
    id              BIGSERIAL PRIMARY KEY,
    token           TEXT NOT NULL UNIQUE,         -- URL-safe random
    device_id       BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    created_by      BIGINT NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    view_count      INTEGER NOT NULL DEFAULT 0,
    last_viewed_at  TIMESTAMPTZ,
    note            TEXT,                          -- 사용자가 메모 (예: "배달 김씨에게")
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_tokens_device_idx ON share_tokens(device_id);
CREATE INDEX IF NOT EXISTS share_tokens_active_idx ON share_tokens(device_id, expires_at)
    WHERE revoked_at IS NULL;
