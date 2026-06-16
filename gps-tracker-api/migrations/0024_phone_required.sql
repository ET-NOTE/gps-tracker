-- 회원가입 OTP 인증이 필수가 되어 users.phone 은 항상 채워져야 함.
-- 1) 기존 NULL/빈 phone 인 계정은 placeholder('01000000000') 로 채움
--    실사용 전엔 사용자가 본인 번호로 갱신하도록 안내 필요.
-- 2) NOT NULL 제약 추가 — 향후 신규 가입은 OTP flow 거치니 자동 보장.
UPDATE users
   SET phone = '01000000000'
 WHERE phone IS NULL OR phone = '';

ALTER TABLE users
    ALTER COLUMN phone SET NOT NULL;
