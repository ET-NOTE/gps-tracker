-- Temporary raster delivery is separate from immutable review metadata.
CREATE TABLE privacy_image_deliveries (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 company_review_id BIGINT REFERENCES privacy_company_reviews(id) ON DELETE RESTRICT,
 company_revision INTEGER,
 category TEXT NOT NULL CHECK(category IN ('document','photo','receipt')),
 source_reference TEXT NOT NULL CHECK(length(btrim(source_reference)) BETWEEN 1 AND 160),
 source_sha256 TEXT NOT NULL CHECK(source_sha256 ~ '^[a-f0-9]{64}$'),
 selection_sha256 TEXT NOT NULL CHECK(selection_sha256 ~ '^[a-f0-9]{64}$'),
 output_sha256 TEXT NOT NULL CHECK(output_sha256 ~ '^[a-f0-9]{64}$'),
 width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 2048),
 height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 2048),
 regions JSONB NOT NULL CHECK(jsonb_typeof(regions)='array' AND jsonb_array_length(regions) BETWEEN 1 AND 30),
 notice TEXT NOT NULL CHECK(length(btrim(notice)) BETWEEN 1 AND 1000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 expires_at TIMESTAMPTZ NOT NULL DEFAULT now()+interval '24 hours',
 revoked_at TIMESTAMPTZ,
 CHECK(width::bigint*height<=1000000),
 CHECK((company_review_id IS NULL)=(company_revision IS NULL)),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '24 hours')
);
CREATE INDEX privacy_image_request ON privacy_image_deliveries(request_id,id);
CREATE TABLE privacy_image_payloads (
 delivery_id BIGINT PRIMARY KEY REFERENCES privacy_image_deliveries(id) ON DELETE RESTRICT,
 png_bytes BYTEA NOT NULL CHECK(octet_length(png_bytes) BETWEEN 1 AND 3100000)
);
CREATE TABLE privacy_image_events (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 delivery_id BIGINT REFERENCES privacy_image_deliveries(id) ON DELETE RESTRICT,
 actor_id BIGINT REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('preview','issued','revoked','download_prepared','payload_removed')),
 selection_sha256 TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_image_preview ON privacy_image_events(request_id,actor_id,created_at);
CREATE TRIGGER privacy_image_event_immutable BEFORE UPDATE OR DELETE ON privacy_image_events FOR EACH ROW EXECUTE FUNCTION privacy_company_proof_immutable();
CREATE TRIGGER privacy_image_delivery_immutable BEFORE UPDATE OR DELETE ON privacy_image_deliveries FOR EACH ROW EXECUTE FUNCTION privacy_redacted_immutable();

CREATE FUNCTION privacy_image_unavailable(g privacy_image_deliveries) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT g.revoked_at IS NOT NULL OR g.expires_at<=now()
 OR EXISTS(SELECT 1 FROM privacy_requests r JOIN privacy_account_controls a ON a.user_id=r.user_id WHERE r.id=g.request_id AND (r.status IN ('cancelled','rejected') OR a.restricted))
 OR (g.company_review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM privacy_company_reviews c JOIN privacy_account_controls a ON a.user_id=c.company_owner_id WHERE c.id=g.company_review_id AND c.request_id=g.request_id AND c.identity='confirmed' AND c.staff_id IS NOT NULL AND c.status NOT IN ('excluded','restricted') AND c.revision=g.company_revision AND NOT a.restricted))
$$;
CREATE FUNCTION privacy_image_payload_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE g privacy_image_deliveries%ROWTYPE;
BEGIN
 IF TG_OP='UPDATE' THEN RAISE EXCEPTION 'immutable raster payload'; END IF;
 SELECT * INTO STRICT g FROM privacy_image_deliveries WHERE id=OLD.delivery_id;
 IF NOT privacy_image_unavailable(g) THEN RAISE EXCEPTION 'active delivery payload'; END IF;
 INSERT INTO privacy_image_events(request_id,delivery_id,action,selection_sha256) VALUES(g.request_id,g.id,'payload_removed',g.selection_sha256);
 RETURN OLD;
END $$;
CREATE TRIGGER privacy_image_payload_guard BEFORE UPDATE OR DELETE ON privacy_image_payloads FOR EACH ROW EXECUTE FUNCTION privacy_image_payload_guard();
CREATE FUNCTION privacy_cleanup_image_payloads() RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE n bigint;
BEGIN
 DELETE FROM privacy_image_payloads p USING privacy_image_deliveries g WHERE g.id=p.delivery_id AND privacy_image_unavailable(g);
 GET DIAGNOSTICS n=ROW_COUNT;
 RETURN n;
END $$;
CREATE FUNCTION privacy_image_scope_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM privacy_cleanup_image_payloads();
 RETURN NULL;
END $$;
CREATE TRIGGER privacy_image_revoke_cleanup AFTER UPDATE OF revoked_at ON privacy_image_deliveries FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
CREATE TRIGGER privacy_image_request_cleanup AFTER UPDATE OF status ON privacy_requests FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
CREATE TRIGGER privacy_image_account_cleanup AFTER UPDATE OF restricted ON privacy_account_controls FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
CREATE TRIGGER privacy_image_company_cleanup AFTER UPDATE ON privacy_company_reviews FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
