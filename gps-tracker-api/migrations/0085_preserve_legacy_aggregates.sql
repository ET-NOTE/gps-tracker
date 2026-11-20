-- Live history/graphs use the owner-scoped location_*_between functions (v82).
-- These old CAGGs have no live data consumer. Preserve their exact published
-- values, including summaries whose raw inputs no longer exist. No recompute.
-- Migration is atomic: any lock/dependency/equality failure rolls everything back.
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
LOCK TABLE location_1min, location_5min, location_1hour IN ACCESS EXCLUSIVE MODE;

CREATE TABLE location_aggregate_archives (
 name TEXT PRIMARY KEY CHECK(name IN ('location_1min','location_5min','location_1hour')),
 archived_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 initial_rows BIGINT NOT NULL,
 mode TEXT NOT NULL DEFAULT 'preserved_legacy' CHECK(mode='preserved_legacy')
);

DO $$
DECLARE t TEXT; staging TEXT; rows BIGINT; differs BOOLEAN;
BEGIN
 FOREACH t IN ARRAY ARRAY['location_1min','location_5min','location_1hour'] LOOP
  IF NOT EXISTS(SELECT 1 FROM timescaledb_information.continuous_aggregates
                WHERE view_schema='public' AND view_name=t AND materialized_only) THEN
   RAISE EXCEPTION 'expected materialized-only legacy aggregate %',t;
  END IF;
  staging=t||'_preserved';
  EXECUTE format('CREATE TABLE %I AS TABLE %I',staging,t);
  EXECUTE format('ALTER TABLE %I ADD PRIMARY KEY(device_id,bucket)',staging);
  EXECUTE format('SELECT EXISTS((TABLE %I EXCEPT ALL TABLE %I) UNION ALL (TABLE %I EXCEPT ALL TABLE %I))',
                 t,staging,staging,t) INTO differs;
  IF differs THEN RAISE EXCEPTION 'aggregate copy differs: %',t; END IF;
  EXECUTE format('SELECT count(*) FROM %I',staging) INTO rows;
  INSERT INTO location_aggregate_archives(name,initial_rows) VALUES(t,rows);
  -- Supported Timescale DDL removes its refresh job and internal materialization.
  -- No CASCADE: an unexpected dependent object must abort the migration.
  EXECUTE format('DROP MATERIALIZED VIEW %I',t);
  EXECUTE format('ALTER TABLE %I RENAME TO %I',staging,t);
  EXECUTE format('COMMENT ON TABLE %I IS %L',t,
    'Preserved legacy summary; not refreshed. Live charts use owner-scoped location functions. Retention policy remains to be decided.');
  EXECUTE format('CREATE TRIGGER privacy_device_write BEFORE INSERT OR UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION privacy_guard_device_write(''direct'')',t);
 END LOOP;
END $$;

CREATE FUNCTION privacy_erase_device_aggregates(job UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE j device_data_erasure_jobs%ROWTYPE; t TEXT; n BIGINT; counts JSONB='{}';
BEGIN
 SELECT * INTO STRICT j FROM device_data_erasure_jobs WHERE id=job;
 PERFORM pg_advisory_xact_lock(j.device_id);
 PERFORM 1 FROM device_data_controls WHERE device_id=j.device_id AND blocked FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'erasure barrier missing'; END IF;
 SELECT * INTO STRICT j FROM device_data_erasure_jobs WHERE id=job FOR UPDATE;
 IF j.state='blocked' THEN RAISE EXCEPTION 'primary erasure incomplete'; END IF;
 FOREACH t IN ARRAY ARRAY['location_1min','location_5min','location_1hour'] LOOP
  IF j.deleted_counts ? t THEN
   counts=counts||jsonb_build_object(t,j.deleted_counts->t);
  ELSE
   IF NOT EXISTS(SELECT 1 FROM location_aggregate_archives WHERE name=t) THEN
    RAISE EXCEPTION 'aggregate preservation incomplete';
   END IF;
   EXECUTE format('DELETE FROM %I WHERE device_id=$1',t) USING j.device_id;
   GET DIAGNOSTICS n=ROW_COUNT; counts=counts||jsonb_build_object(t,n);
  END IF;
 END LOOP;
 UPDATE device_data_erasure_jobs SET deleted_counts=deleted_counts||counts WHERE id=job;
 RETURN counts;
END $$;
REVOKE ALL ON FUNCTION privacy_erase_device_aggregates(UUID) FROM PUBLIC;

CREATE OR REPLACE FUNCTION privacy_erase_device_primary(job UUID) RETURNS JSONB LANGUAGE plpgsql AS $$
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
 -- Remove event dependents first: ON DELETE SET NULL would otherwise trigger
 -- the write barrier while deleting the parent event.
 FOREACH t IN ARRAY ARRAY['location_records','connection_alert_episodes','events','daily_stats','trip_annotations',
  'ai_analyses','geofence_states','geofences','stats_rebuild_queue','device_audit_log','share_tokens'] LOOP
  -- Timescale compressed batch deletion can report ROW_COUNT=0. The barrier
  -- prevents new writes; count logical rows before deletion and verify empty.
  EXECUTE format('SELECT count(*) FROM %I WHERE device_id=$1',t) INTO n USING j.device_id;
  EXECUTE format('DELETE FROM %I WHERE device_id=$1',t) USING j.device_id;
  counts=counts||jsonb_build_object(t,n);
 END LOOP;
 UPDATE devices SET last_lat=NULL,last_lng=NULL,last_fix_at=NULL,last_stationary=NULL,
  last_seen_at=NULL,cycle_first_fix_pending=false WHERE id=j.device_id;
 UPDATE device_data_erasure_jobs SET state='primary_erased',primary_erased_at=clock_timestamp(),deleted_counts=counts WHERE id=job;
 RETURN counts;
END $$;

REVOKE ALL ON FUNCTION privacy_erase_device_primary(UUID) FROM PUBLIC;
