-- Explicitly scoped company reports; no automatic source-data mutation.
CREATE TABLE privacy_company_tasks (
 id BIGSERIAL PRIMARY KEY,
 review_id BIGINT NOT NULL REFERENCES privacy_company_reviews(id) ON DELETE RESTRICT,
 company_owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 instructions TEXT NOT NULL CHECK(length(btrim(instructions)) BETWEEN 1 AND 1000),
 status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','submitted','changes_requested','accepted','revoked')),
 expires_at TIMESTAMPTZ NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 feedback TEXT NOT NULL DEFAULT '' CHECK(length(feedback)<=1000),
 updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(expires_at>created_at AND expires_at<=created_at+interval '14 days')
);
CREATE UNIQUE INDEX privacy_company_task_active ON privacy_company_tasks(review_id) WHERE status<>'revoked';
CREATE INDEX privacy_company_task_owner ON privacy_company_tasks(company_owner_id,id);
CREATE TABLE privacy_company_submissions (
 id BIGSERIAL PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES privacy_company_tasks(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 outcome TEXT NOT NULL CHECK(outcome IN ('provided','corrected','erased','limited')),
 executed_at TIMESTAMPTZ NOT NULL,
 affected_count INTEGER NOT NULL CHECK(affected_count BETWEEN 0 AND 10000000),
 summary TEXT NOT NULL CHECK(length(btrim(summary)) BETWEEN 1 AND 2000),
 evidence_reference TEXT NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 1 AND 160),
 filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 120),
 mime TEXT NOT NULL CHECK(mime IN ('application/pdf','image/png','image/jpeg')),
 sha256 TEXT NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
 file_bytes BYTEA NOT NULL CHECK(octet_length(file_bytes) BETWEEN 1 AND 2097152),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_company_submission_task ON privacy_company_submissions(task_id,id);
CREATE TABLE privacy_company_task_events (
 id BIGSERIAL PRIMARY KEY,
 task_id BIGINT NOT NULL REFERENCES privacy_company_tasks(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 action TEXT NOT NULL CHECK(action IN ('published','submitted','downloaded','accepted','changes_requested','revoked')),
 submission_id BIGINT REFERENCES privacy_company_submissions(id) ON DELETE RESTRICT,
 detail TEXT NOT NULL DEFAULT '' CHECK(length(detail)<=1000),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_company_task_audit ON privacy_company_task_events(task_id,id);
CREATE FUNCTION privacy_company_proof_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'company evidence is immutable; retention requires separate reviewed procedure'; END $$;
CREATE TRIGGER privacy_company_proof_immutable BEFORE UPDATE OR DELETE ON privacy_company_submissions FOR EACH ROW EXECUTE FUNCTION privacy_company_proof_immutable();
CREATE TRIGGER privacy_company_task_audit_immutable BEFORE UPDATE OR DELETE ON privacy_company_task_events FOR EACH ROW EXECUTE FUNCTION privacy_company_proof_immutable();
CREATE FUNCTION privacy_company_task_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t privacy_company_tasks%ROWTYPE; sid BIGINT; result TEXT;
BEGIN
 SELECT * INTO t FROM privacy_company_tasks WHERE review_id=NEW.id AND status<>'revoked';
 IF FOUND THEN
  IF NEW.identity<>'confirmed' THEN RAISE EXCEPTION 'revoke company task before identity change'; END IF;
  IF NEW.status IN ('verified','excluded','restricted') THEN
   SELECT id,outcome INTO sid,result FROM privacy_company_submissions WHERE task_id=t.id ORDER BY id DESC LIMIT 1;
   IF t.status<>'accepted' OR sid IS NULL OR NEW.outcome<>result OR NEW.evidence_reference<>'company-task:'||t.id||'/submission:'||sid THEN
    RAISE EXCEPTION 'company submission must be reviewed before completion';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_company_task_review_guard BEFORE UPDATE ON privacy_company_reviews FOR EACH ROW EXECUTE FUNCTION privacy_company_task_review_guard();
