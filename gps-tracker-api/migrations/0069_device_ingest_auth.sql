-- Existing firmware is explicitly grandfathered, never automatically enrolled.
ALTER TABLE devices ADD COLUMN ingest_legacy_allowed boolean NOT NULL DEFAULT false;
UPDATE devices SET ingest_legacy_allowed=true WHERE COALESCE(device_kind,'hardware') <> 'phone';
ALTER TABLE devices ADD COLUMN claim_code_hash text;
ALTER TABLE devices ADD COLUMN claim_expires_at timestamptz;
ALTER TABLE devices ADD COLUMN last_claim_code_hash text;

CREATE TABLE device_credentials (
    device_id bigint PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    key_digest bytea NOT NULL CHECK(octet_length(key_digest)=32),
    last_counter bigint NOT NULL DEFAULT 0 CHECK(last_counter>=0),
    activated_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE device_pair_attempts (
    user_id bigint PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    window_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 1
);
