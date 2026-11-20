-- Counts only: no identities, tokens, locations or free-text provider payloads.
WITH q AS (
 SELECT count(*) FILTER(WHERE delivery='pending') AS pending,
 count(*) FILTER(WHERE delivery='pending' AND available_at<=now() AND (lease_until IS NULL OR lease_until<now())) AS due,
 count(*) FILTER(WHERE delivery='pending' AND lease_until>now()) AS inflight,
 count(*) FILTER(WHERE delivery='pending' AND lease_until<now()) AS expired_leases,
 count(*) FILTER(WHERE delivery='review') AS review,
 count(*) FILTER(WHERE delivery='waiting') AS waiting,
 COALESCE(extract(epoch FROM now()-min(started_at) FILTER(WHERE delivery='pending')),0)::bigint AS oldest_pending_seconds,
 count(*) FILTER(WHERE delivery='waiting' AND started_at<now()-interval '15 minutes') AS stale_waiting
 FROM location_provision_notices WHERE delivery IN ('pending','review','waiting')
), a AS (
 SELECT count(*) AS attempts_5m,count(*) FILTER(WHERE result='accepted') AS accepted_5m,
 count(*) FILTER(WHERE result<>'accepted') AS failed_5m
 FROM location_notice_attempts WHERE at>=now()-interval '5 minutes'
), s AS (
 SELECT q.*,a.*,p.enabled,p.push_enabled,w.provider_configured,
 COALESCE(extract(epoch FROM now()-w.seen_at)::bigint,2147483647) AS worker_age_seconds,
 CASE WHEN w.cooldown_until>now() THEN ceil(extract(epoch FROM w.cooldown_until-now()))::bigint ELSE 0 END AS cooldown_seconds,
 $1::boolean AS expected_running
 FROM q CROSS JOIN a CROSS JOIN location_subject_policy p CROSS JOIN location_notice_worker w
), h AS (
 SELECT s.*,array_remove(ARRAY[
 CASE WHEN pending>0 AND NOT(expected_running AND enabled AND push_enabled) THEN 'delivery_paused' END,
 CASE WHEN expected_running AND enabled AND push_enabled AND NOT provider_configured THEN 'provider_unconfigured' END,
 CASE WHEN expected_running AND worker_age_seconds>60 THEN 'worker_stale' END,
 CASE WHEN oldest_pending_seconds>=900 THEN 'backlog_critical' WHEN oldest_pending_seconds>=300 THEN 'backlog_warning' END,
 CASE WHEN review>0 THEN 'manual_review' END,
 CASE WHEN expired_leases>0 THEN 'lease_expired' END,
 CASE WHEN stale_waiting>0 THEN 'intent_unresolved' END,
 CASE WHEN cooldown_seconds>0 THEN 'provider_cooldown' END,
 CASE WHEN attempts_5m>=20 AND failed_5m*2>=attempts_5m THEN 'failure_ratio' END
 ],NULL) AS alerts FROM s
)
SELECT to_jsonb(h)||jsonb_build_object('checked_at',clock_timestamp(),'severity',
 CASE WHEN alerts && ARRAY['worker_stale','backlog_critical','provider_unconfigured'] THEN 'critical'
 WHEN cardinality(alerts)>0 THEN 'warning' ELSE 'ok' END,
 'provider_accepted_is_not_device_delivery',true) FROM h;
