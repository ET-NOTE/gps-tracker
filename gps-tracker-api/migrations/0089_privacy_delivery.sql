-- Grants contain scope only, never a copied location archive or bearer secret.
CREATE TABLE privacy_deliveries (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 device_ids BIGINT[] NOT NULL CHECK(cardinality(device_ids) BETWEEN 1 AND 20),
 from_at TIMESTAMPTZ NOT NULL,
 until_at TIMESTAMPTZ NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 revoked_at TIMESTAMPTZ,
 CHECK(until_at > from_at AND until_at-from_at <= interval '31 days'),
 CHECK(expires_at > created_at AND expires_at <= created_at+interval '24 hours')
);
CREATE INDEX privacy_delivery_request ON privacy_deliveries(request_id,id DESC);
CREATE TABLE privacy_delivery_events (
 id BIGSERIAL PRIMARY KEY,
 delivery_id BIGINT NOT NULL REFERENCES privacy_deliveries(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('issued','revoked','download_prepared')),
 record_count INTEGER,
 sha256 TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Operational rate-limit buckets, not a second account or login session store.
CREATE TABLE privacy_result_limits (
 key TEXT PRIMARY KEY,
 window_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 attempts INTEGER NOT NULL DEFAULT 1
);
