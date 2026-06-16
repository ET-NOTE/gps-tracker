-- 다중 전화번호 지원. 기존 users.phone 은 primary 동기화용으로 보존 (하위 호환).
-- seriallink 패턴 참조: per-user 여러 번호, 1개만 메인, 인증된 번호는 글로벌 중복 차단.
CREATE TABLE IF NOT EXISTS user_phones (
    id           BIGSERIAL PRIMARY KEY,
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    phone        TEXT NOT NULL,
    is_verified  BOOLEAN NOT NULL DEFAULT FALSE,
    is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    verified_at  TIMESTAMPTZ,
    UNIQUE(user_id, phone)
);

CREATE INDEX IF NOT EXISTS user_phones_user_idx ON user_phones(user_id);

-- 글로벌 중복 방지: 인증된 번호는 한 계정에만 속할 수 있음.
-- 미인증 행은 자유롭게 (다른 계정과 같아도 허용 — 이후 인증 시점에 거부됨).
CREATE UNIQUE INDEX IF NOT EXISTS user_phones_verified_phone_idx
    ON user_phones(phone) WHERE is_verified = TRUE;

-- 한 사용자당 메인 번호는 최대 1개.
CREATE UNIQUE INDEX IF NOT EXISTS user_phones_user_primary_idx
    ON user_phones(user_id) WHERE is_primary = TRUE;

-- 기존 users.phone 백필. phone_verified 가 TRUE 인 경우만 verified_at 채움.
INSERT INTO user_phones (user_id, phone, is_verified, is_primary, verified_at)
SELECT id, phone, COALESCE(phone_verified, FALSE), TRUE,
       CASE WHEN phone_verified THEN created_at ELSE NULL END
  FROM users
 WHERE phone IS NOT NULL AND phone <> ''
ON CONFLICT (user_id, phone) DO NOTHING;
