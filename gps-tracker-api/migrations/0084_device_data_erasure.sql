-- Device-wide ACTIVE DATABASE erasure, not account closure or backup destruction.
-- SIM device rows and credentials remain; no automatic resume after erasure.
CREATE TABLE device_data_controls (
 device_id BIGINT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
 blocked BOOLEAN NOT NULL DEFAULT false,
 blocked_at TIMESTAMPTZ
);
INSERT INTO device_data_controls(device_id) SELECT id FROM devices;
CREATE FUNCTION privacy_device_control_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO device_data_controls(device_id) VALUES(NEW.id);
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_device_control_created AFTER INSERT ON devices
 FOR EACH ROW EXECUTE FUNCTION privacy_device_control_created();

CREATE TABLE device_data_erasure_jobs (
 id UUID PRIMARY KEY,
 device_id BIGINT NOT NULL UNIQUE REFERENCES devices(id) ON DELETE RESTRICT,
 expected_owner_id BIGINT NOT NULL,
 actor_id BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('blocked','primary_erased','active_db_verified')),
 started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 primary_erased_at TIMESTAMPTZ, verified_at TIMESTAMPTZ,
 window_start TIMESTAMPTZ, window_end TIMESTAMPTZ,
 deleted_counts JSONB NOT NULL DEFAULT '{}',
 external_copies_verified BOOLEAN NOT NULL DEFAULT false CHECK(NOT external_copies_verified)
);

-- Lock the persistent control row while writing. The eraser obtains its exclusive
-- lock after the existing ingest advisory lock. Thus a worker already writing
-- finishes before deletion, while a stale worker starting later is rejected.
CREATE FUNCTION privacy_assert_device_writable(did BIGINT) RETURNS void LANGUAGE plpgsql AS $$
DECLARE stopped BOOLEAN;
BEGIN
 IF did IS NULL THEN RETURN; END IF;
 SELECT blocked INTO stopped FROM device_data_controls WHERE device_id=did FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'device data control missing'; END IF;
 IF stopped THEN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='device data collection blocked by erasure'; END IF;
END $$;

