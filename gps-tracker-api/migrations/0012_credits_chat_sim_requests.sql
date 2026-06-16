-- 크레딧 + SIM 충전 요청 + 1:1 채팅
-- 1 credit = 1 KRW. AI 분석 회당 20 credit 차감, SIM 100MB = 100 credit (관리자가 가격 조정 가능)

-- ─── 사용자 크레딧 잔액 ────────────────────────────────────────
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS credits BIGINT NOT NULL DEFAULT 0
        CHECK (credits >= 0);  -- 음수 잔액 방지 (charge 시 WHERE credits >= cost 와 함께 안전망)

-- ─── 크레딧 거래 로그 ──────────────────────────────────────────
-- delta > 0: 충전 (topup, refund, manual_grant)
-- delta < 0: 소모 (ai_analysis, sim_topup_consume)
CREATE TABLE IF NOT EXISTS credit_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta       BIGINT NOT NULL,                     -- 양수: 추가, 음수: 차감
    balance     BIGINT NOT NULL,                     -- 거래 직후 잔액 (감사용)
    reason      TEXT   NOT NULL,                     -- 'topup' | 'ai_analysis' | 'sim_topup' | 'refund' | 'admin_grant'
    ref_id      BIGINT,                              -- 관련 요청/레코드 id (e.g. sim_topup_requests.id)
    note        TEXT,                                -- 자유 메모
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_log_user_created
    ON credit_log(user_id, created_at DESC);

-- ─── SIM 충전 요청 ─────────────────────────────────────────────
-- 사용자가 보유 크레딧으로 자기 디바이스의 SIM 데이터 충전을 요청.
-- pending → 크레딧은 이미 차감된 상태. processed/failed 면 1NCE 호출 결과 반영.
-- failed 시 자동 환불.
CREATE TABLE IF NOT EXISTS sim_topup_requests (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id       BIGINT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    iccid           TEXT,                            -- 요청 시점의 iccid (snapshot, device 변경 대비)
    data_mb         INT    NOT NULL CHECK (data_mb > 0),
    cost_credits    BIGINT NOT NULL CHECK (cost_credits > 0),
    status          TEXT   NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','processing','done','failed','cancelled')),
    api_response    JSONB,                           -- 1NCE refill_sim 응답 또는 에러 메시지
    requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at    TIMESTAMPTZ,
    processed_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 관리자 id (자동 처리면 NULL)
    note            TEXT
);
CREATE INDEX IF NOT EXISTS idx_sim_topup_user        ON sim_topup_requests(user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_topup_status      ON sim_topup_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_sim_topup_device      ON sim_topup_requests(device_id, requested_at DESC);

-- ─── 1:1 채팅 (user ↔ 모든 admin) ──────────────────────────────
-- 사용자별로 하나의 thread. 관리자는 모두 같은 thread 를 본다 (공동 inbox).
-- thread.last_message_at 으로 정렬, unread_user / unread_admin 로 뱃지.
CREATE TABLE IF NOT EXISTS chat_threads (
    id                  BIGSERIAL PRIMARY KEY,
    user_id             BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    last_message_at     TIMESTAMPTZ,
    last_message_text   TEXT,
    unread_for_user     INT NOT NULL DEFAULT 0,      -- user 가 아직 안 읽은 admin 메시지 수
    unread_for_admin    INT NOT NULL DEFAULT 0,      -- admin 측이 아직 안 읽은 user 메시지 수
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_threads_last ON chat_threads(last_message_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    thread_id   BIGINT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_role TEXT   NOT NULL CHECK (sender_role IN ('user','admin','system')),
    sender_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
    body        TEXT   NOT NULL,
    meta        JSONB,                                -- 시스템 메시지용 (e.g. {"kind":"sim_topup","request_id":42})
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id, created_at);
