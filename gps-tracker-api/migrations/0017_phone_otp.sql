-- 회원가입 시 휴대폰 4자리 SMS 인증.
-- bizmsg.kr 의 AlimTalk/SMS API 를 사용 (seriallink 와 동일 패턴).
--
-- users.phone     : E.164 가 아닌 한국 휴대폰 그대로 (010XXXXXXXX, digits-only).
--                   인증 통과한 경우만 NOT NULL 로 채움.
-- otp_codes       : OTP 발급/검증 상태. expires_at 지나면 의미 없음.
--                   같은 phone 으로 여러 row 가 쌓일 수 있고, 검증은 최신 미만료 row 기준.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS phone           TEXT,
    ADD COLUMN IF NOT EXISTS phone_verified  BOOLEAN NOT NULL DEFAULT FALSE;

-- phone 은 인증된 경우 unique. NULL 은 unique 검사 안 걸림 (PostgreSQL 기본 동작).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
    ON users(phone)
    WHERE phone IS NOT NULL AND phone_verified = TRUE;

CREATE TABLE IF NOT EXISTS otp_codes (
    id          BIGSERIAL PRIMARY KEY,
    phone       TEXT NOT NULL,
    code        TEXT NOT NULL,                  -- 4자리 (3분 만료라 hash 안 함)
    purpose     TEXT NOT NULL DEFAULT 'register'
                    CHECK (purpose IN ('register','update','reset')),
    attempts    INT  NOT NULL DEFAULT 0,
    verified    BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at  TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,                    -- register 등에서 1회 사용 후 마킹
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_otp_phone_created
    ON otp_codes(phone, created_at DESC);
