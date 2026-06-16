-- 다중 전화번호 추가/재인증용 OTP purpose 추가.
-- 기존 CHECK 제약은 register/update/reset 만 허용 → phone_add 거부.
ALTER TABLE otp_codes DROP CONSTRAINT IF EXISTS otp_codes_purpose_check;
ALTER TABLE otp_codes ADD CONSTRAINT otp_codes_purpose_check
    CHECK (purpose = ANY (ARRAY['register'::text, 'update'::text, 'reset'::text, 'phone_add'::text]));
