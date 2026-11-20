-- Narrow speed projection for aggregate charts; never repeat raw JSON per point.
-- The speed algorithm must stay equivalent to location_speed_points_between.
-- Full payload history still uses that existing function.
SET LOCAL lock_timeout='5s';
CREATE OR REPLACE FUNCTION location_speed_metrics_between(wanted_device bigint, wanted_user bigint,
                                               from_time timestamptz, to_time timestamptz)
RETURNS TABLE (
 device_id bigint, user_id bigint, recorded_at timestamptz, source text,
 fix boolean, lat double precision, lng double precision, sat smallint,
 ttff_s integer, csq smallint, reg smallint, vbat_mv integer,
 device_uptime_s integer, heading real, speed_kmh real, anchor_at timestamptz,
 reported_speed_kmh real, speed_interval_s real, speed_reason text, speed_source text
) LANGUAGE sql STABLE PARALLEL SAFE AS $$
WITH records AS MATERIALIZED (
 SELECT r.*,COALESCE(r.raw->>'boot_id',r.raw->>'boot') AS boot FROM location_records r
 WHERE r.device_id=wanted_device AND r.user_id=wanted_user
 AND ((from_time-interval '65 seconds') IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,true)>=(from_time-interval '65 seconds'))
 AND (to_time IS NULL OR location_point_bound(r.recorded_at,r.fixes_jsonb,false)<=to_time)
), samples AS MATERIALIZED (
 SELECT DISTINCT ON (p.recorded_at,r.source)
  r.device_id,r.user_id,p.recorded_at,r.source,
  CASE WHEN f.item IS NULL THEN r.fix ELSE true END AS fix,
  CASE WHEN f.item IS NULL THEN r.lat ELSE (f.item->>'lat')::double precision END AS lat,
  CASE WHEN f.item IS NULL THEN r.lng ELSE (f.item->>'lng')::double precision END AS lng,
  CASE WHEN f.item IS NULL THEN r.sat ELSE (f.item->>'sat')::smallint END AS sat,
  r.ttff_s,r.csq,r.reg,r.vbat_mv,r.device_uptime_s,r.heading,r.boot,
  COALESCE((f.item->>'speed_kmh')::real,r.speed_kmh) AS speed_kmh,
  r.recorded_at AS anchor_at,(f.item->>'up_ms')::bigint AS point_up_ms
 FROM records r LEFT JOIN LATERAL jsonb_array_elements(
   CASE WHEN jsonb_typeof(r.fixes_jsonb)='array' THEN r.fixes_jsonb ELSE '[]'::jsonb END
 ) f(item) ON true
 CROSS JOIN LATERAL (SELECT r.recorded_at+COALESCE((f.item->>'at_ms')::bigint,0)*interval '1 millisecond' AS recorded_at) p
 WHERE ((from_time-interval '65 seconds') IS NULL OR p.recorded_at>=(from_time-interval '65 seconds'))
 AND (to_time IS NULL OR p.recorded_at<=to_time)
 AND (r.fixes_jsonb IS NULL OR f.item IS NOT NULL)
 ORDER BY p.recorded_at,r.source,(f.item IS NOT NULL) DESC,r.recorded_at DESC
), points AS MATERIALIZED (
   SELECT p.device_id,p.user_id,p.fix,p.sat,p.ttff_s,p.csq,p.reg,p.vbat_mv,p.device_uptime_s,p.heading,p.anchor_at,p.speed_kmh AS reported_speed,p.recorded_at AS at, p.source AS src, p.lat AS la, p.lng AS lo,
     p.fix AND p.lat BETWEEN -90 AND 90 AND p.lng BETWEEN -180 AND 180
       AND (p.sat IS NULL OR p.sat >= 4) AS usable,
     p.boot, p.point_up_ms AS up
   FROM samples p
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
 SELECT classified.device_id,classified.user_id,at,src,classified.fix,la,lo,classified.sat,classified.ttff_s,
   classified.csq,classified.reg,classified.vbat_mv,classified.device_uptime_s,classified.heading,
   CASE WHEN reason='ok' THEN round((CASE WHEN metres<=3 THEN 0 ELSE metres/seconds*3.6 END)::numeric,2)::real END,
   classified.anchor_at,classified.reported_speed,CASE WHEN reason='ok' THEN seconds::real END,reason,'server_coordinate_v1'::text
 FROM classified
 WHERE (from_time IS NULL OR at>=from_time) AND (to_time IS NULL OR at<=to_time)
$$;
