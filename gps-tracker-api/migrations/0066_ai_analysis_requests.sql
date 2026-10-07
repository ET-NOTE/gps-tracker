-- Keep a receipt after report deletion so replay cannot charge a second time.
CREATE TABLE ai_analysis_requests (
    user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    request_id text NOT NULL,
    device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    target_date date NOT NULL,
    analysis_id bigint REFERENCES ai_analyses(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, request_id)
);
CREATE INDEX ai_analysis_requests_recent ON ai_analysis_requests(user_id, device_id, target_date, created_at DESC);
