-- 관리자 작업 감사 로그 — device_audit_log 가 device_id NOT NULL 이라 사용자 레벨 작업
-- (예: impersonation) 을 기록 못 함. 별도 테이블.
--
-- 현재 추적 대상:
--   - 'impersonate' : 관리자가 사용자로 가장
--   - 추후: 'role_change', 'force_unpair', 'admin_credit_grant' 등 추가 예정
CREATE TABLE IF NOT EXISTS admin_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    admin_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE SET NULL,
    target_user BIGINT REFERENCES users(id) ON DELETE SET NULL,   -- nullable: 대상 없는 액션도 있음
    action      TEXT   NOT NULL,    -- 'impersonate' 등
    data        JSONB,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_audit_admin_time   ON admin_audit_log(admin_id,    occurred_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_target_time  ON admin_audit_log(target_user, occurred_at DESC);
