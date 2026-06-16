-- 아이디 찾기용 OTP purpose 추가.
-- 비밀번호 재설정과 분리 — find_id 는 phone 만으로 가능, reset 은 (email, phone) 모두 일치 필요.
ALTER TABLE otp_codes DROP CONSTRAINT IF EXISTS otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check
    CHECK (purpose = ANY (ARRAY['register'::text, 'update'::text, 'reset'::text, 'phone_add'::text, 'find_id'::text]));
