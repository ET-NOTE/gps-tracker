-- AI 분석 사용량 로그 (계정당 일일 호출수 제한)

CREATE TABLE IF NOT EXISTS ai_usage_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint    TEXT   NOT NULL,        -- 'route_analyze' 등
    used_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    tokens_in   INTEGER,                -- prompt tokens
    tokens_out  INTEGER,                -- completion tokens
    model       TEXT
);
CREATE INDEX IF NOT EXISTS ai_usage_log_user_idx ON ai_usage_log(user_id, used_at DESC);
