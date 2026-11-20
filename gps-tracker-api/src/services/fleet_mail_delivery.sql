SELECT q.category,coalesce(u.email,''),
       coalesce((p.settings->>'email')::boolean,false)
       AND coalesce((p.settings->>q.category)::boolean,true)
       AND q.created_at>now()-interval '24 hours'
       AND (q.category<>'maintenance' OR EXISTS(
           SELECT 1 FROM fleet_vehicles v CROSS JOIN LATERAL
             (VALUES ('service',v.profile->>'next_service_date'),('insurance',v.profile->>'insurance_expiry'),
                     ('inspection',v.profile->>'inspection_expiry')) d(key,due)
           WHERE v.owner_id=q.owner_id AND v.id=q.vehicle_id AND v.enabled
             AND q.source_key='schedule-'||v.id||'-'||d.key||'-'||d.due))
       AND (q.category<>'connection' OR EXISTS(
           SELECT 1 FROM connection_alert_episodes e
           JOIN fleet_vehicle_bindings b ON b.device_id=e.device_id AND b.owner_id=e.user_id
             AND b.is_primary AND b.ended_at IS NULL AND b.started_at<=e.last_seen_at
           JOIN gps_read_devices d ON d.owner_id=e.user_id AND d.id=e.device_id AND d.last_seen_at=e.last_seen_at
           WHERE e.user_id=q.owner_id AND b.vehicle_id=q.vehicle_id AND q.source_key='episode-'||e.event_id))
       AND NOT EXISTS(SELECT 1 FROM privacy_account_controls c WHERE c.restricted AND c.user_id IN(q.owner_id,q.recipient_id))
       AND (q.owner_id=q.recipient_id OR EXISTS(
           SELECT 1 FROM fleet_staff_accounts a JOIN staff s ON s.user_id=a.owner_id AND s.id=a.staff_id AND s.active
           WHERE a.owner_id=q.owner_id AND a.account_id=q.recipient_id
             AND (q.vehicle_id IS NULL OR s.access_role='admin' OR EXISTS(
                 SELECT 1 FROM fleet_vehicles v WHERE v.owner_id=q.owner_id AND v.id=q.vehicle_id
                   AND ((s.access_role='department_manager' AND s.department_id=v.department_id)
                     OR (s.access_role='member' AND (s.all_vehicles OR s.id=v.manager_staff_id OR EXISTS (
                         SELECT 1 FROM fleet_staff_vehicles sv WHERE sv.owner_id=q.owner_id AND sv.vehicle_id=v.id AND sv.staff_id=s.id))))))
             AND (s.access_role='admin' OR
               (q.category IN ('reservation','trip') AND EXISTS(SELECT 1 FROM vehicle_reservations r
                  WHERE r.user_id=q.owner_id AND r.id=q.record_id AND (r.submitted_by=a.account_id OR r.driver_staff_id=s.id))) OR
               (q.category='expense' AND EXISTS(SELECT 1 FROM fleet_expenses e WHERE e.owner_id=q.owner_id AND e.id=q.record_id
                   AND (e.staff_id=s.id OR (s.access_role='department_manager' AND e.department_id=s.department_id)))) )
       )) AS eligible
FROM fleet_notification_mail q JOIN users u ON u.id=q.recipient_id JOIN fleet_notification_policy p ON p.owner_id=q.owner_id
WHERE q.id=$1 AND q.finished_at IS NULL AND q.next_attempt_at<=now() FOR UPDATE OF q SKIP LOCKED
