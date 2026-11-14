-- Reviewed personal account/document delivery. No copied file contents or credentials.
CREATE TABLE privacy_account_packages (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 documents JSONB NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(documents)='array' AND jsonb_array_length(documents)<=20),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 revoked_at TIMESTAMPTZ,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX privacy_account_packages_request ON privacy_account_packages(request_id,id);
CREATE TABLE privacy_account_package_events (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 package_id BIGINT REFERENCES privacy_account_packages(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('document_review','issued','revoked','account_prepared','document_prepared')),
 document_id BIGINT,
 sha256 TEXT CHECK(sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_account_package_events_request ON privacy_account_package_events(request_id,id);
-- Evidence means an authenticated response was prepared; it is NOT proof of
-- receipt or whole-request fulfilment. Retention policy remains an open item.
