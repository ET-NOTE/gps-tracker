-- 18B: durable per-operation intents; no position, address, token, body or IP.
-- 0100 remains unchanged as legacy aggregated evidence, never backfilled.
CREATE TABLE location_access_events (
 id BIGSERIAL PRIMARY KEY,
 started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 completed_at TIMESTAMPTZ,
 coverage_id BIGINT NOT NULL REFERENCES location_access_coverage(id),
 account_scope_id BIGINT,
 attribution TEXT NOT NULL CHECK(attribution IN ('request_account','owner_snapshot','company_scope','share_creator','privacy_request','all_accounts','unresolved')),
 -- An account scope is NOT proof of the driver / personal location subject.
 subject_user_id BIGINT CHECK(subject_user_id IS NULL),
 all_subjects BOOLEAN NOT NULL DEFAULT false,
 device_id BIGINT, vehicle_id BIGINT, share_id BIGINT,
 recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('self','company','admin','share_link','processor')),
 recipient_user_id BIGINT,
 recipient_name TEXT CHECK(recipient_name IS NULL OR recipient_name ~ '^[a-z0-9_]{1,32}$'),
 path TEXT NOT NULL CHECK(path IN ('api','share_link','realtime','impersonation','server')),
 method TEXT NOT NULL CHECK(method IN ('position','track','trips','stats','events','analysis','file','geocode','push')),
 route TEXT NOT NULL CHECK(length(route) BETWEEN 1 AND 160 AND route !~ '[?=]'),
 range_from TIMESTAMPTZ, range_until TIMESTAMPTZ,
 binding_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(binding_snapshot)='array'),
 outcome TEXT NOT NULL DEFAULT 'prepared' CHECK(outcome IN ('prepared','response_ready','denied','socket_sent','http_accepted','http_rejected','transport_unknown')),
 CHECK((outcome='prepared')=(completed_at IS NULL)),
 CHECK(completed_at IS NULL OR completed_at>=started_at),
 CHECK((recipient_kind IN ('self','company','admin'))=(recipient_user_id IS NOT NULL)),
 CHECK((recipient_kind='processor')=(recipient_name IS NOT NULL)),
 CHECK(NOT all_subjects OR account_scope_id IS NULL)
);
CREATE INDEX location_access_events_scope ON location_access_events(account_scope_id,started_at,id);
CREATE INDEX location_access_events_time ON location_access_events(started_at,id);

-- A transaction-bound grant is only made by the reviewed erasure function.
-- API table ownership is still a known boundary: role/DDL separation is round 19.
CREATE TABLE location_access_erasure_runs (
 id BIGSERIAL PRIMARY KEY, request_id BIGINT NOT NULL REFERENCES privacy_requests(id),
 request_revision INTEGER NOT NULL, account_scope_id BIGINT NOT NULL, actor_id BIGINT NOT NULL,
 period_from TIMESTAMPTZ NOT NULL, period_until TIMESTAMPTZ NOT NULL,
 evidence_reference TEXT NOT NULL CHECK(length(btrim(evidence_reference)) BETWEEN 1 AND 160),
 transaction_id BIGINT NOT NULL DEFAULT txid_current(),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), removed BIGINT NOT NULL DEFAULT 0,
 CHECK(period_from<period_until), UNIQUE(request_id,request_revision)
);
REVOKE ALL ON location_access_erasure_runs FROM PUBLIC;

CREATE FUNCTION location_access_event_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.outcome<>'prepared' OR NEW.outcome='prepared'
     OR (to_jsonb(NEW)-'outcome'-'completed_at') IS DISTINCT FROM (to_jsonb(OLD)-'outcome'-'completed_at') THEN
   RAISE EXCEPTION 'immutable location access event' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.started_at>now()-interval '6 months' AND NOT EXISTS(
   SELECT 1 FROM location_access_erasure_runs r WHERE r.transaction_id=txid_current()
     AND r.account_scope_id=OLD.account_scope_id AND OLD.started_at>=r.period_from AND OLD.started_at<r.period_until
     AND OLD.attribution IN ('request_account','privacy_request') AND NOT OLD.all_subjects
     AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=OLD.device_id)
 ) THEN
  RAISE EXCEPTION 'reviewed erasure or retention expiry required' USING ERRCODE='23514';
 END IF;
 RETURN OLD;
