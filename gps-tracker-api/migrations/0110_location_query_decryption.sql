-- Reuse the narrow authenticated identity expression introduced in 104 for the
-- three original encrypted projections too. Whole-row JSON serialization copies
-- every ciphertext (including the raw batch) once for each projected field.
-- Only the authenticated table/field/primary identity belongs in that context.
SET LOCAL lock_timeout='5s';
DO $$
DECLARE target record; col record; projection text; expression text;
BEGIN
 FOR target IN SELECT * FROM location_storage_fields
   WHERE table_name IN ('location_records','devices','events') ORDER BY table_name LOOP
  projection:='';
  FOR col IN SELECT attname FROM pg_attribute
    WHERE attrelid=format('public.%I',target.table_name)::regclass
      AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
   IF col.attname LIKE '%\_sealed' ESCAPE '\' THEN CONTINUE; END IF;
   expression:=format('t.%I',col.attname);
   IF col.attname=ANY(target.fields) THEN
    expression:=gps_storage_expression(target.table_name,col.attname,target.identity_columns,'t');
   END IF;
   projection:=projection||CASE WHEN projection='' THEN '' ELSE ',' END
     ||expression||format(' AS %I',col.attname);
  END LOOP;
  EXECUTE format('CREATE OR REPLACE VIEW public.gps_read_%I AS SELECT %s FROM public.%I t',
    target.table_name,projection,target.table_name);
 END LOOP;
END $$;

-- Time envelopes contain no coordinates or payload. They let the time indexes
-- reject unrelated transmissions before any coordinate/payload decryption.
-- Old encrypted rows remain correct through the fallback until explicitly
-- backfilled with the key; migrations never require or persist that key.
ALTER TABLE location_records
 ADD COLUMN query_first_at timestamptz,
 ADD COLUMN query_last_at timestamptz,
 ADD COLUMN query_bounds_ready boolean NOT NULL DEFAULT false;

CREATE FUNCTION gps_location_query_bounds() RETURNS trigger LANGUAGE plpgsql
SET search_path=pg_catalog,public AS $$
DECLARE fixes jsonb;
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.query_bounds_ready
    AND ROW(NEW.device_id,NEW.recorded_at,NEW.source,NEW.fixes_jsonb,NEW.fixes_jsonb_sealed)
      IS NOT DISTINCT FROM ROW(OLD.device_id,OLD.recorded_at,OLD.source,OLD.fixes_jsonb,OLD.fixes_jsonb_sealed) THEN
   NEW.query_first_at:=OLD.query_first_at;
   NEW.query_last_at:=OLD.query_last_at;
   NEW.query_bounds_ready:=true;
   RETURN NEW;
  END IF;
 END IF;
 fixes:=CASE WHEN NEW.fixes_jsonb_sealed IS NULL THEN NEW.fixes_jsonb
   ELSE gps_open_cell(NEW.fixes_jsonb_sealed,gps_cell_context('location_records',
     jsonb_build_object('device_id',NEW.device_id,'recorded_at',NEW.recorded_at,'source',NEW.source),
     ARRAY['device_id','recorded_at','source'],'fixes_jsonb')) END;
 NEW.query_first_at:=location_point_bound(NEW.recorded_at,fixes,false);
 NEW.query_last_at:=location_point_bound(NEW.recorded_at,fixes,true);
 NEW.query_bounds_ready:=true;
 RETURN NEW;
END $$;
-- Alphabetical order is intentional: run after seal_* has authenticated NEW.
CREATE TRIGGER zz_location_query_bounds BEFORE INSERT OR UPDATE ON location_records
 FOR EACH ROW EXECUTE FUNCTION gps_location_query_bounds();
CREATE INDEX location_query_end_idx ON location_records
 (device_id,user_id,query_last_at DESC) WHERE query_bounds_ready;
CREATE INDEX location_query_start_idx ON location_records
 (device_id,user_id,query_first_at) WHERE query_bounds_ready;
CREATE INDEX location_query_pending_idx ON location_records
 (device_id,user_id,recorded_at) WHERE NOT query_bounds_ready;

