-- Filter each physical row once before expanding/decrypting it. Joining candidate
-- identities back to the decrypted view made compressed monthly reads build a
-- second, wide input and spill beyond the bounded temporary tablespace.
-- The disjoint arms retain owner isolation and exact pending-bound semantics.
SET LOCAL lock_timeout='5s';
DO $migration$
DECLARE projection text; fixes text;
BEGIN
 -- Query bounds are physical index metadata, deliberately absent from the
 -- logical view's row type. Reuse the exact authenticated view projection and
 -- put predicates on its physical source; do not extend its public row type.
 projection:=pg_get_viewdef('public.gps_read_location_records'::regclass,true);
 IF projection !~ 'FROM (public\.)?location_records t;[[:space:]]*$' THEN
  RAISE EXCEPTION 'unreviewed location read projection';
 END IF;
 projection:=regexp_replace(projection,';[[:space:]]*$','');
 fixes:=$cell$CASE WHEN t.fixes_jsonb_sealed IS NULL THEN t.fixes_jsonb ELSE gps_open_cell(t.fixes_jsonb_sealed,
  gps_cell_context('location_records',jsonb_build_object('device_id',t.device_id,'recorded_at',t.recorded_at,'source',t.source),
  ARRAY['device_id','recorded_at','source'],'fixes_jsonb')) END$cell$;
 EXECUTE format($definition$
 CREATE OR REPLACE FUNCTION location_query_records_between(
  wanted_device bigint,wanted_user bigint,from_time timestamptz,to_time timestamptz)
 RETURNS SETOF gps_read_location_records LANGUAGE sql STABLE PARALLEL RESTRICTED AS $body$
 %s
 WHERE t.device_id=wanted_device AND t.user_id=wanted_user AND t.query_bounds_ready
  AND (from_time IS NULL OR t.query_last_at>=from_time)
  AND (to_time IS NULL OR t.query_first_at<=to_time)
 UNION ALL
 %s
 WHERE t.device_id=wanted_device AND t.user_id=wanted_user AND NOT t.query_bounds_ready
  AND (from_time IS NULL OR location_point_bound(t.recorded_at,%s,true)>=from_time)
  AND (to_time IS NULL OR location_point_bound(t.recorded_at,%s,false)<=to_time)
 $body$;
 $definition$,projection,projection,fixes,fixes);
END $migration$;

-- These CTEs have one consumer. Materializing them forces every output column
-- (including unused metadata) into a separate tuplestore. Preserve the window,
-- deduplication and speed expressions while letting the caller prune columns.
DO $pipeline$
DECLARE name text; definition text;
BEGIN
 FOREACH name IN ARRAY ARRAY['location_speed_metrics_between',
   'location_history_points_between','location_sample_keys_between'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
   WHERE p.pronamespace='public'::regnamespace AND p.proname=name;
  IF strpos(definition,'records AS MATERIALIZED')=0 THEN
   RAISE EXCEPTION 'unreviewed single-consumer pipeline: %',name;
  END IF;
  definition:=replace(definition,'records AS MATERIALIZED','records AS NOT MATERIALIZED');
  IF name<>'location_sample_keys_between' THEN
   IF strpos(definition,'measurement AS MATERIALIZED')=0
      OR strpos(definition,'classified AS MATERIALIZED')=0 THEN
    RAISE EXCEPTION 'unreviewed speed pipeline: %',name;
   END IF;
   definition:=replace(definition,'measurement AS MATERIALIZED','measurement AS NOT MATERIALIZED');
   definition:=replace(definition,'classified AS MATERIALIZED','classified AS NOT MATERIALIZED');
  END IF;
  EXECUTE definition;
 END LOOP;
END $pipeline$;
