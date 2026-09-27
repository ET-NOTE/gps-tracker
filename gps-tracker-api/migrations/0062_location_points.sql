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
       r.recorded_at AS anchor_at
FROM location_records r
LEFT JOIN LATERAL jsonb_array_elements(
  CASE WHEN jsonb_typeof(r.fixes_jsonb)='array' THEN r.fixes_jsonb ELSE '[]'::jsonb END
) f(item) ON true
CROSS JOIN LATERAL (
  SELECT r.recorded_at + COALESCE((f.item->>'at_ms')::bigint,0) * interval '1 millisecond' AS recorded_at
) p
WHERE r.fixes_jsonb IS NULL OR f.item IS NOT NULL
ORDER BY r.device_id, r.user_id, p.recorded_at, r.source, (f.item IS NOT NULL) DESC, r.recorded_at DESC;

-- Durable invalidation: an interrupted worker leaves the affected dates pending.
CREATE TABLE stats_rebuild_queue (
    device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    date date NOT NULL,
    generation bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (device_id,date)
);
INSERT INTO stats_rebuild_queue(device_id,date)
SELECT device_id,date FROM daily_stats
UNION SELECT device_id,(recorded_at AT TIME ZONE 'Asia/Seoul')::date FROM location_points;
