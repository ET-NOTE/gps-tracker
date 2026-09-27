SELECT EXISTS (
 SELECT 1 FROM events e
 JOIN devices d ON d.id=e.device_id AND d.owner_id=e.user_id
 LEFT JOIN notification_settings ns ON ns.user_id=e.user_id
 LEFT JOIN LATERAL (
   SELECT kind,occurred_at,id FROM events
   WHERE device_id=e.device_id AND user_id=e.user_id AND kind IN ('wake','sleep_enter')
   ORDER BY occurred_at DESC,id DESC LIMIT 1
 ) life ON true
 WHERE e.id=$1
 AND e.occurred_at <= now()+interval '5 minutes'
 AND e.occurred_at > now() - CASE
   WHEN e.kind IN ('low_batt','brownout','gps_anomaly','geofence_in','geofence_out') THEN interval '1 hour'
   ELSE interval '15 minutes' END
 AND CASE e.kind
   WHEN 'low_batt' THEN COALESCE(ns.low_batt_alert,true)
   WHEN 'offline' THEN COALESCE(ns.offline_alert,true)
   WHEN 'signal_loss' THEN COALESCE(ns.signal_loss_alert,false)
   WHEN 'online' THEN COALESCE(ns.online_alert,true)
   WHEN 'sleep_enter' THEN COALESCE(ns.sleep_alert,false)
   WHEN 'wake' THEN CASE WHEN e.data->>'wake_cause'='motion' THEN COALESCE(ns.motion_alert,true)
                        ELSE COALESCE(ns.wake_alert,false) END
   WHEN 'motion' THEN COALESCE(ns.motion_alert,true)
   WHEN 'cycle_first_fix' THEN COALESCE(ns.cycle_first_fix_alert,false)
   WHEN 'geofence_in' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'geofence_out' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'geofence_armed' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'brownout' THEN COALESCE(ns.device_health_alert,true)
   WHEN 'gps_anomaly' THEN COALESCE(ns.device_health_alert,true)
   ELSE false END
 AND CASE
   WHEN e.kind IN ('offline','signal_loss') THEN
      d.last_seen_at <= e.occurred_at AND COALESCE(life.kind,'') <> 'sleep_enter'
      AND d.last_seen_at < now()-make_interval(mins => CASE WHEN e.kind='offline'
           THEN COALESCE(ns.offline_minutes,30) ELSE COALESCE(ns.signal_loss_minutes,5) END)
      AND (e.kind <> 'signal_loss' OR d.last_seen_at > now()-make_interval(mins=>COALESCE(ns.offline_minutes,30)))
   WHEN e.kind='online' THEN d.last_seen_at > now()-make_interval(mins=>COALESCE(ns.signal_loss_minutes,5))
   WHEN e.kind IN ('wake','sleep_enter') THEN life.id=e.id
   WHEN e.kind IN ('motion','cycle_first_fix') THEN COALESCE(life.kind,'') <> 'sleep_enter'
   WHEN e.kind='low_batt' THEN
      (e.data->>'vbat_mv')::integer BETWEEN 2500 AND 5000
      AND (e.data->>'vbat_mv')::integer < COALESCE(ns.low_batt_threshold_mv,3500)
      AND COALESCE((SELECT r.vbat_mv FROM location_records r WHERE r.device_id=e.device_id
          AND r.user_id=e.user_id AND r.vbat_mv BETWEEN 2500 AND 5000
          ORDER BY r.recorded_at DESC LIMIT 1),(e.data->>'vbat_mv')::integer) < COALESCE(ns.low_batt_threshold_mv,3500)
   WHEN e.kind='gps_anomaly' THEN d.last_fix_at IS NULL OR d.last_fix_at <= e.occurred_at
   ELSE true END
 AND NOT EXISTS (
   SELECT 1 FROM events newer WHERE newer.device_id=e.device_id AND newer.user_id=e.user_id
     AND (newer.occurred_at,newer.id)>(e.occurred_at,e.id)
     AND (newer.kind=e.kind OR
       (e.kind IN ('signal_loss','offline','online') AND newer.kind IN ('signal_loss','offline','online')) OR
       (e.kind IN ('geofence_in','geofence_out','geofence_armed') AND newer.kind IN ('geofence_in','geofence_out','geofence_armed')))
     AND (e.kind NOT IN ('geofence_in','geofence_out','geofence_armed')
          OR newer.data->>'geofence_id'=e.data->>'geofence_id')
 )
)
