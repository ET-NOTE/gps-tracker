-- No existing administrator receives a new privilege automatically.
CREATE TABLE admin_principals (
 user_id BIGINT PRIMARY KEY REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('officer','operator','handler')),
 enabled BOOLEAN NOT NULL DEFAULT true,
 allowed_cidrs TEXT[] NOT NULL CHECK(cardinality(allowed_cidrs) BETWEEN 1 AND 16),
 subject_ids BIGINT[] NOT NULL DEFAULT '{}',
 revision BIGINT NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE admin_mfa (
 user_id BIGINT PRIMARY KEY REFERENCES admin_principals(user_id),
 nonce TEXT, pending_nonce TEXT, pending_until TIMESTAMPTZ,
 last_counter BIGINT NOT NULL DEFAULT -1,
 failures INTEGER NOT NULL DEFAULT 0, locked_until TIMESTAMPTZ,
 password_hash TEXT NOT NULL, password_set_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE admin_sessions (
 token_hash TEXT PRIMARY KEY, user_id BIGINT NOT NULL REFERENCES admin_principals(user_id),
 ip TEXT NOT NULL, principal_revision BIGINT NOT NULL, password_hash TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL,
 revoked_at TIMESTAMPTZ
);
CREATE TABLE admin_security_events (
 id BIGSERIAL PRIMARY KEY, actor_id BIGINT, ip TEXT NOT NULL, action TEXT NOT NULL,
 route TEXT NOT NULL, outcome TEXT NOT NULL, approval_id BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX admin_security_events_time ON admin_security_events(created_at);
CREATE TABLE admin_approvals (
 id BIGSERIAL PRIMARY KEY, requester_id BIGINT NOT NULL REFERENCES admin_principals(user_id),
 requester_revision BIGINT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
 payload JSONB NOT NULL, digest TEXT NOT NULL, target_fingerprint TEXT NOT NULL,
 reason TEXT NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 300),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','consumed')),
 approver_id BIGINT REFERENCES admin_principals(user_id), approver_revision BIGINT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '30 minutes',
 approved_at TIMESTAMPTZ, consumed_at TIMESTAMPTZ,
 CHECK(approver_id IS NULL OR approver_id<>requester_id)
);
CREATE FUNCTION admin_security_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append only security record' USING ERRCODE='23514'; END $$;
CREATE TRIGGER admin_security_events_immutable BEFORE UPDATE OR DELETE ON admin_security_events
 FOR EACH ROW EXECUTE FUNCTION admin_security_immutable();
CREATE TRIGGER admin_security_events_no_truncate BEFORE TRUNCATE ON admin_security_events
 FOR EACH STATEMENT EXECUTE FUNCTION admin_security_immutable();
-- Audit writes must succeed; no tokens, OTP seeds, passwords or request bodies enter this table.
-- Retention and privileged cleanup are separate policies, not implicit DELETE grants.
