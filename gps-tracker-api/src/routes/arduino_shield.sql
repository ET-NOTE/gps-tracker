WITH shield AS (
    SELECT id, last_seen_at FROM devices
    WHERE device_uid = $1
), recent AS (
    SELECT r.recorded_at, r.device_uptime_s, r.fix, r.sat, r.csq, r.reg,
           CASE WHEN r.raw #>> '{diag,pv_mv}' ~ '^[0-9]{1,5}$'
                THEN (r.raw #>> '{diag,pv_mv}')::integer END AS pv_mv,
           LEFT(r.raw->>'build_tag', 80) AS build_tag
    FROM location_records r JOIN shield s ON s.id = r.device_id
    WHERE r.source = 'lte_gnss' AND r.recorded_at >= now() - interval '24 hours'
    ORDER BY r.recorded_at DESC LIMIT 100
)
SELECT jsonb_build_object(
    'server_now', now(),
    'device_uid', $1::text,
    'available', EXISTS(SELECT 1 FROM shield),
    'last_seen_at', (SELECT last_seen_at FROM shield),
    'count_24h', (SELECT count(*) FROM location_records r JOIN shield s ON s.id = r.device_id
                  WHERE r.source = 'lte_gnss' AND r.recorded_at >= now() - interval '24 hours'),
    'items', COALESCE((SELECT jsonb_agg(to_jsonb(recent) ORDER BY recorded_at DESC) FROM recent), '[]'::jsonb)
)
