-- Keep only selection metadata and hashes; never duplicate raw/private text.
CREATE TABLE privacy_redacted_deliveries (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('chat','ai')),
 source_id BIGINT NOT NULL CHECK(source_id>0),
 source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 output_sha256 TEXT NOT NULL CHECK(output_sha256 ~ '^[a-f0-9]{64}$'),
 ranges JSONB NOT NULL CHECK(jsonb_typeof(ranges)='array' AND jsonb_array_length(ranges) BETWEEN 1 AND 50),
 notice TEXT NOT NULL CHECK(length(btrim(notice)) BETWEEN 1 AND 1000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 revoked_at TIMESTAMPTZ,
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX privacy_redacted_request ON privacy_redacted_deliveries(request_id,id);
CREATE UNIQUE INDEX privacy_redacted_active ON privacy_redacted_deliveries(request_id,source_kind,source_id) WHERE revoked_at IS NULL;
CREATE TABLE privacy_redacted_events (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 delivery_id BIGINT REFERENCES privacy_redacted_deliveries(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('source_review','preview','issued','revoked','download_prepared')),
 source_kind TEXT NOT NULL CHECK(source_kind IN ('chat','ai')),
 source_id BIGINT NOT NULL,
 source_sha256 TEXT NOT NULL,
 selection_sha256 TEXT NOT NULL DEFAULT '',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_redacted_review ON privacy_redacted_events(request_id,actor_id,created_at);
CREATE TRIGGER privacy_redacted_audit_immutable BEFORE UPDATE OR DELETE ON privacy_redacted_events FOR EACH ROW EXECUTE FUNCTION privacy_company_proof_immutable();
CREATE FUNCTION privacy_redacted_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'retention requires reviewed procedure'; END IF;
 IF (to_jsonb(NEW)-'revoked_at')<>(to_jsonb(OLD)-'revoked_at') OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
  RAISE EXCEPTION 'issued selection is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_redacted_immutable BEFORE UPDATE OR DELETE ON privacy_redacted_deliveries FOR EACH ROW EXECUTE FUNCTION privacy_redacted_immutable();
