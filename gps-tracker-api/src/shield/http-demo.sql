-- Opt-in, short-lived HTTP classroom credentials, separate from HTTPS keys.
CREATE TABLE http_demo_links (
    device_id bigint PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
    owner_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    uid_hash text NOT NULL UNIQUE CHECK (length(uid_hash) = 64),
    expires_at timestamptz NOT NULL
);
