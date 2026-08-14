-- (2026-08-14) 로그인 brute-force / credential stuffing 방어.
--
-- 배경: login 핸들러에 rate limit / 계정 잠금 / 실패 카운터가 전혀 없었음 (OTP·충전엔 제한이
--   있는데 로그인만 무방비). Argon2 가 초당 시도를 늦추지만 사전공격·스터핑을 구조적으로 못 막음.
--
-- 정책:
--   · 이메일당 실패 10회 / 15분 → 잠금 (성공 시 해당 이메일 실패기록 삭제 = 즉시 해제)
--   · IP당 실패 30회 / 15분 → 잠금 (여러 이메일 스프레이 차단)
-- housekeeping 이 오래된 행 정리 (created_at < now()-1day).

CREATE TABLE IF NOT EXISTS login_attempts (
    id         BIGSERIAL PRIMARY KEY,
    email      TEXT        NOT NULL,
    ip         TEXT        NOT NULL DEFAULT 'unknown',
    success    BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 윈도우 카운트 쿼리용 (email/ip + 시간). 실패만 세므로 부분 인덱스.
CREATE INDEX IF NOT EXISTS idx_login_attempts_email
    ON login_attempts(email, created_at) WHERE success = FALSE;
CREATE INDEX IF NOT EXISTS idx_login_attempts_ip
    ON login_attempts(ip, created_at) WHERE success = FALSE;
