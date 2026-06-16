-- 공유 토큰 생성/연장 시 차감된 크레딧 누적값.
-- "이 링크에 얼마 썼는지" 사용자 측에 노출 + 운영 통계용.
ALTER TABLE share_tokens
    ADD COLUMN IF NOT EXISTS credits_spent INTEGER NOT NULL DEFAULT 0;
