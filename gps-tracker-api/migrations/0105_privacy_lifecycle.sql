-- Round 21: independent processing controls and explicit retention consent.
-- No inherited consent, automatic deletion or production activation.
SET LOCAL lock_timeout='5s';
CREATE TABLE privacy_processing_controls (
 user_id bigint PRIMARY KEY REFERENCES users(id),
 use_paused boolean NOT NULL DEFAULT false,
 provision_paused boolean NOT NULL DEFAULT false,
 revision bigint NOT NULL DEFAULT 0,
 changed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE privacy_processing_events (
 id bigserial PRIMARY KEY, user_id bigint NOT NULL, actor_id bigint NOT NULL,
 use_paused boolean NOT NULL, provision_paused boolean NOT NULL,
 revision bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,revision)
);
CREATE TABLE privacy_retention_policy (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false, policy_reference text NOT NULL DEFAULT '',
 CHECK(NOT enabled OR length(trim(policy_reference))>=8)
);
INSERT INTO privacy_retention_policy DEFAULT VALUES;
CREATE TABLE privacy_retention_consents (
 user_id bigint PRIMARY KEY REFERENCES users(id),
 months integer NOT NULL CHECK(months BETWEEN 1 AND 12),
 contract_until timestamptz, consent_reference text NOT NULL CHECK(length(trim(consent_reference))>=8),
 consent_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(months<=6 OR contract_until IS NOT NULL)
);
-- Durable cutoff: keep separately from recoverable data before releasing a restored DB.
CREATE TABLE privacy_retention_runs (
 id bigserial PRIMARY KEY, user_id bigint NOT NULL, cutoff timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 counts jsonb NOT NULL, review_reasons jsonb NOT NULL, device_ids bigint[] NOT NULL DEFAULT ARRAY[]::bigint[],
 external_copies_verified boolean NOT NULL DEFAULT false CHECK(NOT external_copies_verified)
);
CREATE INDEX privacy_retention_cutoff ON privacy_retention_runs(user_id,cutoff DESC);
CREATE FUNCTION privacy_retention_ingest_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF gps_storage_rewrite_allowed() THEN RETURN NEW; END IF;
 IF EXISTS(SELECT 1 FROM privacy_retention_runs WHERE user_id=NEW.user_id AND NEW.recorded_at<cutoff)
 THEN RAISE EXCEPTION 'expired location boundary' USING ERRCODE='55000'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_retention_ingest BEFORE INSERT OR UPDATE ON location_records
 FOR EACH ROW EXECUTE FUNCTION privacy_retention_ingest_guard();
-- Automatic derivations stop too; this does not stop ingestion or erase originals.
CREATE FUNCTION privacy_processing_derived_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb:=to_jsonb(NEW); uid bigint; boundary timestamptz; at_time timestamptz;
BEGIN
 IF gps_storage_rewrite_allowed() THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='fcm_outbox' AND doc->>'status'='cancelled' THEN RETURN NEW; END IF;
 uid:=coalesce((doc->>'user_id')::bigint,(doc->>'owner_id')::bigint);
 IF uid IS NULL AND doc ? 'device_id' THEN SELECT owner_id INTO uid FROM devices WHERE id=(doc->>'device_id')::bigint; END IF;
 IF EXISTS(SELECT 1 FROM privacy_processing_controls WHERE (use_paused OR (TG_TABLE_NAME='fcm_outbox' AND provision_paused)) AND (user_id=uid OR uid IS NULL))
 THEN RETURN NULL; END IF;
 SELECT max(cutoff) INTO boundary FROM privacy_retention_runs WHERE user_id=uid;
 at_time:=coalesce((doc->>'first_fix_at')::timestamptz,(doc->>'first_inside_at')::timestamptz,
   ((doc->>'date')::date::timestamp AT TIME ZONE 'Asia/Seoul'),((doc->>'target_date')::date::timestamp AT TIME ZONE 'Asia/Seoul'));
 IF boundary IS NOT NULL AND at_time<boundary THEN RETURN NULL; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['daily_stats','ai_analyses','geofence_states','fleet_site_visits','fleet_site_states','fleet_site_cursors','fcm_outbox'] LOOP
  EXECUTE format('CREATE TRIGGER privacy_processing_derived BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_processing_derived_guard()',t);
 END LOOP;
END $$;

-- Legacy aggregates have no account attribution. Hide ambiguous pre-erasure
-- cells instead of exposing them or deleting another account's rows.
DO $$ DECLARE t text; definition text; BEGIN
 FOREACH t IN ARRAY ARRAY['location_1min','location_5min','location_1hour'] LOOP
  SELECT rtrim(pg_get_viewdef(('gps_read_'||t)::regclass,true),'; ') INTO definition;
  EXECUTE format('CREATE OR REPLACE VIEW %I AS SELECT legacy.* FROM (%s) legacy WHERE NOT EXISTS(SELECT 1 FROM privacy_retention_runs r WHERE legacy.device_id=ANY(r.device_ids) AND legacy.bucket<r.cutoff)','gps_read_'||t,definition);
 END LOOP;
END $$;
