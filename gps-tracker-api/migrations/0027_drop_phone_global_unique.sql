-- 정책 변경: 인증된 번호의 글로벌 중복 차단을 제거.
-- OTP 통과 = 순간 소유 증명만으로 충분. main/sub 가 다른 계정에 겹쳐도 허용.
-- find_id / password_reset 은 (email, phone) 조합으로 식별. email 은 여전히 unique.

-- 0017 의 인덱스 (users 테이블)
DROP INDEX IF EXISTS idx_users_phone_unique;

-- 0025 의 인덱스 (user_phones 테이블)
DROP INDEX IF EXISTS user_phones_verified_phone_idx;

-- otp_codes purpose 에 'reset' 은 이미 0017 의 CHECK 에 포함돼있음.
-- (0026 에서 phone_add 도 추가)
