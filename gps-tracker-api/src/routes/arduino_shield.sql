WITH shield AS (
    SELECT id, last_seen_at FROM devices
    WHERE device_uid = $1 AND ($2::bigint IS NULL OR owner_id=$2)
), recent AS (
    SELECT r.recorded_at, r.device_uptime_s, r.fix, r.sat, r.csq, r.reg,
           CASE WHEN r.raw #>> '{diag,pv_mv}' ~ '^[0-9]{1,5}$'
                THEN (r.raw #>> '{diag,pv_mv}')::integer END AS pv_mv,
           LEFT(r.raw->>'build_tag', 80) AS build_tag,
           CASE WHEN jsonb_typeof(r.fixes_jsonb)='array' THEN jsonb_array_length(r.fixes_jsonb)
                WHEN r.fix THEN 1 ELSE 0 END AS point_count
    FROM location_records r JOIN shield s ON s.id = r.device_id
    WHERE r.source = 'lte_gnss' AND r.recorded_at >= now() - interval '24 hours'
      AND ($2::bigint IS NULL OR r.user_id=$2)
    ORDER BY r.recorded_at DESC LIMIT 100
)
SELECT jsonb_build_object(
    'server_now', now(),
    'device_uid', $1::text,
    'available', EXISTS(SELECT 1 FROM shield),
    'last_seen_at', (SELECT last_seen_at FROM shield),
    'count_24h', (SELECT count(*) FROM location_records r JOIN shield s ON s.id = r.device_id
                  WHERE r.source = 'lte_gnss' AND r.recorded_at >= now() - interval '24 hours'
                    AND ($2::bigint IS NULL OR r.user_id=$2)),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(recent) ORDER BY recorded_at DESC) FROM recent), '[]'::jsonb)
)
