SELECT EXISTS (
 SELECT 1 FROM events e
 JOIN devices d ON d.id=e.device_id AND d.owner_id=e.user_id
 LEFT JOIN notification_settings ns ON ns.user_id=e.user_id
 LEFT JOIN LATERAL (
   SELECT kind,occurred_at,id,data FROM events
   WHERE device_id=e.device_id AND user_id=e.user_id AND kind IN ('wake','sleep_enter')
   ORDER BY occurred_at DESC,id DESC LIMIT 1
 ) life ON true
 LEFT JOIN LATERAL (
   SELECT r.vbat_mv,r.recorded_at FROM location_records r
   WHERE e.kind='low_batt' AND r.device_id=e.device_id AND r.user_id=e.user_id
   ORDER BY r.recorded_at DESC LIMIT 1
 ) latest_battery ON true
 WHERE e.id=$1
 AND e.occurred_at <= now()+interval '5 minutes'
 AND e.occurred_at > now() - CASE
   WHEN e.kind IN ('low_batt','brownout','gps_anomaly','geofence_in','geofence_out','rental_ending','rental_overdue') THEN interval '1 hour'
   ELSE interval '15 minutes' END
 AND CASE e.kind
   WHEN 'low_batt' THEN COALESCE(ns.low_batt_alert,true)
   WHEN 'offline' THEN COALESCE(ns.offline_alert,true)
   WHEN 'signal_loss' THEN COALESCE(ns.signal_loss_alert,false)
   WHEN 'online' THEN COALESCE(ns.online_alert,true)
   WHEN 'sleep_enter' THEN COALESCE(ns.sleep_alert,false) AND COALESCE(e.data->>'sleep_reason','') NOT IN ('timer_hb','timer_hb_fail')
   WHEN 'wake' THEN CASE WHEN e.data->>'wake_cause'='motion' THEN COALESCE(ns.motion_alert,true)
                        ELSE COALESCE(ns.wake_alert,false) END
   WHEN 'motion' THEN COALESCE(ns.motion_alert,true)
   WHEN 'cycle_first_fix' THEN COALESCE(ns.cycle_first_fix_alert,false)
   WHEN 'geofence_in' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'geofence_out' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'geofence_armed' THEN COALESCE(ns.geofence_alert,true)
   WHEN 'brownout' THEN COALESCE(ns.device_health_alert,true)
   WHEN 'gps_anomaly' THEN COALESCE(ns.device_health_alert,true)
   WHEN 'reservation_starting' THEN COALESCE(ns.reservation_alert,true)
   WHEN 'reservation_ending' THEN COALESCE(ns.reservation_alert,true)
   WHEN 'rental_ending' THEN COALESCE(ns.rental_alert,true)
   WHEN 'rental_overdue' THEN COALESCE(ns.rental_alert,true)
   ELSE false END
 AND CASE
   WHEN e.kind IN ('reservation_starting','reservation_ending') THEN EXISTS (
      SELECT 1 FROM vehicle_reservations r WHERE r.id::text=e.data->>'reservation_id'
       AND r.user_id=e.user_id AND (r.fleet_vehicle_id IS NULL AND r.device_id=e.device_id OR EXISTS(SELECT 1 FROM fleet_vehicle_bindings b WHERE b.vehicle_id=r.fleet_vehicle_id AND b.owner_id=e.user_id AND b.device_id=e.device_id AND b.is_primary AND b.ended_at IS NULL))
       AND CASE WHEN e.kind='reservation_starting' THEN
         r.status='planned' AND r.starts_at>now() AND r.starts_at<=now()+interval '30 minutes'
         AND r.starts_at=(e.data->>'starts_at')::timestamptz
       ELSE r.status IN ('planned','in_progress') AND r.ends_at>now() AND r.ends_at<=now()+interval '30 minutes'
         AND r.ends_at=(e.data->>'ends_at')::timestamptz END
   )
   WHEN e.kind IN ('rental_ending','rental_overdue') THEN EXISTS (
      SELECT 1 FROM rental_contracts r WHERE r.id::text=e.data->>'contract_id'
       AND r.user_id=e.user_id AND r.device_id=e.device_id
       AND r.ends_at=(e.data->>'ends_at')::timestamptz
       AND CASE WHEN e.kind='rental_ending' THEN
         r.status IN ('draft','active') AND r.ends_at>now() AND r.ends_at<=now()+interval '24 hours'
       ELSE r.status='overdue' AND r.ends_at<=now() END
   )
   WHEN e.kind IN ('offline','signal_loss') THEN
      d.last_seen_at <= e.occurred_at AND COALESCE(life.kind,'') <> 'sleep_enter'
      AND EXISTS (SELECT 1 FROM connection_alert_episodes a
          WHERE a.device_id=e.device_id AND a.user_id=e.user_id AND a.kind=e.kind
            AND a.last_seen_at=d.last_seen_at AND a.event_id=e.id)
      AND d.last_seen_at < now()-make_interval(mins => CASE WHEN e.kind='offline'
           THEN COALESCE(ns.offline_minutes,1440) ELSE COALESCE(ns.signal_loss_minutes,5) END)
      AND (e.kind <> 'signal_loss' OR d.last_seen_at > now()-make_interval(mins=>COALESCE(ns.offline_minutes,1440)))
   WHEN e.kind='online' THEN d.last_seen_at > now()-make_interval(mins=>COALESCE(ns.signal_loss_minutes,5))
   WHEN e.kind='wake' AND e.data->>'wake_cause'='timer' THEN
      life.id=e.id OR (life.kind='sleep_enter' AND life.data->>'sleep_reason' IN ('timer_hb','timer_hb_fail')
       AND life.data->'diag'->>'boots'=e.data->'diag'->>'boots'
       AND life.occurred_at>=e.occurred_at AND life.occurred_at<e.occurred_at+interval '5 minutes')
   WHEN e.kind IN ('wake','sleep_enter') THEN life.id=e.id
   WHEN e.kind IN ('motion','cycle_first_fix') THEN COALESCE(life.kind,'') <> 'sleep_enter'
   WHEN e.kind='low_batt' THEN
      (__EVENT_BATTERY_VOLTAGE__) < COALESCE(ns.low_batt_threshold_mv,3500)
      AND (__LATEST_BATTERY_VOLTAGE__) < COALESCE(ns.low_batt_threshold_mv,3500)
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
     AND (e.kind NOT IN ('reservation_starting','reservation_ending')
          OR newer.data->>'reservation_id'=e.data->>'reservation_id')
     AND (e.kind NOT IN ('rental_ending','rental_overdue')
          OR newer.data->>'contract_id'=e.data->>'contract_id')
 )
)
