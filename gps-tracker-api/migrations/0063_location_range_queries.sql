-- Prune whole transmissions before expanding JSONB. UTC arithmetic makes the
-- expression index independent of the connection's timezone (including DST).
CREATE FUNCTION location_point_bound(at_time timestamptz, fixes jsonb, newest boolean)
RETURNS timestamptz LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE WHEN fixes IS NULL THEN at_time ELSE
    (at_time AT TIME ZONE 'UTC' +
      (SELECT CASE WHEN newest THEN max(COALESCE((f->>'at_ms')::bigint,0))
                   ELSE min(COALESCE((f->>'at_ms')::bigint,0)) END
       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fixes)='array' THEN fixes ELSE '[]'::jsonb END) f)
      * interval '1 millisecond') AT TIME ZONE 'UTC' END
$$;

CREATE INDEX location_point_end_idx ON location_records
  (device_id, user_id, location_point_bound(recorded_at,fixes_jsonb,true) DESC);
CREATE INDEX location_point_start_idx ON location_records
  (device_id, user_id, location_point_bound(recorded_at,fixes_jsonb,false));

CREATE FUNCTION location_points_between(wanted_device bigint, wanted_user bigint,
                                        from_time timestamptz, to_time timestamptz)
RETURNS SETOF location_points LANGUAGE sql STABLE PARALLEL SAFE AS $$
SELECT DISTINCT ON (r.device_id, r.user_id, p.recorded_at, r.source)
       r.device_id, r.user_id, p.recorded_at, r.source,
       CASE WHEN f.item IS NULL THEN r.fix ELSE true END,
       CASE WHEN f.item IS NULL THEN r.lat ELSE (f.item->>'lat')::double precision END,
       CASE WHEN f.item IS NULL THEN r.lng ELSE (f.item->>'lng')::double precision END,
       CASE WHEN f.item IS NULL THEN r.sat ELSE (f.item->>'sat')::smallint END,
       r.ttff_s, r.csq, r.reg, r.vbat_mv, r.raw, r.device_uptime_s, r.heading,
       COALESCE((f.item->>'speed_kmh')::real, r.speed_kmh), r.recorded_at
FROM location_records r
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.fixes_jsonb)='array' THEN r.fixes_jsonb ELSE '[]'::jsonb END
) f(item) ON true
CROSS JOIN LATERAL (
  SELECT r.recorded_at + COALESCE((f.item->>'at_ms')::bigint,0) * interval '1 millisecond' AS recorded_at
) p
WHERE r.device_id=wanted_device AND r.user_id=wanted_user
  AND (from_time IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,true)>=from_time)
  AND (to_time IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,false)<=to_time)
  AND (from_time IS NULL OR p.recorded_at>=from_time)
  AND (to_time IS NULL OR p.recorded_at<=to_time)
  AND (r.fixes_jsonb IS NULL OR f.item IS NOT NULL)
ORDER BY r.device_id,r.user_id,p.recorded_at,r.source,(f.item IS NOT NULL) DESC,r.recorded_at DESC
$$;

-- Dates need distinct days, not the much larger globally deduplicated point set.
CREATE FUNCTION location_fix_dates(at_time timestamptz, fixes jsonb, has_fix boolean)
RETURNS date[] LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE WHEN fixes IS NULL THEN
   CASE WHEN has_fix THEN ARRAY[(at_time AT TIME ZONE 'Asia/Seoul')::date] ELSE ARRAY[]::date[] END
 ELSE ARRAY(SELECT DISTINCT
   ((at_time AT TIME ZONE 'UTC' + COALESCE((f->>'at_ms')::bigint,0)*interval '1 millisecond')
      AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Seoul')::date
   FROM jsonb_array_elements(CASE WHEN jsonb_typeof(fixes)='array' THEN fixes ELSE '[]'::jsonb END) f)
 END
$$;
