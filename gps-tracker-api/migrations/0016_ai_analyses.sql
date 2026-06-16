-- AI 운행 분석 결과 영구 보관.
-- 기존 ai_usage_log 는 호출 카운트/토큰 audit 용으로 유지.
-- ai_analyses 는 분석 텍스트 자체를 저장 — 재과금 없이 재조회 가능.
CREATE TABLE IF NOT EXISTS ai_analyses (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id    BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    target_date  DATE   NOT NULL,                 -- KST 기준 분석 대상 일자
    analysis     TEXT   NOT NULL,                 -- markdown 분석 본문
    model        TEXT,                            -- gpt-4o-mini 등
    tokens_in    INT,
    tokens_out   INT,
    cost_credits BIGINT NOT NULL DEFAULT 0,       -- 차감된 크레딧 (admin 무료 시 0)
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_device_date
    ON ai_analyses(device_id, target_date DESC, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_analyses_user
    ON ai_analyses(user_id, created_at DESC);
