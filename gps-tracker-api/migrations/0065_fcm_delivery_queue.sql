-- Additive: old apps and the previous API remain compatible for rollback.
ALTER TABLE fcm_tokens ADD COLUMN installation_id TEXT;
ALTER TABLE fcm_tokens ADD COLUMN registration_generation BIGINT;
ALTER TABLE fcm_tokens ADD COLUMN revocation_hash TEXT;

CREATE TABLE fcm_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_id BIGINT,
    token_id BIGINT NOT NULL REFERENCES fcm_tokens(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    binding_hash TEXT,
    message JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','dead','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    last_error TEXT,
    UNIQUE(event_id, token_id)
);
CREATE INDEX fcm_outbox_due_idx ON fcm_outbox(available_at, id) WHERE status='pending';
CREATE INDEX fcm_outbox_finished_idx ON fcm_outbox(finished_at) WHERE status <> 'pending';
COMMENT ON COLUMN events.notified_at IS 'Notification evaluated and durably queued (or intentionally skipped); per-recipient delivery status is in fcm_outbox.';

-- Retain revocation even if an earlier timed-out registration arrives later.
CREATE TABLE fcm_revocations (
    secret_hash TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fcm_revocations_created_idx ON fcm_revocations(created_at);
