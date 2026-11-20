-- The materialized candidate keys do not propagate a constant device_id into
-- the decrypted view's join input. A monthly read could hash every SIM owned by
-- the same account, including wide ciphertext columns, before joining the keys.
-- Repeat the already-required SIM predicate explicitly on that input. Neither
-- receiving-owner isolation nor pending-bound fallback is weakened.
SET LOCAL lock_timeout='5s';
DO $$
DECLARE definition text; original text;
BEGIN
 SELECT pg_get_functiondef('location_query_records_between(bigint,bigint,timestamp with time zone,timestamp with time zone)'::regprocedure)
  INTO STRICT definition;
 original := 'USING(device_id,recorded_at,source) WHERE r.user_id=wanted_user';
 IF strpos(definition,original)=0 THEN
  RAISE EXCEPTION 'unreviewed location_query_records_between definition';
 END IF;
 EXECUTE replace(definition,original,
  original||' AND r.device_id=wanted_device');

 -- Charts need scalar metadata and fixes, not the raw payload in every
 -- materialized record. Keep boot precedence and the speed algorithm unchanged.
 SELECT pg_get_functiondef('location_speed_metrics_between(bigint,bigint,timestamp with time zone,timestamp with time zone)'::regprocedure)
  INTO STRICT definition;
 original := 'SELECT r.*,COALESCE(r.raw->>''boot_id'',r.raw->>''boot'') AS boot';
 IF strpos(definition,original)=0 THEN
  RAISE EXCEPTION 'unreviewed location_speed_metrics_between definition';
 END IF;
 EXECUTE replace(definition,original,
  'SELECT r.device_id,r.user_id,r.recorded_at,r.source,r.fix,r.lat,r.lng,r.sat,r.ttff_s,r.csq,r.reg,r.vbat_mv,r.device_uptime_s,r.heading,r.speed_kmh,r.fixes_jsonb,COALESCE(r.raw->>''boot_id'',r.raw->>''boot'') AS boot');
END $$;
