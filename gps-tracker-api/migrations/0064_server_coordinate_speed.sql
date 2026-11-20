-- One canonical point stream for histories, shares, trips and statistics.
-- Anchor timestamps must not be used to filter the time of a point inside a batch.
CREATE OR REPLACE VIEW location_points AS
SELECT DISTINCT ON (r.device_id, r.user_id, p.recorded_at, r.source)
       r.device_id, r.user_id, p.recorded_at, r.source,
       CASE WHEN f.item IS NULL THEN r.fix ELSE true END AS fix,
       CASE WHEN f.item IS NULL THEN r.lat ELSE (f.item->>'lat')::double precision END AS lat,
       CASE WHEN f.item IS NULL THEN r.lng ELSE (f.item->>'lng')::double precision END AS lng,
       CASE WHEN f.item IS NULL THEN r.sat ELSE (f.item->>'sat')::smallint END AS sat,
       r.ttff_s, r.csq, r.reg, r.vbat_mv, r.raw, r.device_uptime_s, r.heading,
       COALESCE((f.item->>'speed_kmh')::real, r.speed_kmh) AS speed_kmh,
       r.recorded_at AS anchor_at, (f.item->>'up_ms')::bigint AS point_up_ms
FROM location_records r
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.fixes_jsonb)='array' THEN r.fixes_jsonb ELSE '[]'::jsonb END
) f(item) ON true
CROSS JOIN LATERAL (
  SELECT r.recorded_at + COALESCE((f.item->>'at_ms')::bigint,0) * interval '1 millisecond' AS recorded_at
) p
WHERE r.fixes_jsonb IS NULL OR f.item IS NOT NULL
ORDER BY r.device_id, r.user_id, p.recorded_at, r.source, (f.item IS NOT NULL) DESC, r.recorded_at DESC;

CREATE OR REPLACE FUNCTION location_points_between(wanted_device bigint, wanted_user bigint,
                                        from_time timestamptz, to_time timestamptz)
RETURNS SETOF location_points LANGUAGE sql STABLE PARALLEL SAFE AS $$
SELECT DISTINCT ON (r.device_id, r.user_id, p.recorded_at, r.source)
       r.device_id, r.user_id, p.recorded_at, r.source,
       CASE WHEN f.item IS NULL THEN r.fix ELSE true END,
       CASE WHEN f.item IS NULL THEN r.lat ELSE (f.item->>'lat')::double precision END,
       CASE WHEN f.item IS NULL THEN r.lng ELSE (f.item->>'lng')::double precision END,
       CASE WHEN f.item IS NULL THEN r.sat ELSE (f.item->>'sat')::smallint END,
       r.ttff_s, r.csq, r.reg, r.vbat_mv, r.raw, r.device_uptime_s, r.heading,
       COALESCE((f.item->>'speed_kmh')::real, r.speed_kmh), r.recorded_at, (f.item->>'up_ms')::bigint
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

-- Raw receiver speed remains in location_records / location_points. Display speed
-- is derived on read so late uploads and point deletion cannot leave stale values.
CREATE FUNCTION gps_distance_m(a double precision, b double precision,
                               c double precision, d double precision)
RETURNS double precision LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
 SELECT 12742000 * asin(sqrt(least(1.0, greatest(0.0,
   power(sin(radians(c-a)/2),2) + cos(radians(a))*cos(radians(c))*power(sin(radians(d-b)/2),2)))))
$$;

CREATE FUNCTION location_speed_points_between(wanted_device bigint, wanted_user bigint,
                                               from_time timestamptz, to_time timestamptz)
