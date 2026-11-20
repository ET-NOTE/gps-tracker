-- Keep the receiving owner/SIM identity, deduplication and speed algorithm.
-- Preserve source/time ordering through the window pipeline instead of writing
-- and re-sorting materialized samples and points. No persistent plaintext cache.
SET LOCAL lock_timeout='5s';
-- The authenticated context for this table has a fixed three-column identity.
-- Build those exact JSON bytes directly (UTC timestamp), and decode scalar
-- coordinates without constructing an entire composite record for every cell.
-- Encryption, MDC/context validation, key loading and ciphertext are unchanged.
DO $$
DECLARE col record; projection text:=''; expression text; context text;
BEGIN
 FOR col IN SELECT attname FROM pg_attribute
  WHERE attrelid='public.gps_read_location_records'::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum LOOP
  IF col.attname LIKE '%\_sealed' ESCAPE '\' THEN CONTINUE; END IF;
  expression:=format('t.%I',col.attname);
  IF col.attname=ANY(ARRAY['lat','lng','raw','fixes_jsonb']) THEN
   context:=format('jsonb_build_array(''gps-location-v1'',''location_records'',%L,jsonb_build_object(''device_id'',t.device_id,''recorded_at'',t.recorded_at AT TIME ZONE ''UTC'',''source'',t.source))::text',col.attname);
   expression:=format('gps_open_cell(t.%I,%s)',col.attname||'_sealed',context);
   IF col.attname IN ('lat','lng') THEN expression:='('||expression||' #>> ''{}'')::double precision'; END IF;
   expression:=format('CASE WHEN t.%I IS NULL THEN t.%I ELSE %s END',col.attname||'_sealed',col.attname,expression);
  END IF;
  projection:=projection||CASE WHEN projection='' THEN '' ELSE ',' END||expression||format(' AS %I',col.attname);
 END LOOP;
 EXECUTE 'CREATE OR REPLACE VIEW public.gps_read_location_records AS SELECT '||projection||' FROM public.location_records t';
END $$;
DO $$
DECLARE name text; definition text;
BEGIN
 FOREACH name IN ARRAY ARRAY['location_history_points_between',
   'location_speed_metrics_between','location_speed_points_between'] LOOP
  SELECT pg_get_functiondef(p.oid) INTO STRICT definition FROM pg_proc p
   JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public' AND p.proname=name;
  IF strpos(definition,'samples AS MATERIALIZED')=0
     OR strpos(definition,'points AS MATERIALIZED')=0
     OR strpos(definition,'ORDER BY p.recorded_at,r.source,(f.item IS NOT NULL) DESC,r.recorded_at DESC')=0 THEN
   RAISE EXCEPTION 'unreviewed window pipeline: %',name;
  END IF;
  definition:=replace(definition,'samples AS MATERIALIZED','samples AS NOT MATERIALIZED');
  definition:=replace(definition,'points AS MATERIALIZED','points AS NOT MATERIALIZED');
  definition:=replace(definition,'DISTINCT ON (p.recorded_at,r.source)',
    'DISTINCT ON (r.source,p.recorded_at)');
  definition:=replace(definition,'ORDER BY p.recorded_at,r.source,(f.item IS NOT NULL) DESC,r.recorded_at DESC',
    'ORDER BY r.source,p.recorded_at,(f.item IS NOT NULL) DESC,r.recorded_at DESC');
  IF name='location_speed_metrics_between' THEN
   definition:=replace(definition,'measurement AS (','measurement AS MATERIALIZED (');
   definition:=replace(definition,'classified AS (','classified AS MATERIALIZED (');
  END IF;
  EXECUTE definition;
 END LOOP;
END $$;
