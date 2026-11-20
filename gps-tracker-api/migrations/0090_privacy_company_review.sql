-- Minimal identity linkage evidence, never company-wide access or a new SIM owner.
CREATE TABLE privacy_company_link_history (
 id BIGSERIAL PRIMARY KEY,
 subject_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 company_owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 staff_id BIGINT NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('observed','linked','unlinked')),
 effective_at TIMESTAMPTZ NOT NULL,
 captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_company_subject ON privacy_company_link_history(subject_id,id);
INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at)
 SELECT account_id,owner_id,staff_id,'observed',joined_at FROM fleet_staff_accounts;
CREATE FUNCTION privacy_capture_company_link() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP IN ('DELETE','UPDATE') THEN
  INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at)
   VALUES(OLD.account_id,OLD.owner_id,OLD.staff_id,'unlinked',clock_timestamp());
 END IF;
 IF TG_OP IN ('INSERT','UPDATE') THEN
  INSERT INTO privacy_company_link_history(subject_id,company_owner_id,staff_id,action,effective_at)
   VALUES(NEW.account_id,NEW.owner_id,NEW.staff_id,'linked',NEW.joined_at);
 END IF;
 RETURN NULL;
END $$;
CREATE TRIGGER privacy_capture_company_link AFTER INSERT OR UPDATE OR DELETE ON fleet_staff_accounts
 FOR EACH ROW EXECUTE FUNCTION privacy_capture_company_link();

CREATE TABLE privacy_company_reviews (
 id BIGSERIAL PRIMARY KEY,
 request_id BIGINT NOT NULL REFERENCES privacy_requests(id) ON DELETE RESTRICT,
 company_owner_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 staff_id BIGINT,
 category TEXT NOT NULL CHECK(category IN ('staff','trips','reservations','expenses','files','snapshots')),
 from_at TIMESTAMPTZ NOT NULL, until_at TIMESTAMPTZ NOT NULL,
 status TEXT NOT NULL DEFAULT 'identity_pending' CHECK(status IN ('identity_pending','in_review','awaiting_company','awaiting_policy','verified','excluded','restricted')),
 identity TEXT NOT NULL DEFAULT 'pending' CHECK(identity IN ('pending','confirmed','not_subject')),
 identity_evidence TEXT NOT NULL DEFAULT '' CHECK(length(identity_evidence)<=160),
 outcome TEXT NOT NULL DEFAULT '' CHECK(outcome IN ('','provided','corrected','erased','not_subject','limited')),
 evidence_reference TEXT NOT NULL DEFAULT '' CHECK(length(evidence_reference)<=160),
 internal_reason TEXT NOT NULL DEFAULT '' CHECK(length(internal_reason)<=1000),
 public_message TEXT NOT NULL DEFAULT '회사 자료의 본인 범위와 처리 방법을 확인하고 있습니다.' CHECK(length(btrim(public_message)) BETWEEN 1 AND 1000),
 due_at TIMESTAMPTZ NOT NULL,
 inventory JSONB NOT NULL DEFAULT '{}',
 revision INTEGER NOT NULL DEFAULT 1,
 updated_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(until_at>from_at AND until_at-from_at<=interval '366 days'),
 CHECK(identity='pending' OR length(btrim(identity_evidence))>0),
 CHECK(status NOT IN ('verified','excluded','restricted') OR (length(btrim(evidence_reference))>0 AND length(btrim(internal_reason))>0)),
 CHECK(status<>'verified' OR (identity='confirmed' AND outcome IN ('provided','corrected','erased'))),
 CHECK(status<>'excluded' OR (identity='not_subject' AND outcome='not_subject')),
 CHECK(status<>'restricted' OR (identity='confirmed' AND outcome='limited')),
 CHECK(status NOT IN ('in_review','awaiting_company','awaiting_policy') OR identity='confirmed')
);
CREATE UNIQUE INDEX privacy_company_scope ON privacy_company_reviews(request_id,company_owner_id,COALESCE(staff_id,0),category,from_at,until_at);
CREATE TABLE privacy_company_review_events (
 id BIGSERIAL PRIMARY KEY,
 review_id BIGINT NOT NULL REFERENCES privacy_company_reviews(id) ON DELETE RESTRICT,
 actor_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 revision INTEGER NOT NULL, state JSONB NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(review_id,revision)
);
CREATE FUNCTION privacy_company_review_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r privacy_requests%ROWTYPE;
BEGIN
 SELECT * INTO r FROM privacy_requests WHERE id=NEW.request_id FOR UPDATE;
 IF r.status NOT IN ('received','in_review','needs_information') THEN RAISE EXCEPTION 'request closed'; END IF;
 IF NEW.company_owner_id=r.user_id THEN RAISE EXCEPTION 'separate company scope required'; END IF;
 IF NEW.due_at<r.created_at THEN RAISE EXCEPTION 'invalid review due date'; END IF;
 IF TG_OP='UPDATE' AND (NEW.request_id,NEW.company_owner_id,NEW.staff_id,NEW.category,NEW.from_at,NEW.until_at,NEW.inventory)
  IS DISTINCT FROM (OLD.request_id,OLD.company_owner_id,OLD.staff_id,OLD.category,OLD.from_at,OLD.until_at,OLD.inventory)
 THEN RAISE EXCEPTION 'review scope immutable'; END IF;
 IF NEW.status='verified' AND NEW.outcome<>(CASE r.kind WHEN 'access' THEN 'provided' WHEN 'rectification' THEN 'corrected' ELSE 'erased' END)
 THEN RAISE EXCEPTION 'outcome inconsistent with request'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_company_review_guard BEFORE INSERT OR UPDATE ON privacy_company_reviews
 FOR EACH ROW EXECUTE FUNCTION privacy_company_review_guard();
CREATE FUNCTION privacy_company_review_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO privacy_company_review_events(review_id,actor_id,revision,state)
 VALUES(NEW.id,NEW.updated_by,NEW.revision,to_jsonb(NEW));
 RETURN NULL;
END $$;
CREATE TRIGGER privacy_company_review_event AFTER INSERT OR UPDATE ON privacy_company_reviews
 FOR EACH ROW EXECUTE FUNCTION privacy_company_review_event();
CREATE FUNCTION privacy_company_completion_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='fulfilled' AND EXISTS(SELECT 1 FROM privacy_company_reviews WHERE request_id=NEW.id AND status NOT IN ('verified','excluded'))
 THEN RAISE EXCEPTION 'company scope unresolved'; END IF;
 IF NEW.status='rejected' AND EXISTS(SELECT 1 FROM privacy_company_reviews WHERE request_id=NEW.id AND status NOT IN ('verified','excluded','restricted'))
 THEN RAISE EXCEPTION 'company review unfinished'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_company_completion_guard BEFORE UPDATE ON privacy_requests
 FOR EACH ROW EXECUTE FUNCTION privacy_company_completion_guard();
CREATE FUNCTION privacy_company_public(rid BIGINT,subject BIGINT) RETURNS JSONB LANGUAGE sql STABLE AS $$
 SELECT COALESCE(jsonb_agg(jsonb_build_object('id',c.id,'category',c.category,'from_at',c.from_at,'until_at',c.until_at,
  'status',c.status,'message',c.public_message,'due_at',c.due_at,'updated_at',c.updated_at) ORDER BY c.id),'[]'::jsonb)
 FROM privacy_company_reviews c JOIN privacy_requests r ON r.id=c.request_id WHERE r.id=rid AND r.user_id=subject
$$;