END $$;
CREATE TRIGGER location_access_event_guard BEFORE UPDATE OR DELETE ON location_access_events
 FOR EACH ROW EXECUTE FUNCTION location_access_event_guard();
CREATE TRIGGER location_access_events_truncate BEFORE TRUNCATE ON location_access_events
 FOR EACH STATEMENT EXECUTE FUNCTION location_access_no_truncate();

CREATE FUNCTION privacy_erase_access_events(p_request BIGINT,p_revision INTEGER,p_actor BIGINT,
 p_from TIMESTAMPTZ,p_until TIMESTAMPTZ,p_evidence TEXT) RETURNS BIGINT
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r privacy_requests%ROWTYPE; run_id BIGINT; n BIGINT;
BEGIN
 SELECT * INTO r FROM privacy_requests WHERE id=p_request FOR UPDATE;
 IF NOT FOUND OR r.kind NOT IN ('erasure','account_closure') OR r.status<>'in_review' OR r.revision<>p_revision
    OR NOT EXISTS(SELECT 1 FROM users WHERE id=p_actor AND role='admin')
    OR p_from IS NULL OR p_until IS NULL OR p_from>=p_until OR p_until>clock_timestamp()
    OR length(btrim(COALESCE(p_evidence,''))) NOT BETWEEN 1 AND 160 THEN
  RAISE EXCEPTION 'reviewed scope required' USING ERRCODE='23514';
 END IF;
 -- Same lock as intent creation: no pending pre-erasure insert can reappear.
 PERFORM pg_advisory_xact_lock(1830,r.user_id::int);
 INSERT INTO location_access_erasure_runs(request_id,request_revision,account_scope_id,actor_id,period_from,period_until,evidence_reference)
 VALUES(r.id,r.revision,r.user_id,p_actor,p_from,p_until,p_evidence) RETURNING id INTO run_id;
 DELETE FROM location_access_events e WHERE e.account_scope_id=r.user_id AND e.started_at>=p_from AND e.started_at<p_until
   AND e.attribution IN ('request_account','privacy_request') AND NOT e.all_subjects
   AND NOT EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.device_id=e.device_id);
 GET DIAGNOSTICS n=ROW_COUNT;
 UPDATE location_access_erasure_runs SET removed=n WHERE id=run_id;
 INSERT INTO admin_audit_log(admin_id,target_user,action,data) VALUES(p_actor,r.user_id,'location_access_erasure',
  jsonb_build_object('request_id',r.id,'revision',r.revision,'from',p_from,'until',p_until,'removed',n,'run_id',run_id));
 -- Partial executor: does not mark the overall request fulfilled or erase unrelated/company facts.
 RETURN n;
END $$;
REVOKE ALL ON FUNCTION privacy_erase_access_events(BIGINT,INTEGER,BIGINT,TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM PUBLIC;

-- Derived summary; one event remains one row. Never replace the source with this view.
CREATE VIEW location_access_hourly AS
 SELECT date_trunc('hour',started_at) AS bucket,account_scope_id,attribution,recipient_kind,recipient_user_id,
 recipient_name,path,method,route,outcome,count(*) AS hits,min(started_at) AS first_at,max(started_at) AS last_at
 FROM location_access_events GROUP BY 1,2,3,4,5,6,7,8,9,10;

-- Compatibility for facts/admin exporters; explicitly labels legacy aggregates and unresolved subjects.
CREATE VIEW location_access_records AS
 SELECT id,started_at AS first_at,COALESCE(completed_at,started_at) AS last_at,1::integer AS hits,
 account_scope_id AS subject_user_id,all_subjects,device_id,vehicle_id,share_id,recipient_kind,
 recipient_user_id,recipient_name,path,method,range_from,range_until,date_trunc('hour',started_at) AS bucket,
 attribution,outcome,route,'event'::text AS record_type,subject_user_id AS actual_subject_user_id
 FROM location_access_events
 UNION ALL
 SELECT id,first_at,last_at,hits,subject_user_id,all_subjects,device_id,vehicle_id,share_id,recipient_kind,
 recipient_user_id,recipient_name,path,method,range_from,range_until,bucket,
 'legacy_unverified','legacy_aggregate',NULL,'legacy_hourly',NULL::bigint FROM location_access_log;