CREATE FUNCTION location_latest_sample_at(wanted_device bigint,wanted_user bigint)
RETURNS timestamptz LANGUAGE sql STABLE PARALLEL RESTRICTED AS $$
 SELECT max(at) FROM (
  SELECT max(query_last_at) AS at FROM location_records
   WHERE device_id=wanted_device AND user_id=wanted_user AND query_bounds_ready
  UNION ALL
  SELECT max(location_point_bound(r.recorded_at,r.fixes_jsonb,true)) FROM gps_read_location_records r
   JOIN location_records physical USING(device_id,recorded_at,source)
   WHERE r.device_id=wanted_device AND r.user_id=wanted_user AND NOT physical.query_bounds_ready
 ) bounds
$$;

CREATE FUNCTION location_query_records_between(wanted_device bigint,wanted_user bigint,
                                               from_time timestamptz,to_time timestamptz)
RETURNS SETOF gps_read_location_records LANGUAGE sql STABLE PARALLEL RESTRICTED AS $$
 WITH candidates AS MATERIALIZED (
  SELECT r.device_id,r.recorded_at,r.source FROM location_records r
   WHERE r.device_id=wanted_device AND r.user_id=wanted_user AND r.query_bounds_ready
    AND (from_time IS NULL OR r.query_last_at>=from_time)
    AND (to_time IS NULL OR r.query_first_at<=to_time)
  UNION ALL
  SELECT r.device_id,r.recorded_at,r.source FROM location_records r
   WHERE r.device_id=wanted_device AND r.user_id=wanted_user AND NOT r.query_bounds_ready
    AND (from_time IS NULL OR location_point_bound(r.recorded_at,
      CASE WHEN r.fixes_jsonb_sealed IS NULL THEN r.fixes_jsonb ELSE gps_open_cell(r.fixes_jsonb_sealed,
       gps_cell_context('location_records',jsonb_build_object('device_id',r.device_id,'recorded_at',r.recorded_at,'source',r.source),
         ARRAY['device_id','recorded_at','source'],'fixes_jsonb')) END,true)>=from_time)
    AND (to_time IS NULL OR location_point_bound(r.recorded_at,
      CASE WHEN r.fixes_jsonb_sealed IS NULL THEN r.fixes_jsonb ELSE gps_open_cell(r.fixes_jsonb_sealed,
       gps_cell_context('location_records',jsonb_build_object('device_id',r.device_id,'recorded_at',r.recorded_at,'source',r.source),
         ARRAY['device_id','recorded_at','source'],'fixes_jsonb')) END,false)<=to_time)
 )
 SELECT r.* FROM candidates c JOIN gps_read_location_records r
   USING(device_id,recorded_at,source) WHERE r.user_id=wanted_user
$$;

-- Keep the existing expansion, deduplication, source precedence, 65-second speed
-- context and reporting algorithms byte-for-byte. Change only their row source.
DO $$
DECLARE name text; definition text; old_source text; new_source text; lower_bound text;
BEGIN
 FOREACH name IN ARRAY ARRAY['location_points_between','location_speed_points_between',
   'location_speed_metrics_between','location_history_points_between','location_sample_keys_between'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname=name;
  lower_bound:=CASE WHEN name IN ('location_points_between','location_sample_keys_between')
    THEN 'from_time' ELSE '(from_time-interval ''65 seconds'')' END;
  old_source:='FROM gps_read_location_records r'||chr(10)
    ||' WHERE r.device_id=wanted_device AND r.user_id=wanted_user'||chr(10)
    ||' AND ('||lower_bound||' IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,true)>='||lower_bound||')'||chr(10)
    ||' AND (to_time IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,false)<=to_time)';
  new_source:='FROM location_query_records_between(wanted_device,wanted_user,'||lower_bound||',to_time) r';
  IF strpos(definition,old_source)=0 THEN RAISE EXCEPTION 'unreviewed location query definition: %',name; END IF;
  EXECUTE replace(definition,old_source,new_source);
 END LOOP;
END $$;
