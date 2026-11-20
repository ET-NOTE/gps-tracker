-- Monotonic source revisions invalidate derived deliveries without copying source contents.
ALTER TABLE fleet_expenses ADD COLUMN privacy_revision BIGINT NOT NULL DEFAULT 1;
ALTER TABLE fleet_expense_receipts ADD COLUMN privacy_revision BIGINT NOT NULL DEFAULT 1;
CREATE FUNCTION privacy_source_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.privacy_revision=OLD.privacy_revision+1; RETURN NEW; END $$;
CREATE TRIGGER privacy_expense_revision BEFORE UPDATE ON fleet_expenses FOR EACH ROW EXECUTE FUNCTION privacy_source_revision();
CREATE TRIGGER privacy_receipt_revision BEFORE UPDATE ON fleet_expense_receipts FOR EACH ROW EXECUTE FUNCTION privacy_source_revision();
-- Deliberately no FK to the source: deleting an original must not be blocked by audit metadata.
ALTER TABLE privacy_image_deliveries ADD COLUMN receipt_id BIGINT,
 ADD COLUMN receipt_revision BIGINT, ADD COLUMN expense_revision BIGINT,
 ADD CONSTRAINT privacy_image_receipt_binding CHECK(
 (receipt_id IS NULL AND receipt_revision IS NULL AND expense_revision IS NULL) OR
 (receipt_id IS NOT NULL AND receipt_revision IS NOT NULL AND expense_revision IS NOT NULL AND company_review_id IS NOT NULL AND category='receipt'));
CREATE INDEX privacy_image_receipt_source ON privacy_image_deliveries(receipt_id) WHERE receipt_id IS NOT NULL;
CREATE TABLE privacy_receipt_reads (
 id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 review_id BIGINT NOT NULL REFERENCES privacy_company_reviews(id) ON DELETE RESTRICT,
 review_revision INTEGER NOT NULL, actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 receipt_id BIGINT NOT NULL, receipt_revision BIGINT NOT NULL, expense_revision BIGINT NOT NULL,
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_receipt_read_lookup ON privacy_receipt_reads(request_id,actor_id,receipt_id,created_at);
CREATE TRIGGER privacy_receipt_read_immutable BEFORE UPDATE OR DELETE ON privacy_receipt_reads FOR EACH ROW EXECUTE FUNCTION privacy_company_proof_immutable();
CREATE FUNCTION privacy_receipt_in_scope(review bigint, receipt bigint) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM privacy_company_reviews c
 JOIN fleet_expenses e ON e.owner_id=c.company_owner_id AND e.staff_id=c.staff_id
 JOIN fleet_expense_receipts f ON f.owner_id=e.owner_id AND f.expense_id=e.id
 WHERE c.id=review AND f.id=receipt AND c.identity='confirmed' AND c.staff_id IS NOT NULL
 AND c.category IN ('expenses','files') AND c.status NOT IN ('excluded','restricted')
 AND e.status<>'cancelled' AND f.removed_at IS NULL AND f.mime IN ('image/png','image/jpeg')
 AND e.spent_on>=(c.from_at AT TIME ZONE 'Asia/Seoul')::date
 AND e.spent_on<(c.until_at AT TIME ZONE 'Asia/Seoul')::date)
$$;
CREATE OR REPLACE FUNCTION privacy_image_unavailable(g privacy_image_deliveries) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT g.revoked_at IS NOT NULL OR g.expires_at<=now()
 OR EXISTS(SELECT 1 FROM privacy_requests r JOIN privacy_account_controls a ON a.user_id=r.user_id WHERE r.id=g.request_id AND (r.status IN ('cancelled','rejected') OR a.restricted))
 OR (g.company_review_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM privacy_company_reviews c JOIN privacy_account_controls a ON a.user_id=c.company_owner_id WHERE c.id=g.company_review_id AND c.request_id=g.request_id AND c.identity='confirmed' AND c.staff_id IS NOT NULL AND c.status NOT IN ('excluded','restricted') AND c.revision=g.company_revision AND NOT a.restricted))
 OR (g.receipt_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fleet_expense_receipts f JOIN fleet_expenses e ON e.id=f.expense_id AND e.owner_id=f.owner_id WHERE f.id=g.receipt_id AND f.privacy_revision=g.receipt_revision AND e.privacy_revision=g.expense_revision AND f.digest=g.source_sha256 AND privacy_receipt_in_scope(g.company_review_id,f.id)))
$$;

-- Source edits/removal purge only invalid derived PNGs, never original receipts or ledger rows.
CREATE TRIGGER privacy_receipt_source_cleanup AFTER UPDATE OR DELETE ON fleet_expense_receipts FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
CREATE TRIGGER privacy_expense_source_cleanup AFTER UPDATE OR DELETE ON fleet_expenses FOR EACH STATEMENT EXECUTE FUNCTION privacy_image_scope_cleanup();
