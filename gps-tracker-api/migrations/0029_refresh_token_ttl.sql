-- "로그인 기억하기" 옵션 — refresh token 별 TTL 차등 적용.
-- remember_me=true → 30일 (기본). remember_me=false → 1일 짧은 세션.
-- ttl_days 컬럼은 refresh 시점에 새 토큰의 만료 산정에 사용 (rolling).

ALTER TABLE refresh_tokens
    ADD COLUMN IF NOT EXISTS ttl_days INT NOT NULL DEFAULT 30;