RETURNS TABLE (
 device_id bigint, user_id bigint, recorded_at timestamptz, source text,
 fix boolean, lat double precision, lng double precision, sat smallint,
 ttff_s integer, csq smallint, reg smallint, vbat_mv integer, raw jsonb,
 device_uptime_s integer, heading real, speed_kmh real, anchor_at timestamptz,
 reported_speed_kmh real, speed_interval_s real, speed_reason text, speed_source text
) LANGUAGE sql STABLE PARALLEL SAFE AS $$
 WITH points AS MATERIALIZED (
   SELECT p, p.recorded_at AS at, p.source AS src, p.lat AS la, p.lng AS lo,
     p.fix AND p.lat BETWEEN -90 AND 90 AND p.lng BETWEEN -180 AND 180
       AND (p.sat IS NULL OR p.sat >= 4) AS usable,
     COALESCE(p.raw->>'boot_id',p.raw->>'boot') AS boot, p.point_up_ms AS up
   FROM location_points_between(wanted_device,wanted_user,from_time-interval '65 seconds',to_time) p
 ), previous AS (
   SELECT *, lag(at) OVER w AS prev_at, lag(la) OVER w AS prev_la,
     lag(lo) OVER w AS prev_lo, lag(usable) OVER w AS prev_usable,
     lag(boot) OVER w AS prev_boot, lag(up) OVER w AS prev_up
   FROM points WINDOW w AS (PARTITION BY src ORDER BY at)
 ), timing AS (
   SELECT *, CASE WHEN boot IS NOT NULL AND boot=prev_boot AND up IS NOT NULL AND prev_up IS NOT NULL
     THEN (up-prev_up)/1000.0 ELSE extract(epoch FROM at-prev_at) END AS elapsed
   FROM previous
 ), segments AS (
   SELECT *, CASE WHEN prev_at IS NULL THEN false ELSE
     NOT COALESCE(usable AND prev_usable,false)
     OR (boot IS NOT NULL AND prev_boot IS NOT NULL AND boot<>prev_boot)
     OR elapsed <= 0 OR elapsed > 60
     OR gps_distance_m(prev_la,prev_lo,la,lo)/NULLIF(elapsed,0)*3.6 > 250
     END AS broken
   FROM timing
 ), counted AS (
   SELECT *, sum(broken::integer) OVER (PARTITION BY src ORDER BY at) AS breaks
   FROM segments
 ), baseline AS (
   SELECT *, first_value(at) OVER w AS base_at, first_value(la) OVER w AS base_la,
     first_value(lo) OVER w AS base_lo, first_value(up) OVER w AS base_up, first_value(breaks) OVER w AS base_breaks
   FROM counted WINDOW w AS (PARTITION BY src ORDER BY at RANGE BETWEEN interval '5 seconds' PRECEDING AND CURRENT ROW)
 ), measurement AS (
   SELECT *, CASE WHEN boot IS NOT NULL AND boot=prev_boot AND up IS NOT NULL
      AND (CASE WHEN base_at<at THEN base_up ELSE prev_up END) IS NOT NULL
     THEN (up-CASE WHEN base_at<at THEN base_up ELSE prev_up END)/1000.0
     ELSE extract(epoch FROM at-CASE WHEN base_at<at THEN base_at ELSE prev_at END) END AS seconds,
     gps_distance_m(CASE WHEN base_at<at THEN base_la ELSE prev_la END,
                    CASE WHEN base_at<at THEN base_lo ELSE prev_lo END,la,lo) AS metres
   FROM baseline
 ), classified AS (
   SELECT *, CASE WHEN NOT COALESCE(usable,false) THEN 'invalid_fix'
     WHEN prev_at IS NULL OR seconds<3 THEN 'insufficient_history'
     WHEN seconds>60 THEN 'insufficient_history'
     WHEN (CASE WHEN base_at<at THEN breaks>base_breaks ELSE broken END) THEN 'discontinuity'
     WHEN metres/NULLIF(seconds,0)*3.6>250 THEN 'outlier'
     ELSE 'ok' END AS reason
   FROM measurement
 )
 SELECT (p).device_id,(p).user_id,at,src,(p).fix,la,lo,(p).sat,(p).ttff_s,
   (p).csq,(p).reg,(p).vbat_mv,(p).raw,(p).device_uptime_s,(p).heading,
   CASE WHEN reason='ok' THEN round((CASE WHEN metres<=3 THEN 0 ELSE metres/seconds*3.6 END)::numeric,2)::real END,
   (p).anchor_at,(p).speed_kmh,CASE WHEN reason='ok' THEN seconds::real END,reason,'server_coordinate_v1'::text
 FROM classified
 WHERE (from_time IS NULL OR at>=from_time) AND (to_time IS NULL OR at<=to_time)
$$;

-- Rebuild maxima using the same point speeds exposed by REST and WebSocket.
INSERT INTO stats_rebuild_queue(device_id,date)
SELECT device_id,date FROM daily_stats
ON CONFLICT(device_id,date) DO UPDATE SET generation=stats_rebuild_queue.generation+1;