CREATE FUNCTION privacy_guard_device_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE did BIGINT; prior_did BIGINT;
BEGIN
 IF TG_ARGV[0]='direct' THEN did=NEW.device_id;
 ELSIF TG_ARGV[0]='source' THEN did=NEW.source_device_id;
 ELSIF TG_ARGV[0]='binding' THEN
  SELECT device_id INTO did FROM fleet_vehicle_bindings WHERE id=NEW.binding_id;
 ELSIF TG_ARGV[0]='annotation_audit' THEN
  did=NULLIF(NEW.after_value->>'device_id','')::bigint;
  prior_did=NULLIF(NEW.before_value->>'device_id','')::bigint;
 ELSIF TG_ARGV[0]='notification' THEN
  SELECT device_id INTO did FROM events WHERE id=NEW.event_id;
  IF did IS NULL AND (NEW.message#>>'{data,device_id}') ~ '^[0-9]{1,18}$' THEN
   did=(NEW.message#>>'{data,device_id}')::bigint;
  END IF;
 END IF;
 PERFORM privacy_assert_device_writable(did);
 IF prior_did IS DISTINCT FROM did THEN PERFORM privacy_assert_device_writable(prior_did); END IF;
 RETURN NEW;
END $$;

DO $$
DECLARE t TEXT;
BEGIN
 FOREACH t IN ARRAY ARRAY['location_records','events','daily_stats','trip_annotations',
  'ai_analyses','geofence_states','geofences','stats_rebuild_queue',
  'connection_alert_episodes','device_audit_log','share_tokens'] LOOP
  EXECUTE format('CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write(''direct'')',t);
 END LOOP;
 FOREACH t IN ARRAY ARRAY['fleet_site_visits','fleet_site_states','fleet_site_cursors'] LOOP
  EXECUTE format('CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write(''binding'')',t);
 END LOOP;
END $$;
CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON fleet_trip_corrections
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write('source');
CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON fleet_trip_assignment_audit
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write('annotation_audit');
CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON fcm_outbox
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write('notification');

CREATE FUNCTION privacy_guard_device_cache() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
  PERFORM privacy_assert_device_writable(NEW.id);
 END IF;
 IF NEW.last_seen_at IS DISTINCT FROM OLD.last_seen_at AND NEW.last_seen_at IS NOT NULL THEN
  PERFORM privacy_assert_device_writable(NEW.id);
 END IF;
 IF (NEW.last_lat,NEW.last_lng,NEW.last_fix_at,NEW.last_stationary) IS DISTINCT FROM
    (OLD.last_lat,OLD.last_lng,OLD.last_fix_at,OLD.last_stationary)
    AND (NEW.last_lat IS NOT NULL OR NEW.last_lng IS NOT NULL OR NEW.last_fix_at IS NOT NULL OR NEW.last_stationary IS NOT NULL) THEN
  PERFORM privacy_assert_device_writable(NEW.id);
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER privacy_device_cache BEFORE UPDATE ON devices
 FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_cache();

-- Explicit all-owner scope. Only the operator command exposes this function;
-- it is never called by the personal request workflow or account DELETE.
CREATE FUNCTION privacy_begin_device_erasure(job UUID,did BIGINT,expected_owner BIGINT,expected_name TEXT,actor BIGINT)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE existing device_data_erasure_jobs%ROWTYPE; first_at TIMESTAMPTZ; last_at TIMESTAMPTZ;
BEGIN
 PERFORM pg_advisory_xact_lock(did);
 SELECT * INTO existing FROM device_data_erasure_jobs WHERE device_id=did;
 IF FOUND THEN
  IF existing.id<>job OR existing.expected_owner_id<>expected_owner THEN
   RAISE EXCEPTION 'erasure target already has a different job';
  END IF;
  RETURN existing.id;
 END IF;
 IF NOT EXISTS(SELECT 1 FROM devices WHERE id=did AND owner_id=expected_owner AND display_name=expected_name) THEN
  RAISE EXCEPTION 'device identity changed';
 END IF;
 UPDATE device_data_controls SET blocked=true,blocked_at=clock_timestamp() WHERE device_id=did;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure barrier missing'; END IF;
 -- A non-ingest writer may have changed ownership while we waited for its
 -- shared control lock. Recheck after the exclusive barrier is acquired.
 IF NOT EXISTS(SELECT 1 FROM devices WHERE id=did AND owner_id=expected_owner AND display_name=expected_name) THEN
  RAISE EXCEPTION 'device identity changed while fencing writers';
 END IF;
 -- Include materialized history whose raw rows may already have expired.
 SELECT min(at),max(at) INTO first_at,last_at FROM (
  SELECT min(recorded_at) at FROM location_records WHERE device_id=did UNION ALL
  SELECT max(recorded_at) FROM location_records WHERE device_id=did UNION ALL
  SELECT min(bucket) FROM location_1min WHERE device_id=did UNION ALL
  SELECT max(bucket) FROM location_1min WHERE device_id=did UNION ALL
  SELECT min(bucket) FROM location_5min WHERE device_id=did UNION ALL
  SELECT max(bucket) FROM location_5min WHERE device_id=did UNION ALL
  SELECT min(bucket) FROM location_1hour WHERE device_id=did UNION ALL
  SELECT max(bucket) FROM location_1hour WHERE device_id=did
 ) x;
 INSERT INTO device_data_erasure_jobs(id,device_id,expected_owner_id,actor_id,state,window_start,window_end)
 VALUES(job,did,expected_owner,actor,'blocked',date_trunc('day',first_at)-interval '1 day',date_trunc('day',last_at)+interval '2 days');
 RETURN job;
END $$;

CREATE FUNCTION privacy_erase_device_primary(job UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE j device_data_erasure_jobs%ROWTYPE; t TEXT; n BIGINT; counts JSONB='{}';
BEGIN
 SELECT * INTO STRICT j FROM device_data_erasure_jobs WHERE id=job;
 PERFORM pg_advisory_xact_lock(j.device_id);
 PERFORM 1 FROM device_data_controls WHERE device_id=j.device_id AND blocked FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure barrier missing'; END IF;
 SELECT * INTO STRICT j FROM device_data_erasure_jobs WHERE id=job FOR UPDATE;
 IF j.state<>'blocked' THEN RETURN j.deleted_counts; END IF;
 IF EXISTS(SELECT 1 FROM fcm_outbox o WHERE o.lease_until>now() AND
   (o.event_id IN (SELECT id FROM events WHERE device_id=j.device_id) OR o.message#>>'{data,device_id}'=j.device_id::text)) THEN
  RAISE EXCEPTION 'notification delivery in flight; retry after lease expiry';
 END IF;
 -- Device files and contract/vehicle attachments require the separate file
 -- executor and retention review. Fail before deleting anything if present.
 IF EXISTS(SELECT 1 FROM device_documents WHERE device_id=j.device_id)
 OR EXISTS(SELECT 1 FROM device_documents d JOIN fleet_vehicle_bindings b ON b.vehicle_id=d.fleet_vehicle_id WHERE b.device_id=j.device_id)
 OR EXISTS(SELECT 1 FROM rental_photos p JOIN rental_contracts c ON c.id=p.contract_id WHERE c.device_id=j.device_id)
 OR EXISTS(SELECT 1 FROM devices WHERE id=j.device_id AND NULLIF(car_image_url,'') IS NOT NULL) THEN
  RAISE EXCEPTION 'linked files require separate erasure review';
 END IF;
 DELETE FROM fcm_outbox WHERE event_id IN (SELECT id FROM events WHERE device_id=j.device_id)
  OR message#>>'{data,device_id}'=j.device_id::text;
 GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object('fcm_outbox',n);
 FOREACH t IN ARRAY ARRAY['fleet_site_states','fleet_site_visits','fleet_site_cursors'] LOOP
  EXECUTE format('DELETE FROM %I WHERE binding_id IN (SELECT id FROM fleet_vehicle_bindings WHERE device_id=$1)',t) USING j.device_id;
  GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object(t,n);
 END LOOP;
 DELETE FROM fleet_trip_corrections WHERE source_device_id=j.device_id;
 GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object('fleet_trip_corrections',n);
 DELETE FROM fleet_trip_assignment_audit WHERE before_value->>'device_id'=j.device_id::text OR after_value->>'device_id'=j.device_id::text;
 GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object('fleet_trip_assignment_audit',n);
 -- AI request receipts and transaction rows are retained; analysis_id becomes
 -- NULL through its FK. Their legal retention is not decided by this operation.
 FOREACH t IN ARRAY ARRAY['location_records','events','daily_stats','trip_annotations',
  'ai_analyses','geofence_states','geofences','stats_rebuild_queue','connection_alert_episodes','device_audit_log','share_tokens'] LOOP
  EXECUTE format('DELETE FROM %I WHERE device_id=$1',t) USING j.device_id;
  GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object(t,n);
 END LOOP;
 UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL,last_stationary=NULL,
  last_seen_at=NULL,cycle_first_fix_pending=false WHERE id=j.device_id;
 UPDATE device_data_erasure_jobs SET state='primary_erased',primary_erased_at=clock_timestamp(),deleted_counts=counts WHERE id=job;
 RETURN counts;
END $$;

-- No public/anonymous database role may run privileged job functions.
REVOKE ALL ON FUNCTION privacy_begin_device_erasure(UUID,BIGINT,BIGINT,TEXT,BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION privacy_erase_device_primary(UUID) FROM PUBLIC;

CREATE FUNCTION privacy_verify_device_erasure(job UUID) RETURNS void LANGUAGE plpgsql AS $$
DECLARE j device_data_erasure_jobs%ROWTYPE; t TEXT; remains BOOLEAN;
BEGIN
 SELECT * INTO STRICT j FROM device_data_erasure_jobs WHERE id=job;
 PERFORM pg_advisory_xact_lock(j.device_id);
 PERFORM 1 FROM device_data_controls WHERE device_id=j.device_id AND blocked FOR UPDATE;
 IF NOT FOUND OR j.state='blocked' THEN RAISE EXCEPTION 'primary erasure incomplete'; END IF;
 FOREACH t IN ARRAY ARRAY['location_records','events','daily_stats','trip_annotations',
  'ai_analyses','geofence_states','geofences','stats_rebuild_queue','connection_alert_episodes',
  'device_audit_log','share_tokens','location_1min','location_5min','location_1hour'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE device_id=$1)',t) INTO remains USING j.device_id;
  IF remains THEN RAISE EXCEPTION 'remaining device rows in %',t; END IF;
 END LOOP;
 FOREACH t IN ARRAY ARRAY['fleet_site_visits','fleet_site_states','fleet_site_cursors'] LOOP
  EXECUTE format('SELECT EXISTS(SELECT 1 FROM %I WHERE binding_id IN (SELECT id FROM fleet_vehicle_bindings WHERE device_id=$1))',t) INTO remains USING j.device_id;
  IF remains THEN RAISE EXCEPTION 'remaining linked device rows in %',t; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM fleet_trip_corrections WHERE source_device_id=j.device_id)
 OR EXISTS(SELECT 1 FROM fleet_trip_assignment_audit WHERE before_value->>'device_id'=j.device_id::text OR after_value->>'device_id'=j.device_id::text)
 OR EXISTS(SELECT 1 FROM fcm_outbox WHERE message#>>'{data,device_id}'=j.device_id::text)
 OR EXISTS(SELECT 1 FROM devices WHERE id=j.device_id AND (last_lat IS NOT NULL OR last_lng IS NOT NULL OR last_fix_at IS NOT NULL OR last_stationary IS NOT NULL)) THEN
  RAISE EXCEPTION 'remaining derived device data';
 END IF;
 UPDATE device_data_erasure_jobs SET state='active_db_verified',verified_at=clock_timestamp() WHERE id=job;
END $$;
REVOKE ALL ON FUNCTION privacy_verify_device_erasure(UUID) FROM PUBLIC;
